/**
 * The `creator:write` tools (WP-333): what the `amazon-creator-connections`
 * skill writes into Arcana from the control runner's outputs.
 *
 * Each tool validates with the shared schemas, refuses raw contact data by
 * shape, writes through the same upserts, keys and content digests as the file
 * import (`apps/worker/src/creators-import.ts`), and writes one audit row. The
 * audit row records a digest of the arguments and their size, never the
 * arguments themselves: a refused payload may carry the contact data it was
 * refused for, and a draft body is not the audit log's to keep.
 *
 * Nothing here calls Amazon, sends a message or places an order. Creator status
 * written into Arcana is not an Amazon write. `creators.sample_send_outcome`
 * (WP-338h) only reads: what became of the Arcana send on one sample lane. No
 * tool here can seal, preview, approve, send, resolve or cancel an MCF order.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CreatorAppendActionInput, CreatorAsin, CreatorMcfSendOutcome, CreatorPreflightResultInput, CreatorRecordId, CreatorSampleOrderKey, CreatorQueueSnapshotInput, CreatorRecordScoreInput, CreatorRegisterRecordInput, CreatorRunnerQueueItem,
  CreatorSubmitDraftInput, CreatorSweepCheckpointInput, CreatorSweepThread, findCreatorContactData,
  type CreatorRunnerRegistryRecord, type CreatorRunnerResolution,
} from '@wizard-ads/shared';
import {
  CreatorWriteRefusal, appendCreatorActions, creatorContentDigest, creatorPreflightRow, creatorQueueRows, creatorRegistryRows, creatorSweepRow,
  readCreatorWriteBaseline, recordCreatorScore, submitCreatorDraft, writeCreatorMcpRows, writeCreatorPreflights, type CreatorEventWrite,
} from '@wizard-ads/db/mcp-writes';
import { readCreatorMcfSendOutcome } from '@wizard-ads/db';
import { writeAuditEntry } from './audit.js';
import { ToolError } from './errors.js';
import { withCreatorWriteOperation, type CreatorWriteOperationContext, type ServerContext } from './operation.js';

/** Every tool a `creator:write` key may call, and nothing else. The last one only reads. */
export const CREATOR_WRITE_TOOLS = [
  'creators.register_record', 'creators.record_score', 'creators.append_action', 'creators.submit_draft',
  'creators.queue_snapshot', 'creators.sweep_checkpoint', 'creators.preflight_result', 'creators.sample_send_outcome',
] as const;
export type CreatorWriteTool = typeof CREATOR_WRITE_TOOLS[number];

// ---------------------------------------------------------------------------
// Runner shapes to rows: packages/db/src/queries/creators-runner.ts, shared with
// the file import. The identity decision is the one thing only `register` knows.
// ---------------------------------------------------------------------------

/**
 * The identity decision `register` acted on, as its own action-log entry: the
 * rung for a resolved or new record (the import cannot know it), or `conflict`
 * with the records a conflict named. The registry-derived `conflict:` entry the
 * import writes stays separate, so whichever path writes first loses nothing.
 */
export function creatorIdentityEvent(record: CreatorRunnerRegistryRecord, resolution: Exclude<CreatorRunnerResolution, { result: 'HOLD' }>,
  actorUserId: string): CreatorEventWrite {
  const id = record.creator_record_id;
  return { eventKey: `identity:${id}:${record.version}`, creatorRecordId: id, action: 'identity_resolved', occurredAt: null, reservationId: null,
    asin: null, reasonCode: resolution.result === 'CONFLICT' ? 'conflict' : resolution.result === 'NEW' ? 'new' : resolution.match_method,
    evidenceReference: null, recordVersion: record.version,
    relatedRecordIds: resolution.result === 'CONFLICT' ? resolution.matches.filter((match) => match !== id) : [], actorUserId };
}

// ---------------------------------------------------------------------------
// Validation and audit
// ---------------------------------------------------------------------------

/** Where the arguments failed, never what they held. */
function invalid(issues: readonly { path: readonly PropertyKey[]; code: string; message?: string }[], prefix = ''): ToolError {
  // A custom issue's message is ours (a rule, never a value); the others are named by code.
  const where = issues.slice(0, 10).map((issue) => `${prefix}${issue.path.map(String).join('.') || '(root)'} (${
    issue.code === 'custom' && issue.message ? issue.message : issue.code})`).join('; ');
  return new ToolError('invalid_argument', `The arguments do not have the runner's shape: ${where}. Nothing was written.`);
}

/** Refuse raw contact data before any parsing, so no shape can let it through. */
export function refuseCreatorContactData(args: unknown): void {
  const hits = findCreatorContactData(args);
  if (hits.length === 0) return;
  const where = hits.slice(0, 10).map((hit) => `${hit.path || '(root)'} (${hit.shape})`).join('; ');
  throw new ToolError('invalid_argument',
    `Raw contact data is refused: ${where}. Send fingerprints only, never an email, phone number, address or link. Nothing was written.`);
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return parsed.data;
}

/**
 * The audit keeps a digest and a size, so a call can be matched without the log
 * holding its content, and names only the argument keys the tool's own schema
 * has. Any other key is counted, never written: a key can be contact data too.
 */
function auditParams(args: unknown, expected: readonly string[]): Record<string, unknown> {
  const text = JSON.stringify(args ?? null) ?? 'null';
  const keys = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : [];
  return {
    digest: creatorContentDigest(args ?? null),
    bytes: Buffer.byteLength(text, 'utf8'),
    keys: keys.filter((key) => expected.includes(key)).sort(),
    otherKeys: keys.filter((key) => !expected.includes(key)).length,
  };
}

interface McpToolResult { [key: string]: unknown; content: { type: 'text'; text: string }[]; isError?: boolean }
const result = (payload: unknown, isError = false): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}),
});

type CreatorHandler = (args: unknown, operation: CreatorWriteOperationContext) => Promise<{ payload: unknown; summary: Record<string, unknown> }>;

/**
 * Run one creator tool, write its audit row on every path, and turn a refusal
 * into a result a model can act on. A failed audit write fails the call. A
 * `read` tool runs under the same re-authorization and audit; only its
 * fallback message differs.
 */
function auditedCreatorWrite(context: ServerContext, tool: CreatorWriteTool, expected: readonly string[], handler: CreatorHandler,
  kind: 'write' | 'read' = 'write') {
  return async (args: unknown): Promise<McpToolResult> => {
    const started = Date.now();
    try {
      refuseCreatorContactData(args);
      const outcome = await withCreatorWriteOperation(context, (operation) => handler(args, operation));
      await writeAuditEntry(context.handle, {
        orgId: context.actor.orgId, keyId: context.keyId, tool, params: auditParams(args, expected), outcome: 'ok',
        summary: outcome.summary, durationMs: Date.now() - started,
      });
      return result(outcome.payload);
    } catch (error) {
      const refusal = error instanceof CreatorWriteRefusal ? new ToolError(error.code === 'record_not_found' || error.code === 'draft_not_found'
        || error.code === 'lane_not_found'
        ? 'not_found' : 'invalid_argument', `${error.message} Nothing was written.`) : null;
      const known = refusal ?? (error instanceof ToolError ? error : null);
      await writeAuditEntry(context.handle, {
        orgId: context.actor.orgId, keyId: context.keyId, tool, params: auditParams(args, expected), outcome: 'error',
        summary: { code: error instanceof CreatorWriteRefusal ? error.code : known?.code ?? 'internal' },
        durationMs: Date.now() - started,
      });
      return result({ error: known?.code ?? 'internal',
        message: known?.message ?? `The ${kind} could not be completed. This has been logged; nothing was written.` }, true);
    }
  };
}

// ---------------------------------------------------------------------------
// The eight tools
// ---------------------------------------------------------------------------

const any = (description: string) => z.unknown().describe(description);
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * One sample lane: its derived order key (the `CCS-` key `creators.preflight_result`
 * returned) or its record and ASIN. Exactly one form; both at once is refused
 * rather than guessed between.
 */
const SendOutcomeByKey = z.object({ derivedOrderKey: CreatorSampleOrderKey }).strict();
const SendOutcomeByLane = z.object({ creatorRecordId: CreatorRecordId, asin: CreatorAsin }).strict();
function sendOutcomeTarget(args: unknown): z.infer<typeof SendOutcomeByKey> | z.infer<typeof SendOutcomeByLane> {
  const keyed = args !== null && typeof args === 'object' && !Array.isArray(args) && 'derivedOrderKey' in args;
  const laned = args !== null && typeof args === 'object' && !Array.isArray(args) && ('creatorRecordId' in args || 'asin' in args);
  if (keyed && laned) {
    throw invalid([{ path: [], code: 'custom', message: 'give either derivedOrderKey or creatorRecordId with asin, not both' }]);
  }
  return keyed ? parse(SendOutcomeByKey, args) : parse(SendOutcomeByLane, args);
}

export function registerCreatorWriteTools(server: McpServer, context: ServerContext): void {
  server.registerTool('creators.register_record', {
    title: 'Register a creator record',
    description: 'Write one Creator Registry row as creator_control.py holds it after `register` (issue_record_id), with the resolve_record '
      + 'result it acted on. Fingerprints only. Records the identity rung (RESOLVED/NEW) or the records a CONFLICT named. Idempotent.',
    inputSchema: z.looseObject({
      record: any('The registry row: creator_record_id, brand, campaign_id, the six fingerprints, record_state, lock_state, version, created_at, and the optional reservation and history.'),
      resolution: any('resolve_record output: {result: "RESOLVED", creator_record_id, match_method} | {result: "NEW", fingerprints} | {result: "CONFLICT", reason, matches, conflicting_fields?}.'),
    }),
    annotations: WRITE,
  }, auditedCreatorWrite(context, 'creators.register_record', ['record', 'resolution'], async (args, operation) => {
    const input = parse(CreatorRegisterRecordInput, args);
    const rows = creatorRegistryRows(operation.actor.orgId, input.record);
    if (!rows.ok) {
      throw invalid(rows.paths.map((path) => ({ path: ['record', ...path], code: 'custom', message: path.at(-1) === 'order_id'
        ? 'order_id is not this organisation\'s derived order key for the record and ASIN'
        : 'derived_order_key is not this organisation\'s key for the record and ASIN' })));
    }
    const resolution = input.resolution as Exclude<CreatorRunnerResolution, { result: 'HOLD' }>;
    const held = await readCreatorWriteBaseline(operation.sql, operation.actor.orgId, input.record.creator_record_id);
    if (held.runnerVersion !== null && held.runnerVersion > input.record.version) {
      // A stale registry row must not undo a newer lock; nothing of it is written.
      return {
        payload: { creator_record_id: input.record.creator_record_id, record: 'older_than_held', held_version: held.runnerVersion },
        summary: { creatorRecordId: input.record.creator_record_id, record: 'older_than_held' },
      };
    }
    const actions = [creatorIdentityEvent(input.record, resolution, operation.actor.userId), ...rows.actions];
    const counts = await writeCreatorMcpRows(operation.sql, operation.actor.orgId, { records: [rows.record], actions, shipments: rows.lanes });
    return {
      payload: { creator_record_id: input.record.creator_record_id, lock_state: input.record.lock_state, counts },
      summary: { creatorRecordId: input.record.creator_record_id, resolution: resolution.result, counts },
    };
  }));

  server.registerTool('creators.record_score', {
    title: 'Record a creator score',
    description: 'Write the `score` command output (score_record: score, checks, missing) for one record, with the tracker status and the '
      + 'score typed on the tracker. A score older than the one held changes nothing. Idempotent.',
    inputSchema: z.looseObject({
      creator_record_id: any('CCR-{BRAND}-{YY}-{NNNN}'),
      scored_on: any('YYYY-MM-DD, the day the score was computed'),
      current_status: any('The tracker Status label'),
      tracker_score: any('Total Qualification Score as typed on the tracker, 0-10, or null when blank'),
      result: any('score_record output: {score, checks: {ten booleans}, missing: [...]}'),
    }),
    annotations: WRITE,
  }, auditedCreatorWrite(context, 'creators.record_score', ['creator_record_id', 'scored_on', 'current_status', 'tracker_score', 'result'], async (args, operation) => {
    const input = parse(CreatorRecordScoreInput, args);
    const written = await recordCreatorScore(operation.sql, operation.actor.orgId, operation.actor.userId, input);
    return { payload: { creator_record_id: input.creator_record_id, ...written }, summary: { creatorRecordId: input.creator_record_id, ...written } };
  }));

  server.registerTool('creators.append_action', {
    title: 'Append creator action-log entries',
    description: 'Append Creator Action Log entries the skill recorded: message_sent_by_hand, status_moved, content_verified, escalated, '
      + 'preflight_recorded. Each entry carries its own event_key; the same key twice is one entry, and a key reused for other content is refused.',
    inputSchema: z.looseObject({ entries: any('1-200 entries: {event_key, creator_record_id, action, occurred_at, reservation_id?, asin?, reason_code?, evidence_reference?}') }),
    annotations: WRITE,
  }, auditedCreatorWrite(context, 'creators.append_action', ['entries'], async (args, operation) => {
    const input = parse(CreatorAppendActionInput, args);
    const counts = await appendCreatorActions(operation.sql, operation.actor.orgId, operation.actor.userId, input.entries.map((entry) => ({
      eventKey: entry.event_key, creatorRecordId: entry.creator_record_id, action: entry.action, occurredAt: entry.occurred_at,
      reservationId: entry.reservation_id === undefined || entry.reservation_id === null ? null : entry.reservation_id.trim().toUpperCase(),
      asin: entry.asin ?? null, reasonCode: entry.reason_code ?? null, evidenceReference: entry.evidence_reference ?? null,
    })));
    return { payload: { counts }, summary: { counts } };
  }));

  server.registerTool('creators.submit_draft', {
    title: 'Submit a reply draft',
    description: 'Submit one rendered reply for one creator thread, from an approved template. Returns the draft id. An owner or admin approves '
      + 'it on /creators/drafts; Arcana sends nothing, the operator sends the text by hand. Refused for a record locked in Conflict. Idempotent.',
    inputSchema: z.looseObject({
      creator_record_id: any('CCR-{BRAND}-{YY}-{NNNN}'),
      thread_key: any('The thread fingerprint (64 hex), as on the registry row'),
      template_key: any('One of the approved reply templates, by key'),
      draft_date: any('YYYY-MM-DD, the run day the draft answers'),
      body: any('The rendered reply text, at most 4000 characters, with no email, phone number, address or link'),
    }),
    annotations: WRITE,
  }, auditedCreatorWrite(context, 'creators.submit_draft', ['creator_record_id', 'thread_key', 'template_key', 'draft_date', 'body'], async (args, operation) => {
    const input = parse(CreatorSubmitDraftInput, args);
    const draft = await submitCreatorDraft(operation.sql, operation.actor.orgId, operation.actor.userId, input);
    return {
      payload: { draft_id: draft.draftId, status: draft.status, outcome: draft.outcome, withdrew: draft.withdrew },
      summary: { creatorRecordId: input.creator_record_id, templateKey: input.template_key, draftId: draft.draftId, outcome: draft.outcome,
        withdrew: draft.withdrew },
    };
  }));

  server.registerTool('creators.queue_snapshot', {
    title: 'Write the day\'s queue',
    description: 'Write the `queue` command\'s whole output file (run_date, items, counts) as the day\'s Daily Action Queue. Every item must '
      + 'validate; a newer snapshot for the same day replaces that day. Idempotent.',
    inputSchema: z.looseObject({
      run_date: any('YYYY-MM-DD'), items: any('queue_item results'), counts: any('{queued, escalated}, which must sum to the items'),
    }),
    annotations: WRITE,
  }, auditedCreatorWrite(context, 'creators.queue_snapshot', ['run_date', 'items', 'counts'], async (args, operation) => {
    const envelope = parse(CreatorQueueSnapshotInput, args);
    const items = envelope.items.map((raw, index) => {
      const parsed = CreatorRunnerQueueItem.safeParse(raw);
      if (!parsed.success) throw invalid(parsed.error.issues, `items.${index}.`);
      if (parsed.data.run_date !== envelope.run_date) throw invalid([{ path: ['run_date'], code: 'other_run' }], `items.${index}.`);
      return parsed.data;
    });
    const counted = { queued: items.filter((item) => item.queue_state === 'Queued').length, escalated: items.filter((item) => item.queue_state === 'Escalated').length };
    if (counted.queued !== envelope.counts.queued || counted.escalated !== envelope.counts.escalated) {
      throw new ToolError('invalid_argument', 'The counts do not match the items by queue_state. Nothing was written.');
    }
    const held = await readCreatorWriteBaseline(operation.sql, operation.actor.orgId, null);
    if (held.newestQueueDay !== null && held.newestQueueDay > envelope.run_date) {
      throw new CreatorWriteRefusal('older_than_held', `A queue for ${held.newestQueueDay} is already held; a snapshot for an earlier day is refused.`);
    }
    const counts = await writeCreatorMcpRows(operation.sql, operation.actor.orgId, { queue: { runDate: envelope.run_date, rows: creatorQueueRows(items) } });
    return { payload: { run_date: envelope.run_date, counts }, summary: { runDate: envelope.run_date, counts } };
  }));

  server.registerTool('creators.sweep_checkpoint', {
    title: 'Write an inbox sweep checkpoint',
    description: 'Write one inbox sweep as the proposed sweep checkpoint (WP-332 contract: schema_version 1, run_id, run_date, the nine counts, '
      + 'per-thread signatures with hashed bodies). Arcana computes whether it reconciled. Idempotent by run_id and content.',
    inputSchema: z.looseObject({
      schema_version: any('1'), run_id: any('The run identity'), run_date: any('YYYY-MM-DD'), brand: any('Brand or null'),
      started_at: any('ISO timestamp or null'), completed_at: any('ISO timestamp'), evidence_reference: any('Opaque reference or null'),
      counts: any('The nine sweep counts'), threads: any('Per-thread checkpoints: thread_key, creator_record_id, sender_role, amazon_timestamp, body_hash, outcome, reason'),
    }),
    annotations: WRITE,
  }, auditedCreatorWrite(context, 'creators.sweep_checkpoint', ['schema_version', 'run_id', 'run_date', 'brand', 'started_at', 'completed_at', 'evidence_reference', 'counts', 'threads'], async (args, operation) => {
    const checkpoint = parse(CreatorSweepCheckpointInput, args);
    const threads = checkpoint.threads.map((raw, index) => {
      const parsed = CreatorSweepThread.safeParse(raw);
      if (!parsed.success) throw invalid(parsed.error.issues, `threads.${index}.`);
      return parsed.data;
    });
    const counts = await writeCreatorMcpRows(operation.sql, operation.actor.orgId, { sweeps: [creatorSweepRow(checkpoint, threads)] });
    return { payload: { run_id: checkpoint.run_id, counts }, summary: { runId: checkpoint.run_id, threads: threads.length, counts } };
  }));
  server.registerTool('creators.preflight_result', {
    title: 'Record a sample pre-flight',
    description: 'Record one creator_control.py `preflight` (mcf_preflight: the eight checks for one record and ASIN) or `preflight-switch` '
      + '(product_switch_preflight: one alternate ASIN) result, with the stock read, the fulfillability preview and the time each check read '
      + 'its value. Stored per sample lane under its derived order key. Never an address or a name: recipient_binding is the runner\'s '
      + 'fingerprint. Arcana places no order and changes no lane or lock. Idempotent by run_id; a run_id reused for another result is refused.',
    inputSchema: z.looseObject({
      command: any('"preflight" or "preflight-switch"'),
      run_id: any('The run identity: letters, digits and : _ . -, at most 80'),
      started_at: any('ISO timestamp the run started'), completed_at: any('ISO timestamp the run ended'),
      result: any('The runner output: mcf_preflight {result, creator_record_id, computed_score, errors, required_next_state, quantity, visible_fee_cents, '
        + 'approved_fee_cap_cents, selected_asin, selected_sku, product_title, campaign_id, tracker_source_ref, recipient_binding} or '
        + 'product_switch_preflight {result, phase, creator_record_id, errors, required_next_state, original_asin, alternate_asin, alternate_sku}'),
      inventory: any('The product_catalog entry for the selected (or alternate) ASIN: {asin, sku, fulfillment_channel, mcf_fulfillable, '
        + 'fulfillable_quantity, inventory_checked_at, fulfillment_evidence_reference}, or null'),
      preview: any('preflight only: {operation: "getFulfillmentPreview", read_at, valid_until, is_fulfillable, fee_cents, currency, constraints}, or null').optional(),
      reads: any('preflight only: up to eight {check, read_at, evidence_reference}, one per check').optional(),
      original_unavailable_reason: any('preflight-switch only: not_mcf_fulfillable | out_of_stock | not_found, or null').optional(),
      original_blocker_evidence_reference: any('preflight-switch only: the evidence reference for the original blocker, or null').optional(),
    }),
    annotations: WRITE,
  }, auditedCreatorWrite(context, 'creators.preflight_result', ['command', 'run_id', 'started_at', 'completed_at', 'result', 'inventory', 'preview',
    'reads', 'original_unavailable_reason', 'original_blocker_evidence_reference'], async (args, operation) => {
    const input = parse(CreatorPreflightResultInput, args);
    const row = creatorPreflightRow(input);
    const { derivedOrderKeys, ...counts } = await writeCreatorPreflights(operation.sql, operation.actor.orgId, 'mcp', [row], operation.actor.userId);
    return {
      payload: { run_id: row.runId, command: row.command, result: row.result, derived_order_key: derivedOrderKeys[0] ?? null, counts },
      summary: { creatorRecordId: row.creatorRecordId, command: row.command, result: row.result, counts },
    };
  }));

  server.registerTool('creators.sample_send_outcome', {
    title: 'Read a sample send outcome',
    description: 'Read what became of the newest Arcana MCF send on one sample lane: {derivedOrderKey, state, class, escalated, mcfStatus, '
      + 'acceptedAt, placedAt, reservationId}. class is pending | placed | failed | uncertain | cancelled; record the order only on placed. '
      + 'Read-only: this key cannot place, change or cancel an Amazon order; a send happens only when an operator presses the button on '
      + 'the Arcana lane screen. No address, mask or fingerprint is returned. not_found when the lane has no Arcana send.',
    inputSchema: z.looseObject({
      derivedOrderKey: any('The lane\'s CCS- key, exactly as creators.preflight_result returned it in derived_order_key. Or give creatorRecordId and asin instead.').optional(),
      creatorRecordId: any('CCR-{BRAND}-{YY}-{NNNN}, with asin, when not giving derivedOrderKey').optional(),
      asin: any('The lane\'s 10-character ASIN, with creatorRecordId').optional(),
    }),
    annotations: READ,
  }, auditedCreatorWrite(context, 'creators.sample_send_outcome', ['derivedOrderKey', 'creatorRecordId', 'asin'], async (args, operation) => {
    const target = sendOutcomeTarget(args);
    const outcome = await readCreatorMcfSendOutcome(operation.sql, operation.actor.orgId, target);
    if (outcome === null) {
      throw new ToolError('not_found', 'This lane has no Arcana send: an operator has not sealed an address for it on the Arcana lane screen, '
        + 'or the lane is not registered for this organisation. Nothing was written.');
    }
    // Re-parsed strictly at the boundary: exactly the eight outcome fields leave this tool, never a mask, fee or fingerprint.
    const payload = CreatorMcfSendOutcome.parse(outcome);
    return { payload, summary: { state: payload.state, class: payload.class, escalated: payload.escalated } };
  }, 'read'));
}

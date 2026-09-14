/** Human review runs under RLS; narrow SQL commands own service-only DML. */
import { createHash, randomUUID } from 'node:crypto';
import { OrgRole, ORG_CAPABILITY_ROLES, Uuid } from '@wizard-ads/shared';
import { AgencyAccessDenied, type AuthenticatedEditorTransaction } from './authenticated-actor.js';
import {
  CONTEXTUAL_NEGATIVE_ACTION_LIMIT, CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT,
  ContextualNegativeReviewConflictError, ContextualNegativeReviewStateError,
  ContextualNegativeReviewValidationError, ContextualNegativeReviewLockTimeoutError,
  contextualNegativeReviewFingerprint, getContextualNegativeExport,
  serializeContextualNegativeExportCsv, serializeContextualNegativeExportJson,
  type ContextualNegativeExportProposalSnapshot, type ContextualNegativeDecisionResult,
  type ContextualNegativeExportResult, type decideContextualNegativeProposals,
  type exportAcceptedContextualNegatives,
} from './contextual-negative-review.js';

type Decision = Omit<Parameters<typeof decideContextualNegativeProposals>[1], 'orgId' | 'actorId'>;
type Export = Omit<Parameters<typeof exportAcceptedContextualNegatives>[1], 'orgId' | 'actorId'>;

async function selection(context: AuthenticatedEditorTransaction, input: Export | Decision, exporting: boolean) {
  const { sql, actor } = context;
  const [member] = await sql<{ role: string }[]>`select role::text as role from public.org_members
    where org_id=${actor.orgId} and user_id=auth.uid()`;
  const role = OrgRole.safeParse(member?.role);
  if (!role.success || !(ORG_CAPABILITY_ROLES[exporting ? 'exportBatches' : 'editTargets'] as readonly OrgRole[]).includes(role.data)) {
    throw new AgencyAccessDenied();
  }
  if (!Uuid.safeParse(input.profileId).success || !input.marketplaceId.trim()
      || input.marketplaceId.length > 128 || input.proposals.length < 1
      || input.proposals.length > CONTEXTUAL_NEGATIVE_ACTION_LIMIT
      || new Set(input.proposals.map((p) => p.id)).size !== input.proposals.length
      || input.proposals.some((p) => !Uuid.safeParse(p.id).success || !/^[0-9a-f]{64}$/.test(p.expectedFingerprint))
      || (input.note?.length ?? 0) > 4000) {
    throw new ContextualNegativeReviewValidationError('Invalid contextual-negative selection');
  }
  const ids = input.proposals.map((p) => p.id);
  await sql`set local lock_timeout = '5s'`;
  await sql`set local statement_timeout = '5s'`;
  await sql`select app.lock_query_negative_review(${actor.orgId}::uuid,${input.profileId}::uuid,
    ${input.marketplaceId},${ids}::uuid[],${exporting})`;
  const rows = await sql<Omit<ContextualNegativeExportProposalSnapshot, 'reviewFingerprint'>[]>`
    select org_id as "orgId",id,profile_id as "profileId",marketplace_id as "marketplaceId",campaign_id as "campaignId",
      ad_group_id as "adGroupId",search_term as "searchTerm",normalized_query as "normalizedQuery",category,
      source_group_role as "sourceGroupRole",match_type as "matchType",reason,status
    from public.contextual_negative_proposals where org_id=${actor.orgId} and profile_id=${input.profileId}
      and marketplace_id=${input.marketplaceId} and id=any(${ids}::uuid[]) order by id::text collate "C"`;
  const snapshots = rows.map((row) => ({ ...row, reviewFingerprint: contextualNegativeReviewFingerprint(row) }));
  const byId = new Map(snapshots.map((row) => [row.id, row]));
  const stale = input.proposals.filter((p) => byId.get(p.id)?.reviewFingerprint !== p.expectedFingerprint).map((p) => p.id);
  if (stale.length || snapshots.length !== ids.length) throw new ContextualNegativeReviewConflictError(stale);
  if (Buffer.byteLength(JSON.stringify(snapshots)) > CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT) {
    throw new ContextualNegativeReviewValidationError('Selected review evidence exceeds capacity');
  }
  const terminal = snapshots.filter((row) => exporting ? row.status !== 'accepted' : row.status === 'exported').map((row) => row.id);
  if (terminal.length) throw new ContextualNegativeReviewStateError(terminal, exporting
    ? 'Every selected contextual-negative proposal must still be accepted' : 'Exported contextual-negative proposals are terminal');
  return snapshots;
}

function mapLockError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '55P03' || code === '57014') throw new ContextualNegativeReviewLockTimeoutError();
  throw error;
}

export async function decideContextualNegativesForActor(context: AuthenticatedEditorTransaction, input: Decision): Promise<ContextualNegativeDecisionResult> {
  try {
    const before = await selection(context, input, false);
    const note = input.note?.trim() || null;
    if (!['accepted', 'dismissed', 'proposed'].includes(input.decision) || (input.decision === 'dismissed' && !note)) {
      throw new ContextualNegativeReviewValidationError('A dismissal needs a note and a valid decision');
    }
    const changed = await context.sql<{ id: string; status: Decision['decision']; updated_at: Date | string }[]>`
      select * from app.apply_query_negative_review(${context.actor.orgId}::uuid,${input.profileId}::uuid,
        ${input.marketplaceId},${JSON.stringify(before)}::text::jsonb,${input.decision},${note})`;
    const expected = before.filter((row) => row.status !== input.decision);
    if (changed.length !== expected.length || new Set(changed.map((row) => row.id)).size !== changed.length
      || changed.some((row) => !expected.some((p) => p.id === row.id) || row.status !== input.decision)) {
      throw new Error('Contextual-negative decision counts do not reconcile');
    }
    const beforeById = new Map(before.map((row) => [row.id, row]));
    return { offered: input.proposals.length, matched: before.length, updated: changed.length,
      unchanged: before.length - changed.length, amazonUpdated: false,
      changed: changed.map((row) => ({ id: row.id, status: row.status, decisionNote: note, decidedBy: context.actor.userId,
        decidedAt: new Date(row.updated_at), reviewFingerprint: contextualNegativeReviewFingerprint({ ...beforeById.get(row.id)!, status: row.status }),
      })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  } catch (error) { return mapLockError(error); }
}

export async function exportContextualNegativesForActor(context: AuthenticatedEditorTransaction, input: Export): Promise<ContextualNegativeExportResult> {
  try {
    const proposals = await selection(context, input, true);
    const note = input.note.trim();
    if (!note) throw new ContextualNegativeReviewValidationError('An export needs a note');
    const exportId = randomUUID(); const createdAt = new Date();
    const json = serializeContextualNegativeExportJson({ version: 1, exportId, orgId: context.actor.orgId,
      profileId: input.profileId, marketplaceId: input.marketplaceId, note, createdAt: createdAt.toISOString(),
      rowCount: proposals.length, amazonUpdated: false, proposals });
    const csv = serializeContextualNegativeExportCsv(proposals);
    const changed = await context.sql<{ id: string; status: string }[]>`select * from app.apply_query_negative_review(
      ${context.actor.orgId}::uuid,${input.profileId}::uuid,${input.marketplaceId},${JSON.stringify(proposals)}::text::jsonb,
      'exported',${note},${exportId}::uuid,${createdAt.toISOString()}::timestamptz,${json},${csv})`;
    if (changed.length !== proposals.length || new Set(changed.map((row) => row.id)).size !== proposals.length
      || changed.some((row) => row.status !== 'exported' || !proposals.some((p) => p.id === row.id))) {
      throw new Error('Contextual-negative export counts do not reconcile');
    }
    const storedJson = await getContextualNegativeExport(context, { orgId: context.actor.orgId, exportId, format: 'json' });
    const storedCsv = await getContextualNegativeExport(context, { orgId: context.actor.orgId, exportId, format: 'csv' });
    if (!storedJson?.bytes.equals(json) || !storedCsv?.bytes.equals(csv)
      || storedJson.rowCount !== proposals.length || storedCsv.rowCount !== proposals.length) throw new Error('Export readback does not reconcile');
    return { exportId, offered: input.proposals.length, matched: proposals.length, accepted: proposals.length,
      stamped: changed.length, storedJsonRows: storedJson.rowCount, rowCount: proposals.length,
      jsonSha256: createHash('sha256').update(json).digest('hex'), csvSha256: createHash('sha256').update(csv).digest('hex'),
      exportedIds: proposals.map((p) => p.id), createdAt, amazonUpdated: false };
  } catch (error) { return mapLockError(error); }
}

/**
 * Creator Connections round 2: one record, one conflict, the day's reply
 * drafts, and the inputs a `creator:write` MCP key may submit.
 *
 * A reply draft is text the operator sends by hand in Amazon's Creator
 * Connections inbox. Approving one records a decision; Arcana sends nothing,
 * and nothing here is an Amazon write. Fingerprints only: a submission that
 * carries an email address, a phone number, a street address or a link is
 * refused before anything is stored.
 */
import { z } from 'zod';
import {
  CreatorAsin, CreatorFingerprint, CreatorQualificationCheck, CreatorRecordId, CreatorReservationId, CreatorRunnerQueueResult,
  CreatorRunnerRegistryRecord, CreatorRunnerResolution, CreatorRunnerScoreResult, CreatorSweepCheckpoint, CreatorIdentityMatchMethod,
  CreatorLockState,
} from './runner.js';
import {
  CreatorActionKind, CreatorActionSource, CreatorDailyQueueItem, CreatorImportRun, CreatorRecord, CreatorSampleShipment, CreatorSource,
} from './model.js';

const Timestamp = z.iso.datetime({ offset: true });
const Code = z.string().regex(/^[a-z0-9_]+$/).max(120);

/** A person's name in a template. Arcana keeps it unrendered; the operator fills it in when sending by hand. */
export const CREATOR_FIRST_NAME_PLACEHOLDER = '{first name}';
export const CREATOR_RECIPIENT_NAME_PLACEHOLDER = '{recipient name}';
const FIRST = [CREATOR_FIRST_NAME_PLACEHOLDER] as const;

/**
 * The eleven reply templates in the `amazon-creator-connections` skill
 * (`references/reply-playbook.md`), by key and heading, with the name
 * placeholders each carries. Bodies stay in the skill; Arcana stores the text
 * the skill rendered from one of these, with every name placeholder left as it
 * is, so no creator's name is stored.
 */
export const CREATOR_REPLY_TEMPLATES = [
  { key: 'first_base_verification', name: 'First-base verification after background check', names: FIRST },
  { key: 'asin_product_confirmation', name: 'ASIN/product confirmation', names: FIRST },
  { key: 'proof_request', name: 'Proof request only when background check is incomplete', names: FIRST },
  { key: 'product_switch_clarification', name: 'Product switch clarification', names: FIRST },
  { key: 'exact_asin_unavailable_for_mcf', name: 'Exact ASIN unavailable for MCF', names: FIRST },
  { key: 'recipient_mismatch_clarification', name: 'Recipient mismatch clarification',
    names: [CREATOR_FIRST_NAME_PLACEHOLDER, CREATOR_RECIPIENT_NAME_PLACEHOLDER] },
  { key: 'sample_confirmation', name: 'Sample confirmation', names: FIRST },
  { key: 'awaiting_content_follow_up', name: 'Awaiting content follow-up', names: FIRST },
  { key: 'content_posted_thank_you', name: 'Content posted thank-you', names: FIRST },
  { key: 'performance_update_thank_you', name: 'Creator performance update thank-you', names: FIRST },
  { key: 'paused_product', name: 'Paused product', names: FIRST },
] as const;
export const CreatorReplyTemplateKey = z.enum(CREATOR_REPLY_TEMPLATES.map((template) => template.key) as
  [typeof CREATOR_REPLY_TEMPLATES[number]['key'], ...typeof CREATOR_REPLY_TEMPLATES[number]['key'][]]);
export type CreatorReplyTemplateKey = z.infer<typeof CreatorReplyTemplateKey>;
export function creatorReplyTemplateName(key: CreatorReplyTemplateKey): string {
  return CREATOR_REPLY_TEMPLATES.find((template) => template.key === key)!.name;
}
/** The name placeholders a body from this template must still carry, unrendered. */
export function creatorTemplateNamePlaceholders(key: CreatorReplyTemplateKey): readonly string[] {
  return CREATOR_REPLY_TEMPLATES.find((template) => template.key === key)!.names;
}

/**
 * The tracker's status dropdown (`references/tracker-schema.md`). The vocabulary
 * is closed: a label outside it is shown as unrecognised, never as a new stage.
 * `<Product> Pause` is the one pattern, one label per paused product.
 */
export const CREATOR_TRACKER_STATUSES = [
  'New Inquiry', 'First-Base Pass', 'Verification Sent', 'Verification Confirmed', 'Proof Requested', 'Address Verification',
  'Approved for Sample', 'Sample Sent', 'Delivered / Awaiting Content', 'Content Posted', 'Performance Update', 'Follow Up',
  'Manager Review', 'Product Switch Pending', 'On Hold', 'Unqualified', 'Ghosted', 'Declined / Closed',
] as const;
export function isRecognisedCreatorStatus(label: string): boolean {
  const value = label.trim();
  return (CREATOR_TRACKER_STATUSES as readonly string[]).includes(value) || /^\S.* Pause$/.test(value);
}

// ---------------------------------------------------------------------------
// Raw contact data is refused by shape, wherever it appears in a submission.
// ---------------------------------------------------------------------------

export type CreatorContactShape = 'email' | 'phone' | 'address' | 'link';
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;
/** A scheme, a `www.` host, or a bare domain followed by a path (`amazon.de/shop/...`). */
const LINK = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s]+/i;
/** A digit run with separators, not inside an identifier, so hex fingerprints, ids and run keys never match. */
const PHONE_RUN = /(?<![\w+\-/])(?:\+|\(|00)?\d[\d\s().\-/]{5,}\d(?!\w)/g;
/**
 * Dates and clock times are removed before the phone scan: they are digit runs,
 * not numbers to call. ISO dates and timestamps, `dd.mm.yyyy`, and `hh:mm`.
 */
const DATE_OR_TIME = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\b\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
/** A number, one to three capitalised name words, and a capitalised street type: `12 Synthetic Street`. */
const STREET_NUMBER_FIRST = /\b\d{1,5}[a-z]?\s+(?:[A-ZÀ-Ý][\p{L}.'-]*\s+){1,3}(?:Street|Road|Avenue|Lane|Drive|Boulevard|Blvd|Rd|Ave|Ln|St)\b/u;
/** A street name ending in a German street suffix, then a house number: `Beispielstraße 7`, not `Platz 1`. */
const STREET_NAME_FIRST = /\b\p{L}[\p{L}-]*(?:straße|strasse|str\.|weg|platz|allee|gasse)\s+\d{1,4}[a-z]?\b/iu;
/** A postcode and a town where an address puts them: at the start of a line or after a comma. */
const POSTCODE_CITY = /(?:^|\n|,)\s*(?:D-)?\d{5}\s+[A-ZÄÖÜ][a-zäöüß]{2,}\b/;
const PO_BOX = /\b(?:p\.?\s?o\.?\s+box|postfach)\s+\d+/i;

function phoneShaped(text: string): boolean {
  for (const match of text.replace(DATE_OR_TIME, ' ').matchAll(PHONE_RUN)) {
    const run = match[0].trim();
    const digits = run.replace(/\D/g, '').length;
    if (digits < 7 || digits > 15) continue;
    // A leading +, ( or 0 is how a number to call is written; otherwise it needs
    // separators and ten digits, so a bare counter or epoch is not a phone.
    if (/^[+(0]/.test(run) || (/[\s().\-/]/.test(run) && digits >= 10)) return true;
  }
  return false;
}

/** The contact shapes a text carries. Empty means none was found. */
export function creatorContactShapes(text: string): CreatorContactShape[] {
  const found: CreatorContactShape[] = [];
  if (EMAIL.test(text)) found.push('email');
  if (phoneShaped(text)) found.push('phone');
  if (STREET_NUMBER_FIRST.test(text) || STREET_NAME_FIRST.test(text) || POSTCODE_CITY.test(text) || PO_BOX.test(text)) found.push('address');
  if (LINK.test(text)) found.push('link');
  return found;
}

/** A key named for contact data. Fingerprint keys (`email_fp`, `storefront_key`, `recipient_binding`) are not. */
const CONTACT_KEY = /e-?mail|phone|telephone|mobile|\btel\b|address|street|postal|postcode|\bzip\b|\bcity\b|full_?name|first_?name|last_?name|recipient_?name|display_?name|\burl\b|link|website|handle/i;
const FINGERPRINT_KEY = /_(?:fp|key|binding|hash)$/;
/** Keys are echoed in a refusal only when they look like identifiers; anything else is named by position. */
const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Every string and every object key in a value, walked with its path, checked
 * for contact shapes. A key named like contact data, or a key that is contact
 * data, is refused, so `{ "email_address": ... }` or a key holding an address
 * cannot slip through a permissive schema. Returns where and what, never the
 * value: a key that is not an identifier appears as `[key n]`.
 */
export function findCreatorContactData(value: unknown): { path: string; shape: CreatorContactShape | 'contact_key' }[] {
  const hits: { path: string; shape: CreatorContactShape | 'contact_key' }[] = [];
  const walk = (item: unknown, path: string) => {
    if (typeof item === 'string') {
      for (const shape of creatorContactShapes(item)) hits.push({ path, shape });
    } else if (Array.isArray(item)) {
      item.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    } else if (item !== null && typeof item === 'object') {
      Object.entries(item as Record<string, unknown>).forEach(([key, entry], index) => {
        const segment = SAFE_KEY.test(key) ? key : `[key ${index}]`;
        const next = path === '' ? segment : `${path}.${segment}`;
        const shapes = creatorContactShapes(key);
        for (const shape of shapes) hits.push({ path: next, shape });
        if (shapes.length === 0 && CONTACT_KEY.test(key) && !FINGERPRINT_KEY.test(key)) hits.push({ path: next, shape: 'contact_key' });
        walk(entry, next);
      });
    }
  };
  walk(value, '');
  return hits;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** draft → approved | withdrawn; approved → sent_by_hand | withdrawn. The last two are final. */
export const CreatorDraftStatus = z.enum(['draft', 'approved', 'sent_by_hand', 'withdrawn']);
export type CreatorDraftStatus = z.infer<typeof CreatorDraftStatus>;
export const CREATOR_DRAFT_TRANSITIONS: Record<CreatorDraftStatus, readonly CreatorDraftStatus[]> = {
  draft: ['approved', 'withdrawn'], approved: ['sent_by_hand', 'withdrawn'], sent_by_hand: [], withdrawn: [],
};
export const CREATOR_DRAFT_BODY_MAX = 4000;
const DraftBody = z.string().min(1).max(CREATOR_DRAFT_BODY_MAX).refine((body) => body.trim().length > 0, 'the draft is blank');

export const CreatorDraft = z.object({
  id: z.uuid(),
  creatorRecordId: CreatorRecordId,
  threadKey: CreatorFingerprint,
  templateKey: CreatorReplyTemplateKey,
  body: DraftBody,
  /** The skill's run date: the day the draft answers. */
  draftDate: z.iso.date(),
  status: CreatorDraftStatus,
  createdBy: z.uuid().nullable(),
  createdAt: Timestamp,
  approvedBy: z.uuid().nullable(),
  approvedAt: Timestamp.nullable(),
  /** Who marked it sent by hand or withdrew it, and when. */
  closedBy: z.uuid().nullable(),
  closedAt: Timestamp.nullable(),
  source: CreatorSource,
}).strict().superRefine((draft, context) => {
  // A withdrawn draft may or may not have been approved first.
  const approved = draft.status === 'approved' || draft.status === 'sent_by_hand';
  if ((approved && draft.approvedAt === null) || (draft.status === 'draft' && draft.approvedAt !== null)
    || ((draft.approvedAt === null) !== (draft.approvedBy === null))) {
    context.addIssue({ code: 'custom', path: ['approvedAt'], message: 'approval disagrees with status' });
  }
  const closed = draft.status === 'sent_by_hand' || draft.status === 'withdrawn';
  if (closed !== (draft.closedAt !== null)) context.addIssue({ code: 'custom', path: ['closedAt'], message: 'closing time disagrees with status' });
});
export type CreatorDraft = z.infer<typeof CreatorDraft>;

/** One draft as the drafts screen lists it: the record's lock and the queue row it answers. */
export const CreatorDraftRow = z.object({
  draft: CreatorDraft,
  lockState: CreatorLockState,
  /** The action the newest queue run gave the record on the draft's day; null when it named none. */
  queueAction: CreatorDailyQueueItem.shape.actionType.nullable(),
}).strict();
export type CreatorDraftRow = z.infer<typeof CreatorDraftRow>;

/** `/creators/drafts`: the newest draft day and every draft on it, one row per thread. */
export const CreatorDraftsSnapshot = z.object({
  lastImport: CreatorImportRun.nullable(),
  /** Null until any draft was submitted. */
  draftDate: z.iso.date().nullable(),
  rows: z.array(CreatorDraftRow),
  /** Drafts ever submitted for this organisation, so an empty day is not "never". */
  submittedEver: z.number().int().nonnegative(),
}).strict();
export type CreatorDraftsSnapshot = z.infer<typeof CreatorDraftsSnapshot>;

// ---------------------------------------------------------------------------
// One record, and one conflict
// ---------------------------------------------------------------------------

/** Which fingerprints two records share. */
export const CreatorFingerprintClass = z.enum(['storefront', 'thread', 'fullName', 'email', 'phone', 'address']);
export type CreatorFingerprintClass = z.infer<typeof CreatorFingerprintClass>;
/** The rung, or `new` for a record `issue_record_id` created. */
export const CreatorIdentityRung = z.union([CreatorIdentityMatchMethod, z.literal('new')]);
export type CreatorIdentityRung = z.infer<typeof CreatorIdentityRung>;

/** One action-log row as the record page lists it. */
export const CreatorRecordEvent = z.object({
  eventKey: z.string().min(1),
  action: CreatorActionKind,
  occurredAt: Timestamp.nullable(),
  recordedAt: Timestamp,
  reservationId: CreatorReservationId.nullable(),
  asin: CreatorAsin.nullable(),
  reasonCode: Code.nullable(),
  evidenceReference: z.string().nullable(),
  recordVersion: z.number().int().positive().nullable(),
  relatedRecordIds: z.array(CreatorRecordId),
  draftId: z.uuid().nullable(),
  actorUserId: z.uuid().nullable(),
  /** An action-log row, so the MCF worker may have written it. */
  source: CreatorActionSource,
}).strict();
export type CreatorRecordEvent = z.infer<typeof CreatorRecordEvent>;

/**
 * A record that shares a fingerprint with this one but that the runner's rules
 * would not match: a thread fingerprint on another campaign, or one contact
 * fingerprint where `resolve_record` needs two.
 */
export const CreatorRefusedCandidate = z.object({
  creatorRecordId: CreatorRecordId,
  lockState: CreatorLockState,
  shared: z.array(CreatorFingerprintClass).min(1),
  rule: z.enum(['thread_on_other_campaign', 'one_contact_fingerprint']),
}).strict();
export type CreatorRefusedCandidate = z.infer<typeof CreatorRefusedCandidate>;

export const CreatorIdentityDecision = z.object({
  rung: CreatorIdentityRung, recordedAt: Timestamp, source: CreatorSource,
}).strict();
export type CreatorIdentityDecision = z.infer<typeof CreatorIdentityDecision>;

/** `/creators/records/[id]`. */
export const CreatorRecordDetail = z.object({
  lastImport: CreatorImportRun.nullable(),
  record: CreatorRecord,
  /** The tracker's typed score, when `creators.record_score` reported one. */
  trackerScore: z.object({ score: z.number().int().min(0).max(10), scoredOn: z.iso.date() }).strict().nullable(),
  /** The newest identity decision a `creator:write` key registered; the import does not know the rung. */
  identity: CreatorIdentityDecision.nullable(),
  refusedCandidates: z.array(CreatorRefusedCandidate),
  /** Records sharing a storefront, thread or two contact fingerprints: what a Conflict lock is about. */
  matching: z.array(z.object({ creatorRecordId: CreatorRecordId, lockState: CreatorLockState, shared: z.array(CreatorFingerprintClass).min(1) }).strict()),
  /** The newest queue run's row for this record, when it named it. */
  queueItem: CreatorDailyQueueItem.nullable(),
  events: z.array(CreatorRecordEvent),
  shipments: z.array(CreatorSampleShipment),
  drafts: z.array(CreatorDraft),
}).strict();
export type CreatorRecordDetail = z.infer<typeof CreatorRecordDetail>;

/** `/creators/conflicts/[id]`: a record locked in Conflict and every record it collides with. Nothing here may act. */
export const CreatorConflictDetail = z.object({
  lastImport: CreatorImportRun.nullable(),
  record: CreatorRecord,
  /** `lock_conflicting_records` stamps `last_verified_at` when it locks; null when the runner kept no date. */
  lockedSince: z.iso.date().nullable(),
  counterparts: z.array(z.object({
    record: CreatorRecord,
    /** Fingerprint classes the two records share; empty when only the resolution named it. */
    shared: z.array(CreatorFingerprintClass),
    /** Whether a registered conflict named this record among its matches. */
    namedByResolution: z.boolean(),
  }).strict()),
  /** Identity events on the record and its counterparts, newest first. */
  events: z.array(CreatorRecordEvent.extend({ creatorRecordId: CreatorRecordId }).strict()),
}).strict();
export type CreatorConflictDetail = z.infer<typeof CreatorConflictDetail>;

// ---------------------------------------------------------------------------
// `creator:write` MCP tool inputs. Snake_case: they carry the runner's shapes.
// ---------------------------------------------------------------------------

/** `creators.register_record`: the registry row after `register`, and the resolution it acted on. */
export const CreatorRegisterRecordInput = z.object({
  record: CreatorRunnerRegistryRecord,
  resolution: CreatorRunnerResolution,
}).strict().superRefine((input, context) => {
  const id = input.record.creator_record_id;
  const resolution = input.resolution;
  if (resolution.result === 'HOLD') {
    context.addIssue({ code: 'custom', path: ['resolution', 'result'], message: 'a held resolution registers nothing' });
  } else if (resolution.result === 'RESOLVED' && resolution.creator_record_id !== id) {
    context.addIssue({ code: 'custom', path: ['resolution', 'creator_record_id'], message: 'the resolution names another record' });
  } else if (resolution.result === 'CONFLICT' && (!resolution.matches.includes(id) || input.record.lock_state !== 'Conflict')) {
    context.addIssue({ code: 'custom', path: ['resolution', 'matches'], message: 'a conflict names this record, and locks it in Conflict' });
  } else if (resolution.result === 'NEW') {
    const f = resolution.fingerprints;
    const r = input.record;
    if (f.thread_key !== r.thread_key || f.storefront_key !== r.storefront_key || f.full_name_fp !== r.full_name_fp
      || f.email_fp !== r.email_fp || f.phone_fp !== r.phone_fp || f.address_fp !== r.address_fp) {
      context.addIssue({ code: 'custom', path: ['resolution', 'fingerprints'], message: 'a new record carries the fingerprints it was issued with' });
    }
  }
});
export type CreatorRegisterRecordInput = z.infer<typeof CreatorRegisterRecordInput>;

/** `creators.record_score`: the runner's `score` output for one record, with the status and the tracker's typed score beside it. */
export const CreatorRecordScoreInput = z.object({
  creator_record_id: CreatorRecordId,
  scored_on: z.iso.date(),
  current_status: z.string().trim().min(1).max(120),
  /** Column 36, Total Qualification Score, as typed on the tracker; null when blank. */
  tracker_score: z.number().int().min(0).max(10).nullable(),
  result: CreatorRunnerScoreResult,
}).strict();
export type CreatorRecordScoreInput = z.infer<typeof CreatorRecordScoreInput>;

/** The entries a skill appends by itself. Registry history and drafts write their own kinds. */
export const CreatorAppendableAction = z.enum(['message_sent_by_hand', 'status_moved', 'content_verified', 'escalated', 'preflight_recorded']);
export type CreatorAppendableAction = z.infer<typeof CreatorAppendableAction>;
export const CreatorAppendActionEntry = z.object({
  /** The idempotency identity: the same key twice is one entry. */
  event_key: z.string().regex(/^[A-Za-z0-9:_.-]{1,160}$/),
  creator_record_id: CreatorRecordId,
  action: CreatorAppendableAction,
  occurred_at: z.iso.datetime({ offset: true }),
  reservation_id: CreatorReservationId.nullable().optional(),
  asin: CreatorAsin.nullable().optional(),
  reason_code: Code.nullable().optional(),
  evidence_reference: z.string().trim().min(1).max(500).nullable().optional(),
}).strict();
export type CreatorAppendActionEntry = z.infer<typeof CreatorAppendActionEntry>;
export const CreatorAppendActionInput = z.object({
  entries: z.array(CreatorAppendActionEntry).min(1).max(200)
    .refine((entries) => new Set(entries.map((entry) => entry.event_key)).size === entries.length, 'an event key repeats'),
}).strict();
export type CreatorAppendActionInput = z.infer<typeof CreatorAppendActionInput>;

/**
 * `creators.submit_draft`: one reply for one thread, rendered from its template
 * except for the name placeholders, which stay as written (`{first name}`).
 * Returns the draft id.
 */
export const CreatorSubmitDraftInput = z.object({
  creator_record_id: CreatorRecordId,
  thread_key: CreatorFingerprint,
  template_key: CreatorReplyTemplateKey,
  draft_date: z.iso.date(),
  body: DraftBody,
}).strict().superRefine((input, context) => {
  for (const placeholder of creatorTemplateNamePlaceholders(input.template_key)) {
    if (!input.body.includes(placeholder)) {
      context.addIssue({ code: 'custom', path: ['body'], message: `leave ${placeholder} unrendered: Arcana stores no names` });
    }
  }
});
export type CreatorSubmitDraftInput = z.infer<typeof CreatorSubmitDraftInput>;

/** `creators.queue_snapshot`: the `queue` command's whole output. Every item must validate. */
export const CreatorQueueSnapshotInput = CreatorRunnerQueueResult;
/** `creators.sweep_checkpoint`: the proposed sweep checkpoint (WP-332). Every thread must validate. */
export const CreatorSweepCheckpointInput = CreatorSweepCheckpoint;

/**
 * What a write tool reports: the rows it was given and what each became.
 * Replays report unchanged; `skipped` is rows left untouched on purpose, and a
 * count object from before it existed skipped none.
 */
export const CreatorWriteCounts = z.object({
  read: z.number().int().nonnegative(), inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative(), skipped: z.number().int().nonnegative().default(0),
}).strict().refine((counts) => counts.read === counts.inserted + counts.updated + counts.unchanged + counts.skipped, 'write counts do not reconcile');
export type CreatorWriteCounts = z.infer<typeof CreatorWriteCounts>;

/** Re-exported check list so the screens can show all ten in the runner's order. */
export const CREATOR_QUALIFICATION_CHECKS = CreatorQualificationCheck.options;

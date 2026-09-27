/**
 * Frame 445:522 from CREATOR-FIXTURE.json: the day's drafts match the queue's
 * eleven SEND_TAILORED_VERIFICATION_FOLLOW_UP rows, three of them approved.
 * One thread also carries an earlier draft that was withdrawn when the skill
 * resubmitted it. 0203 was locked in Conflict after its draft was submitted,
 * so its approval is disabled. Thread fingerprints are SHA-256 over synthetic
 * labels; the reply bodies are synthetic placeholders.
 */
import type { CreatorDraft, CreatorDraftRow, CreatorDraftsSnapshot } from '@wizard-ads/shared';
import { AS_OF, failedImport, items, lastImport } from '../creators-daily-queue/render-fixture';
import { fingerprint } from '../creators-record/render-fixture';
import type { ScreenData } from './view';

export const ADMIN = '10000000-0000-4000-8000-000000000001';
export const OTHER_ADMIN = '10000000-0000-4000-8000-000000000005';
const verification = items.filter((item) => item.actionType === 'SEND_TAILORED_VERIFICATION_FOLLOW_UP');
const uuid = (index: number) => `33300000-0000-4000-8000-${String(index).padStart(12, '0')}`;

function draft(index: number, id: string, change: Partial<CreatorDraft> = {}): CreatorDraft {
  return {
    id: uuid(index), creatorRecordId: id, threadKey: fingerprint(`thread-${id}`), templateKey: 'first_base_verification',
    body: `Hi {first name}, synthetic verification follow-up ${index}.\nSecond line of the synthetic reply.`, draftDate: AS_OF.date, status: 'draft',
    createdBy: ADMIN, createdAt: '2026-09-09T06:50:00.000Z', approvedBy: null, approvedAt: null, closedBy: null, closedAt: null, source: 'mcp',
    ...change,
  };
}
const approved = (by: string): Partial<CreatorDraft> => ({ status: 'approved', approvedBy: by, approvedAt: '2026-09-09T07:05:00.000Z' });

const drafts: CreatorDraft[] = verification.map((item, index) => {
  const id = item.creatorRecordId!;
  if (index === 1) return draft(index + 1, id, approved(ADMIN));
  if (index === 2) return draft(index + 1, id, approved(ADMIN));
  if (index === 3) return draft(index + 1, id, approved(OTHER_ADMIN));
  return draft(index + 1, id);
});
/** The earlier draft on thread 2, withdrawn when the skill resubmitted it. */
const withdrawn = draft(99, verification[1]!.creatorRecordId!, { status: 'withdrawn', createdAt: '2026-09-09T06:45:00.000Z',
  templateKey: 'proof_request', closedBy: ADMIN, closedAt: '2026-09-09T06:50:00.000Z' });

/** Ordered as the read orders them: by thread, then submission time. */
export const rows: CreatorDraftRow[] = [...drafts, withdrawn].map((item) => ({
  draft: item, lockState: verification.find((queue) => queue.creatorRecordId === item.creatorRecordId)!.lockState ?? 'Unlocked',
  queueAction: 'SEND_TAILORED_VERIFICATION_FOLLOW_UP' as const,
})).sort((left, right) => left.draft.threadKey.localeCompare(right.draft.threadKey) || left.draft.createdAt.localeCompare(right.draft.createdAt));

export const snapshot: CreatorDraftsSnapshot = { lastImport, draftDate: AS_OF.date, rows, submittedEver: 12 };
export const ready = { view: 'ready', props: { snapshot, canDecide: true, viewerId: ADMIN } } satisfies ScreenData;
export const analyst = { view: 'ready', props: { snapshot, canDecide: false, viewerId: '10000000-0000-4000-8000-000000000002' } } satisfies ScreenData;
export const refused = { view: 'ready', props: { snapshot: { ...snapshot, lastImport: failedImport }, canDecide: true, viewerId: ADMIN } } satisfies ScreenData;
export const notMeasured = { view: 'ready', props: { snapshot: { lastImport, draftDate: null, rows: [], submittedEver: 0 }, canDecide: true,
  viewerId: ADMIN } } satisfies ScreenData;
export const empty = { view: 'ready', props: { snapshot: { lastImport, draftDate: AS_OF.date, rows: [], submittedEver: 12 }, canDecide: true,
  viewerId: ADMIN } } satisfies ScreenData;

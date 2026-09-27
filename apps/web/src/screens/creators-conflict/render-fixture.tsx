/**
 * Frame 445:298 from CREATOR-FIXTURE.json: 0117 and 0203 share one storefront
 * and are both locked in Conflict, 0117 since 31 Aug 2026. Fingerprints are
 * SHA-256 over synthetic labels; the events are synthetic.
 */
import type { CreatorConflictDetail, CreatorRecord } from '@wizard-ads/shared';
import { failedImport, lastImport } from '../creators-daily-queue/render-fixture';
import { fingerprint, record as base } from '../creators-record/render-fixture';
import type { ScreenData } from './view';

const storefront = fingerprint('storefront-shared-0117-0203');
export const record: CreatorRecord = {
  ...base, creatorRecordId: 'CCR-SW-26-0117', lockState: 'Conflict', status: 'New Inquiry', qualification: null, qualifiedOn: null,
  createdOn: '2026-08-20', lastVerifiedOn: '2026-08-31', escalationReason: 'identity_conflict',
  fingerprints: { storefront, thread: fingerprint('thread-0117'), fullName: null, email: fingerprint('email-0117'), phone: null, address: null },
};
export const other: CreatorRecord = {
  ...base, creatorRecordId: 'CCR-SW-26-0203', lockState: 'Conflict', status: 'First-Base Pass', qualification: null, qualifiedOn: null,
  createdOn: '2026-09-01', lastVerifiedOn: '2026-09-04', escalationReason: 'identity_conflict',
  fingerprints: { storefront, thread: fingerprint('thread-0203'), fullName: fingerprint('name-0203'), email: null, phone: null, address: null },
};
const lockEvent = (id: string, related: string, occurredAt: string | null) => ({
  creatorRecordId: id, eventKey: `registry:${id}:conflict`, action: 'identity_conflict_locked' as const, occurredAt,
  recordedAt: '2026-09-04T06:14:00.000Z', reservationId: null, asin: null, reasonCode: 'identity_conflict', evidenceReference: null, recordVersion: 2,
  relatedRecordIds: [related], draftId: null, actorUserId: null, source: 'control-runner' as const,
});
export const detail: CreatorConflictDetail = {
  lastImport, record, lockedSince: '2026-08-31',
  counterparts: [{ record: other, shared: ['storefront'], namedByResolution: true }],
  events: [lockEvent('CCR-SW-26-0203', 'CCR-SW-26-0117', '2026-09-04T06:14:00.000Z'), lockEvent('CCR-SW-26-0117', 'CCR-SW-26-0203', null)],
};

export const ready = { view: 'ready', props: { detail } } satisfies ScreenData;
export const refused = { view: 'ready', props: { detail: { ...detail, lastImport: failedImport } } } satisfies ScreenData;
/** The runner kept no date when it locked: locked since is not measured, not today. */
export const lockedSinceUnknown = { view: 'ready', props: { detail: { ...detail, lockedSince: null } } } satisfies ScreenData;
/** A record whose lock was released: nothing to show here. */
export const notInConflict = { view: 'ready', props: { detail: { ...detail, record: { ...record, lockState: 'Unlocked' }, lockedSince: null,
  counterparts: [], events: [] } } } satisfies ScreenData;
/** A counterpart only the resolution named: it shares no fingerprint class with this record. */
export const namedOnly = { view: 'ready', props: { detail: { ...detail, counterparts: [{ record: { ...other, fingerprints: { ...other.fingerprints,
  storefront: fingerprint('storefront-0203') } }, shared: [], namedByResolution: true }] } } } satisfies ScreenData;
export const missing = { view: 'missing', props: { id: 'CCR-SW-26-0999' } } satisfies ScreenData;

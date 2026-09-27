/** Frame 443:2 from CREATOR-FIXTURE.json: the nine counts; the seven unmatched threads carry synthetic fingerprints. */
import type { CreatorSweepRun } from '@wizard-ads/shared';
import { failedImport, lastImport, sweep } from '../creators-daily-queue/render-fixture';
import type { ScreenData } from './view';

const hex = (seed: number) => Array.from({ length: 64 }, (_, index) => ((seed * 7 + index * 13) % 16).toString(16)).join('');
export const latest: CreatorSweepRun = {
  ...sweep,
  outcomes: { unchanged: 359, actioned: 37, held: 6, escalated: 3, unmatched: 7, unopened: 0, unclassified: 0 },
  unresolved: Array.from({ length: 7 }, (_, index) => ({ threadKey: hex(index + 1), amazonTimestamp: `2026-09-0${index < 4 ? 8 : 9}T0${index}:15:00.000Z`,
    outcome: 'unmatched' as const, reason: index < 2 ? 'multiple_active_records_match' : 'new_record_requires_thread_key_and_campaign_id' })),
};
export const previous: CreatorSweepRun = { ...sweep, runId: 'sweep-20260908-0610', runDate: '2026-09-08', completedAt: '2026-09-08T06:10:00.000Z',
  counts: { ...sweep.counts, mounted: 405, opened: 405, changed: 31, noActionAcknowledgements: 366, heldOrEscalated: 8, unmatched: 0 }, reconciled: true };
export const ready = { view: 'ready', props: { snapshot: { lastImport, latest, previous } } } satisfies ScreenData;
export const refused = { view: 'ready', props: { snapshot: { lastImport: failedImport, latest, previous } } } satisfies ScreenData;
export const notImported = { view: 'ready', props: { snapshot: { lastImport: null, latest: null, previous: null } } } satisfies ScreenData;
/** The import found a sweep file in a shape nothing produces yet and skipped it. */
export const notProduced = { view: 'ready', props: { snapshot: { latest, previous, lastImport: { ...lastImport, counts: { ...lastImport.counts,
  sweep_runs: { read: 1, valid: 0, invalid: 1, inserted: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 } } } } } } satisfies ScreenData;
/** The import read no sweep file at all. */
export const noSweepFile = { view: 'ready', props: { snapshot: { latest, previous, lastImport: { ...lastImport, files: ['registry', 'queue'],
  counts: { ...lastImport.counts, sweep_runs: null } } } } } satisfies ScreenData;

import { TimeMachineInstant } from '@wizard-ads/shared/time-machine-writes';
import type { RestorePreviewInput, RestorePreviewRow } from '@wizard-ads/shared';
import { COORDINATED_RESTORE_UNAVAILABLE } from '@wizard-ads/shared';

/** An exact sync link is evidence; equal values alone never establish ownership. */
export function classifyRestoreRow({ row, exportedAt }: RestorePreviewInput): RestorePreviewRow {
  let state: RestorePreviewRow['state'];
  let why: string;
  const read = TimeMachineInstant.safeParse(row.currentSyncedAt);
  const exported = TimeMachineInstant.safeParse(exportedAt);
  if (row.state === 'unsupported') {
    state = 'unsupported'; why = row.reason === COORDINATED_RESTORE_UNAVAILABLE
      ? COORDINATED_RESTORE_UNAVAILABLE : 'No adapter for this field';
  } else if (!read.success || !exported.success || read.data < exported.data) {
    state = 'awaiting sync'; why = 'Not read back from Amazon yet';
  } else if (row.state === 'ambiguous') {
    state = 'ambiguous'; why = 'The observed change cannot be attributed uniquely';
  } else if (row.currentValue !== null && Object.is(row.currentValue, row.originalValue)) {
    state = 'already restored'; why = 'Already back at the old value';
  } else if (row.state === 'ready' && row.synchronizedAt !== null && row.currentValue !== null
    && Object.is(row.currentValue, row.exportedValue)) {
    state = 'ready'; why = 'Untouched since we set it';
  } else if (row.state === 'awaiting_sync') {
    state = 'awaiting sync'; why = 'Not read back from Amazon yet';
  } else {
    state = 'conflict'; why = row.field === 'budget' && typeof row.currentValue === 'number'
      && typeof row.exportedValue === 'number' && row.currentValue > row.exportedValue
      ? 'Budget raised at Amazon' : 'Someone changed it after us';
  }
  return { rowId: row.rowId, entityId: row.entityId, entityType: row.entityType,
    entity: row.entityName ?? row.entityId, field: row.field, weSet: row.exportedValue,
    now: state === 'awaiting sync' ? null : row.currentValue, restoreTo: row.originalValue,
    state, why, readAt: row.currentSyncedAt };
}

export function restoreCounts(rows: readonly RestorePreviewRow[]) {
  const ready = rows.filter((row) => row.state === 'ready').length;
  const nothingToDo = rows.filter((row) => row.state === 'already restored').length;
  return { total: rows.length, ready, blocked: rows.length - ready - nothingToDo, nothingToDo };
}

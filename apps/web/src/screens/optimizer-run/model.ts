import type { ExecutionVerdict, ObjectiveVerdict } from '@wizard-ads/shared';
import type { OptimizerOperationRow, SpWriteOperationDetail } from '@wizard-ads/shared/sp-write-application';

export type OperationResultRow = Pick<OptimizerOperationRow,
  'actionId' | 'name' | 'before' | 'requested' | 'observed' | 'status'>
  & { applyRowIds: Readonly<OptimizerOperationRow['applyRowIds']> }
  & Partial<Pick<OptimizerOperationRow, 'reason' | 'retryEligible' | 'retryReason'>>;

export function operationCounts(detail: SpWriteOperationDetail) {
  const counts = detail.snapshot.accounting;
  return {
    requested: counts.approvedRows,
    admitted: counts.approvedRows,
    attempted: counts.intentCommitted,
    succeeded: counts.providerAccepted,
    failed: counts.providerRejected,
    refused: counts.refusedBeforeDispatch,
    observed: counts.observedRequested,
    pending: counts.pendingDispatch,
    ambiguous: counts.providerAmbiguous,
  };
}

export function operationHeadline(detail: SpWriteOperationDetail, _workerEnabled: boolean | undefined): string {
  const c = operationCounts(detail);
  if (c.pending === c.requested) return 'Approved · waiting for the worker';
  if (c.pending > 0) return `Applying ${c.requested} changes · ${c.succeeded} accepted by Amazon · ${c.pending} waiting to send`;
  if (c.observed === c.requested && c.failed + c.refused + c.ambiguous === 0) return `${c.observed} change${c.observed === 1 ? '' : 's'} applied and confirmed in sync.`;
  const attention = c.failed + c.refused;
  if (attention > 0 && c.observed > 0) return `${c.observed} change${c.observed === 1 ? '' : 's'} applied. ${attention} need${attention === 1 ? 's' : ''} attention.`;
  if (attention > 0) return `${c.succeeded} accepted by Amazon · ${attention} need${attention === 1 ? 's' : ''} attention.`;
  if (c.ambiguous > 0) return `${c.ambiguous} change${c.ambiguous === 1 ? '' : 's'} awaiting a conclusive Amazon response.`;
  return `${c.succeeded} change${c.succeeded === 1 ? '' : 's'} accepted by Amazon · Waiting for the updated bid to appear in sync.`;
}

export function observationAnswers(detail: SpWriteOperationDetail, execution?: ExecutionVerdict, objective?: ObjectiveVerdict, calculation?: 'yes' | 'partly' | 'unavailable') {
  const observed = detail.snapshot.accounting.observedRequested;
  const unknown = 'Not yet answerable' as const;
  return {
    calculation: observed === 0 || calculation === undefined || calculation === 'unavailable' ? unknown : calculation === 'yes' ? 'Yes' : 'Partly',
    execution: observed === 0 || execution === undefined || execution === 'not_attempted' ? unknown
      : execution === 'applied_as_intended' && observed === detail.snapshot.accounting.approvedRows ? 'Yes' : 'Partly',
    objective: observed === 0 || objective === undefined || objective === 'evidence_insufficient' ? unknown : objective === 'supported_lift' ? 'Yes' : 'Partly',
  };
}

export function resultStatus(row: OperationResultRow): string {
  switch (row.status) {
    case 'pending': return 'Waiting for the worker';
    case 'sending': return 'Sending';
    case 'accepted': return 'Accepted by Amazon · Waiting for sync';
    case 'observed': return 'Confirmed in sync';
    case 'failed': return 'Failed';
    case 'refused': return 'Refused · Fresh preview required';
    case 'ambiguous': return 'Awaiting a conclusive response';
    case 'conflict': return 'Observed state conflicts with the request';
  }
}

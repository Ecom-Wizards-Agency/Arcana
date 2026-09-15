'use client';

import type { ReactNode } from 'react';
import type { ExecutionVerdict, ObjectiveVerdict } from '@wizard-ads/shared';
import type { SpWriteOperationDetail, SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import { Cell, DataTable, optimizerStyles } from '../optimizer-review/components';
import { operationValue } from '../optimizer-review/presentation';
import { optimizerBatchHref } from '../optimizer/navigation';
import { observationAnswers, operationCounts, operationHeadline, resultStatus, type OperationResultRow } from './model';

export interface ResultsContentProps {
  detail: SpWriteOperationDetail;
  plan: SpWritePreview['plan'];
  rows: readonly OperationResultRow[];
  executionGate?: { enabled: boolean; name: string };
  profileId: string;
  batchId: string;
  onRetry?: () => void;
  retry?: { excludedSuccessfulNames: readonly string[] };
  details?: ReactNode;
  executionVerdict?: ExecutionVerdict;
  objectiveVerdict?: ObjectiveVerdict;
  calculationVerdict?: 'yes' | 'partly' | 'unavailable';
}

export function ResultsContent({ detail, plan, rows, executionGate, profileId, batchId, onRetry, retry, details, executionVerdict, objectiveVerdict, calculationVerdict }: ResultsContentProps) {
  const counts = operationCounts(detail);
  const answers = observationAnswers(detail, executionVerdict, objectiveVerdict, calculationVerdict);
  const inFlight = ['queued', 'running'].includes(detail.snapshot.status);
  const waitingForObservation = detail.snapshot.accounting.pendingObservation > 0;
  const retryEligible = rows.filter((row) => row.retryEligible === true);
  const suffix = `?profile=${encodeURIComponent(profileId)}`;
  const ladder = [['Requested', counts.requested], ['Admitted', counts.admitted], ['Attempted', counts.attempted], ['Succeeded', counts.succeeded], ['Failed or refused', counts.failed + counts.refused], ['Observed in sync', counts.observed]] as const;
  return <section style={optimizerStyles.stack} aria-label={retry ? 'Retry results' : inFlight ? 'Applying changes' : 'Run results'}>
    <div style={optimizerStyles.card}><h2>{operationHeadline(detail, executionGate?.enabled)}</h2>
      {counts.pending === counts.requested && executionGate?.enabled === false ? <p>The worker execution gate <code>{executionGate.name}</code> is off. The saved approval is waiting for the worker.</p> : null}
      {inFlight ? <p>You can leave this page. Follow this run from its saved history.</p> : null}
      {waitingForObservation ? <p>This run is waiting for observation. It is not yet marked applied.</p> : null}
      {counts.ambiguous > 0 ? <p>{counts.ambiguous} response{counts.ambiguous === 1 ? ' is' : 's are'} unresolved. An unresolved response is not evidence of failure and cannot be retried blindly.</p> : null}
      {retry ? <p>The earlier successful change{retry.excludedSuccessfulNames.length === 1 ? '' : 's'} {retry.excludedSuccessfulNames.join(', ')} {retry.excludedSuccessfulNames.length === 1 ? 'was' : 'were'} not sent again.</p> : null}
    </div>
    <DataTable headers={['Target', 'Before', 'Requested', 'Observed', 'Result']} label="Run change results">
      {rows.map((row) => <tr key={row.actionId}><Cell>{row.name}</Cell><Cell>{operationValue(row.before, plan.actions.find((action) => action.actionId === row.actionId), plan.providerScope.currencyCode)}</Cell><Cell>{operationValue(row.requested, plan.actions.find((action) => action.actionId === row.actionId), plan.providerScope.currencyCode)}</Cell><Cell>{operationValue(row.observed, plan.actions.find((action) => action.actionId === row.actionId), plan.providerScope.currencyCode)}</Cell><Cell>{resultStatus(row)}{row.reason ? <p>{row.reason}</p> : null}{row.retryReason ? <p style={optimizerStyles.muted}>{row.retryReason}</p> : null}</Cell></tr>)}
    </DataTable>
    {rows.length !== plan.counts.providerRows ? <p role="alert" style={optimizerStyles.warning}>Row detail is incomplete: {rows.length} of {plan.counts.providerRows} approved rows loaded. Totals below come from the saved operation.</p> : null}
    <p data-testid="optimizer-result-counts">Requested {counts.requested} · Attempted {counts.attempted} · Accepted {counts.succeeded} · Failed {counts.failed} · Confirmed in sync {counts.observed}</p>
    <section style={optimizerStyles.card} aria-label="Reconciliation ladder"><h2>Reconciliation</h2><DataTable headers={['Stage', 'Rows']} label="Reconciliation counts">{ladder.map(([label, count]) => <tr key={label}><Cell>{label}</Cell><Cell>{count}</Cell></tr>)}</DataTable>
      {counts.pending > 0 ? <p>Waiting to send: {counts.pending}. Requested = attempted + refused + waiting to send.</p> : <p>Requested {counts.requested} = attempted {counts.attempted} + refused {counts.refused}.</p>}
      {counts.ambiguous > 0 ? <p>Awaiting a conclusive response: {counts.ambiguous}. Attempted = accepted + failed + unresolved response.</p> : <p>Attempted {counts.attempted} = accepted {counts.succeeded} + failed {counts.failed}.</p>}
      <p>Accepted by Amazon and observed in sync are recorded separately.</p>
    </section>
    <section style={optimizerStyles.card} aria-label="Run observation"><h2>Observation</h2><DataTable headers={['Question', 'Answer']} label="Three observation questions"><tr><Cell>Calculated as specified?</Cell><Cell>{answers.calculation}</Cell></tr><tr><Cell>Applied as intended?</Cell><Cell>{answers.execution}</Cell></tr><tr><Cell>Objective improved?</Cell><Cell>{answers.objective}</Cell></tr></DataTable>
      <h3>What was measured anyway</h3><p>{counts.attempted} attempted rows, {counts.succeeded} accepted by Amazon, {counts.observed} confirmed in sync.</p>
      <p><strong>Outcome note:</strong> {objectiveVerdict === 'complete_no_lift' ? 'The completed outcome evidence did not show improvement.' : objectiveVerdict === 'supported_lift' && counts.observed > 0 ? 'Recorded outcome evidence supports improvement for the observed change.' : 'Objective improvement remains unmeasured until sufficient outcome evidence is recorded. A successful API response does not establish improvement.'}</p>
    </section>
    {details ? <details><summary>Run details</summary><div style={optimizerStyles.card}>{details}</div></details> : <p>Immutable plan: {plan.id} · Generated {plan.generatedAt} · {plan.providerScope.currencyCode} · {plan.providerScope.marketplaceId}</p>}
    <div style={optimizerStyles.actions}>{onRetry && retryEligible.length > 0 ? <button type="button" style={{ ...optimizerStyles.action, ...optimizerStyles.primary }} onClick={onRetry}>Review failed change{retryEligible.length === 1 ? '' : 's'}</button> : null}<a href={optimizerBatchHref('review', batchId, profileId, { tab: 'details' })}>Run details</a><a href={`/optimizer${suffix}`}>Return to Optimize Now</a></div>
  </section>;
}

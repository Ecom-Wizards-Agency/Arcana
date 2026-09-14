'use client';
import { useEffect, useState } from 'react';
import { OptimizerOperation, SpWriteOperationDetail, spWriteExecutionRequirements } from '@wizard-ads/shared/sp-write-application';
import { gateMessage } from '../../ui/gate-message';
import { OptimizerFrame, OptimizerUnavailable } from '../optimizer/frame';
import { operationValue } from '../optimizer-review/presentation';
import { ResultsContent } from './components';
import { DataTable, Cell } from '../optimizer-review/components';
import styles from '../optimizer/optimizer.module.css';
import type { load } from './load';
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'gated') return <OptimizerUnavailable title="Run results" message={gateMessage(data.props.entry.state)} />;
  if (data.view === 'empty') return <OptimizerUnavailable title="Run results" message="No profiles yet." />;
  if (data.view === 'error') return <OptimizerUnavailable title="Run results" message={data.props.message} />;
  return <RunScreen data={data} />;
}
function RunScreen({ data }: { data: Extract<ScreenData, { view: 'ready' }> }) {
  const { profile, batchId } = data.props;
  const [operation, setOperation] = useState(data.props.operation);
  const [retry, setRetry] = useState(data.props.retry);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const identity = operation.detail.operation;
    const query = new URLSearchParams({ profileId: profile.id, executionId: identity.executionId, planId: identity.planId });
    const rowQuery = new URLSearchParams(query); rowQuery.set('batchId', batchId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/writes/status?${query}`, { signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Saved execution status is temporarily unavailable.');
        const detail = SpWriteOperationDetail.parse(await response.json());
        const rows = await fetch(`/api/optimizer/operations?${rowQuery}`, { signal: controller.signal, credentials: 'same-origin' });
        if (!rows.ok) throw new Error('Updated row observations are temporarily unavailable.');
        const next = OptimizerOperation.parse(await rows.json());
        if (detail.operation.planId !== identity.planId || detail.operation.executionId !== identity.executionId
          || next.detail.operation.planId !== identity.planId || next.detail.operation.executionId !== identity.executionId) throw new Error('The status response identifies another operation.');
        setOperation(next); setError(null);
        if (!['queued', 'running'].includes(next.detail.snapshot.status) && next.detail.snapshot.accounting.pendingObservation === 0) return;
      } catch (caught) { if (controller.signal.aborted) return; setError(caught instanceof Error ? caught.message : 'Could not read saved results.'); }
      timer = setTimeout(() => { void poll(); }, 5000);
    };
    timer = setTimeout(() => { void poll(); }, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [profile.id, batchId, operation.detail.operation.planId, operation.detail.operation.executionId]);
  const pending = operation.detail.snapshot.accounting.pendingDispatch === operation.detail.snapshot.accounting.approvedRows;
  return <OptimizerFrame title={retry ? 'Review unresolved change' : pending ? 'Approved · waiting for the worker' : ['queued', 'running'].includes(operation.detail.snapshot.status) ? 'Applying changes' : 'Run results'} subtitle={`${profile.label} · ${profile.currencyCode}`} step={3}>
    {error ? <p role="alert">{error}</p> : null}
    {pending ? <p>Waiting for the {spWriteExecutionRequirements.executor}. Execution requires <code>{spWriteExecutionRequirements.dispatchGate.environmentVariable}</code> and the profile write gates. This page does not enable them.</p> : null}
    {retry ? <RetryReview operation={operation} onBack={() => setRetry(false)} /> : <ResultsContent executionVerdict={operation.detail.snapshot.accounting.observedRequested === operation.detail.snapshot.accounting.approvedRows ? 'applied_as_intended' : operation.detail.snapshot.accounting.observationConflict > 0 ? 'synchronization_conflict' : 'not_synchronized'} detail={operation.detail} plan={operation.plan} rows={operation.rows.map((row) => ({ ...row, reason: row.reason ?? undefined }))} profileId={profile.id} batchId={batchId} onRetry={() => setRetry(true)} />}
  </OptimizerFrame>;
}
export function RetryReview({ operation, onBack }: { operation: OptimizerOperation; onBack(): void }) {
  const unresolved = operation.rows.filter((row) => row.retryEligible);
  const successful = operation.rows.filter((row) => row.status === 'accepted' || row.status === 'observed');
  return <section><h2>Refresh this preview</h2><p>The successful changes are excluded from the retry: {successful.map((row) => row.name).join(', ') || 'None recorded'}.</p>
    <DataTable headers={['Target', 'Earlier bid', 'Earlier proposal', 'Status']}>{unresolved.map((row) => <tr key={row.actionId}><Cell>{row.name}</Cell><Cell>{operationValue(row.before, operation.plan.actions.find((action) => action.actionId === row.actionId), operation.plan.providerScope.currencyCode)}</Cell><Cell>{operationValue(row.requested, operation.plan.actions.find((action) => action.actionId === row.actionId), operation.plan.providerScope.currencyCode)}</Cell><Cell>Fresh preview required</Cell></tr>)}</DataTable>
    <p role="status">A guarded forward preview restricted to these original rows is required before a retry can be confirmed. This installation does not yet support that source.</p>
    <button className={styles.action} disabled>Refresh unresolved change unavailable</button> <button className={styles.action} onClick={onBack}>Return to results</button>
  </section>;
}

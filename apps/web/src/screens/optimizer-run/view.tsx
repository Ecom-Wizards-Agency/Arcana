'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { optimizerBatchHref } from '../optimizer/navigation';
import { OptimizerOperation, OptimizerRetryPreview, SpWriteOperationDetail, spWriteExecutionRequirements } from '@wizard-ads/shared/sp-write-application';
import { gateMessage } from '../../ui/gate-message';
import { OptimizerFrame, OptimizerUnavailable } from '../optimizer/frame';
import type { RecommendationRecord } from '@wizard-ads/db';
import { ApplyRowWire, type MethodEvaluatorInput } from '@wizard-ads/shared';
import { operationValue, changeValue, recommendationReason } from '../optimizer-review/presentation';
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
  const router = useRouter();
  const retryIdentity = useRef<string | null>(null);
  const retryLock = useRef(false);
  const [preparingRetry, setPreparingRetry] = useState(false);
  const [operation, setOperation] = useState(data.props.operation);
  const [retry, setRetry] = useState(data.props.retry);
  const [preparedRetry, setPreparedRetry] = useState<OptimizerRetryPreview | null>(null);
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
  async function prepareRetry() {
    if (retryLock.current) return;
    retryLock.current = true; setPreparingRetry(true); setError(null);
    const requestId = retryIdentity.current ?? crypto.randomUUID(); retryIdentity.current = requestId;
    try {
      const response = await fetch('/api/optimizer/retry', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, profileId: profile.id,
          batchId, original: operation.detail.operation }) });
      if (!response.ok) throw new Error('This retry needs a fresh evaluation or updated operation evidence. Original values have not been changed.');
      const saved = OptimizerRetryPreview.parse(await response.json());
      const source = saved.preview.plan.source;
      if (source.kind !== 'apply_batch' || source.retryOrigin?.executionId !== operation.detail.operation.executionId
        || source.retryOrigin.planId !== operation.plan.id || source.retryOrigin.planFingerprint !== operation.plan.fingerprint
        || saved.preview.plan.profileId !== profile.id) throw new Error('The retry response identifies another saved operation.');
      setPreparedRetry(saved);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The saved retry could not be read. Try again to recover it.'); }
    finally { retryLock.current = false; setPreparingRetry(false); }
  }
  const pending = operation.detail.snapshot.accounting.pendingDispatch === operation.detail.snapshot.accounting.approvedRows;
  return <OptimizerFrame title={retry ? 'Review unresolved change' : pending ? 'Approved · waiting for the worker' : ['queued', 'running'].includes(operation.detail.snapshot.status) ? 'Applying changes' : data.props.retryDetails ? 'Retry results' : 'Run results'} subtitle={`${profile.label} · ${profile.currencyCode}`} step={retry ? 2 : 3}>
    {error ? <p role="alert">{error}</p> : null}
    {pending ? <p>Waiting for the {spWriteExecutionRequirements.executor}. Execution requires <code>{spWriteExecutionRequirements.dispatchGate.environmentVariable}</code> and the profile write gates. This page does not enable them.</p> : null}
    {retry && preparedRetry ? <PreparedRetryReview saved={preparedRetry} proposals={data.props.retryProposals} snapshots={data.props.retrySnapshots} onBack={() => setRetry(false)} onReview={() => router.push(optimizerBatchHref('confirm', batchId, profile.id, { plan: preparedRetry.preview.plan.id }))} /> : retry ? <RetryReview operation={operation} busy={preparingRetry} onRefresh={() => { void prepareRetry(); }} onBack={() => setRetry(false)} /> : <ResultsContent retry={data.props.retryDetails} executionVerdict={operation.detail.snapshot.accounting.observedRequested === operation.detail.snapshot.accounting.approvedRows ? 'applied_as_intended' : operation.detail.snapshot.accounting.observationConflict > 0 ? 'synchronization_conflict' : 'not_synchronized'} detail={operation.detail} plan={operation.plan} rows={operation.rows.map((row) => ({ ...row, reason: row.reason ?? undefined }))} profileId={profile.id} batchId={batchId} onRetry={() => { retryIdentity.current = null; setPreparedRetry(null); setRetry(true); }} />}
  </OptimizerFrame>;
}
export function RetryReview({ operation, onBack, onRefresh, busy = false }: { operation: OptimizerOperation; onBack(): void; onRefresh?(): void; busy?: boolean }) {
  const unresolved = operation.rows.filter((row) => row.retryEligible);
  const successful = operation.rows.filter((row) => row.status === 'accepted' || row.status === 'observed');
  return <section><h2>Refresh this preview</h2><p>The successful changes are excluded from the retry: {successful.map((row) => row.name).join(', ') || 'None recorded'}.</p>
    <DataTable headers={['Target', 'Earlier bid', 'Earlier proposal', 'Status']}>{unresolved.map((row) => <tr key={row.actionId}><Cell>{row.name}</Cell><Cell>{operationValue(row.before, operation.plan.actions.find((action) => action.actionId === row.actionId), operation.plan.providerScope.currencyCode)}</Cell><Cell>{operationValue(row.requested, operation.plan.actions.find((action) => action.actionId === row.actionId), operation.plan.providerScope.currencyCode)}</Cell><Cell>Fresh preview required</Cell></tr>)}</DataTable>
    <p role="status">A fresh preview will check these original unresolved rows against the saved operation and current values. A changed bid requires a fresh evaluation.</p>
    <button className={styles.action} disabled={busy || unresolved.length === 0 || !onRefresh} onClick={onRefresh}>Refresh unresolved change</button> <button className={styles.action} onClick={onBack}>Return to results</button>
  </section>;
}

/** The refreshed saved plan owns this review; earlier successful rows never enter its table. */
export function PreparedRetryReview({ saved, proposals = [], snapshots = [], onBack, onReview }: {
  saved: OptimizerRetryPreview; proposals?: readonly RecommendationRecord[]; snapshots?: readonly MethodEvaluatorInput[];
  onBack(): void; onReview(): void;
}) {
  const { plan, evidence } = saved.preview;
  if (!evidence || evidence.schemaVersion !== 'openspell.sp-write-preview-evidence.v1') return <p role="alert">Recorded retry source unavailable. Reload this run.</p>;
  const artifact = ApplyRowWire.array().parse(JSON.parse(evidence.provenance.artifactText));
  const count = plan.counts.logicalChanges;
  return <section aria-label="Refreshed unresolved changes">
    <div className={styles.card}><h2>Review unresolved change</h2><p>This fresh preview contains {count} original unresolved change{count === 1 ? '' : 's'}.</p>
      <p>The earlier successful changes are excluded: {saved.excludedSuccessfulRows.map((row) => row.name).join(', ') || 'None recorded'}.</p></div>
    <DataTable headers={['Target / Campaign', 'Current bid', 'New bid', 'Reason']} label="Refreshed retry changes">
      {plan.actions.map((action) => {
        const source = action.sources[0];
        const index = evidence.provenance.rows.findIndex((row) => source?.kind === 'apply_row' && row.applyRowId === source.applyRowId);
        const proposal = proposals.find((row) => row.id === evidence.provenance.rows[index]?.recommendationId);
        return <tr key={action.actionId}><Cell><strong>{artifact[index]?.name ?? artifact[index]?.entity_id ?? 'Target unavailable'}</strong><div>{proposal?.campaignName ?? proposal?.campaignId ?? 'Campaign unavailable'}</div></Cell>
          <Cell>{Object.entries(action.changes).map(([field, change]) => <p key={field}>{changeValue(change?.expected, field, plan.providerScope.currencyCode)}</p>)}</Cell>
          <Cell>{Object.entries(action.changes).map(([field, change]) => <p key={field}>{changeValue(change?.requested, field, plan.providerScope.currencyCode)}</p>)}</Cell>
          <Cell>{proposal ? recommendationReason(proposal, snapshots) : 'Recorded suggestion; calculation inputs unavailable'}</Cell></tr>;
      })}
    </DataTable>
    <div className={styles.footer}><button className={styles.action} onClick={onBack}>Return to results</button>
      <button className={`${styles.action} ${styles.primary}`} onClick={onReview}>Review {count} selected change{count === 1 ? '' : 's'}</button></div>
  </section>;
}

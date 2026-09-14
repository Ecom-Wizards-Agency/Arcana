'use client';
import type { RecommendationRecord } from '@wizard-ads/db';
import { changeValue } from '../optimizer-review/presentation';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SpWriteAdmission, SpWriteConfirmedApprovalRequest, SpWritePreview, SpWriteRecordedPreview, spWriteConfirmation } from '@wizard-ads/shared/sp-write-application';
import { gateMessage } from '../../ui/gate-message';
import { OptimizerFrame, OptimizerUnavailable } from '../optimizer/frame';
import { optimizerBatchHref } from '../optimizer/navigation';
import { DataTable, Cell } from '../optimizer-review/components';
import styles from '../optimizer/optimizer.module.css';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;
export function confirmationRequest(preview: SpWritePreview, approvalRequestId: string): SpWriteConfirmedApprovalRequest {
  return SpWriteConfirmedApprovalRequest.parse({ profileId: preview.plan.profileId, confirmation: spWriteConfirmation(preview.plan.counts.logicalChanges), approval: {
    approvalRequestId, plan: preview.binding, approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null,
  } });
}
function freshnessMessage(reasons: SpWriteRecordedPreview['freshness']['reasons']): string {
  const messages: Record<SpWriteRecordedPreview['freshness']['reasons'][number], string> = {
    expired: 'This preview has expired.',
    profile_changed: 'The profile changed after this preview was prepared.',
    grant_changed: 'Write permissions changed after this preview was prepared.',
    gate_disabled: 'The write gate is disabled.',
    source_changed: 'The saved source changed after this preview was prepared.',
    current_value_changed: 'Current values changed after this preview was prepared',
    entity_unavailable: 'Current entity state is unavailable.',
    unsupported_action: 'This action is not supported by the current write gateway.',
  };
  return reasons.map((reason) => messages[reason]).join(' ') || 'This preview needs a fresh review.';
}
export function ConfirmContent({ recorded, batchId, busy = false, onConfirm, onRefresh, retry, proposals = [] }: { recorded: SpWriteRecordedPreview; batchId: string; busy?: boolean; onConfirm(): void; onRefresh(): void; retry?: { excludedSuccessfulNames: readonly string[] }; proposals?: readonly RecommendationRecord[] }) {
  const { preview } = recorded;
  const shadow = preview.evidence?.schemaVersion !== 'openspell.sp-write-preview-evidence.v2'
    && preview.evidence?.provenance.rows.some((row) => row.method?.methodId === 'sp.coordinated-efficiency');
  const stale = recorded.freshness.status !== 'current';
  const count = preview.plan.counts.logicalChanges;
  const evidence = preview.evidence;
  const sourceRows = evidence && evidence.schemaVersion !== 'openspell.sp-write-preview-evidence.v2' ? evidence.provenance.rows : [];
  const scopedRows = preview.plan.actions.map((action) => {
    const ids = action.sources.flatMap((source) => source.kind === 'apply_row' ? sourceRows.filter((row) => row.applyRowId === source.applyRowId).map((row) => row.recommendationId) : []);
    return proposals.filter((row) => row.profileId === preview.plan.profileId && ids.includes(row.id));
  });
  const scopeComplete = scopedRows.every((rows) => rows.length > 0 && rows.every((row) => row.campaignId !== null));
  const campaigns = new Set(scopedRows.flatMap((rows) => rows.map((row) => row.campaignId)));
  const scope = scopeComplete ? `These changes affect ${preview.plan.counts.uniqueEntities} target${preview.plan.counts.uniqueEntities === 1 ? '' : 's'} in ${campaigns.size} campaign${campaigns.size === 1 ? '' : 's'}.` : `These changes affect ${preview.plan.counts.uniqueEntities} targets. Campaign scope unavailable.`;
  const query = `?profile=${preview.plan.profileId}`;
  return <OptimizerFrame title={shadow ? 'Shadow preview' : stale ? 'Refresh this preview' : retry ? 'Confirm retry' : 'Confirm changes'} subtitle={`${recorded.profile.label} · ${preview.plan.counts.uniqueEntities} entities · ${recorded.profile.currencyCode}`} step={3}>
    {shadow ? <div className={styles.shadow}><h2>Shadow preview</h2><p>This method cannot send changes to Amazon.</p></div> : <section className={stale ? styles.warning : styles.card}><h2>{stale ? freshnessMessage(recorded.freshness.reasons) : retry ? `Retry ${count} bid change${count === 1 ? '' : 's'} in Amazon` : `Apply ${count} bid change${count === 1 ? '' : 's'} to Amazon`}</h2><p>{stale ? recorded.freshness.reasons.join(' · ') : scope}</p></section>}
    {retry ? <p>The earlier successful changes are excluded: {retry.excludedSuccessfulNames.join(', ')}. This confirmation applies to the refreshed preview.</p> : null}
    <DataTable headers={stale ? ['Target', 'Earlier bid', 'Earlier proposal', 'Status'] : ['Campaign / Target', 'Current bid', 'New bid']}>
      {preview.plan.actions.map((action, index) => <tr key={action.actionId}><Cell><strong>{scopedRows[index]?.[0]?.campaignName ?? scopedRows[index]?.[0]?.campaignId ?? 'Campaign unavailable'}</strong><div>{recorded.currentRows.find((row) => row.actionId === action.actionId)?.entityName ?? Object.values(action.entity).join(' · ')}</div></Cell><Cell>{Object.entries(action.changes).map(([field, change]) => <p key={field}>{changeValue(change?.expected, field, preview.plan.providerScope.currencyCode)}</p>)}</Cell><Cell>{Object.entries(action.changes).map(([field, change]) => <p key={field}>{changeValue(change?.requested, field, preview.plan.providerScope.currencyCode)}</p>)}</Cell>{stale ? <Cell>Fresh preview required</Cell> : null}</tr>)}
    </DataTable>
    <p>Saved campaign limits checked. This approval covers the values shown above.</p>
    <p>If current values or permissions change, Arcana will stop the affected changes and request a fresh review.</p>
    <div className={styles.actions}><a className={styles.action} href={optimizerBatchHref('review', batchId, preview.plan.profileId, { tab: 'details' })}>Review limits and settings</a></div>
    <div className={styles.footer}><a className={styles.action} href={`/optimizer/review/${batchId}${query}`}>Back to suggestions</a>
      {shadow ? <button className={styles.action} disabled>Send to Amazon unavailable in shadow</button> : recorded.admission ? <a className={styles.action} href={`/optimizer/run/${batchId}${query}&execution=${recorded.admission.operation.executionId}&plan=${recorded.admission.operation.planId}`}>View saved results</a> : stale ? <button className={`${styles.action} ${styles.primary}`} disabled={busy} onClick={onRefresh}>Refresh unresolved change</button> : <button className={`${styles.action} ${styles.primary}`} disabled={busy} onClick={onConfirm}>{spWriteConfirmation(count)}</button>}
    </div>
  </OptimizerFrame>;
}
export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'gated') return <OptimizerUnavailable title="Confirm changes" message={gateMessage(data.props.entry.state)} />;
  if (data.view === 'empty') return <OptimizerUnavailable title="Confirm changes" message="No profiles yet." />;
  if (data.view === 'error') return <OptimizerUnavailable title="Confirm changes" message={data.props.message} />;
  return <ConfirmScreen data={data} />;
}
function ConfirmScreen({ data }: { data: Extract<ScreenData, { view: 'ready' }> }) {
  const { profile, batchId, applyBatchId } = data.props;
  const router = useRouter();
  const [recorded, setRecorded] = useState(data.props.recorded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvalIdentity = useRef<string | null>(null);
  const previewIdentity = useRef<string | null>(null);
  const lock = useRef(false);
  async function requestPreview(source: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    const requestId = previewIdentity.current ?? crypto.randomUUID(); previewIdentity.current = requestId;
    try {
      const response = await fetch('/api/writes/preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, profileId: profile.id, applyBatchId: source }) });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(payload));
      const preview = SpWritePreview.parse(payload);
      const read = await fetch(`/api/writes/preview?profileId=${profile.id}&planId=${preview.plan.id}`, { credentials: 'same-origin' });
      if (!read.ok) throw new Error('The preview was saved but its current state could not be checked. Reload to read the saved plan.');
      setRecorded(SpWriteRecordedPreview.parse(await read.json()));
      const url = new URL(window.location.href); url.searchParams.set('plan', preview.plan.id); window.history.replaceState(window.history.state, '', url);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The preview could not be prepared.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { if (data.props.recorded === null && applyBatchId !== null) void requestPreview(applyBatchId); }, [applyBatchId]);
  async function approve() {
    if (!recorded || lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    const identity = approvalIdentity.current ?? crypto.randomUUID(); approvalIdentity.current = identity;
    try {
      const response = await fetch('/api/writes/approve', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(confirmationRequest(recorded.preview, identity)) });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const fresh = await fetch(`/api/writes/preview?profileId=${profile.id}&planId=${recorded.preview.plan.id}`, { credentials: 'same-origin' });
        if (fresh.ok) setRecorded(SpWriteRecordedPreview.parse(await fresh.json()));
        throw new Error(errorMessage(payload));
      }
      const admission = SpWriteAdmission.parse(payload);
      router.push(optimizerBatchHref('run', batchId, profile.id, { execution: admission.operation.executionId, plan: admission.operation.planId }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Approval status is unknown. Retry this same confirmation to check the saved result.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>{error ? <p role="alert">{error}</p> : null}{recorded ? <ConfirmContent proposals={data.props.proposals} recorded={recorded} batchId={batchId} busy={busy} onConfirm={() => { void approve(); }} onRefresh={() => { const source = recorded.preview.plan.source; if (source.kind === 'apply_batch') { previewIdentity.current = null; approvalIdentity.current = null; void requestPreview(source.applyBatchId); } }} /> : <OptimizerFrame title="Preparing immutable preview" step={3}><p aria-busy={busy}>The selected rows, saved limits and current values are being checked.</p>{error && applyBatchId ? <button className={styles.action} onClick={() => { void requestPreview(applyBatchId); }}>Check saved preview</button> : null}</OptimizerFrame>}</>;
}
function errorMessage(value: unknown): string {
  const code = typeof value === 'object' && value !== null && 'code' in value ? value.code : null;
  return code === 'source_changed' ? 'Current values changed. A fresh evaluation and review are required.' : code === 'authorization_refused' ? 'Current permissions or write gates do not permit this change.' : code === 'not_found' ? 'An enabled profile write grant and a supported saved source are required.' : 'This preview could not be admitted. Its saved values have not been changed.';
}

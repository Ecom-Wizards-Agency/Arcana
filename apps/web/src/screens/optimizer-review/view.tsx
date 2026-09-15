'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { gateMessage } from '../../ui/gate-message';
import { OptimizerFrame, OptimizerUnavailable } from '../optimizer/frame';
import { optimizerBatchHref } from '../optimizer/navigation';
import { ReviewContent } from './components';
import { RunDetails } from './details';
import { acceptSelection, stageSelection } from './selection';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'gated') return <OptimizerUnavailable title="Review suggestions" message={gateMessage(data.props.entry.state)} />;
  if (data.view === 'empty') return <OptimizerUnavailable title="Review suggestions" message="No profiles yet." />;
  if (data.view === 'error') return <OptimizerUnavailable title="Review suggestions" message={data.props.message} />;
  return <ReviewScreen data={data} />;
}
function ReviewScreen({ data }: { data: Extract<ScreenData, { view: 'ready' }> }) {
  const { review, profile } = data.props;
  const router = useRouter();
  const [selected, setSelected] = useState(new Set(review.proposals.filter((row) => row.status === 'accepted').map((row) => row.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decisionRows = useRef(review.proposals);
  const exportIdentity = useRef<{ key: string; id: string } | null>(null);
  const details = <RunDetails review={review} currencyCode={profile.currencyCode} marketplace={profile.countryCode} />;
  async function proceed() {
    setBusy(true); setError(null);
    try {
      const ids = await acceptSelection(decisionRows.current, selected);
      // A lost export response must recover that command without deciding already exported rows again.
      decisionRows.current = decisionRows.current.map((row) => ids.includes(row.id)
        ? { ...row, status: 'accepted' } : row.status === 'accepted' ? { ...row, status: 'proposed' } : row);
      const key = JSON.stringify([...ids].sort());
      if (exportIdentity.current?.key !== key) exportIdentity.current = { key, id: crypto.randomUUID() };
      if (review.executionSnapshot !== null && !data.props.exportFingerprint) throw new Error('The immutable export binding is unavailable. Reload this review.');
      const applyBatchId = await stageSelection(profile.id, review.proposals, ids, undefined,
        review.executionSnapshot === null ? undefined : { batchId: review.batchId,
          reviewFingerprint: data.props.exportFingerprint!, requestId: exportIdentity.current.id });
      router.push(optimizerBatchHref('confirm', review.batchId, profile.id, { applyBatch: applyBatchId }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The selected changes could not be prepared.'); }
    finally { setBusy(false); }
  }
  return <OptimizerFrame title="Review suggestions" subtitle={`${profile.label} · ${review.campaignCount} campaigns · ${profile.currencyCode}`} step={2}>
    {review.status !== 'succeeded' ? <p role="status">Saved preview: {review.status}. Completed results remain available below.</p> : null}
    {data.props.savedPreviews.length ? <section aria-label="Saved change reviews"><h2>Saved change reviews</h2><p>Continue from the recorded preview or its saved results.</p><ul>{data.props.savedPreviews.map((saved) => {
      const plan = saved.preview.plan;
      const admission = saved.admission;
      const href = admission
        ? optimizerBatchHref('run', review.batchId, profile.id, { execution: admission.operation.executionId, plan: admission.operation.planId })
        : optimizerBatchHref('confirm', review.batchId, profile.id, { plan: plan.id });
      return <li key={plan.id}><a href={href}>{admission ? 'View saved results' : 'Review saved preview'} · {plan.counts.logicalChanges} change{plan.counts.logicalChanges === 1 ? '' : 's'}</a></li>;
    })}</ul></section> : null}
    {error ? <p role="alert">{error}</p> : null}
    {(data.props.savedExports ?? []).filter((item) => !data.props.savedPreviews.some((saved) => saved.preview.plan.source.kind === 'apply_batch' && saved.preview.plan.source.applyBatchId === item.applyBatchId)).map((item) => <p key={item.requestId}><a href={optimizerBatchHref('confirm', review.batchId, profile.id, { applyBatch: item.applyBatchId })}>Review saved selection · {item.counts.exported} changes</a></p>)}
    {data.props.details ? details : <ReviewContent snapshots={review.children.flatMap((child) => child.calculationSnapshots)} rows={review.proposals} population={review.totals} holds={review.children.flatMap((child) => child.outcomesComplete ? child.blocked.flatMap((row) => row.hold ? [row.hold] : []) : child.holds)} unchanged={review.children.flatMap((child) => child.unchanged.map((row) => ({ id: `${row.entityRef.entityType}:${row.entityRef.entityId}`, name: row.entityRef.entityId, campaignName: row.entityRef.campaignId ?? null, currentValue: row.currentBid, proposedValue: row.currentBid, reason: `${row.reasonCode} · ${row.reason}` })))} evaluatedTargets={review.totals.evaluated} selected={selected} onToggle={(ids) => { const next = new Set(selected); const remove = ids.every((id) => next.has(id)); for (const id of ids) { if (remove) next.delete(id); else next.add(id); } setSelected(next); }} onClear={() => setSelected(new Set())} onContinue={() => { void proceed(); }} profileId={profile.id} batchId={review.batchId} currencyCode={profile.currencyCode} busy={busy} details={details} />}
    {review.status === 'succeeded' && review.proposals.length === 0 ? <p>This run proposed nothing. Preview completed. No changes were recommended.</p> : null}
  </OptimizerFrame>;
}

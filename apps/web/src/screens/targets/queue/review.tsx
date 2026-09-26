'use client';
import { useEffect, useState } from 'react';
import { corridorMaxCpc } from '@wizard-ads/core';
import { placementLabel, type QueuedBidChange } from '@wizard-ads/shared';
import styles from '../target360.module.css';
export function QueueReview({ change, back }: { change: QueuedBidChange; back: string }) {
  const [approval, setApproval] = useState<Pick<QueuedBidChange, 'id' | 'approvedAt' | 'approvedBy'> | null>(change.approvedAt === null ? null : change);
  const approved = approval?.approvedAt != null;
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const components = change.context.placementModifiers === null || Object.values(change.context.placementModifiers).some((value) => value === null) ? [] : Object.entries(change.context.placementModifiers).filter((entry): entry is [string,number] => entry[1] !== null).map(([name,pct]) => ({name,pct}));
  const money = (value: number | null) => value === null ? 'Not measured' : new Intl.NumberFormat('en-US',{style:'currency',currency:change.request.newBid.currencyCode}).format(value);
  const pass = change.checks.length === 5 && change.checks.every((c) => c.passed);
  const target = `/targets/${encodeURIComponent(change.context.targetId)}?${new URLSearchParams({ profile: change.context.profileId, back, limits: '1' })}#target-limits`;
  const approve = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/targets/${encodeURIComponent(change.context.targetId)}/queue/${change.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: change.context.profileId }) });
      const result = await response.json() as { approval?: Pick<QueuedBidChange, 'id' | 'approvedAt' | 'approvedBy'>; error?: string };
      if (!response.ok || result.approval?.id !== change.id || !result.approval.approvedAt || !result.approval.approvedBy) throw new Error(result.error ?? 'Approval could not be confirmed. Reload before trying again.');
      setApproval(result.approval);
    } catch (e) { setError(e instanceof Error ? e.message : 'Approval failed.'); }
    finally { setBusy(false); }
  };
  return <main className={styles.tabContent} data-state={approved ? 'approved' : 'queued'}><h1>Review queued change</h1>
    <p>Profile: {change.context.profileLabel} · {change.context.profileId}</p>
    <table><thead><tr><th>Target / Campaign</th><th>Current</th><th>Proposed</th><th>Status</th></tr></thead><tbody><tr><td>{change.context.targetLabel} / {change.context.campaignLabel}<small> · {change.context.targetId}</small></td><td>{change.request.expectedBid.amount} {change.request.expectedBid.currencyCode}</td><td>{change.request.newBid.amount} {change.request.newBid.currencyCode}</td><td>{approved ? 'Approved' : 'Awaiting review'}</td></tr></tbody></table>
    <p>Amazon bid last read: {change.request.expectedReadAt}</p>
    <p>Placement exposure: {change.context.placementModifiers === null ? 'Not measured' : Object.entries(change.context.placementModifiers).map(([name,pct]) => `${placementLabel(name) ?? name}: ${pct === null ? 'not measured' : `${pct}%`}`).join(' · ')}</p>
    <p>Current max CPC {money(corridorMaxCpc(Number(change.request.expectedBid.amount),components))} · Proposed max CPC {money(corridorMaxCpc(Number(change.request.newBid.amount),components))}</p>
    <h2>Review before approval</h2><p>Check the latest bid, placement exposure and campaign limits. If the proposal is outside a limit, fix it before approving.</p>
    <ul className={styles.checks}>{change.checks.map((c) => <li key={c.key}><strong>{c.passed ? 'Pass' : 'Fail'} · {c.key.replaceAll('_',' ')}</strong><p>{c.reason}</p><small>{c.source}</small></li>)}</ul>
    {change.request.overrideReason ? <p>Rank gate override: {change.request.overrideReason}</p> : null}
    <div className={styles.actions}><a className="wa-btn" href={target}>View target and limits</a><button className="wa-btn wa-btn--primary" disabled={!hydrated || !pass || approved || busy} onClick={() => void approve()}>{busy ? 'Approving…' : 'Approve after checks pass'}</button></div>
    <p role="status" aria-live="polite">{approved ? 'Approved. Approval was recorded; no Amazon bid was changed.' : ''}</p>{!approved ? <p>Queueing and approval do not change an Amazon bid.</p> : null}{error ? <p role="alert">{error}</p> : null}
  </main>;
}

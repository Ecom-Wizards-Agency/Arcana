'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RecommendationPreviewAccepted, RecommendationPreviewBatchStatus, type MethodSelection, type OneTimeRpcConfiguration } from '@wizard-ads/shared';
import type { OptimizerCampaignRow } from '../../optimizer/campaigns';
import { filterOptimizerCampaignRows, optimizerPreviewError } from '../../optimizer/campaigns';
import { oneTimePreviewUnavailableMessage } from '../../optimizer/preview-availability';
import { effectiveAcos, readOptimizerDraft, saveOptimizerDraft, savedConfiguration, optimizerAdmissionRequest,
  clearOptimizerAdmission, draftDefaultMethod, type OptimizerDraft } from './draft';
import { goalLabel } from '../optimizer-review/presentation';
import styles from './optimizer.module.css';

export interface ChooseCampaignsProps {
  rows: readonly OptimizerCampaignRow[];
  profileId: string;
  currencyCode: string;
  period: { start: string; end: string };
  today: string;
  mayRun: boolean;
  readiness: { ready: boolean; message?: string };
  initialBatchId?: string;
  methods?: Readonly<Record<string, MethodSelection>>;
}

/** Retries an interrupted admission with the same immutable client request identity. */
export async function queueSuggestions(body: string, signal?: AbortSignal): Promise<RecommendationPreviewAccepted> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try { response = await fetch('/api/optimizer/runs/one-time', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body, signal }); }
    catch (error) { if (signal?.aborted || attempt === 1) throw error; continue; }
    let payload: unknown;
    try { payload = await response.json(); }
    catch (error) { if (signal?.aborted || attempt === 1) throw error; continue; }
    if (!response.ok) {
      if (response.status >= 500 && attempt === 0) continue;
      throw new Error(optimizerPreviewError(payload, 'The preview could not be queued. Retry with these settings to check its saved status.'));
    }
    return RecommendationPreviewAccepted.parse(payload);
  }
  throw new Error('The preview response was interrupted.');
}

export function ChooseCampaigns({ rows, profileId, period, today, mayRun, readiness, initialBatchId, methods = {} }: ChooseCampaignsProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<OptimizerDraft>({ campaignIds: [] });
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('Campaigns');
  const [busy, setBusy] = useState(false);
  const [batchId, setBatchId] = useState(initialBatchId ?? null);
  const [status, setStatus] = useState<RecommendationPreviewBatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const submitting = useRef(false);
  const admissionController = useRef<AbortController | null>(null);
  const eligible = rows.filter((row) => row.selectable);
  const selected = new Set(draft.campaignIds);
  const selectedRows = eligible.filter((row) => selected.has(row.campaignId));
  const filtered = filterOptimizerCampaignRows(rows, { query, group: 'all', state: 'all' });
  const filterEligible = filtered.filter((row) => row.selectable);
  const filterCount = filterEligible.filter((row) => selected.has(row.campaignId)).length;
  const all = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(readOptimizerDraft(profileId));
    setBatchId(initialBatchId ?? null); setStatus(null); setBusy(false); setError(null); setAnnouncement('');
    return () => {
      admissionController.current?.abort();
      admissionController.current = null;
      submitting.current = false;
    };
  }, [profileId, initialBatchId]);
  useEffect(() => { if (all.current) all.current.indeterminate = filterCount > 0 && filterCount < filterEligible.length; }, [filterCount, filterEligible.length]);
  function update(next: OptimizerDraft) { setDraft(next); saveOptimizerDraft(profileId, next); }
  function toggle(ids: readonly string[], checked: boolean) {
    const next = new Set(draft.campaignIds);
    for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
    update({ ...draft, campaignIds: [...next].sort() });
  }
  useEffect(() => {
    if (batchId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/optimizer/runs/${batchId}?profileId=${profileId}`, { signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Saved preview status is temporarily unavailable.');
        const next = RecommendationPreviewBatchStatus.parse(await response.json());
        if (controller.signal.aborted) return;
        if (next.batchId !== batchId) throw new Error('The status response identifies another preview.');
        setStatus(next);
        if (next.status === 'succeeded') {
          setBusy(false);
          router.push(`/optimizer/review/${batchId}?profile=${profileId}`);
          return;
        }
        if (next.status === 'failed') { setBusy(false); setError('The preview failed. Completed child runs remain available in its saved history.'); return; }
        setAnnouncement(next.availability?.ready === false ? `Preview saved. ${oneTimePreviewUnavailableMessage(next.availability.reason)}` : `Preview ${next.status} for ${next.campaignCount} campaigns.`);
      } catch (caught) { if (controller.signal.aborted) return; setError(caught instanceof Error ? caught.message : 'Could not read saved preview.'); }
      if (++attempts < 120) timer = setTimeout(() => { void poll(); }, attempts < 3 ? 1000 : 5000);
      else { setBusy(false); setAnnouncement('Preview saved. Check its history for completion.'); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [batchId, profileId, router]);

  async function getSuggestions() {
    if (submitting.current || selectedRows.length === 0) return;
    const configuration: OneTimeRpcConfiguration | null = draft.configuration ?? savedConfiguration(selectedRows, period, today);
    if (configuration === null || selectedRows.some((row) => effectiveAcos(row, configuration).value === null)) {
      router.push(`/optimizer/settings?profile=${profileId}`); return;
    }
    submitting.current = true; setBusy(true); setError(null);
    const controller = new AbortController();
    admissionController.current = controller;
    try {
      const request = optimizerAdmissionRequest(profileId, selectedRows.map((row) => row.campaignId), configuration, draft.campaignMethods);
      const accepted = await queueSuggestions(JSON.stringify(request), controller.signal);
      if (controller.signal.aborted || admissionController.current !== controller) return;
      if (accepted.scope.campaignCount !== selectedRows.length) throw new Error('The saved preview campaign count differs from the selected scope.');
      setAnnouncement(`Preview queued for ${accepted.scope.campaignCount} campaigns across ${accepted.childCount} runs.`);
      setBatchId(accepted.batchId);
      const url = new URL(window.location.href); url.searchParams.set('batch', accepted.batchId); window.history.replaceState(window.history.state, '', url);
      clearOptimizerAdmission(profileId, request.clientRequestId);
    } catch (caught) {
      if (controller.signal.aborted || admissionController.current !== controller) return;
      setBusy(false); setError(caught instanceof Error ? caught.message : 'Could not queue suggestions.');
    } finally {
      if (admissionController.current === controller) { submitting.current = false; admissionController.current = null; }
    }
  }

  return <>
    <div className={styles.tabs} role="tablist" aria-label="Choose campaigns">
      {['Campaigns', 'Optimization groups', 'Search campaigns'].map((name) => <button key={name} className={styles.action} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}
    </div>
    {tab === 'Optimization groups' ? <div className={styles.actions}>{[...new Set(rows.map((row) => row.groupId).filter((id) => id !== null))].map((id) => {
      const members = eligible.filter((row) => row.groupId === id);
      return <label className={styles.action} key={id}><input type="checkbox" disabled={busy || !mayRun} checked={members.length > 0 && members.every((row) => selected.has(row.campaignId))} onChange={(event) => toggle(members.map((row) => row.campaignId), event.target.checked)} />{members[0]?.groupName ?? 'Unavailable group'} · {members.length} campaigns</label>;
    })}<a href={`/optimizer/groups?profile=${profileId}`}>Open groups</a></div> : null}
    <div role="search" aria-label="Filter optimizer campaigns"><label>Find campaign <input aria-label="Find campaign" className={styles.search} type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label><span className="wa-optimizer-campaigns__shown">{filtered.length === rows.length ? `${rows.length} campaigns` : `${filtered.length} of ${rows.length} campaigns`}</span></div>
    <p data-testid="optimizer-selection-count">{selectedRows.length ? `${selectedRows.length} campaigns selected. Selections hidden by the current filters remain selected.` : 'No campaigns selected.'}</p>
    <table className={styles.table}><thead><tr><th>Campaign</th><th>Saved goal</th><th>Target ACOS</th><th><input ref={all} type="checkbox" data-testid="optimizer-select-filtered" aria-label={`Select all ${filterEligible.length} eligible campaigns matching current filters`} disabled={busy || !mayRun || !filterEligible.length} checked={filterEligible.length > 0 && filterCount === filterEligible.length} onChange={(event) => toggle(filterEligible.map((row) => row.campaignId), event.target.checked)} /></th></tr></thead>
      <tbody>{filtered.map((row) => { const acos = effectiveAcos(row, draft.configuration); const method = draft.campaignMethods?.[row.campaignId] ?? methods[row.campaignId] ?? draftDefaultMethod(draft); return <tr key={row.campaignId}>
        <td>{row.name}<details><summary>Campaign details</summary><p>{row.adProduct} · {row.adProduct === 'SP' ? 'CPC' : 'Cost type unavailable'} · {row.biddingStrategy ?? 'Bidding mode unavailable'}</p><p>{method ? `${method.id} · ${method.version}` : 'SP reference efficiency · reference.1 · run default'}</p><p>{row.currentRows ? 'Reporting data available' : 'No reporting data for this period'}</p><p>Experiment locks are checked when the preview is prepared.</p>{row.eligibilityReason ? <p>{row.eligibilityReason}</p> : null}</details></td>
        <td>{goalLabel(row.groupRole)}</td><td>{acos.value === null ? 'Missing target ACOS' : `${Number((acos.value * 100).toPrecision(10))}%`}<small>{acos.source}</small></td>
        <td><label><input type="checkbox" disabled={busy || !mayRun || !row.selectable} checked={selected.has(row.campaignId)} aria-label={`Select ${row.name} for this preview`} onChange={(event) => toggle([row.campaignId], event.target.checked)} />{selected.has(row.campaignId) ? 'Selected' : 'Select'}</label></td>
      </tr>; })}</tbody></table>
    {rows.length === 0 ? <p>No campaigns available for this profile.</p> : null}
    <p className={styles.muted}>Using saved goals, methods and limits. Unavailable methods and blocked targets will be shown in the review.</p>
    {!readiness.ready ? <p role="status">{readiness.message}</p> : null}
    {!mayRun ? <p>Your role can view previews but cannot queue one.</p> : null}
    {error ? <p role="alert">{error}</p> : null}<p role="status">{announcement}</p>
    {status ? <ul aria-label="Preview runs">{status.children.map((child) => <li key={child.runId}>{child.groupName ?? 'Unassigned campaigns'} · {child.campaignCount} campaigns · {child.status}</li>)}</ul> : null}
    <div className={styles.footer}>
      <button className={styles.action} disabled={busy || !selectedRows.length} onClick={() => router.push(`/optimizer/settings?profile=${profileId}`)}>Edit settings</button>
      <button className={`${styles.action} ${styles.primary}`} data-testid="optimizer-run-preview" disabled={busy || !mayRun || !readiness.ready || !selectedRows.length} onClick={() => { void getSuggestions(); }}>{busy ? 'Preparing suggestions…' : 'Get suggestions'}</button>
      <button className={styles.action} disabled={busy || !selectedRows.length} onClick={() => update({ ...draft, campaignIds: [] })}>Clear selected</button>
      <a href={`/optimizer/help?profile=${profileId}`}>Optimization help</a>
    </div>
  </>;
}

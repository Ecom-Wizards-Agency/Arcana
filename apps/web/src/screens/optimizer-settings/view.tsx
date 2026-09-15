'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ONE_TIME_RPC_BID_FIELDS, OneTimeRpcConfiguration, REFERENCE_METHOD, type MethodSelection } from '@wizard-ads/shared';
import { gateMessage } from '../../ui/gate-message';
import { commonOneTimeSettings, completedPreviewWindow } from '../../optimizer/one-time-settings';
import { todayIsoInTimeZone } from '../../../app/_lib/periods';
import { MethodPicker } from '../methods/picker';
import { OptimizerFrame, OptimizerUnavailable } from '../optimizer/frame';
import { draftDefaultMethod, effectiveAcos, readOptimizerDraft, saveOptimizerDraft, type OptimizerDraft } from '../optimizer/draft';
import styles from '../optimizer/optimizer.module.css';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'gated') return <OptimizerUnavailable title="Run settings" message={gateMessage(data.props.entry.state)} />;
  if (data.view === 'empty') return <OptimizerUnavailable title="Run settings" message="No profiles yet." />;
  return <RunSettings data={data} />;
}

const labels = { targetAcos: 'Target ACOS (%)', bidFloor: 'Minimum bid', bidCeiling: 'Maximum bid', bidIncreaseCap: 'Maximum bid increase (%)', bidDecreaseCap: 'Maximum bid decrease (%)' };
export function RunSettings({ data, initialDraft }: { data: Extract<ScreenData, { view: 'ready' }>; initialDraft?: OptimizerDraft }) {
  const router = useRouter();
  const { profile, campaignRows, period } = data.props;
  const [draft, setDraft] = useState<OptimizerDraft>(initialDraft ?? { campaignIds: [] });
  const [method, setMethod] = useState<MethodSelection>(() => initialDraft ? draftDefaultMethod(initialDraft) : REFERENCE_METHOD);
  const form = useRef<HTMLFormElement>(null);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [overrides, setOverrides] = useState(false);
  useEffect(() => {
    const saved = initialDraft ?? readOptimizerDraft(profile.id);
    setDraft(saved); setMethod(draftDefaultMethod(saved)); setValid(null); setPicker(false); setOverrides(false); setError(null);
  }, [profile.id, initialDraft]);
  const rows = campaignRows.filter((row) => draft.campaignIds.includes(row.campaignId));
  const common = draft.configuration ?? commonOneTimeSettings(rows.map((row) => row.oneTimeSettings));
  const today = todayIsoInTimeZone(profile.timezone);
  const window = completedPreviewWindow(period, today);
  const missing = rows.filter((row) => row.groupId !== null && effectiveAcos(row).value === null);
  function parse(form: HTMLFormElement) {
    const fields = new FormData(form);
    return OneTimeRpcConfiguration.safeParse({
      version: method.id === 'sp.coordinated-efficiency' ? 2 : 1, method: method.id,
      ...Object.fromEntries(ONE_TIME_RPC_BID_FIELDS.map((field) => { const raw = String(fields.get(field) ?? ''); return [field, raw === '' ? undefined : Number(raw) / (field.includes('Cap') || field === 'targetAcos' ? 100 : 1)]; })),
      ...(method.id === 'sp.coordinated-efficiency' ? { exposureCeiling: Number(fields.get('exposureCeiling')), minClicksPerPlacement: Number(fields.get('minClicksPerPlacement')), placementEvidenceRequirements: fields.get('placementEvidenceRequirements') } : {}),
      window: { start: fields.get('start'), end: fields.get('end') },
    });
  }
  useEffect(() => {
    if (form.current !== null) {
      const result = parse(form.current);
      setValid(result.success && result.data.window.end < today);
    }
  }, [method.id, draft.campaignIds, today]);
  return <OptimizerFrame title={missing.length ? 'Finish campaign setup' : 'Run settings'} subtitle={`${profile.label} · ${profile.currencyCode}`}>
    <section><h2>Saved campaign settings</h2><p>These values apply to this run. Saving group settings is a separate action.</p></section>
    {missing.length ? <section className={styles.warning} role="alert"><h2>Set a target ACOS for this campaign</h2>{missing.map((row) => <p key={row.campaignId}>{row.name} · Target ACOS missing · <a href={`/optimizer/groups/${row.groupId}/settings?profile=${profile.id}`}>Update {row.groupName ?? 'assigned group'}</a></p>)}<p>If the campaign belongs to a group, update the missing setting in that group.</p></section> : null}
    {!rows.length ? <p>Select campaigns before editing run settings.</p> : <table className={styles.table}><thead><tr><th>Campaign</th><th>Method</th><th>Target ACOS</th></tr></thead><tbody>{rows.map((row) => { const acos = effectiveAcos(row, draft.configuration); const selection = draft.campaignMethods?.[row.campaignId] ?? data.props.savedMethods[row.campaignId] ?? method; const source = draft.campaignMethods?.[row.campaignId] ? 'campaign selection for this run' : data.props.savedMethods[row.campaignId] ? 'assigned group' : 'run default'; return <tr key={row.campaignId}><td>{row.name}</td><td>{selection.id}<small>{selection.version} · {source}</small></td><td>{acos.value === null ? 'Missing target ACOS' : `${acos.value * 100}%`}<small>{acos.source}</small></td></tr>; })}</tbody></table>}
    <div className={styles.actions}><button className={styles.action} onClick={() => setPicker(!picker)}>Change method</button><button className={styles.action} onClick={() => setOverrides(true)}>Edit target ACOS</button><button className={styles.action} onClick={() => setOverrides(true)}>View limits</button></div>
    {picker ? <MethodPicker selection={method} onSelect={(selection) => {
      const edited = form.current === null ? null : parse(form.current);
      setMethod(selection); setDraft({ ...draft, ...(edited?.success ? { configuration: edited.data } : {}),
        campaignMethods: Object.fromEntries(rows.map((row) => [row.campaignId, selection])) });
      setPicker(false); setOverrides(true);
    }} /> : null}
    <p className={styles.muted}>Assigned group settings take precedence. A missing required group value must be fixed in that group.</p>
    <form ref={form} onChange={(event) => { const result = parse(event.currentTarget); setValid(result.success && result.data.window.end < today); }} onSubmit={(event) => {
      event.preventDefault(); const result = parse(event.currentTarget);
      if (!result.success || result.data.window.end >= today || missing.length) { setError('Complete valid settings and use completed reporting days. Missing group values must be fixed in the group.'); return; }
      saveOptimizerDraft(profile.id, { ...draft, configuration: result.data }); router.push(`/optimizer?profile=${profile.id}`);
    }}>
      <details open={overrides || !ONE_TIME_RPC_BID_FIELDS.every((field) => common[field] !== undefined)}><summary>Temporary run fields and limits</summary>
        <fieldset className={styles.fields} key={`${profile.id}:${draft.campaignIds.join(',')}`}>
          {ONE_TIME_RPC_BID_FIELDS.map((field) => <label key={field}>{labels[field]}{field === 'bidFloor' || field === 'bidCeiling' ? ` (${profile.currencyCode})` : ''}<input name={field} type="number" step="any" min="0" required defaultValue={common[field] === undefined ? '' : Number((common[field]! * (field.includes('Cap') || field === 'targetAcos' ? 100 : 1)).toPrecision(12))} /></label>)}
          {method.id === 'sp.coordinated-efficiency' ? <><label>Exposure ceiling ({profile.currencyCode})<input name="exposureCeiling" type="number" step="any" min="0" required defaultValue={draft.configuration?.version === 2 ? draft.configuration.exposureCeiling : ''} /></label><label>Minimum clicks per placement<input name="minClicksPerPlacement" type="number" step="1" min="1" required defaultValue={draft.configuration?.version === 2 ? draft.configuration.minClicksPerPlacement : ''} /></label><label>Placement evidence<select name="placementEvidenceRequirements" defaultValue={draft.configuration?.version === 2 ? draft.configuration.placementEvidenceRequirements : 'single_target'}><option value="single_target">Single-target campaigns</option><option value="validated_homogeneous">Validated homogeneous campaigns</option></select></label></> : null}
          <label>Reporting start<input name="start" type="date" required defaultValue={draft.configuration?.window.start ?? window.start} max={window.lastComplete} /></label><label>Reporting end<input name="end" type="date" required defaultValue={draft.configuration?.window.end ?? window.end} max={window.lastComplete} /></label>
        </fieldset>
      </details>
      <p>Completed reporting days · {profile.timezone}. A changed input requires a fresh preview and approval.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className={styles.footer}>
        <button className={`${styles.action} ${styles.primary}`} type="submit" disabled={missing.length > 0 || !rows.length || (valid === false || (valid === null && (!ONE_TIME_RPC_BID_FIELDS.every((field) => common[field] !== undefined) || method.id === 'sp.coordinated-efficiency')))}>Save settings and continue</button>
        <button className={styles.action} type="button" onClick={() => { saveOptimizerDraft(profile.id, { campaignIds: draft.campaignIds }); router.push(`/optimizer?profile=${profile.id}`); }}>Use saved settings</button>
        <button className={styles.action} type="button" onClick={() => router.push(`/optimizer?profile=${profile.id}`)}>Cancel</button>
      </div>
    </form>
  </OptimizerFrame>;
}

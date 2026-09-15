'use client';
import { useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { DaypartingSchedule, DaypartingEvidenceSummary } from '@wizard-ads/shared';
import type { DaypartingModifiers, DaypartingScheduleProposal } from '@wizard-ads/shared';
import { emptyDaypartingGrid, paintDaypartingGrid, daypartingPreset, daypartingGridFromBlocks, daypartingBlockLabel, daypartingReviewRanges, DAYPARTING_DAYS } from '@wizard-ads/core';
import { EmptyState } from '@wizard-ads/ui';
import { useRouter } from 'next/navigation';
import { ResearchAction, ResearchInfo, researchMutation, researchMoney, researchPercent } from '../query-intelligence/research-ui';
import type { ScreenData } from './view';
import type { DaypartingResults } from '../../dayparting/results';
import '../query-intelligence/research.css';
import './workspace.css';
const executionReason = 'Scheduled writes are not available yet. The reviewed schedule can be exported.';
type Ready = Extract<ScreenData, { view: 'ready' }>['props'];
type Tab = 'schedule' | 'suggestions' | 'results';
type Surface = 'main' | 'review' | 'evidence';
export function DaypartingWorkspaceView({ data, measurement, initialTab = 'schedule', initialSurface = 'main', initialEvidence = null }: { data: Ready; measurement: ReactNode; initialTab?: Tab; initialSurface?: Surface; initialEvidence?: DaypartingEvidenceSummary | null }) {
  const router = useRouter();
  const [schedules, setSchedules] = useState(data.research.schedules), [schedule, setSchedule] = useState<DaypartingSchedule | null>(schedules[0] ?? null), [tab, setTab] = useState<Tab>(initialTab), [surface, setSurface] = useState<Surface>(initialSurface);
  const [name, setName] = useState(schedule?.name ?? 'Untitled schedule'), [modifiers, setModifiers] = useState<DaypartingModifiers>(schedule?.modifiers ?? emptyDaypartingGrid()), [campaignIds, setCampaignIds] = useState(schedule?.campaignIds ?? []), [source, setSource] = useState<string | null>(schedule?.sourceProposalId ?? null);
  const [paint, setPaint] = useState(0), [start, setStart] = useState(0), [end, setEnd] = useState(24), [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [evidence, setEvidence] = useState(initialEvidence);
  const [window, setWindow] = useState({
    start: data.from,
    end: data.to
  }), [showAll, setShowAll] = useState(false), [creating, setCreating] = useState(false);
  const editable = !schedule || schedule.status === 'draft' || schedule.status === 'reviewed';
  function choose(next: DaypartingSchedule | null) {
    setSchedule(next);
    setName(next?.name ?? 'Untitled schedule');
    setModifiers(next?.modifiers ?? emptyDaypartingGrid());
    setCampaignIds(next?.campaignIds ?? []);
    setSource(next?.sourceProposalId ?? null);
    setDirty(false);
    setEvidence(null);
    setSurface('main');
    setCreating(next === null);
  }
  function grid(next: DaypartingModifiers) {
    setModifiers(next);
    setDirty(true);
    setEvidence(null);
  }
  async function save(review = false) {
    setBusy(true);
    setError('');
    try {
      const result = await researchMutation('/api/dayparting/schedules', {
        profileId: data.profile.id,
        ...(schedule ? {
          id: schedule.id,
          expectedUpdatedAt: schedule.updatedAt
        } : {}),
        name,
        modifiers,
        campaignIds,
        sourceProposalId: source
      });
      const saved = DaypartingSchedule.parse(result['schedule']);
      setSchedule(saved);
      setSchedules([...schedules.filter(s => s.id !== saved.id), saved]);
      setDirty(false);
      setCreating(false);
      setEvidence(null);
      if (review) setSurface('review');
      return saved;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Schedule could not be saved');
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function showEvidence() {
    setSurface('evidence');
    setError('');
    if (!schedule || dirty) return;
    try {
      const response = await fetch(`/api/dayparting/schedules/evidence?${new URLSearchParams({
        profileId: data.profile.id,
        id: schedule.id,
        from: window.start,
        to: window.end
      })}`);
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result['error']));
      setEvidence(DaypartingEvidenceSummary.parse(result['evidence']));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hourly evidence is unavailable');
    }
  }
  async function reviewEvidence() {
    if (!schedule || !evidence) return;
    setBusy(true);
    setError('');
    try {
      const result = await researchMutation('/api/dayparting/schedules/review', {
        profileId: data.profile.id,
        id: schedule.id,
        expectedUpdatedAt: schedule.updatedAt,
        evidenceStart: window.start,
        evidenceEnd: window.end,
        evidenceFingerprint: evidence.fingerprint
      });
      const saved = DaypartingSchedule.parse(result['schedule']);
      setSchedule(saved);
      setSchedules(schedules.map(s => s.id === saved.id ? saved : s));
      setSurface('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review could not be saved');
    } finally {
      setBusy(false);
    }
  }
  function fromProposal(proposal: DaypartingScheduleProposal) {
    try {
      const full = daypartingGridFromBlocks(proposal.blocks);
      choose(null);
      setName(proposal.baselineLabel);
      setModifiers(full);
      setCampaignIds([proposal.campaignId]);
      setSource(proposal.id ?? null);
      setWindow({
        start: proposal.evidenceStart,
        end: proposal.evidenceEnd
      });
      setDirty(true);
      setTab('schedule');
      setSurface('review');
    } catch {
      setError('This proposal contains unsupported or overlapping hourly modifiers. Review its export before creating a whole-percent schedule.');
    }
  }
  const currentFacts = data.selectedFacts.filter(f => (!campaignIds.length || campaignIds.includes(f.campaignId)) && f.localDate >= window.start && f.localDate <= window.end);
  const hasEvidence = evidence ? evidence.factRows > 0 : currentFacts.length > 0;
  const mature = evidence ? evidence.maturityPolicyConfigured && evidence.factRows > 0 && evidence.settledRows === evidence.factRows : data.workspace.maturityPolicyConfigured && currentFacts.length > 0 && currentFacts.every(f => f.settlingState === 'settled');
  const coverage = evidence ? evidence.coveredCampaignIds.length : new Set(currentFacts.map(f => f.campaignId)).size;
  const evidenceReady = !!evidence && mature && campaignIds.length > 0 && coverage === campaignIds.length && !dirty;
  const reviewed = schedule?.status === 'reviewed' && !dirty;
  const title = surface === 'review' ? 'Review suggested schedule' : surface === 'evidence' ? 'Hourly performance' : 'Dayparting';
  const status = dirty ? 'Draft' : schedule ? `${schedule.status[0]!.toUpperCase()}${schedule.status.slice(1)}` : 'Draft';
  return <main className="research"><header><h1>{title}</h1><p className="muted">{data.profile.label} · {data.profile.countryCode} · {data.profile.timezone}</p></header>
    <nav className="research-tabs" aria-label="Dayparting tabs">{(['schedule', 'suggestions', 'results'] as const).map(t => <ResearchAction primary={tab === t && surface === 'main'} key={t} aria-pressed={tab === t && surface === 'main'} onClick={() => {
      setTab(t);
      setSurface('main');
    }}>{t[0]!.toUpperCase() + t.slice(1)}</ResearchAction>)}</nav>
    {error ? <p role="alert">{error}</p> : null}
    {surface === 'evidence' ? <><h2>{name}</h2><div className="research-actions"><label className="research-field">Evidence from<input type="date" value={window.start} onChange={e => {
      setWindow({
        ...window,
        start: e.target.value
      });
      setEvidence(null);
    }} /></label><label className="research-field">Evidence to<input type="date" value={window.end} onChange={e => {
      setWindow({
        ...window,
        end: e.target.value
      });
      setEvidence(null);
    }} /></label></div><p>{window.start} to {window.end} · {data.profile.timezone} · {campaignIds.length || data.campaignChoices.length} campaign(s)</p><table className="research-table"><thead><tr><th>Hourly evidence</th><th>Status</th></tr></thead><tbody>
      <tr><td>Hourly spend, sales and orders</td><td>{hasEvidence ? 'Available in this report' : 'Unavailable in this report'}</td></tr><tr><td>Attribution maturity</td><td>{mature ? 'Verified: settled evidence' : hasEvidence ? 'Not verified: evidence is settling or policy is unavailable' : 'Not verified'}</td></tr><tr><td>Campaign coverage</td><td>{coverage} of {campaignIds.length || data.campaignChoices.length} campaign(s) selected</td></tr><tr><td>Schedule comparison</td><td>{hasEvidence && mature ? 'Hourly evidence can be reviewed' : 'Cannot be evaluated without mature hourly data'}</td></tr></tbody></table>
      {!hasEvidence ? <div className="research-card warn"><h2>Hourly evidence is unavailable</h2><p>Try loading the report again or choose a longer period. A performance-based suggestion cannot be verified from this report.</p></div> : null}
      <div className="research-actions"><ResearchAction onClick={() => {
        void showEvidence();
        router.refresh();
      }}>Retry report</ResearchAction>{schedule && editable ? <ResearchAction primary disabled={!evidenceReady || busy} onClick={() => void reviewEvidence()}>Record evidence review</ResearchAction> : null}<ResearchAction onClick={() => {
        setTab('suggestions');
        setSurface('main');
      }}>Back to suggestions</ResearchAction></div>
      {measurement}</> : surface === 'review' ? <><h2>{name}</h2><p>{campaignIds.length} campaign(s) · {data.profile.timezone}</p>
        <table className="research-table"><thead><tr><th>Setting / Hours</th><th>Current</th><th>Proposed</th></tr></thead><tbody>{daypartingReviewRanges(modifiers).map(c => <tr key={c.label}><td>{c.label}</td><td>Base bid, 0%</td><td>{c.value > 0 ? '+' : ''}{c.value}%</td></tr>)}</tbody></table><p>Other hours: Use the full schedule below</p>
        <div className="research-actions"><ResearchAction onClick={() => setShowAll(!showAll)}>View all 168 hours</ResearchAction><ResearchAction onClick={() => void showEvidence()}>Review hourly evidence</ResearchAction></div>{showAll ? <ModifierGrid modifiers={modifiers} editable={false} paint={paint} onChange={grid} /> : null}
        {!schedule || dirty ? <div className="research-card warn"><h2>Save this draft before reviewing evidence</h2><p>The review records this schedule, its campaign set and the supporting report.</p><ResearchAction primary disabled={busy || !campaignIds.length} onClick={() => void save(true)}>Save draft for review</ResearchAction></div> : null}
        {!reviewed ? <div className="research-card warn"><h2>Review the supporting hourly report</h2><p>Check attribution maturity, campaign coverage and hourly spend before enabling this proposal.</p><ResearchAction disabled>Enable after evidence review</ResearchAction></div> : <div className="research-card"><h2>Schedule reviewed</h2><p>Reviewed {schedule?.review?.reviewedAt} · {schedule?.review?.campaignIds.length} campaign(s)</p><p>Only the reviewed schedule can be considered for a future cadence. New suggestions require another review.</p></div>}
        <p>{executionReason}</p><div className="research-actions"><ResearchAction primary disabled title={executionReason}>Yes, enable this schedule for {campaignIds.length} campaign(s)</ResearchAction>{schedule ? <ScheduleExports schedule={schedule} /> : null}<ResearchAction onClick={() => {
          setTab('suggestions');
          setSurface('main');
        }}>Back to suggestions</ResearchAction></div></> : tab === 'suggestions' ? <><h2>Review a schedule before enabling it</h2><p>{data.from} to {data.to} · {data.profile.timezone} · {data.campaignChoices.length} campaign(s)</p>
          {data.proposals.length ? <table className="research-table"><thead><tr><th>Schedule</th><th>Proposed hours</th><th>Evidence</th><th>Review</th></tr></thead><tbody>{data.proposals.map(p => <tr key={p.id ?? p.campaignId}><td>{p.baselineLabel}</td><td>{p.blocks.map((b, i) => <div key={i}>{daypartingBlockLabel(b)}</div>)}</td><td>Review hourly performance</td><td><ResearchAction onClick={() => fromProposal(p)}>Review</ResearchAction></td></tr>)}</tbody></table> : <div className="research-card warn"><h2>Not enough hourly data to suggest a schedule</h2><p>No schedule has been generated. Review the report coverage or choose a longer period.</p><div className="research-actions"><ResearchAction onClick={() => void showEvidence()}>Review data coverage</ResearchAction><ResearchAction onClick={() => void showEvidence()}>Choose another period</ResearchAction><ResearchAction onClick={() => setTab('schedule')}>Return to schedule</ResearchAction></div></div>}
          <p>Suggestions do not change the active schedule. Review the proposed hours, evidence and limits before enabling one.</p><div className="research-actions"><ResearchAction onClick={() => void showEvidence()}>View hourly evidence</ResearchAction><ResearchInfo label="Why no suggestion?"><p>{data.workspace.maturityPolicyConfigured ? 'No eligible proposal is recorded for this window. A suggestion requires settled hourly evidence and approved model inputs.' : 'No tenant dayparting settling window is configured. A suggestion requires approved evidence and model inputs.'}</p></ResearchInfo></div></> : tab === 'results' ? <DaypartingResultsView schedule={schedule} results={schedule ? data.research.results[schedule.id] ?? null : null} currencyCode={data.profile.currencyCode} /> : <>
            <div className="research-actions"><select aria-label="Saved schedule" value={schedule?.id ?? ''} onChange={e => choose(schedules.find(s => s.id === e.target.value) ?? null)}><option value="">New schedule</option>{schedules.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select><span className="research-chip">{campaignIds.length} campaigns</span><span className="research-chip" data-schedule-state={status.toLowerCase()}>{status}</span><ResearchAction onClick={() => choose(null)}>New schedule</ResearchAction></div>
            {schedule?.status === 'enabled' || schedule?.status === 'paused' ? <ScheduleExecutionStatus schedule={schedule} onReview={() => setSurface('review')} onResults={() => setTab('results')} /> : null}
            {!schedule && !creating ? <EmptyState title="No saved schedule" body="Create a draft and review the exact campaigns and hourly evidence before any future cadence." action={<ResearchAction onClick={() => setCreating(true)}>Create schedule</ResearchAction>} /> : null}
            {campaignIds.length ? <div className="research-card warn">While a schedule is assigned, make bid changes here only. Changes made elsewhere are overwritten when scheduled writes are enabled. Bids shown across the app are the base bid, before any dayparting modifier. Schedules run in the profile’s timezone. One campaign, one schedule.</div> : null}
            <div className="research-actions"><label className="research-field">Schedule name<input value={name} disabled={!editable} onChange={e => {
              setName(e.target.value);
              setDirty(true);
            }} /></label><label className="research-field">Paint %<input type="number" min={-99} max={300} step={1} value={paint} onChange={e => setPaint(Number(e.target.value))} /></label>
              <label className="research-field">Day selection<select onChange={e => setDays(e.target.value === 'weekend' ? [0, 6] : e.target.value === 'all' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5])}><option value="weekdays">Weekdays</option><option value="weekend">Weekend</option><option value="all">Every day</option></select></label><label className="research-field">From hour<input type="number" min={0} max={23} value={start} onChange={e => setStart(Number(e.target.value))} /></label><label className="research-field">To hour<input type="number" min={1} max={24} value={end} onChange={e => setEnd(Number(e.target.value))} /></label><ResearchAction disabled={!editable} onClick={() => {
                try {
                  grid(paintDaypartingGrid(modifiers, days, start, end, paint));
                } catch {
                  setError('Use whole percentages from −99 to +300 and a valid hour range.');
                }
              }}>Paint range</ResearchAction>
              {(['weekdays', 'weekend', 'working-hours'] as const).map(p => <ResearchAction key={p} disabled={!editable} onClick={() => {
                try {
                  grid(daypartingPreset(modifiers, p, paint));
                } catch {
                  setError('Use a whole percentage from −99 to +300.');
                }
              }}>{p === 'working-hours' ? 'Working hours' : p === 'weekend' ? 'Weekend preset' : 'Weekday preset'}</ResearchAction>)}<ResearchAction disabled={!editable} onClick={() => grid(emptyDaypartingGrid())}>Reset all</ResearchAction></div>
            <fieldset className="daypart-campaigns"><legend>Campaign assignment</legend>{data.research.campaigns.map(c => <label key={c.id}><input type="checkbox" disabled={!editable} checked={campaignIds.includes(c.id)} onChange={e => {
              setCampaignIds(e.target.checked ? [...campaignIds, c.id] : campaignIds.filter(id => id !== c.id));
              setDirty(true);
              setEvidence(null);
            }} />{c.name}</label>)}</fieldset>
            <ModifierGrid modifiers={modifiers} editable={editable} paint={paint} onChange={grid} /><p className="muted">0% uses the base bid. Modifiers range from −99% to +300% in whole percentages.</p><p className="muted">Drag across cells to paint a range. Saving a draft does not start hourly runs.</p>
            <div className="research-actions"><ResearchAction primary disabled={!editable || busy || !campaignIds.length} onClick={() => {
              if (!schedule || dirty) void save(true); else setSurface('review');
            }}>Review schedule</ResearchAction><ResearchAction disabled={!editable || busy} onClick={() => void save()}>Save draft</ResearchAction><ResearchAction onClick={() => setTab('suggestions')}>View suggestions</ResearchAction><ResearchAction onClick={() => void showEvidence()}>Hourly performance</ResearchAction></div>
            {!data.selectedFacts.length ? <p className="muted">No hourly evidence in this window</p> : null}</>}
  </main>;
}
export function ModifierGrid({ modifiers, editable, paint, onChange }: { modifiers: DaypartingModifiers; editable: boolean; paint: number; onChange: (next: DaypartingModifiers) => void }) {
  const drag = useRef<{ day: number; hour: number; original: DaypartingModifiers } | null>(null);
  function range(day: number, hour: number) {
    const anchor = drag.current;
    if (!anchor) return;
    const order = [1, 2, 3, 4, 5, 6, 0];
    const first = order.indexOf(anchor.day), last = order.indexOf(day);
    const days = order.slice(Math.min(first, last), Math.max(first, last) + 1);
    try {
      onChange(paintDaypartingGrid(anchor.original, days, Math.min(hour, anchor.hour), Math.max(hour, anchor.hour) + 1, paint));
    } catch {/* Invalid paint values leave the original grid intact. */ }
  }
  return <div className="research-table-scroll"><div className="daypart-grid" role="grid" aria-label="Schedule modifiers, 168 hours" onPointerUp={() => {
    drag.current = null;
  }} onPointerLeave={() => {
    drag.current = null;
  }}><span />{Array.from({ length: 24 }, (_, h) => <span role="columnheader" className="hour" key={h}>{String(h).padStart(2, '0')}</span>)}{[1, 2, 3, 4, 5, 6, 0].flatMap(day => [<strong role="rowheader" className="day" key={`day-${day}`}>{DAYPARTING_DAYS[day]}</strong>, ...modifiers[day]!.map((value, hour) => <button type="button" role="gridcell" key={`${day}:${hour}`} disabled={!editable} className={value === 0 ? 'neutral' : value > 0 ? 'positive' : 'negative'} style={{ '--daypart-mix': `${Math.min(70, 12 + Math.abs(value) / 3)}%` } as CSSProperties} aria-label={`${DAYPARTING_DAYS[day]} ${hour}:00 ${value}%`}
    onPointerDown={e => {
      if (e.button !== 0) return;
      drag.current = {
        day,
        hour,
        original: modifiers
      };
      range(day, hour);
    }} onPointerEnter={() => range(day, hour)} onKeyDown={e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        try {
          onChange(paintDaypartingGrid(modifiers, [day], hour, hour + 1, paint));
        } catch {/* Bounds are validated before mutation. */ }
      }
    }}>{value > 0 ? '+' : ''}{value}%</button>)])}</div></div>;
}
function ScheduleExports({ schedule }: { schedule: DaypartingSchedule }) {
  return <>{(['csv', 'json'] as const).map(format => <a className="research-action" key={format} href={`/api/dayparting/export?${new URLSearchParams({
    profileId: schedule.profileId,
    scheduleId: schedule.id,
    format
  })}`}>Export {format.toUpperCase()}</a>)}</>;
}
export function ScheduleExecutionStatus({ schedule, onReview, onResults, initialStopOpen = false }: { schedule: DaypartingSchedule; onReview: () => void; onResults: () => void; initialStopOpen?: boolean }) {
  const enabled = schedule.status === 'enabled';
  return <section className={`research-card ${enabled ? 'good' : ''}`}><h2>{schedule.name} is {schedule.status}</h2>{enabled ? <><p>{schedule.campaignIds.length} campaign(s) · {schedule.timezone} · Next run at {schedule.nextRunAt ?? 'Unavailable from the cadence backend'}</p><p>Only the reviewed schedule runs automatically. New suggestions wait for review.</p></> : <><p>No new scheduled writes will start. A request already sent to Amazon may still finish.</p><p>Resuming requires review of the schedule, campaigns and current limits.</p></>}
    <p>Campaigns: {schedule.campaignIds.join(', ')}</p><p>Profile kill switch: {schedule.profileKillSwitch === null ? 'Unavailable' : schedule.profileKillSwitch ? 'Stopped' : 'Open'}</p><p>Cadence limits: {schedule.cadenceLimits ? Object.entries(schedule.cadenceLimits).map(([key, value]) => `${key}: ${value}`).join(' · ') : 'Unavailable'}</p>
    <div className="research-actions">{enabled ? <><ResearchAction disabled title={executionReason}>Pause schedule</ResearchAction><ResearchInfo label="Stop all scheduled writes" initialOpen={initialStopOpen}><h2>Stop all scheduled writes?</h2><p>Stop new scheduled writes for this profile. Requests already sent to Amazon may still finish. Resume schedules only after review.</p><p>{executionReason}</p><ResearchAction disabled>Stop scheduled writes</ResearchAction></ResearchInfo></> : <ResearchAction onClick={onReview}>Review before resuming</ResearchAction>}<ResearchAction onClick={onResults}>View results</ResearchAction></div></section>;
}
export function DaypartingResultsView({ schedule, results, currencyCode }: { schedule: DaypartingSchedule | null; results: DaypartingResults | null; currencyCode: string }) {
  const [period, setPeriod] = useState<'before' | 'after'>('after');
  const mature = results?.mature === true;
  return <section className="research"><h2>Results</h2><p>{schedule ? `${schedule.name} · ${schedule.campaignIds.length} campaign(s)` : 'No enabled schedule to compare'}</p><div className="research-actions"><ResearchAction aria-pressed={period === 'before'} onClick={() => setPeriod('before')}>Before enablement</ResearchAction><ResearchAction aria-pressed={period === 'after'} onClick={() => setPeriod('after')}>After enablement</ResearchAction></div>{results ? <p>{results[period].start} to {results[period].end}</p> : null}
    <table className="research-table"><thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>{(['spend', 'sales', 'acos', 'orders'] as const).map(metric => {
      const before = results?.before[metric] ?? null, after = results?.after[metric] ?? null;
      const format = (v: number | null) => metric === 'acos' ? researchPercent(v) : metric === 'orders' ? v ?? '—' : researchMoney(v, currencyCode);
      return <tr key={metric}><td>{metric === 'acos' ? 'ACOS' : metric[0]!.toUpperCase() + metric.slice(1)}</td><td>{results?.before.complete ? format(before) : 'Pending'}</td><td>{mature ? format(after) : 'Pending'}</td><td>{mature ? before !== null && after !== null && before !== 0 ? researchPercent((after - before) / before) : '—' : 'Pending until mature'}</td></tr>;
    })}</tbody></table>
    {!mature ? <div className="research-card warn"><h2>Waiting for mature performance data</h2><p>Compare equivalent periods once enough attributed data is available. Overlapping promotions, stock changes and other edits can affect the result.</p></div> : null}
    {results?.events.length ? <section><h2>Overlapping Timeline events</h2><ul>{results.events.map(event => <li key={event.id}>{event.name} · {event.kind} · {event.start} to {event.end ?? 'ongoing'}</li>)}</ul></section> : null}<p>Before-and-after differences show observed performance. They do not establish that dayparting caused the change.</p></section>;
}

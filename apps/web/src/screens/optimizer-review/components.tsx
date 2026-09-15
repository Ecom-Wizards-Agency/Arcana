'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { RecommendationRecord } from '@wizard-ads/db';
import type { CalculationTrace, DependencySet, Hold, MethodEvaluatorInput } from '@wizard-ads/shared';
import { money, changeValue, recommendationReason } from './presentation';
import { tokens } from '@wizard-ads/ui';
import { optimizerCalculationHref } from '../optimizer/navigation';
import { changedPercent, displayValue, holdScope, recordedDependencyExposures, recordedMetric, reviewUnits, selectedChangeCount, selectedIncludesShadow, targetName, type RecordedPlacementInput, type UnchangedTarget } from './model';

export const optimizerStyles = {
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.space(6), minWidth: 0 } as CSSProperties,
  card: { padding: tokens.space(6), background: tokens.color.surface, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md } as CSSProperties,
  warning: { padding: tokens.space(5), background: tokens.color.warnSoft, color: tokens.color.warn, border: `1px solid ${tokens.color.warnBorder}`, borderRadius: tokens.radius.md } as CSSProperties,
  shadow: { padding: tokens.space(5), background: 'var(--wa-surface-sunken)', color: tokens.color.textMuted, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md } as CSSProperties,
  action: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '12px 16px', borderRadius: 8, border: `1px solid ${tokens.color.border}`, background: tokens.color.surface, color: tokens.color.text, fontFamily: tokens.font.sans, fontSize: 14, fontWeight: 600, lineHeight: '20px', textDecoration: 'none', cursor: 'pointer' } as CSSProperties,
  primary: { background: tokens.color.accent, color: tokens.color.text, border: `1px solid ${tokens.color.accent}` } as CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: tokens.font.size.sm, textAlign: 'left' } as CSSProperties,
  cell: { padding: '16px', verticalAlign: 'top', borderBottom: `1px solid ${tokens.color.border}` } as CSSProperties,
  muted: { color: tokens.color.textMuted, fontSize: tokens.font.size.sm } as CSSProperties,
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.space(3) } as CSSProperties,
};

/** Hover and keyboard share one disclosure; Escape always restores its trigger. */
export function InfoPopover({ label, children, initialOpen = false }: { label: string; children: ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [pinned, setPinned] = useState(initialOpen);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) { setOpen(false); setPinned(false); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); setPinned(false); trigger.current?.focus(); }
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <span ref={root} style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle', alignSelf: 'flex-start', width: 'fit-content' }}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!pinned) setOpen(false); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setPinned(false); } }}>
    <button ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
      onClick={() => { setOpen(!pinned); setPinned(!pinned); }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!pinned); setPinned(!pinned); } }}
      style={{ ...optimizerStyles.action, padding: '2px 6px', border: 0, background: 'transparent' }}>ⓘ</button>
    {open ? <span id={id} role="tooltip" style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, width: 'min(340px, 80vw)', paddingTop: tokens.space(2) }}>
      <span style={{ ...optimizerStyles.card, display: 'block', fontWeight: 400, color: tokens.color.text }}>{children}</span>
    </span> : null}
  </span>;
}

export function DataTable({ headers, children, label }: { headers: readonly string[]; children: ReactNode; label?: string }) {
  return <div style={{ overflowX: 'auto' }}><table aria-label={label} style={optimizerStyles.table}>
    <thead><tr>{headers.map((header) => <th key={header} scope="col" style={{ ...optimizerStyles.cell, background: 'var(--wa-surface-sunken)', color: tokens.color.textMuted, fontWeight: 600 }}>{header}</th>)}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>;
}

export function Cell({ children }: { children: ReactNode }) { return <td style={optimizerStyles.cell}>{children}</td>; }

export interface ReviewContentProps {
  snapshots?: readonly MethodEvaluatorInput[];
  rows: readonly RecommendationRecord[];
  holds?: readonly Hold[];
  unchanged?: readonly UnchangedTarget[];
  evaluatedTargets?: number | null;
  selected: ReadonlySet<string>;
  onToggle: (ids: readonly string[]) => void;
  onContinue: () => void;
  onClear?: () => void;
  profileId: string;
  batchId: string;
  currencyCode: string;
  busy?: boolean;
  details?: ReactNode;
  retry?: { excludedSuccessfulNames: readonly string[] };
  initialTab?: 'suggestions' | 'unchanged' | 'blocked' | 'details';
  population?: { suggestions: number | null; unchanged: number | null; blocked: number | null };
}

export function ReviewContent({ snapshots = [], rows, holds = [], unchanged = [], evaluatedTargets, selected, onToggle, onContinue, onClear, profileId, batchId, currencyCode, busy = false, details, retry, initialTab = 'suggestions', population }: ReviewContentProps) {
  const [tab, setTab] = useState<string>(initialTab);
  const units = reviewUnits(rows);
  const count = selectedChangeCount(units, selected);
  const shadowSelected = selectedIncludesShadow(units, selected);
  const totals = population ?? { suggestions: units.length, unchanged: unchanged.length, blocked: holds.length };
  const countLabel = (value: number | null) => value === null ? 'Unavailable' : value;
  const incomplete = evaluatedTargets != null && totals.suggestions !== null && totals.unchanged !== null && totals.blocked !== null
    && evaluatedTargets !== totals.suggestions + totals.unchanged + totals.blocked;
  const suffix = `?profile=${encodeURIComponent(profileId)}`;
  const tabs = [{ id: 'suggestions', label: `Suggestions ${countLabel(totals.suggestions)}` }, { id: 'unchanged', label: `Unchanged ${countLabel(totals.unchanged)}` }, { id: 'blocked', label: `Blocked ${countLabel(totals.blocked)}` }, { id: 'details', label: 'Run details' }];
  return <section style={optimizerStyles.stack} aria-label={retry ? 'Review unresolved change' : 'Review suggestions'}>
    {retry ? <div style={optimizerStyles.card}><h2>Review unresolved change</h2><p>The earlier successful changes are excluded: {retry.excludedSuccessfulNames.join(', ') || 'None recorded'}.</p><p>This review uses a fresh preview of the unresolved rows.</p></div> : null}
    <div role="tablist" aria-label="Suggestion views" style={optimizerStyles.actions}>
      {tabs.map((item, index) => <button key={item.id} role="tab" type="button" id={`review-tab-${item.id}`} aria-controls={`review-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
        onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); const item = tabs[next]!; setTab(item.id); document.getElementById(`review-tab-${item.id}`)?.focus();
        }} onClick={() => setTab(item.id)} style={{ ...optimizerStyles.action, ...(tab === item.id ? optimizerStyles.primary : {}) }}>{item.label}</button>)}
    </div>
    <div role="tabpanel" id={`review-panel-${tab}`} aria-labelledby={`review-tab-${tab}`} style={optimizerStyles.stack}>
      {tab === 'suggestions' ? <>
        {units.length > 0 ? <h2 style={{ margin: 0, fontSize: 16 }}>{units.length} suggestion{units.length === 1 ? '' : 's'} to review</h2> : null}
        {units.length === 0 ? <p>No suggestions were recorded for this run.</p> : <DataTable headers={['Target / Campaign', 'Current bid', 'New bid', 'Reason', 'Select']} label="Suggested changes">
          {units.map((unit) => { const row = unit.rows[0]!; return <tr key={unit.id} data-testid={`optimizer-suggestion-${row.id}`}>
            <Cell><strong>{targetName(row)}</strong><div style={optimizerStyles.muted}>{row.campaignName ?? row.campaignId ?? 'Campaign unavailable'}</div><details><summary>View full details</summary><ExpandedRow row={row} currencyCode={currencyCode} />{unit.dependencySet ? <DependencyContent set={unit.dependencySet} currencyCode={currencyCode} peakExposureByStep={recordedDependencyExposures(row)} /> : null}</details></Cell>
            <Cell>{changeValue(row.currentValue, row.field, currencyCode)}</Cell><Cell>{changeValue(row.proposedValue, row.field, currencyCode)}</Cell>
            <Cell>{recommendationReason(row, snapshots)}{unit.shadow ? <p>Shadow only · preview available</p> : null}<div><a href={optimizerCalculationHref(batchId, row.id, profileId)}>View calculation</a></div></Cell>
            <Cell><input type="checkbox" aria-label={`Select ${targetName(row)}${unit.dependencySet ? ' and its dependent changes' : ''}`} checked={unit.rows.every((item) => selected.has(item.id))} disabled={busy || !unit.selectable} onChange={() => onToggle(unit.rows.map((item) => item.id))} /></Cell>
          </tr>; })}
        </DataTable>}
        <div style={optimizerStyles.actions}>
          {units.filter((unit) => unit.selectable).length > 1 ? <button type="button" style={optimizerStyles.action} disabled={busy} onClick={() => onToggle(units.filter((unit) => unit.selectable && !unit.rows.every((row) => selected.has(row.id))).flatMap((unit) => unit.rows.map((row) => row.id)))}>{units.length === 2 ? 'Select both changes' : 'Select all changes'}</button> : null}
          {selected.size > 0 ? <button type="button" style={optimizerStyles.action} disabled={busy} onClick={() => onClear ? onClear() : onToggle([...selected])}>Clear selection</button> : null}
        </div>
      </> : null}
      {tab === 'unchanged' ? <><h2>Unchanged targets</h2>{unchanged.length === 0 ? <p>{totals.unchanged === null ? 'Retained unchanged outcomes are unavailable for this historical run.' : 'No retained unchanged rows were recorded.'}</p> : <DataTable headers={['Target', 'Current / Proposed', 'Reason']} label="Unchanged targets">{unchanged.map((row) => <tr key={row.id}><Cell>{row.name}<div style={optimizerStyles.muted}>{row.campaignName}</div></Cell><Cell>{money(row.currentValue, currencyCode)} / {money(row.proposedValue, currencyCode)}</Cell><Cell>{row.reason}</Cell></tr>)}</DataTable>}<p>Unchanged targets are included in the evaluated targets. They cannot be selected for sending.</p></> : null}
      {tab === 'blocked' ? <><h2>Blocked targets</h2>{holds.length === 0 ? <p>{totals.blocked === null ? 'The blocked target count is unavailable for this historical run.' : 'No holds were recorded.'}</p> : holds.map((hold, index) => <HoldContent hold={hold} settingsHref={`/optimizer/settings${suffix}`} key={`${hold.reason}-${index}`} />)}</> : null}
      {tab === 'details' ? details ?? <p>Run snapshot details are unavailable for this historical preview.</p> : null}
    </div>
    <p data-testid="optimizer-evaluation-totals">{evaluatedTargets == null ? 'Evaluated target total unavailable. ' : `${evaluatedTargets} targets evaluated: `}{countLabel(totals.suggestions)} suggestions, {countLabel(totals.unchanged)} unchanged, {countLabel(totals.blocked)} blocked.</p>
    {incomplete ? <p role="alert" style={optimizerStyles.warning}>The saved target counts do not reconcile. A complete evaluation is required before reviewing changes for sending.</p> : null}
    <div style={{ ...optimizerStyles.actions, borderTop: `1px solid ${tokens.color.border}`, paddingTop: tokens.space(6) }}><a style={optimizerStyles.action} href={`/optimizer${suffix}`}>Back to campaigns</a>
      <button type="button" onClick={onContinue} disabled={busy || count === 0 || shadowSelected || incomplete} style={{ ...optimizerStyles.action, ...optimizerStyles.primary, opacity: busy || count === 0 || shadowSelected || incomplete ? 0.55 : 1 }}>{shadowSelected ? 'Send to Amazon unavailable in shadow' : count === 0 ? 'Select changes to continue' : `Review ${count} selected change${count === 1 ? '' : 's'}`}</button>
    </div>
  </section>;
}

export function HoldContent({ hold, settingsHref = '/optimizer/settings' }: { hold: Hold; settingsHref?: string }) {
  return <article style={optimizerStyles.warning}><h3>{hold.reason === 'NO_FEASIBLE_CONTROL_SET' ? 'The bid and exposure limits conflict' : hold.reason.replaceAll('_', ' ')}</h3><p>{hold.prose}</p><p><strong>Reason:</strong> {hold.reason}</p><p><strong>Scope:</strong> {holdScope(hold)}</p><p><strong>Reconsider when:</strong> {hold.reconsiderWhen}</p><a href={settingsHref}>Review limits</a></article>;
}

function ExpandedRow({ row, currencyCode }: { row: RecommendationRecord; currencyCode: string }) {
  const percent = changedPercent(row.currentValue, row.proposedValue);
  const fields = [
    ['Rank group', recordedMetric(row, ['rank group', 'rankgroup', 'organic rank'])],
    ['Evidence window', row.inputs.window ? `${row.inputs.window.start} to ${row.inputs.window.end}` : 'Unavailable'],
    ['Clicks', displayValue(row.inputs.clicks)], ['Orders', recordedMetric(row, ['orders'])], ['CVR', recordedMetric(row, ['cvr', 'conversion rate'])],
    ['RPC', money(row.inputs.rpc, currencyCode)], ['Current bid', changeValue(row.currentValue, row.field, currencyCode)], ['Proposed bid', changeValue(row.proposedValue, row.field, currencyCode)],
    ['Change %', percent === null ? 'Unavailable' : `${percent.toFixed(2)}%`],
    ['Bounds hit', [row.inputs.floorApplied, row.inputs.ceilingApplied, row.inputs.capClamped ? 'Change cap' : null].filter(Boolean).join(' · ') || 'None recorded'],
    ['Method · version', `${row.inputs.methodId ?? 'Method unavailable'} · ${row.inputs.methodVersion ?? 'Version unavailable'}`],
  ];
  return <DataTable headers={['Field', 'Recorded value']} label="Full preview details">{fields.map(([label, value]) => <tr key={label}><Cell>{label}</Cell><Cell>{value}</Cell></tr>)}</DataTable>;
}

export function DependencyContent({ set, currencyCode, peakExposureByStep }: { set: DependencySet; currencyCode: string; peakExposureByStep?: readonly (number | null)[] }) {
  return <section style={optimizerStyles.stack}><h3>Dependent changes</h3><p>These controls depend on each other. The set is selected and reviewed together.</p><DataTable headers={['Order', 'Control', 'Current', 'Proposed', 'Peak exposure after step']} label="Ordered dependent writes">
    {set.changes.map((change, index) => <tr key={`${change.control}-${index}`}><Cell>{index + 1}</Cell><Cell>{change.control === 'target_bid' ? 'Base bid' : change.control === 'placement_adjustment' ? change.placementKey.replaceAll('_', ' ') : change.control.replaceAll('_', ' ')}<div style={optimizerStyles.muted}>{set.precedenceReasons[index] ?? 'Final dependent write'}</div></Cell><Cell>{changeValue(change.current, change.control, currencyCode)}</Cell><Cell>{changeValue(change.proposed, change.control, currencyCode)}</Cell><Cell>{peakExposureByStep?.[index] == null ? 'Not recorded' : money(peakExposureByStep[index], currencyCode)}</Cell></tr>)}
  </DataTable><p><strong>Ordering constraint:</strong> {set.precedenceReasons.join(' Then ')}</p><p><strong>Partial-failure rule:</strong> Stop the dependent sequence and report the partially applied state. Review the remaining controls against fresh synchronized values.</p></section>;
}

export function TraceContent({ trace }: { trace: CalculationTrace }) {
  const inputs = trace.steps.flatMap((step) => step.inputs.map((input, index) => ({ key: `${step.index}-${index}`, step: step.label, ...input })));
  return <section style={optimizerStyles.stack}><h2>Recorded inputs</h2><DataTable headers={['Input', 'Value', 'Unit', 'Used in step']} label="Recorded calculation inputs">{inputs.map((input) => <tr key={input.key}><Cell>{input.name}</Cell><Cell>{displayValue(input.value)}</Cell><Cell>{input.unit}</Cell><Cell>{input.step}</Cell></tr>)}</DataTable>
    <h2>Calculation steps</h2><DataTable headers={['Step', 'Formula / Check', 'Result']} label="Recorded calculation steps">{trace.steps.map((step) => <tr key={step.index}><Cell>{step.index + 1}. {step.label}</Cell><Cell>{step.formula}{step.boundApplied ? <p>Bound: {step.boundApplied.name} = {step.boundApplied.value}; {step.boundApplied.before} → {step.boundApplied.after}</p> : null}{step.intermediateValue !== null ? <p>Intermediate value: {step.intermediateValue}</p> : null}</Cell><Cell>{displayValue(step.result)}</Cell></tr>)}</DataTable><p><strong>Rounded result:</strong> {displayValue(trace.roundingStep.result)} · <strong>Final result:</strong> {displayValue(trace.finalResult)}</p></section>;
}

export function CalculationContent({ row, currencyCode, backHref, profileId = row.profileId, dependencySet, peakExposureByStep, workedExample = false, placementInputs, snapshots = [] }: { row: RecommendationRecord; currencyCode: string; backHref: string; profileId?: string; dependencySet?: DependencySet; peakExposureByStep?: readonly (number | null)[]; workedExample?: boolean; placementInputs?: readonly RecordedPlacementInput[]; snapshots?: readonly MethodEvaluatorInput[] }) {
  const trace = row.inputs.trace;
  const set = dependencySet ?? row.inputs.dependencySet;
  const shadow = row.inputs.methodId === 'sp.coordinated-efficiency';
  const change = changedPercent(row.currentValue, row.proposedValue);
  const totalClicks = placementInputs?.reduce((sum, placement) => sum + placement.clicks, 0) ?? 0;
  const totalRevenue = placementInputs?.reduce((sum, placement) => sum + placement.revenue, 0) ?? 0;
  return <section style={optimizerStyles.stack} aria-label={shadow ? 'Placement calculation' : 'Calculation details'}>
    {workedExample ? <p style={optimizerStyles.muted}>Synthetic worked example adapted from the documented placement calculation. Its recorded inputs and limits are illustrative; they do not describe a saved account run.</p> : null}
    {shadow ? <div style={optimizerStyles.shadow}><strong>{set ? `Shadow preview: ${set.changes.length} changes reviewed together.` : 'Shadow preview · Dependent change count unavailable.'}</strong><p>This method cannot send changes to Amazon.</p>{!set ? <p>Recorded dependency evidence is unavailable for this preview.</p> : null}</div> : null}
    <DataTable headers={['Target / Campaign', 'Current bid', 'New bid', 'Reason']} label="Calculation target"><tr><Cell>{targetName(row)}<div style={optimizerStyles.muted}>{row.campaignName}</div></Cell><Cell>{changeValue(row.currentValue, row.field, currencyCode)}</Cell><Cell>{changeValue(row.proposedValue, row.field, currencyCode)}</Cell><Cell>{recommendationReason(row, snapshots)}</Cell></tr></DataTable>
    <p>Method: {row.inputs.methodId === 'sp.reference-efficiency' ? 'SP reference efficiency' : row.inputs.methodId === 'sp.coordinated-efficiency' ? 'SP coordinated efficiency' : 'Unavailable'} · {row.inputs.methodVersion ?? 'Version unavailable'}</p>
    {placementInputs && placementInputs.length > 0 ? <section><h2>Inputs: placement report</h2><DataTable headers={['Placement', 'Clicks', 'Revenue', 'RPC', 'Click share']} label="Placement report inputs">{placementInputs.map((placement) => <tr key={placement.placement}><Cell>{placement.placement}</Cell><Cell>{placement.clicks}</Cell><Cell>{money(placement.revenue, currencyCode)}</Cell><Cell>{money(placement.rpc, currencyCode)}</Cell><Cell>{(placement.clickShare * 100).toFixed(2)}%</Cell></tr>)}<tr><Cell>Total</Cell><Cell>{totalClicks}</Cell><Cell>{money(totalRevenue, currencyCode)}</Cell><Cell>{money(totalClicks > 0 ? totalRevenue / totalClicks : null, currencyCode)}</Cell><Cell>{totalClicks > 0 ? '100%' : 'Unavailable'}</Cell></tr></DataTable></section> : shadow ? <p>Recorded placement report inputs are unavailable for this preview.</p> : null}
    {trace ? <TraceContent trace={trace} /> : <div style={optimizerStyles.warning}><h2>Recorded calculation unavailable</h2><p>The proposed bid was saved without the inputs needed to reproduce its calculation.</p></div>}
    <p>Change: (new − old) ÷ old = {change === null ? 'Unavailable because a nonzero numeric earlier bid was not recorded.' : `${change.toFixed(2)}%, displayed as ${Math.round(change)}%.`}</p>
    {set ? <DependencyContent set={set} currencyCode={currencyCode} peakExposureByStep={peakExposureByStep ?? recordedDependencyExposures(row)} /> : null}
    {shadow ? <><p>Maximum exposure <InfoPopover label="About maximum exposure">Base bid × the applicable placement and audience multipliers. This is a configured maximum, not a forecast of realized CPC.</InfoPopover></p><button type="button" style={optimizerStyles.action} disabled>Send to Amazon unavailable in shadow</button></> : null}
    <div style={optimizerStyles.actions}><a href={`/optimizer/help?profile=${encodeURIComponent(profileId)}&example=placement`}>View worked placement example</a><a href={`/optimizer/help?profile=${encodeURIComponent(profileId)}`}>Optimization help</a><a href={backHref}>{workedExample ? 'Back to help' : 'Back to suggestions'}</a></div>
  </section>;
}

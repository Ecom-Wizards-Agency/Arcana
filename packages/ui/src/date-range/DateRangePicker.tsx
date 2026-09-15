'use client';
import { useRef, useState, type ReactNode } from 'react';
import type { DateRange } from '../views.js';
import { tokens } from '../theme.js';
import { comparisonRange, dateWords, mismatchPercentage, rangeDays, rangePresets, rangeWords, shiftDate, validRange, type ComparisonMode } from './model.js';

export interface DateRangeSelection { period: DateRange; comparison: DateRange | null; mode: ComparisonMode; preset?: string }
export interface DateRangePickerProps {
  period: DateRange; comparison: DateRange; today: string; includeToday?: boolean;
  mode?: ComparisonMode; factsThrough?: string | null; factsComplete?: boolean;
  trigger?: ReactNode; selectedPresetId?: string;
  hiddenFields?: Readonly<Record<string, string | undefined>>;
  presetHref: (period: DateRange, preset: string) => string;
  onApply: (selection: DateRangeSelection) => void;
}
const button = { background: tokens.color.surface, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: tokens.space(2), cursor: 'pointer' };

export function DateRangePicker(props: DateRangePickerProps): ReactNode {
  const root = useRef<HTMLDetailsElement>(null);
  const [period, setPeriod] = useState(props.period);
  const [custom, setCustom] = useState(props.comparison);
  const [mode, setMode] = useState<ComparisonMode>(props.mode ?? 'previous');
  const [preset, setPreset] = useState<string | undefined>(props.selectedPresetId);
  const [month, setMonth] = useState(`${props.period.start.slice(0, 8)}01`);
  const [anchor, setAnchor] = useState<string | null>(null);
  const presets = rangePresets(props.today, props.includeToday);
  const comparison = validRange(period) ? comparisonRange(period, mode, custom) : null;
  const valid = validRange(period) && (comparison === null || validRange(comparison));
  const selectedLabel = presets.find((item) => item.id === props.selectedPresetId && item.range.start === props.period.start && item.range.end === props.period.end)?.label
    ?? presets.find((item) => item.range.start === props.period.start && item.range.end === props.period.end)?.label ?? rangeWords(props.period);
  const close = () => { root.current?.removeAttribute('open'); root.current?.querySelector('summary')?.focus(); };
  const chooseDate = (date: string) => {
    setPreset(undefined);
    if (anchor === null) { setAnchor(date); setPeriod({ start: date, end: date }); }
    else { setPeriod({ start: anchor < date ? anchor : date, end: anchor < date ? date : anchor }); setAnchor(null); }
  };
  const moveMonth = (offset: number) => { const date = new Date(`${month}T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + offset); setMonth(date.toISOString().slice(0, 10)); };
  const completeness = (range: DateRange) => props.factsThrough == null ? 'facts completeness unavailable'
    : range.end > props.factsThrough ? 'facts incomplete' : props.factsComplete ? 'facts complete' : 'facts coverage not verified';
  return <details className="wa-date-range" ref={root} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <summary onClick={() => { if (!root.current?.open) { setPeriod(props.period); setCustom(props.comparison); setMode(props.mode ?? 'previous'); setPreset(props.selectedPresetId); setAnchor(null); setMonth(`${props.period.start.slice(0, 8)}01`); } }} className="wa-date-range__trigger" aria-label={`Date range: ${selectedLabel}`}>{props.trigger ?? rangeWords(props.period)} ▾</summary>
    <div role="dialog" aria-label="Date and comparison range" style={{ position: 'absolute', right: 0, top: '100%', width: 'min(720px, 95vw)', zIndex: 70, background: tokens.color.surface, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, boxShadow: 'var(--wa-shadow)', padding: tokens.space(3), fontSize: tokens.font.size.sm }}>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: tokens.space(4) }}>
        <nav aria-label="Date range presets" style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(1) }}><small>RANGE</small>
          {presets.map((item) => <a key={item.id} href={props.presetHref(item.range, item.id)} aria-current={preset === item.id ? 'date' : undefined}
            style={{ ...button, textDecoration: 'none', background: preset === item.id ? tokens.color.indigoSoft : tokens.color.surface }}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              props.onApply({ period: item.range, preset: item.id, mode, comparison: comparisonRange(item.range, mode, custom) });
              close();
            }}>{item.label}</a>)}
          <button style={button} onClick={() => { setPreset(undefined); root.current?.querySelector<HTMLInputElement>('[name="from"]')?.focus(); }}>Custom</button>
        </nav>
        <div><div style={{ display: 'flex', justifyContent: 'space-between' }}><button style={button} aria-label="Previous month" onClick={() => moveMonth(-1)}>←</button><button style={button} aria-label="Next month" onClick={() => moveMonth(1)}>→</button></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space(4) }}>{[0, 1].map((offset) => {
            const first = new Date(`${month}T00:00:00Z`); first.setUTCMonth(first.getUTCMonth() + offset);
            const start = first.toISOString().slice(0, 10); const last = new Date(first); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
            return <section key={offset} aria-label={first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}>
              <h3 style={{ textAlign: 'center', fontSize: tokens.font.size.sm }}>{first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: tokens.space(.5) }}>
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <small key={`day-${index}`} style={{ textAlign: 'center' }}>{day}</small>)}
                {Array.from({ length: (first.getUTCDay() + 6) % 7 }, (_, i) => <span key={`blank-${i}`} />)}
                {Array.from({ length: last.getUTCDate() }, (_, i) => {
                  const date = shiftDate(start, i); const selected = date >= period.start && date <= period.end; const compared = comparison !== null && date >= comparison.start && date <= comparison.end;
                  return <button key={date} type="button" aria-label={dateWords(date)} aria-pressed={selected} data-selected={selected} data-comparison={compared} onClick={() => chooseDate(date)}
                    style={{ ...button, padding: tokens.space(1), border: compared ? `1px dashed ${tokens.color.indigo}` : '1px solid transparent', background: selected ? tokens.color.indigoSoft : compared ? tokens.color.warnSoft : tokens.color.surface }}>{i + 1}</button>;
                })}
              </div>
            </section>;
          })}</div>
        </div>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (valid) { props.onApply({ period, comparison, mode, ...(preset ? { preset } : {}) }); close(); } }}>
        {Object.entries(props.hiddenFields ?? {}).map(([name, value]) => value === undefined ? null : <input key={name} type="hidden" name={name} value={value} />)}
        <div style={{ display: 'flex', gap: tokens.space(2), marginBlock: tokens.space(3) }}>
          <label>From<input name="from" type="date" required value={period.start} onChange={(event) => { setPreset(undefined); setPeriod({ ...period, start: event.target.value }); }} /></label>
          <label>To<input name="to" type="date" required value={period.end} onChange={(event) => { setPreset(undefined); setPeriod({ ...period, end: event.target.value }); }} /></label>
        </div>
        <fieldset style={{ border: 0, padding: 0 }}><legend>COMPARE AGAINST</legend>
          {([['previous', 'Previous period'], ['year', 'Same period last year'], ['custom', 'Custom'], ['none', 'None']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} style={{ ...button, marginRight: tokens.space(1), background: mode === value ? tokens.color.indigoSoft : tokens.color.surface }} onClick={() => setMode(value)}>{label}</button>)}
          {mode === 'custom' ? <div><label>Comparison from<input type="date" required value={custom.start} onChange={(event) => setCustom({ ...custom, start: event.target.value })} /></label><label>Comparison to<input type="date" required value={custom.end} onChange={(event) => setCustom({ ...custom, end: event.target.value })} /></label></div> : null}
        </fieldset>
        {valid ? <div style={{ paddingBlock: tokens.space(3) }}><div>Selected {rangeWords(period)} · {rangeDays(period)} days · {completeness(period)}</div>
          {comparison === null ? <div>Comparison: None</div> : <div>Comparison {rangeWords(comparison)} · {rangeDays(comparison)} days · {completeness(comparison)}</div>}
          {comparison !== null && rangeDays(period) !== rangeDays(comparison) ? <p role="status" style={{ padding: tokens.space(2), background: tokens.color.warnSoft, color: tokens.color.warn }}><span>Date ranges differ: {rangeDays(period)} days compared with {rangeDays(comparison)} days.</span> At the same daily rate, totals differ by {Number(mismatchPercentage(period, comparison).toFixed(1))}%. Totals would be compared, not rates.</p> : null}
        </div> : <p role="alert">Choose valid dates with the start on or before the end.</p>}
        <footer style={{ display: 'flex', gap: tokens.space(2), alignItems: 'center' }}><small style={{ flex: 1 }}>{props.factsThrough == null ? 'Facts coverage unavailable.' : `Facts load through ${dateWords(props.factsThrough)}. Later days are selectable but return nothing.`}</small><button type="button" style={button} onClick={close}>Cancel</button><button type="submit" style={button} disabled={!valid} aria-label="Apply range">Apply</button></footer>
      </form>
    </div>
  </details>;
}

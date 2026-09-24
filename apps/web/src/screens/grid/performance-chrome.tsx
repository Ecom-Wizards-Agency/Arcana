'use client';
import { formatDateWindow } from '../../ui/date-format';

import { useSearchParams } from 'next/navigation';
import { ProductAssignmentList, awaitingProductDerivation, unresolvedProductAssignment, type ProductAssignmentSource } from '@wizard-ads/shared';
import { EmptyState } from '@wizard-ads/ui';
import { Badge, Button } from '../../ui/primitives';
import { periodFromParams, todayIso } from '../../../app/_lib/periods';
import { countPerformanceRows, verdictFilter } from './performance-model';
import { useCallback, useId, useMemo, useState, type ReactNode, type Ref, type RefObject, useEffect, useRef } from 'react';
import { deltaColor, resolveField, describeFilter, formatValue, metricSpec, NumericValue, GridToolbar, ColumnManager, GroupBar, isGroupedRow, type ColumnLayout, readEntitySearch, writeEntitySearch, entitySearchColumn, tokens, type GridToolbarProps, type GridRow, type SavedView } from '@wizard-ads/ui';
import { GRID_SUMMARY_METRIC_LIMIT, GRID_SUMMARY_METRICS, TRANSLATION_LANGUAGES, TranslationLanguage, PerformanceVerdict, type GridPerformanceEvidence, type GridSummaryMetric } from '@wizard-ads/shared';
import { DEFAULT_SUMMARY_METRICS, isChartable, summarizeGrid, summaryMetrics, type SummaryCard } from './summary-model';

const button = { border: `1px solid ${tokens.color.border}`, background: tokens.color.surface, color: tokens.color.text, borderRadius: 6, padding: '5px 9px', fontSize: 12, whiteSpace: 'nowrap' as const };
/**
 * The provenance band and the KPI strip of the performance frame (Figma 5:2).
 *
 * The strip shows the operator's chosen metrics (default: the frame's eight)
 * under the WP-321 window rule in `summary-model.ts`; the dashed tile opens the
 * metric picker and shows how many are chosen. Cards for chartable metrics
 * still toggle up to four saved chart series, as WP-261 built them. No trend
 * chart is drawn and the picker promises none: neither performance frame
 * (5:2, 88:37) has one between the strip and the toolbar.
 */
export function PerformanceSummary({ rows, performance, view, onChange, currencyCode, profileId }: {
  rows: readonly GridRow[]; performance?: GridPerformanceEvidence; view: SavedView; onChange: (patch: Partial<SavedView>) => void; currencyCode: string; profileId: string;
}): ReactNode {
  const series: NonNullable<SavedView['chart']>['series'] = view.chart?.series ?? ['spend', 'sales'];
  const metrics = useMemo(() => summaryMetrics(view.summary?.metrics), [view.summary?.metrics]);
  // Outside the app router (render tests) there are no search params and the comparison is on.
  const comparisonOff = useSearchParams()?.get('comparison') === 'none';
  const evidence = performance?.summary;
  const summary = useMemo(() => summarizeGrid(rows, { entity: view.entity, metrics, evidence, comparisonOff }), [rows, view.entity, metrics, evidence, comparisonOff]);
  const [picking, setPicking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closePicker = useCallback(() => { setPicking(false); trigger.current?.focus(); }, []);
  const ids = useId();
  const choose = (next: readonly GridSummaryMetric[]) => {
    const kept = series.filter((key) => next.includes(key));
    onChange({ summary: { metrics: [...next] }, ...(kept.length === series.length ? {} : { chart: { series: kept } }) });
  };
  return <>
    <ProductAssignmentBanner profileId={profileId} currencyCode={currencyCode} enabled={performance !== undefined} />
    <section data-testid="grid-provenance" aria-label="Data completeness" style={{ height: 120, boxSizing: 'border-box', padding: '10px 24px', display: 'flex', alignItems: 'flex-start', gap: 18, background: tokens.color.surfaceAlt, borderBottom: `1px solid ${tokens.color.border}` }}>
      {(performance?.feeds ?? (['PPC', 'RANK', 'SQP'] as const).map((feed) => ({ feed, reason: `${feed} completeness not measured.`, status: 'not-measured' }))).map((feed) => <div key={feed.feed} style={{ display: 'flex', flex: 1, gap: 8, fontSize: 11, color: tokens.color.textMuted }}>
        <b style={{ fontSize: 10, borderRadius: 4, padding: '2px 7px', color: feed.status === 'complete' ? tokens.color.good : feed.status === 'partial' ? tokens.color.warn : tokens.color.bad, background: feed.status === 'complete' ? tokens.color.goodSoft : feed.status === 'partial' ? tokens.color.warnSoft : tokens.color.badSoft }}>{feed.feed}</b>
        <span>{feed.reason}</span>
      </div>)}
      <span style={{ width: 200, flexShrink: 0, paddingLeft: 12, borderLeft: `1px solid ${tokens.color.border}`, fontSize: 11, color: tokens.color.textFaint }}>Current bids as last read from Amazon.<br />Not affected by the date range.</span>
    </section>
    <section data-testid="grid-kpis" aria-label="Performance metrics" style={{ position: 'relative', height: 100, boxSizing: 'border-box', padding: '16px 24px 10px', display: 'grid', gridTemplateColumns: `repeat(${GRID_SUMMARY_METRIC_LIMIT + 1},minmax(0,1fr))`, gap: 8 }}>
      {summary.cards.map((card) => {
        const valueId = `${ids}-${card.key}-value`;
        const detailId = `${ids}-${card.key}-detail`;
        const body = <SummaryCardBody card={card} currencyCode={currencyCode} valueId={valueId} detailId={detailId} />;
        const style = { ...button, position: 'relative' as const, textAlign: 'left' as const, padding: '6px 10px 9px', lineHeight: '16px', minWidth: 0, overflow: 'hidden', borderRadius: 8 };
        if (!isChartable(card.key)) return <div key={card.key} role="group" aria-label={`${card.label} summary`} aria-describedby={`${valueId} ${detailId}`} data-summary-metric={card.key} style={style}>{body}</div>;
        const key = card.key;
        const selected = series.includes(key);
        return <button type="button" key={key} aria-label={`Chart ${key}`} aria-describedby={`${valueId} ${detailId}`} aria-pressed={selected} disabled={!selected && series.length === 4} data-summary-metric={key}
          onClick={() => onChange({ chart: { series: selected ? series.filter((item) => item !== key) : [...series, key] } })}
          style={style}>
          {body}
          {selected ? <span style={{ position: 'absolute', bottom: 3, left: 10, right: 10, height: 3, borderRadius: 2, background: `var(--wa-viz-${series.indexOf(key) + 1})` }} /> : null}
        </button>;
      })}
      <button type="button" ref={trigger} aria-haspopup="dialog" aria-expanded={picking} data-testid="grid-summary-picker-trigger"
        aria-label={`Choose summary metrics (${metrics.length} of ${GRID_SUMMARY_METRIC_LIMIT})`}
        onClick={() => setPicking(!picking)}
        style={{ ...button, alignSelf: 'start', borderStyle: 'dashed', textAlign: 'center', fontSize: 11 }}>+ Metrics<br /><small>{metrics.length} of {GRID_SUMMARY_METRIC_LIMIT}</small></button>
      {picking ? <SummaryMetricPicker metrics={metrics} onChoose={choose} onClose={closePicker} trigger={trigger} /> : null}
    </section>
  </>;
}

const clipped = { display: 'block', overflow: 'hidden', whiteSpace: 'nowrap' as const, textOverflow: 'ellipsis' };

/** One card: label, the window value or why it has none, then the comparison or the reason. */
function SummaryCardBody({ card, currencyCode, valueId, detailId }: { card: SummaryCard; currencyCode: string; valueId: string; detailId: string }): ReactNode {
  const format = (value: number) => formatValue(value, card.scale, { currencyCode });
  const { current, prior } = card;
  return <>
    <span style={{ display: 'block', fontSize: 11, color: tokens.color.textMuted }}>{card.label}</span>
    <strong id={valueId} data-summary-state={current.value !== null ? 'measured' : current.notMeasured ? 'not-measured' : 'unknown'} title={current.reason ?? current.note ?? undefined}
      style={{ ...clipped, fontSize: current.notMeasured ? 13 : 18, lineHeight: '22px', fontVariantNumeric: 'tabular-nums', color: current.value === null ? tokens.color.textMuted : undefined }}>
      {current.value !== null ? <NumericValue value={format(current.value)} /> : current.notMeasured ? 'Not measured' : '—'}
    </strong>
    {current.value === null && current.reason !== null
      ? <span id={detailId} data-summary-reason title={current.reason} style={{ ...clipped, fontSize: 11, color: tokens.color.textMuted }}>{current.reason}</span>
      : <span id={detailId} title={prior.reason ?? prior.note ?? undefined} style={{ ...clipped, fontSize: 11, color: tokens.color.textMuted }}>
        {prior.value !== null ? format(prior.value) : prior.notMeasured ? 'Not measured' : '—'} · <span style={{ color: deltaColor(card.delta, card.better) }}>{card.delta === null ? '—' : `${card.delta > 0 ? '+' : ''}${card.delta.toFixed(1)}%`}</span>
      </span>}
  </>;
}

/** A bounded picker over the grid metric catalogue; the choice travels with the saved view. */
function SummaryMetricPicker({ metrics, onChoose, onClose, trigger }: { metrics: readonly GridSummaryMetric[]; onChoose: (next: readonly GridSummaryMetric[]) => void; onClose: () => void; trigger: RefObject<HTMLButtonElement | null> }): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  // Focus lands once, on open; a toggle re-renders without moving it.
  useEffect(() => { root.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus(); }, []);
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target !== null && !root.current?.contains(target) && !trigger.current?.contains(target)) onClose();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [onClose, trigger]);
  const full = metrics.length >= GRID_SUMMARY_METRIC_LIMIT;
  const isDefault = metrics.length === DEFAULT_SUMMARY_METRICS.length && metrics.every((key, index) => key === DEFAULT_SUMMARY_METRICS[index]);
  return <div ref={root} role="dialog" aria-label="Summary metrics" data-testid="grid-summary-picker" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
    style={{ position: 'absolute', top: 60, right: 24, zIndex: 30, width: 300, padding: tokens.space(4), background: tokens.color.surface, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: 8, boxShadow: 'var(--wa-shadow)', fontSize: 12 }}>
    <strong style={{ display: 'block', fontSize: 13 }}>Summary metrics</strong>
    <p role="status" style={{ margin: '4px 0 8px', color: tokens.color.textMuted }}>{metrics.length} of {GRID_SUMMARY_METRIC_LIMIT} shown.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '4px 12px' }}>
      {GRID_SUMMARY_METRICS.map((key) => {
        const chosen = metrics.includes(key);
        return <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={chosen} disabled={chosen ? metrics.length === 1 : full}
            onChange={() => onChoose(chosen ? metrics.filter((item) => item !== key) : [...metrics, key])} />
          {metricSpec(key)!.label}
        </label>;
      })}
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
      <button type="button" style={button} disabled={isDefault} onClick={() => onChoose(DEFAULT_SUMMARY_METRICS)}>Reset to default</button>
      <button type="button" style={button} onClick={onClose}>Done</button>
    </div>
  </div>;
}

export function PerformanceToolbar(props: GridToolbarProps & { view: SavedView; update: (patch: Partial<SavedView>) => void; profileId: string; onSaveColumnPreset: (name: string, layout: ColumnLayout) => Promise<void>; onTranslation: () => void; onRefreshTranslation: () => void; asinScope?: string | null; onRemoveScope?: () => void }): ReactNode {
  const [panel, setPanel] = useState<'advanced' | 'filters' | 'groups' | 'columns' | null>(null);
  const [share, setShare] = useState('Share');
  const filters = props.filter.groups[0]?.filters ?? [];
  const identity = entitySearchColumn(props.available);
  const language = props.view.translation?.language ?? 'en';
  const applyColumns = (ids: readonly string[]) => {
    const original = identity?.id;
    const ordered = original ? [original, ...ids.filter((id) => id !== original)] : [...ids];
    if (ordered.includes('translation')) { ordered.splice(ordered.indexOf('translation'), 1); ordered.splice(1, 0, 'translation'); }
    props.onVisibleChange([...new Set(ordered)]);
  };
  const counts = useMemo(() => new Map(props.entity === 'targets' ? PerformanceVerdict.shape.diagnosis.options.map((diagnosis) => [diagnosis, countPerformanceRows(props.optionRows ?? [], verdictFilter(props.filter, diagnosis))] as const) : []), [props.entity, props.optionRows, props.filter]);
  return <div style={{ position: 'relative' }}>
    <div data-testid="grid-performance-toolbar" style={{ height: 47, boxSizing: 'border-box', padding: '12px 24px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <input style={{ ...button, width: 240, minWidth: 100 }} aria-label={`Search ${props.entity.replace('_', ' ')}`} placeholder={`Search ${props.entity.replace('_', ' ')}…`} value={readEntitySearch(filters, identity)} onChange={(event) => props.onFilterChange({ groups: [{ filters: writeEntitySearch(filters, identity, event.target.value) }] })} />
      <button style={button} onClick={() => setPanel(panel === 'filters' ? null : 'filters')}>Filter ({filters.length})</button>
      <span style={{ flex: 1 }} />
      <button style={button} onClick={() => setPanel(panel === 'groups' ? null : 'groups')}>Group ({props.groupBy.length})</button>
      <button style={button} onClick={() => setPanel(panel === 'columns' ? null : 'columns')}>Columns ({props.visible.length})</button>
      <select style={button} aria-label="Row density" value={props.density ?? 'normal'} onChange={(event) => props.onDensityChange?.(event.target.value as 'normal' | 'compact' | 'comfortable')}><option value="normal">Density: Normal</option><option value="compact">Density: Compact</option><option value="comfortable">Density: Comfortable</option></select>
      <button style={button} onClick={() => setPanel(panel === 'advanced' ? null : 'advanced')}>Saved view: {props.view.name}</button>
      <button style={button} onClick={() => { void navigator.clipboard.writeText(window.location.href).then(() => setShare('Copied'), () => setShare('Copy the address bar')); }}>{share}</button>
      <button style={button} onClick={props.onExport}>{props.model.grouped ? `Export CSV (${props.model.exported.toLocaleString('en-US')} deepest ${props.model.exported === 1 ? 'group' : 'groups'})` : `Export CSV (${props.model.exported.toLocaleString('en-US')} of ${props.model.total.toLocaleString('en-US')})`}</button>
    </div>
    <div data-testid="grid-chip-rail" style={{ height: 33, boxSizing: 'border-box', padding: '0 24px 10px', display: 'flex', gap: 6, alignItems: 'center', overflowX: 'auto', whiteSpace: 'nowrap' }}>
      {props.asinScope ? <span style={{ ...button, borderRadius: 999, fontSize: 11 }}>Product is {props.asinScope} <button aria-label="Remove product scope" onClick={props.onRemoveScope}>×</button></span> : null}
      {(panel === 'advanced' ? [] : filters).map((filter, index) => <span key={`${filter.key}:${index}`} style={{ ...button, padding: '3px 8px', fontSize: 11, borderStyle: filter.key.endsWith('_STATE') ? 'dashed' : 'solid', borderRadius: 999 }}>
        {filter.key.endsWith('_STATE') ? <small>default </small> : null}{filter.key === 'ASIN' ? `Product is ${filter.conditions.flatMap((condition) => condition.values).join(', ')}` : describeFilter(filter, props.available)}
        <button aria-label={`Remove filter ${filter.key}`} style={{ border: 0, color: tokens.color.textMuted, background: 'transparent' }} onClick={() => props.onFilterChange({ ...props.filter, groups: [{ filters: filters.filter((_, position) => position !== index) }, ...props.filter.groups.slice(1)] })}>×</button>
      </span>)}
      {props.visible.includes('translation') ? <><button style={button} onClick={props.onRefreshTranslation}>Refresh translations</button><button style={button} onClick={() => applyColumns(props.visible.filter((id) => id !== 'translation'))}>Hide Translation</button><a href={`/grid/translation?profile=${props.profileId}&language=${language}`} style={{ fontSize: 11 }}>Translation status</a></> : null}
    </div>
    {panel === 'filters' ? <section role="region" aria-label="Quick filters" style={{ position: 'absolute', top: 47, left: 24, zIndex: 25, width: 400, padding: tokens.space(4), background: tokens.color.surface, border: `1px solid ${tokens.color.border}`, boxShadow: 'var(--wa-shadow)' }}>
      <p>Quick filters are saved conditions on the Diagnosis column. Choosing one adds an ordinary chip you can remove.</p><h3>QUICK FILTERS</h3>
      {props.entity === 'targets' ? PerformanceVerdict.shape.diagnosis.options.map((diagnosis) => <button key={diagnosis} data-quick-verdict={diagnosis} style={{ ...button, display: 'flex', width: '100%', whiteSpace: 'normal', textAlign: 'left', marginBottom: tokens.space(2), gap: tokens.space(2) }} onClick={() => { props.onFilterChange(verdictFilter(props.filter, diagnosis)); setPanel(null); }}>
        <span aria-hidden style={{ color: diagnosis === 'Efficient' ? tokens.color.good : diagnosis === 'Insufficient evidence' ? tokens.color.textMuted : tokens.color.warn }}>●</span>
        <span style={{ flex: 1 }}><strong>{diagnosis}</strong><small style={{ display: 'block' }}>{VERDICT_DEFINITIONS[diagnosis]}</small></span><span data-quick-count style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{counts.get(diagnosis) ?? 0}</span>
      </button>) : null}
      <button style={button} onClick={() => setPanel('advanced')}>+ Add a condition on any column</button>
    </section> : null}
    {panel === 'advanced' ? <section role="region" aria-label="Grid controls"><button style={button} onClick={() => setPanel(null)}>Close controls</button><GridToolbar {...props} onOpenColumnManager={() => setPanel('columns')} onDensityChange={undefined} onExport={undefined} onVisibleChange={applyColumns} /></section> : null}
    {panel === 'columns' ? <ColumnManager available={props.available.map((column) => ({ ...column,
      measurementStatus: (column.subject === 'SQP' || column.subject === 'BRAND ANALYTICS') && !(props.optionRows ?? []).some((row) => resolveField(row, column.id) !== null) ? 'needs-ingestion' : 'available',
    }))} view={props.view} views={props.views ?? []} onApply={(layout) => props.update(layout)} onClose={() => setPanel(null)} onSave={props.onSaveColumnPreset}>
      {(layout, change) => props.entity === 'targets' ? <div style={{ marginBlock: tokens.space(3) }}><span>Translation · Hidden by default</span>
        <button style={button} onClick={() => { change({ ...layout, columns: [...new Set([identity?.id ?? 'targeting', 'translation', ...layout.columns])] }); props.onTranslation(); }}>Add Translation</button>
        <label>Translation language · <select aria-label="Translation language" value={language} onChange={(event) => props.update({ translation: { language: TranslationLanguage.parse(event.target.value) } })}>{Object.entries(TRANSLATION_LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      </div> : null}
    </ColumnManager> : null}
    {panel === 'advanced' ? null : <GroupBar dimensions={props.available.filter((column) => column.kind === 'dimension')} groupBy={props.groupBy} onChange={props.onGroupByChange} restingHidden={panel !== 'groups'} />}
    {props.groupBy.length ? <div style={{ paddingInline: tokens.space(6) }}><button style={button} onClick={() => props.update({ collapsedGroupIds: [] })}>Expand all</button><button style={button} onClick={() => props.update({ collapsedGroupIds: props.model.rows.filter((row) => isGroupedRow(row) && !row.isLeafGroup).map((row) => row.id) })}>Collapse all</button><small>Ratio metrics recomputed from summed bases, never averaged. Group ACOS is total spend / total sales for that group, not the mean of its rows’ ACOS.</small></div> : null}
  </div>;
}
const VERDICT_DEFINITIONS: Record<string, string> = {
  'Paying for rank we own': 'Paid activity on wording where the product already holds organic rank.',
  'Rank gap': 'Organic rank is outside the configured rank goal.',
  'Ranked, unfunded': 'Organic rank is present without paid funding.',
  Efficient: 'Measured performance meets the configured efficiency goal.',
  'Insufficient evidence': 'Required measurements or strategy thresholds are missing.',
};

type ProductAssignmentItem = ProductAssignmentList['items'][number];
/** Only these sources offer the chooser; every other row is settled until the mirror changes. */
const needsChoice = (source: ProductAssignmentSource): boolean => source === 'proposed' || source === 'unassigned';
const AWAITING_CHIP = { label: 'Awaiting derivation', tone: 'info' } as const;
const SOURCE_CHIP: Record<ProductAssignmentSource, { label: string; tone: 'good' | 'info' | 'warn' | 'bad' }> = {
  derived: { label: 'Derived', tone: 'good' },
  derived_parent: { label: 'Derived parent', tone: 'good' },
  proposed: { label: 'Proposed', tone: 'warn' },
  manual: { label: 'Manual', tone: 'info' },
  unassigned: { label: 'Unassigned', tone: 'bad' },
};
const moneyIn = (currencyCode: string) => (value: number | null) => value === null ? 'Not measured' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(value);

/** The grid notice: present only while at least one ad group is proposed or unassigned. */
export function ProductAssignmentNotice({ data, currencyCode, onOpen, trigger }: {
  data: ProductAssignmentList; currencyCode: string; onOpen: () => void; trigger?: Ref<HTMLButtonElement>;
}): ReactNode {
  if (data.unassignedCount === 0) return null;
  const unresolved = data.items.filter(unresolvedProductAssignment);
  const measured = unresolved.filter((item) => item.spend !== null).length;
  const days = `${data.days} ${data.days === 1 ? 'day' : 'days'}`;
  // A group without target facts has unmeasured spend, never zero spend.
  const spend = measured === 0 ? `spend not measured over ${days}` : `${moneyIn(currencyCode)(data.unassignedSpend)} of spend over ${days}${measured < unresolved.length ? ', some not measured' : ''}`;
  return <section data-testid="grid-unattributed" style={{ height: 120, boxSizing: 'border-box', padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 16, background: tokens.color.warnSoft, borderBlock: `1px solid ${tokens.color.warnBorder}`, color: tokens.color.warn, fontSize: 13 }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <strong>{data.unassignedCount} {data.unassignedCount === 1 ? 'ad group needs' : 'ad groups need'} a product check · {spend}</strong>
      <p style={{ margin: '4px 0 0' }}>Arcana reads each target’s organic rank, search query share and rank verdict against its ad group’s product, so proposed groups rest on a guess and unassigned groups show none.</p>
    </div>
    <Button className="wa-product-assignment-action" ref={trigger} onClick={onOpen}>Link them</Button>
  </section>;
}

/** Every ad group with its effective product, source and spend; choosers only where Arcana could not decide. */
export function ProductAssignmentTable({ data, currencyCode, selected, busy, onSelect, onSave, onRevert }: {
  data: ProductAssignmentList; currencyCode: string; selected: Readonly<Record<string, string>>; busy: boolean;
  onSelect: (adGroupId: string, asin: string) => void; onSave: (adGroupId: string, asin: string) => void; onRevert: (adGroupId: string) => void;
}): ReactNode {
  const money = moneyIn(currencyCode);
  const baseline = (item: ProductAssignmentItem) => item.derived === null ? 'Not derived yet'
    : `Derived: ${item.derived.asin ?? 'no product'} (${SOURCE_CHIP[item.derived.source].label.toLowerCase()})`;
  return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th>Ad group</th><th>Spend</th><th>Product</th><th>Source</th></tr></thead><tbody>
    {data.items.map((item) => {
      const choose = needsChoice(item.source);
      const choice = selected[item.adGroupId] ?? item.assignedAsin ?? '';
      const awaiting = awaitingProductDerivation(item);
      const chip = awaiting ? AWAITING_CHIP : SOURCE_CHIP[item.source];
      return <tr key={item.adGroupId} data-testid="product-assignment-row">
        <td>{item.name ?? item.adGroupId}</td><td>{money(item.spend)}</td>
        <td>
          {item.assignedAsin ? <span className="wa-assignment-saved" style={item.source === 'proposed' ? { color: tokens.color.warn } : undefined}>{item.source === 'proposed' ? 'Proposed' : 'Assigned'}: {item.assignedAsin}</span>
            : <span className="wa-assignment-none">{awaiting ? 'Awaiting first derivation' : 'No assigned product'}</span>}
          {item.source === 'manual' ? <span className="wa-assignment-baseline">{baseline(item)}</span> : null}
          {choose ? <select aria-label={`Product for ${item.name ?? item.adGroupId}`} value={choice} disabled={!data.canAssign || busy} onChange={(event) => onSelect(item.adGroupId, event.target.value)}>
            <option value="">Choose product</option>{item.asins.map((asin) => <option key={asin} value={asin}>{asin}</option>)}
          </select> : null}
          {item.reason ? <p>{item.reason}</p> : null}
          {item.source === 'proposed' ? <ul aria-label="Assignment candidates">{item.candidates.map((candidate) => <li key={candidate.asin}>{candidate.asin} · {money(candidate.spend)} over 30 settled days</li>)}</ul> : null}
        </td>
        <td><Badge tone={chip.tone} data-assignment-source={awaiting ? 'awaiting' : item.source}>{chip.label}</Badge>
          {choose ? <Button variant="primary" disabled={!data.canAssign || busy || !choice} onClick={() => onSave(item.adGroupId, choice)}>Save assignment</Button> : null}
          {item.source === 'manual' ? <Button disabled={!data.canAssign || busy} onClick={() => onRevert(item.adGroupId)}>Revert to derived</Button> : null}
        </td>
      </tr>;
    })}
  </tbody></table></div>;
}

/** The saved assignment list owns both the pickers and unresolved banner counts. */
export function ProductAssignmentBanner({ profileId, currencyCode, enabled }: { profileId: string; currencyCode: string; enabled: boolean }) {
  return enabled ? <RoutedProductAssignmentBanner profileId={profileId} currencyCode={currencyCode} /> : null;
}
function RoutedProductAssignmentBanner({ profileId, currencyCode }: { profileId: string; currencyCode: string }) {
  const search = useSearchParams();
  const period = periodFromParams(Object.fromEntries(search.entries()), todayIso());
  const key = `${profileId}:${period.start}:${period.end}`;
  return <ProductAssignmentContent key={key} profileId={profileId} start={period.start} end={period.end} currencyCode={currencyCode} />;
}
function ProductAssignmentContent({ profileId, start, end, currencyCode }: { profileId: string; start: string; end: string; currencyCode: string }) {
  const [data, setData] = useState<ProductAssignmentList | null>(null);
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<Record<string,string>>({});
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch(`/targets/product-assignments?${new URLSearchParams({ profileId, start, end })}`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw Error(); return ProductAssignmentList.parse(await response.json()); })
      .then((value) => { if (!controller.signal.aborted) { setData(value); setError(''); } })
      .catch(() => { if (!controller.signal.aborted) setError('Product assignments could not be loaded. Try again.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [profileId, start, end, revision]);
  const open = () => dialog.current?.showModal();
  const close = () => { dialog.current?.close(); trigger.current?.focus(); };
  const mutate = async (body: { action: 'assign'; adGroupId: string; asin: string } | { action: 'revert'; adGroupId: string }) => {
    setPending(true); setError('');
    try {
      const response = await fetch('/targets/product-assignments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, profileId }) });
      const result: unknown = await response.json().catch(() => null);
      if (response.status === 409 && result !== null && typeof result === 'object' && 'code' in result && result.code === 'assignment_derived') {
        // Keep the explanation visible; the error state offers the reload.
        setError('Arcana has derived this ad group’s product since the list loaded, so there is nothing to confirm. Reload the list.');
        return;
      }
      if (!response.ok || result === null || typeof result !== 'object' || !('assigned' in result) || result.assigned !== 1) throw Error();
      refresh((value) => value+1);
    } catch { setError('Assignment could not be confirmed. Reload the list before trying again.'); }
    finally { setPending(false); }
  };
  return <>
    <style>{`
      .wa-product-assignment-action, .wa-product-assignments .wa-btn { border: 1px solid var(--wa-border); border-radius: 8px; background: var(--wa-surface-2); color: var(--wa-text); padding: 12px 16px; font: 600 14px/20px var(--wa-font); cursor: pointer; }
      .wa-product-assignments { font: 400 13px/20px var(--wa-font); }
      .wa-product-assignments h2 { margin: 0 0 12px; font: 600 24px/32px var(--wa-font); }
      .wa-product-assignments p { color: var(--wa-text-muted); }
      .wa-product-assignments th, .wa-product-assignments td { padding: 12px; border-bottom: 1px solid var(--wa-border); text-align: left; vertical-align: top; }
      .wa-product-assignments th { font-weight: 600; background: var(--wa-surface-2); }
      .wa-product-assignments select { display: block; margin-top: 8px; min-width: 160px; border: 1px solid var(--wa-border); border-radius: 8px; padding: 12px; background: var(--wa-surface-2); color: var(--wa-text); font: inherit; }
      .wa-product-assignments .wa-btn--primary { background: var(--wa-accent); border-color: var(--wa-accent); color: var(--wa-on-accent); }
      .wa-product-assignments .wa-btn--primary:hover:not(:disabled) { background: var(--wa-accent); }
      .wa-product-assignments :disabled { cursor: not-allowed; opacity: .55; }
      .wa-product-assignments .wa-badge { margin: 0 8px 8px 0; }
      .wa-product-assignments .wa-assignment-saved { display: block; color: var(--wa-good-text); }
      .wa-product-assignments .wa-assignment-none, .wa-product-assignments .wa-assignment-baseline { display: block; color: var(--wa-text-muted); }
    `}</style>
    {loading && data === null ? <div style={{ height: 120, overflow: 'hidden' }}><EmptyState variant="loading" title="Checking product assignments" body="Reading every ad group's product for this date range." /></div> : null}
    {error ? <EmptyState variant="error" title="Product assignment unavailable" body={error} action={<Button onClick={() => refresh((value) => value+1)}>Reload assignments</Button>} /> : null}
    {data ? <ProductAssignmentNotice data={data} currencyCode={currencyCode} onOpen={open} trigger={trigger} /> : null}
    {data && data.unassignedCount === 0 ? <div style={{ position: 'relative', height: 0, zIndex: 1 }}><Button ref={trigger} style={{ position: 'absolute', right: 24, top: 72, fontSize: 11 }} onClick={open}>Product assignments</Button></div> : null}
    <dialog className="wa-product-assignments" ref={dialog} aria-label="Assign products to ad groups" onClose={() => trigger.current?.focus()} style={{ width: 'min(900px, calc(100vw - 48px))', maxHeight: '80vh', background: tokens.color.surface, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: 24 }}>
      <h2>Assign products to ad groups</h2>
      <p>Arcana derives each ad group’s product from its enabled and paused product ads. Confirm or choose a product for proposed and unassigned groups; a manual choice stays until you revert it. Assignments do not change Amazon ads or recompute product performance totals.</p>
      {error ? <EmptyState variant="error" title="Assignment unavailable" body={error} action={<Button onClick={() => refresh((value) => value+1)}>Reload list</Button>} /> : null}
      {loading ? <EmptyState variant="loading" title="Refreshing assignments" body="Waiting for the saved list and counts." /> : null}
      {data?.canAssign === false ? <EmptyState variant="gated" title="Read-only access" body="An analyst, admin or owner can assign products." /> : null}
      {data?.count === 0 ? <EmptyState title="No ad groups" body="No current Sponsored Products ad groups were found." /> : null}
      <p>{data?.count ?? '—'} {data?.count === 1 ? 'ad group' : 'ad groups'} · {formatDateWindow(start, end)}</p>
      {data ? <ProductAssignmentTable data={data} currencyCode={currencyCode} selected={selected} busy={pending || loading}
        onSelect={(adGroupId, asin) => setSelected({ ...selected, [adGroupId]: asin })}
        onSave={(adGroupId, asin) => void mutate({ action: 'assign', adGroupId, asin })}
        onRevert={(adGroupId) => void mutate({ action: 'revert', adGroupId })} /> : null}
      <Button style={{ marginTop: 24 }} onClick={close}>Close</Button>
    </dialog>
  </>;
}

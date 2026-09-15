'use client';
import { countPerformanceRows, verdictFilter } from './performance-model';
import { useMemo, useState, type ReactNode } from 'react';
import { deltaColor, grandTotal, resolveField, describeFilter, formatValue, metricSpec, NumericValue, GridToolbar, ColumnManager, GroupBar, isGroupedRow, type ColumnLayout, readEntitySearch, writeEntitySearch, entitySearchColumn, tokens, type GridToolbarProps, type GridRow, type SavedView } from '@wizard-ads/ui';
import { TRANSLATION_LANGUAGES, TranslationLanguage, PerformanceVerdict, type GridPerformanceEvidence } from '@wizard-ads/shared';

const button = { border: `1px solid ${tokens.color.border}`, background: tokens.color.surface, color: tokens.color.text, borderRadius: 6, padding: '5px 9px', fontSize: 12, whiteSpace: 'nowrap' as const };
const keys = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'acos', 'cvr', 'cpc'] as const;
export function PerformanceSummary({ rows, performance, view, onChange, currencyCode, profileId: _profileId }: {
  rows: readonly GridRow[]; performance?: GridPerformanceEvidence; view: SavedView; onChange: (patch: Partial<SavedView>) => void; currencyCode: string; profileId: string;
}): ReactNode {
  const series: NonNullable<SavedView['chart']>['series'] = view.chart?.series ?? ['spend', 'sales'];
  const aggregate = useMemo(() => grandTotal(rows), [rows]);
  return <>
    {performance?.unattributed ? <section data-testid="grid-unattributed" style={{ height: 120, boxSizing: 'border-box', padding: '10px 24px', display: 'flex', alignItems: 'center', gap: 10, background: tokens.color.warnSoft, borderBlock: `1px solid ${tokens.color.warnBorder}`, color: tokens.color.warn, fontSize: 12 }}>
      <strong>{performance.unattributed.adGroups} ad groups advertise more than one ASIN, so {new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(performance.unattributed.spend)} of spend over {performance.unattributed.days} days is attributed to no product.</strong>
      <button type="button" style={{ ...button, color: tokens.color.warn }} disabled title="Product linking is unavailable.">Link them</button>
      <span style={{ marginLeft: 'auto', fontSize: 11 }}>Sorted by what ignoring it costs</span>
    </section> : null}
    <section data-testid="grid-provenance" aria-label="Data completeness" style={{ height: 120, boxSizing: 'border-box', padding: '10px 24px', display: 'flex', alignItems: 'flex-start', gap: 18, background: tokens.color.surfaceAlt, borderBottom: `1px solid ${tokens.color.border}` }}>
      {(performance?.feeds ?? (['PPC', 'RANK', 'SQP'] as const).map((feed) => ({ feed, reason: `${feed} completeness not measured.`, status: 'not-measured' }))).map((feed) => <div key={feed.feed} style={{ display: 'flex', flex: 1, gap: 8, fontSize: 11, color: tokens.color.textMuted }}>
        <b style={{ fontSize: 10, borderRadius: 4, padding: '2px 7px', color: feed.status === 'complete' ? tokens.color.good : feed.status === 'partial' ? tokens.color.warn : tokens.color.bad, background: feed.status === 'complete' ? tokens.color.goodSoft : feed.status === 'partial' ? tokens.color.warnSoft : tokens.color.badSoft }}>{feed.feed}</b>
        <span>{feed.reason}</span>
      </div>)}
      <span style={{ width: 200, flexShrink: 0, paddingLeft: 12, borderLeft: `1px solid ${tokens.color.border}`, fontSize: 11, color: tokens.color.textFaint }}>Current bids as last read from Amazon.<br />Not affected by the date range.</span>
    </section>
    <section data-testid="grid-kpis" aria-label="Performance metrics" style={{ height: 100, boxSizing: 'border-box', padding: '16px 24px 10px', display: 'grid', gridTemplateColumns: 'repeat(9,minmax(0,1fr))', gap: 8 }}>
      {keys.map((key) => {
        const current = aggregate === null ? null : resolveField(aggregate, key);
        const value = typeof current === 'number' ? current : null;
        const comparison = aggregate === null ? null : resolveField(aggregate, `${key}_comparison`);
        const prior = typeof comparison === 'number' ? comparison : null;
        const delta = value === null || prior === null || prior === 0 ? null : (value - prior) / Math.abs(prior) * 100;
        const selected = series.includes(key);
        return <button type="button" key={key} aria-label={`Chart ${key}`} aria-pressed={selected} disabled={!selected && series.length === 4}
          onClick={() => onChange({ chart: { series: selected ? series.filter((item) => item !== key) : [...series, key] } })}
          style={{ ...button, position: 'relative', textAlign: 'left', padding: '6px 10px 9px', lineHeight: '16px', minWidth: 0, overflow: 'hidden', borderRadius: 8 }}>
          <span style={{ display: 'block', fontSize: 11, color: tokens.color.textMuted }}>{key === 'acos' || key === 'cvr' || key === 'cpc' ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1)}</span>
          <strong style={{ display: 'block', fontSize: 18, fontVariantNumeric: 'tabular-nums' }}><NumericValue value={formatValue(value, metricSpec(key)!.scale, { currencyCode })} /></strong>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{formatValue(prior, metricSpec(key)!.scale, { currencyCode })} · <span style={{ color: deltaColor(delta, metricSpec(key)!.better) }}>{delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`}</span></span>
          {selected ? <span style={{ position: 'absolute', bottom: 3, left: 10, right: 10, height: 3, borderRadius: 2, background: `var(--wa-viz-${series.indexOf(key) + 1})` }} /> : null}
        </button>;
      })}
      <span style={{ ...button, alignSelf: 'start', borderStyle: 'dashed', textAlign: 'center', fontSize: 11 }}>+ Series<br /><small>{series.length} of 4</small></span>
    </section>
  </>;
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

'use client';
import { useState, type ReactNode } from 'react';
import { deltaColor, grandTotal, resolveField, describeFilter, formatValue, metricSpec, GridToolbar, groupColumns, readEntitySearch, writeEntitySearch, entitySearchColumn, tokens, type GridToolbarProps, type GridRow, type SavedView } from '@wizard-ads/ui';
import { TRANSLATION_LANGUAGES, TranslationLanguage, PerformanceVerdict, type GridPerformanceEvidence } from '@wizard-ads/shared';

const button = { border: `1px solid ${tokens.color.border}`, background: tokens.color.surface, color: tokens.color.text, borderRadius: 6, padding: '5px 9px', fontSize: 12, whiteSpace: 'nowrap' as const };
const keys = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'acos', 'cvr', 'cpc'] as const;
export function PerformanceSummary({ rows, performance, view, onChange, currencyCode, profileId: _profileId }: {
  rows: readonly GridRow[]; performance?: GridPerformanceEvidence; view: SavedView; onChange: (patch: Partial<SavedView>) => void; currencyCode: string; profileId: string;
}): ReactNode {
  const series: NonNullable<SavedView['chart']>['series'] = view.chart?.series ?? ['spend', 'sales'];
  const aggregate = grandTotal(rows);
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
          <strong style={{ display: 'block', fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{formatValue(value, metricSpec(key)!.scale, { currencyCode })}</strong>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{formatValue(prior, metricSpec(key)!.scale, { currencyCode })} · <span style={{ color: deltaColor(delta, metricSpec(key)!.better) }}>{delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`}</span></span>
          {selected ? <span style={{ position: 'absolute', bottom: 3, left: 10, right: 10, height: 3, borderRadius: 2, background: `var(--wa-viz-${series.indexOf(key) + 1})` }} /> : null}
        </button>;
      })}
      <span style={{ ...button, alignSelf: 'start', borderStyle: 'dashed', textAlign: 'center', fontSize: 11 }}>+ Series<br /><small>{series.length} of 4</small></span>
    </section>
  </>;
}

export function PerformanceToolbar(props: GridToolbarProps & { view: SavedView; update: (patch: Partial<SavedView>) => void; profileId: string; onTranslation: () => void; asinScope?: string | null; onRemoveScope?: () => void }): ReactNode {
  const [panel, setPanel] = useState<'advanced' | 'columns' | null>(null);
  const [columnSearch, setColumnSearch] = useState('');
  const [share, setShare] = useState('Share');
  const filters = props.filter.groups[0]?.filters ?? [];
  const identity = entitySearchColumn(props.available);
  const language = props.view.translation?.language ?? 'en';
  const groups = groupColumns(props.available.filter((column) => `${column.header} ${column.description ?? ''}`.toLowerCase().includes(columnSearch.toLowerCase())));
  const applyColumns = (ids: readonly string[]) => {
    const original = identity?.id;
    const ordered = original ? [original, ...ids.filter((id) => id !== original)] : [...ids];
    if (ordered.includes('translation')) { ordered.splice(ordered.indexOf('translation'), 1); ordered.splice(1, 0, 'translation'); }
    props.onVisibleChange([...new Set(ordered)]);
  };
  const counts = new Map<string, number>();
  for (const row of props.optionRows ?? []) { const verdict = row.dimensions['verdict']; if (typeof verdict === 'string') counts.set(verdict, (counts.get(verdict) ?? 0) + 1); }
  return <div style={{ position: 'relative' }}>
    <div data-testid="grid-performance-toolbar" style={{ height: 47, boxSizing: 'border-box', padding: '12px 24px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <input style={{ ...button, width: 240, minWidth: 100 }} aria-label={`Search ${props.entity.replace('_', ' ')}`} placeholder={`Search ${props.entity.replace('_', ' ')}…`} value={readEntitySearch(filters, identity)} onChange={(event) => props.onFilterChange({ groups: [{ filters: writeEntitySearch(filters, identity, event.target.value) }] })} />
      <button style={button} onClick={() => setPanel(panel === 'advanced' ? null : 'advanced')}>Filter ({filters.length})</button>
      <span style={{ flex: 1 }} />
      <button style={button} onClick={() => setPanel(panel === 'advanced' ? null : 'advanced')}>Group ({props.groupBy.length})</button>
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
      {props.entity === 'targets' ? PerformanceVerdict.shape.diagnosis.options.map((diagnosis) => <button key={diagnosis} data-quick-verdict={diagnosis} style={{ ...button, padding: '3px 8px', fontSize: 11, borderRadius: 999, background: tokens.color.accentSoft }} onClick={() => props.onFilterChange({ ...props.filter, groups: [{ filters: [...filters.filter((filter) => filter.key !== 'VERDICT'), { key: 'VERDICT', conditions: [{ operator: '=', values: [diagnosis] }] }] }, ...props.filter.groups.slice(1)] })}>{diagnosis} ({counts.get(diagnosis) ?? 0})</button>) : null}
      {props.visible.includes('translation') ? <><button style={button} onClick={() => applyColumns(props.visible.filter((id) => id !== 'translation'))}>Hide Translation</button><a href={`/grid/translation?profile=${props.profileId}&language=${language}`} style={{ fontSize: 11 }}>Translation status</a></> : null}
    </div>
    {panel === null ? null : <section role="region" aria-label={panel === 'columns' ? 'Column picker' : 'Grid controls'} style={{ position: panel === 'advanced' ? 'relative' : 'absolute', top: panel === 'advanced' ? 0 : 47, left: panel === 'advanced' ? 0 : 24, right: 24, zIndex: 20, background: tokens.color.surface, border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: 16, maxHeight: 540, overflow: 'auto', boxShadow: 'var(--wa-shadow)' }}>
      <button style={{ ...button, float: 'right' }} onClick={() => setPanel(null)}>Close controls</button>
      {panel === 'advanced' ? <GridToolbar {...props} onDensityChange={undefined} onExport={undefined} onVisibleChange={applyColumns} /> : <>
        <h2 style={{ fontSize: 16 }}>Choose columns</h2><input aria-label="Search columns" value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} style={button} />
        {props.entity === 'targets' ? <div style={{ marginBlock: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>Translation · Hidden by default</span><button style={button} onClick={() => { applyColumns([...props.visible, 'translation']); props.onTranslation(); }}>Add Translation</button>
          <label>Translation language · <select aria-label="Translation language" value={language} onChange={(event) => props.update({ translation: { language: TranslationLanguage.parse(event.target.value) } })}>{Object.entries(TRANSLATION_LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
        </div> : null}
        <div style={{ display: 'flex', gap: 8 }}>
          {props.entity === 'targets' ? <button style={button} onClick={() => applyColumns(props.available.filter((column) => column.referenceOrder !== undefined).sort((a, b) => a.referenceOrder! - b.referenceOrder!).map((column) => column.id))}>Performance columns</button> : null}
          <button style={button} onClick={() => applyColumns(groupColumns(props.available).flatMap((group) => group.columns).filter((column) => column.id !== 'translation' || props.visible.includes('translation')).map((column) => column.id))}>Show all columns</button>
        </div>
        {groups.map((group) => <fieldset key={group.id} style={{ border: 0, borderTop: `1px solid ${tokens.color.border}`, marginBlock: 12 }}><legend>{group.label} ({group.columns.length})</legend>
          {group.columns.map((column) => <label key={column.id} title={column.description} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', column.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const moved = event.dataTransfer.getData('text/plain'); const next = props.visible.filter((id) => id !== moved); next.splice(Math.max(0, next.indexOf(column.id)), 0, moved); applyColumns(next); }} style={{ display: 'inline-flex', alignItems: 'center', width: 230, padding: 6, gap: 6 }}>
            <input type="checkbox" checked={props.visible.includes(column.id)} disabled={column.id === identity?.id} onChange={() => applyColumns(props.visible.includes(column.id) ? props.visible.filter((id) => id !== column.id) : [...props.visible, column.id])} />{column.header}
          </label>)}
        </fieldset>)}
      </>}
    </section>}
  </div>;
}

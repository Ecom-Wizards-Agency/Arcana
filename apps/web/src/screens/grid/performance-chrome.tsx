'use client';
import { formatDateWindow } from '../../ui/date-format';

import { useSearchParams } from 'next/navigation';
import { AdGroupProductAssignmentList } from '@wizard-ads/shared';
import { EmptyState } from '@wizard-ads/ui';
import { Button } from '../../ui/primitives';
import { periodFromParams, todayIso } from '../../../app/_lib/periods';
import { countPerformanceRows, verdictFilter } from './performance-model';
import { useMemo, useState, type ReactNode, useEffect, useRef } from 'react';
import { deltaColor, grandTotal, resolveField, describeFilter, formatValue, metricSpec, NumericValue, GridToolbar, ColumnManager, GroupBar, isGroupedRow, type ColumnLayout, readEntitySearch, writeEntitySearch, entitySearchColumn, tokens, type GridToolbarProps, type GridRow, type SavedView } from '@wizard-ads/ui';
import { TRANSLATION_LANGUAGES, TranslationLanguage, PerformanceVerdict, type GridPerformanceEvidence } from '@wizard-ads/shared';

const button = { border: `1px solid ${tokens.color.border}`, background: tokens.color.surface, color: tokens.color.text, borderRadius: 6, padding: '5px 9px', fontSize: 12, whiteSpace: 'nowrap' as const };
const keys = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'acos', 'cvr', 'cpc'] as const;
export function PerformanceSummary({ rows, performance, view, onChange, currencyCode, profileId }: {
  rows: readonly GridRow[]; performance?: GridPerformanceEvidence; view: SavedView; onChange: (patch: Partial<SavedView>) => void; currencyCode: string; profileId: string;
}): ReactNode {
  const series: NonNullable<SavedView['chart']>['series'] = view.chart?.series ?? ['spend', 'sales'];
  const aggregate = useMemo(() => grandTotal(rows), [rows]);
  return <>
    <ProductAssignmentBanner profileId={profileId} currencyCode={currencyCode} enabled={performance?.unattributed != null} />
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
  const [data, setData] = useState<AdGroupProductAssignmentList | null>(null);
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
      .then(async (response) => { if (!response.ok) throw Error(); return AdGroupProductAssignmentList.parse(await response.json()); })
      .then((value) => { if (!controller.signal.aborted) { setData(value); setError(''); } })
      .catch(() => { if (!controller.signal.aborted) setError('Product assignments could not be loaded. Try again.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [profileId, start, end, revision]);
  const money = (value: number | null) => value === null ? 'Not measured' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(value);
  const close = () => { dialog.current?.close(); trigger.current?.focus(); };
  const assign = async (adGroupId: string, asin: string) => {
    setPending(true); setError('');
    try {
      const response = await fetch('/targets/product-assignments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId, adGroupId, asin }) });
      if (!response.ok || (await response.json()).assigned !== 1) throw Error();
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
      .wa-product-assignments th, .wa-product-assignments td { padding: 12px; border-bottom: 1px solid var(--wa-border); text-align: left; }
      .wa-product-assignments th { font-weight: 600; background: var(--wa-surface-2); }
      .wa-product-assignments select { min-width: 160px; border: 1px solid var(--wa-border); border-radius: 8px; padding: 12px; background: var(--wa-surface-2); color: var(--wa-text); font: inherit; }
      .wa-product-assignments .wa-btn--primary { background: var(--wa-accent); border-color: var(--wa-accent); color: var(--wa-on-accent); }
      .wa-product-assignments .wa-btn--primary:hover:not(:disabled) { background: var(--wa-accent); }
      .wa-product-assignments :disabled { cursor: not-allowed; opacity: .55; }
      .wa-product-assignments .wa-assignment-saved { display: block; margin-top: 8px; color: var(--wa-good-text); }
    `}</style>
    {loading && data === null ? <div style={{ height: 120, overflow: 'hidden' }}><EmptyState variant="loading" title="Checking product assignments" body="Reading unresolved ad groups for this date range." /></div> : null}
    {error ? <EmptyState variant="error" title="Product assignment unavailable" body={error} action={<Button onClick={() => refresh((value) => value+1)}>Reload assignments</Button>} /> : null}
    {data && data.unassignedCount > 0 ? <section data-testid="grid-unattributed" style={{ height: 120, boxSizing: 'border-box', padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 16, background: tokens.color.warnSoft, borderBlock: `1px solid ${tokens.color.warnBorder}`, color: tokens.color.warn, fontSize: 13 }}>
      <strong>{data.unassignedCount} {data.unassignedCount === 1 ? 'ad group advertises' : 'ad groups advertise'} more than one ASIN, so {money(data.unassignedSpend)} of spend over {data.days} {data.days === 1 ? 'day' : 'days'} needs a product assignment.</strong>
      <Button className="wa-product-assignment-action" ref={trigger} onClick={() => dialog.current?.showModal()}>Link them</Button>
    </section> : null}
    <dialog className="wa-product-assignments" ref={dialog} aria-label="Assign products to ad groups" onClose={() => trigger.current?.focus()} style={{ width: 'min(900px, calc(100vw - 48px))', maxHeight: '80vh', background: tokens.color.surface, color: tokens.color.text, border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: 24 }}>
      <h2>Assign products to ad groups</h2>
      <p>Choose the advertised product to associate with each ad group in Arcana. Assignments do not change Amazon ads or recompute product performance totals.</p>
      {error ? <EmptyState variant="error" title="Assignment unavailable" body={error} action={<Button onClick={() => refresh((value) => value+1)}>Reload list</Button>} /> : null}
      {loading ? <EmptyState variant="loading" title="Refreshing assignments" body="Waiting for the saved list and counts." /> : null}
      {data?.canAssign === false ? <EmptyState variant="gated" title="Read-only access" body="An analyst, admin or owner can assign products." /> : null}
      {data?.count === 0 ? <EmptyState title="No multi-product ad groups" body="No current ad groups advertise multiple products." /> : null}
      <p>{data?.count ?? '—'} {data?.count === 1 ? 'ad group' : 'ad groups'} · {formatDateWindow(start, end)}</p>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th>Ad group</th><th>Spend</th><th>Product</th><th>Assignment</th></tr></thead><tbody>
        {data?.items.map((item) => <tr key={item.adGroupId} data-testid="product-assignment-row">
          <td>{item.name ?? item.adGroupId}</td><td>{money(item.spend)}</td>
          <td><select aria-label={`Product for ${item.name ?? item.adGroupId}`} value={selected[item.adGroupId] ?? item.assignedAsin ?? ''} disabled={!data.canAssign || pending || loading} onChange={(event) => setSelected({ ...selected, [item.adGroupId]: event.target.value })}>
            <option value="">Choose product</option>{item.asins.map((asin) => <option key={asin} value={asin}>{asin}</option>)}
          </select></td>
          <td><Button variant="primary" disabled={!data.canAssign || pending || loading || !(selected[item.adGroupId] ?? item.assignedAsin)} onClick={() => void assign(item.adGroupId, selected[item.adGroupId] ?? item.assignedAsin!)}>Save assignment</Button>{item.assignedAsin ? <span className="wa-assignment-saved"> Assigned: {item.assignedAsin}</span> : null}</td>
        </tr>)}
      </tbody></table></div>
      <Button style={{ marginTop: 24 }} onClick={close}>Close</Button>
    </dialog>
  </>;
}

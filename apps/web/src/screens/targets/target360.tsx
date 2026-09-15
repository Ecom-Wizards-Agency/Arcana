'use client';
import { ProductShelf } from './product-shelf';
import { useEffect, useRef, useState } from 'react';
import { BidCorridorChart, TrendChart } from '@wizard-ads/ui';
import { corridorReading, corridorSummary, targetBidChecks } from '@wizard-ads/core';
import { normalizeQueuedBidOverride, parseGridView, serializeGridView, type GridSavedView } from '@wizard-ads/shared';
import type { Target360Model } from './model';
import styles from './target360.module.css';
const tabs = ['Corridor', 'Shelf', 'Rank', 'Changes', 'Performance'] as const;
const defaultTarget: NonNullable<GridSavedView['target']> = { series: { bid: true, realisedCpc: true, suggestedBand: true, maxCpc: true, dailySpend: true, acos: true }, maxCpcExpanded: true };
const seriesLabels = { bid: 'Bid', realisedCpc: 'Realised CPC', suggestedBand: 'Amazon suggested band', maxCpc: 'Max CPC', dailySpend: 'Daily spend', acos: 'ACOS' };
export function Target360({ model, currencyCode, back, savedView, onClose, showLimits = false }: { model: Target360Model; currencyCode: string; back: string; savedView: string | null; onClose?: () => void; showLimits?: boolean }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Corridor');
  const [view, setView] = useState<GridSavedView>(() => parseGridView(savedView) ?? parseGridView(new URL(back, 'https://arcana.invalid').searchParams.get('view')) ?? {
    id: 'target-analysis', name: 'Target analysis', entity: 'targets', columns: [], pinned: [], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: { start: model.payload.window.from, end: model.payload.window.to }, updatedAt: model.payload.window.to,
  });
  const target = view.target ?? defaultTarget;
  const [bid, setBid] = useState(model.bidContext?.oldBid?.amount ?? '');
  const [override, setOverride] = useState('');
  const [message, setMessage] = useState('');
  const [queued, setQueued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestIdentity = useRef<{ draft: string; id: string } | null>(null);
  const [comparisons, setComparisons] = useState<Record<string, Target360Model>>({});
  const money = (value: number | null) => value === null ? 'Not measured' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(value);
  const percent = (value: number | null) => value === null ? 'Not measured' : `${(value * 100).toFixed(1)}%`;
  const summary = corridorSummary(model.payload.points);
  const hasSeries = model.payload.points.some((p) => [p.bid,p.cpc,p.low,p.median,p.high,p.maxCpc].some((value) => value !== null));
  const current = model.bidContext;
  const latestRank = model.ranks.at(-1);
  const latestRanks = model.ranks.filter((r) => r.date === latestRank?.date && r.organicRank !== null);
  const rank = latestRank ? { ...latestRank, organicRank: latestRanks.length ? Math.min(...latestRanks.map((r) => r.organicRank!)) : null } : undefined;
  const share = model.performance.filter((p) => p.topOfSearchShare !== null).at(-1);
  const checks = current === null ? [] : targetBidChecks(current, Number(bid), override || null);
  const rankProtected = current?.organicRank != null && current.protectionRank != null && current.organicRank <= current.protectionRank;
  const rankBlocked = checks.some((c) => c.key === 'rank_gate' && !c.passed);
  const update = (next: GridSavedView) => {
    setView(next);
    const url = new URL(window.location.href); url.searchParams.set('view', serializeGridView(next));
    window.history.replaceState(window.history.state, '', url);
    if (onClose) window.dispatchEvent(new CustomEvent('arcana:target-view', { detail: serializeGridView(next) }));
  };
  const returnUrl = new URL(back, 'https://arcana.invalid');
  const originView = parseGridView(returnUrl.searchParams.get('view'));
  if (originView && (view.target !== undefined || view.compare !== undefined)) {
    returnUrl.searchParams.set('view', serializeGridView({ ...originView,
      ...(view.target === undefined ? {} : { target: view.target }),
      ...(view.compare === undefined ? {} : { compare: view.compare }),
    }));
  }
  const returnTo = `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;
  const fullQuery = new URLSearchParams({ profile: model.profileId, from: model.payload.window.from, to: model.payload.window.to, back: returnTo, view: serializeGridView(view) });
  const targetPath = '/targets/' + encodeURIComponent(model.payload.target.targetId);
  const full = `${targetPath}?${fullQuery}`;
  const compare = async () => {
    const pair = { profileId: model.profileId, targetId: model.payload.target.targetId };
    if ((view.compare ?? []).some((p) => p.profileId === pair.profileId && p.targetId === pair.targetId)) { setMessage('This target is already in compare.'); return; }
    if ((view.compare?.length ?? 0) >= 4) { setMessage('Compare holds up to four targets. Remove a target before adding another.'); return; }
    update({ ...view, compare: [...view.compare ?? [], pair] }); setMessage('Target added to compare.');
  };
  useEffect(() => {
    const controller = new AbortController();
    for (const pair of view.compare ?? []) {
      if (pair.profileId === model.profileId && pair.targetId === model.payload.target.targetId) continue;
      const key = `${pair.profileId}:${pair.targetId}`;
      const query = new URLSearchParams({ profile: pair.profileId, from: model.payload.window.from, to: model.payload.window.to });
      const path = `/api/targets/${encodeURIComponent(pair.targetId)}`;
      void fetch(`${path}?${query}`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error('Comparison could not be loaded.');
        const data = await response.json() as Target360Model;
        if (!controller.signal.aborted) setComparisons((old) => ({ ...old, [key]: data }));
      }).catch(() => { if (!controller.signal.aborted) setMessage('Comparison could not be loaded.'); });
    }
    return () => controller.abort();
  }, [view.compare, model.profileId, model.payload.target.targetId, model.payload.window.from, model.payload.window.to]);
  const queue = async () => {
    if (!current?.oldBid || !current.readAt) return;
    setBusy(true); setMessage('');
    const draft = JSON.stringify([current.profileId,current.targetId,current.oldBid,current.readAt,bid,override.trim()]);
    if (requestIdentity.current?.draft !== draft) requestIdentity.current = { draft, id: crypto.randomUUID() };
    try {
      const response = await fetch(`/api/targets/${encodeURIComponent(current.targetId)}/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        requestId: requestIdentity.current.id, profileId: current.profileId, targetId: current.targetId, expectedBid: current.oldBid, expectedReadAt: current.readAt,
        newBid: { amount: String(Number(bid)), currencyCode }, overrideReason: normalizeQueuedBidOverride(override) || null,
      }) });
      const data = await response.json() as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? 'The save could not be confirmed. Reload before trying again.');
      setQueued(data.id); setMessage('Change added to queue');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Queueing failed.'); }
    finally { setBusy(false); }
  };
  const components = model.payload.points.at(-1)?.components ?? [];
  const zeroPlacements = model.payload.points.at(-1)?.placementEvidence === 'known-zero';
  const maxPlacement = components.length ? components.reduce((a,b) => a.pct >= b.pct ? a : b) : null;
  return <article className={styles.root} style={onClose ? { margin: 0 } : undefined} data-state={queued ? 'queued' : rankBlocked ? 'rank-gated' : hasSeries ? 'populated' : 'empty-series'}>
    <header className={styles.header}>
      <div className={styles.breadcrumb}><a href={returnTo}>Back to grid</a> / Targets / {model.payload.target.targeting}</div>
      <div className={styles.titleRow}><div><h1>{model.payload.target.targeting}</h1><p className={styles.meta}>{model.payload.target.matchType ?? 'Not measured'} · {model.payload.target.targetKind} · {model.payload.target.state ?? 'State not measured'} | {model.payload.target.adProduct} | {model.payload.target.campaignName}</p></div>
        <div className={styles.actions}><button className="wa-btn" onClick={() => void compare()}>Add to compare</button><a className="wa-btn" href={full}>Open full ↗</a>{onClose ? <button className="wa-btn" onClick={onClose} aria-label="Close target">×</button> : <a className="wa-btn" href={returnTo} aria-label="Close target">×</a>}</div>
      </div>
    </header>
    <div className={styles.signals}><div className={styles.rank}><span className={styles.rankMark}>R</span><div><strong>{rank?.organicRank == null ? 'Not measured' : `#${rank.organicRank}`}</strong><p className={styles.meta}>daily · {model.ranks.length} observations{rank ? ` · to ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(rank.date))}` : ''}</p></div></div>
      <div className={styles.notice}>{share ? `T · ${percent(share.topOfSearchShare)} on ${share.date}. I · P not measured` : 'T · I · P not measured'}<small>{share ? '' : 'Top-of-search share: column empty. '}SQP shares are not measured until SP-API ingestion.</small></div></div>
    <nav className={styles.tabs} role="tablist" aria-label="Target analysis">{tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} aria-controls={`target-${name}`} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {tab === 'Corridor' ? <section id="target-Corridor" role="tabpanel" className={styles.corridor}>
      <aside className={`${styles.panel} ${styles.seriesPanel}`}><h2>DATA SERIES</h2>{(Object.keys(seriesLabels) as (keyof typeof seriesLabels)[]).map((key) => <div key={key} className={styles.seriesItem}><label className={styles.selector}><input type="checkbox" checked={target.series[key]} onChange={(e) => update({ ...view, target: { ...target, series: { ...target.series, [key]: e.target.checked } } })} /><span aria-hidden="true" className={styles.swatch} data-series={key} />{seriesLabels[key]}</label>{key === 'maxCpc' ? <><button className={styles.expand} aria-label="Placement components" aria-expanded={target.maxCpcExpanded} onClick={() => update({ ...view, target: { ...target, maxCpcExpanded: !target.maxCpcExpanded } })}>▾</button>{target.maxCpcExpanded ? <div className={styles.components}>{components.length ? components.map((c) => <label className={styles.selector} key={c.name}><input type="checkbox" checked={target.placementLines?.[c.name] ?? c.pct > 0} onChange={(e) => update({ ...view, target: { ...target, placementLines: { ...target.placementLines, [c.name]: e.target.checked } } })} /><span aria-hidden="true" className={styles.swatch} />{c.name} {c.pct > 0 ? '+' : ''}{c.pct}%</label>) : <p>{zeroPlacements ? 'Placement uplifts: 0%.' : 'Placement modifiers not measured.'}</p>}</div> : null}</> : null}</div>)}</aside>
      <div className={styles.plot}><section aria-label="Bid corridor chart"><BidCorridorChart ariaLabel="Bid, realised CPC, suggested band and max CPC" currencyCode={currencyCode} points={model.payload.points} compact placementLines={target.series.maxCpc ? components.filter((c) => target.placementLines?.[c.name] ?? c.pct > 0).map((c) => c.name) : []} visible={{ bid: target.series.bid, cpc: target.series.realisedCpc, suggested: target.series.suggestedBand, maxCpc: target.series.maxCpc }} /></section>
        <section className={styles.lane} aria-label="Target metrics"><TrendChart title="Daily spend · ACOS" ariaLabel="Daily spend bars and ACOS line" currencyCode={currencyCode} scale="money" height={158} series={[
          ...(target.series.dailySpend ? [{ label: 'Daily spend', mark: 'bar' as const, points: model.performance.map((p) => ({ date: p.date, value: p.spend })) }] : []),
          ...(target.series.acos ? [{ label: 'ACOS', axis: 'right' as const, scale: 'percent' as const, points: model.performance.map((p) => ({ date: p.date, value: p.acos })) }] : []),
          ...(target.series.acos && current?.targetAcos != null ? [{ label: 'Target ACOS', axis: 'right' as const, scale: 'percent' as const, points: model.performance.map((p) => ({ date: p.date, value: current.targetAcos })) }] : []),
        ]} />{current?.targetAcos == null ? <p className={styles.meta}>Target ACOS setting is missing; no target line is shown.</p> : null}</section>
      </div>
      <aside className={`${styles.panel} ${styles.summary}`}><h2>WHAT THIS SHOWS</h2><dl>
        <dt>Bid</dt><dd>{money(summary.bid)}{summary.bid !== null && model.payload.points.every((p) => p.bid === summary.bid) ? <small>Unchanged for all {model.payload.points.length} measured days</small> : null}</dd><dt>Realised CPC</dt><dd>{money(summary.cpcAverage)}{summary.cpcAverage === null ? '' : ' avg'}<small>Highest single day {money(summary.highestCpc)}{summary.highestDate ? ` on ${summary.highestDate}` : ''}</small></dd>
        <dt>Suggested median</dt><dd>{money(summary.median)}{summary.previousMedian ? <small>Was {money(summary.previousMedian.median)} on {summary.previousMedian.date}.</small> : null}</dd>
        <dt>Bid vs band</dt><dd>{summary.bandPosition}</dd><dt>Max CPC</dt><dd>{money(summary.maxCpc)}<small>{summary.bid !== null && maxPlacement ? `${money(summary.bid)} base × (1 + ${maxPlacement.pct}% ${maxPlacement.name.toLowerCase()})` : summary.bid !== null && zeroPlacements ? `${money(summary.bid)} base × (1 + 0% placement uplift)` : 'Placement formula not measured.'}</small></dd>
      </dl><strong>Reading</strong><p>{corridorReading(model.payload.points, money)}</p>{!hasSeries ? <p className={styles.honesty}>The bid series is empty. No reference values or invented numbers are plotted.</p> : null}</aside>
    </section> : <section id={`target-${tab}`} role="tabpanel" className={styles.tabContent}>
      {tab === 'Shelf' ? <ProductShelf products={model.shelf}/> : null}
      {tab === 'Rank' ? <section aria-label="Rank observations"><h2>Rank observations</h2>{model.ranks.length === 0 ? <p>No rank observations measured for this keyword and profile in this period.</p> : <table><thead><tr><th>Date</th><th>ASIN</th><th>Organic rank</th><th>Sponsored rank</th></tr></thead><tbody>{model.ranks.map((r,i) => <tr key={i}><td>{r.date}</td><td>{r.asin}</td><td>{r.organicRank ?? 'Not measured'}</td><td>{r.sponsoredRank ?? 'Not measured'}</td></tr>)}</tbody></table>}</section> : null}
      {tab === 'Changes' ? <><h2>Changes</h2>{model.changes.length === 0 ? <p>No entity changes recorded in this period.</p> : <table><thead><tr><th>Date</th><th>Field</th><th>Before</th><th>After</th><th>Source</th></tr></thead><tbody>{model.changes.map((r) => <tr key={r.id}><td>{r.date}</td><td>{r.field}</td><td>{r.oldValue ?? 'Not measured'}</td><td>{r.newValue ?? 'Not measured'}</td><td>{r.source}</td></tr>)}</tbody></table>}</> : null}
      {tab === 'Performance' ? <><h2>Performance</h2>{model.performance.length === 0 ? <p>No target facts measured in this period.</p> : <table><thead><tr><th>Date</th><th>Impressions</th><th>Clicks</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACOS</th><th>Top-of-search share</th></tr></thead><tbody>{model.performance.map((r) => <tr key={r.date}><td>{r.date}</td><td>{r.impressions ?? 'Not measured'}</td><td>{r.clicks ?? 'Not measured'}</td><td>{money(r.spend)}</td><td>{money(r.sales)}</td><td>{r.orders ?? 'Not measured'}</td><td>{percent(r.acos)}</td><td>{percent(r.topOfSearchShare)}</td></tr>)}</tbody></table>}</> : null}
    </section>}
    <footer className={styles.footer}><label>Bid <input aria-label="Proposed bid" inputMode="decimal" value={bid} onChange={(e) => { setBid(e.target.value); setQueued(null); }} /></label>
      <div className={styles.footerNote}>{current?.organicRank == null ? 'Current organic rank not measured.' : `Organic rank #${current.organicRank}.`} {rankProtected ? 'A bid-down here needs a rank gate override.' : rankBlocked ? 'A bid-down here needs measured rank protection settings.' : ''}<br />Current bid {current?.oldBid ? money(Number(current.oldBid.amount)) : 'Not measured'}. Review and approve the queued change before it is sent to Amazon.</div>
      <button className="wa-btn" disabled={summary.median === null} onClick={() => { setBid(String(summary.median)); setQueued(null); }}>Match suggested {summary.median === null ? '' : money(summary.median)}</button>
      <button className="wa-btn wa-btn--primary" disabled={busy || rankBlocked || !current?.oldBid || !current.readAt || !Number.isFinite(Number(bid)) || Number(bid) <= 0 || Number(bid) === Number(current?.oldBid?.amount)} onClick={() => void queue()}>{busy ? 'Adding…' : 'Add to change queue'}</button>
      {message ? <p role="status">{message} {queued ? <a href={`${targetPath}/queue/${queued}?${fullQuery}`}>Review queued change</a> : null}</p> : null}
    </footer>
    {rankBlocked || override ? <div className={styles.overridePanel}><label>Override reason <input className={styles.override} value={override} onChange={(e) => { setOverride(e.target.value); setQueued(null); }} /></label><span>The reason is stored with the queued change.</span></div> : null}
    {showLimits ? <section id="target-limits" className={`${styles.panel} ${styles.limits}`} aria-label="Current bid limits"><h2>Current bid limits</h2>
      <p>These are the latest sourced settings. Changing a bid still requires a new queued proposal and review.</p>
      <dl><dt>Minimum bid</dt><dd>{money(current?.bidFloor ?? null)}</dd><dt>Maximum bid</dt><dd>{money(current?.bidCeiling ?? null)}</dd>
        <dt>Maximum increase</dt><dd>{percent(current?.maxIncrease ?? null)}</dd><dt>Maximum decrease</dt><dd>{percent(current?.maxDecrease ?? null)}</dd>
        <dt>Campaign daily budget</dt><dd>{money(current?.campaignBudget ?? null)}</dd><dt>Target ACOS</dt><dd>{percent(current?.targetAcos ?? null)}</dd>
        <dt>Organic rank protection</dt><dd>{current?.protectionRank == null ? 'Not measured' : `Rank ${current.protectionRank} or better`}</dd>
        <dt>Settings source</dt><dd>{current?.settingSource ?? 'Not measured'}</dd></dl>
    </section> : null}
    {(view.compare?.length ?? 0) > 0 ? <section aria-label="Compare targets" className={styles.compare}><h2>Compare targets ({view.compare!.length}/4)</h2>{view.compare!.map((p) => {
      const key = `${p.profileId}:${p.targetId}`;
      const other = p.profileId === model.profileId && p.targetId === model.payload.target.targetId ? model : comparisons[key];
      return <section key={key}><button className="wa-btn" onClick={() => update({ ...view, compare: view.compare!.filter((c) => c !== p) })}>Remove {other?.payload.target.targeting ?? p.targetId}</button>{other ? <BidCorridorChart title={other.payload.target.targeting} ariaLabel={`Compare ${other.payload.target.targeting}`} currencyCode={other.currencyCode} points={other.payload.points} /> : <p aria-busy="true">Loading comparison {p.targetId}…</p>}</section>;
    })}</section> : null}
  </article>;
}

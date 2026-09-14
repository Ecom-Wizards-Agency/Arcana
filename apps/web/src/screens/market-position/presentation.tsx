import type { CSSProperties, ReactNode } from 'react';
import { TrendChart } from '@wizard-ads/ui';
import { EmptyState } from '../../ui/primitives';
import { number, positionModel, productUrl, shortDate, type Ready } from './model';

const small: CSSProperties = { fontSize: 'var(--wa-fs-2xs)', color: 'var(--wa-text-muted)', lineHeight: 1.35 };
const action: CSSProperties = { border: '1px solid var(--wa-bad-border)', borderRadius: 'var(--wa-radius-sm)', padding: '0.375rem 0.75rem', fontSize: 'var(--wa-fs-xs)', fontWeight: 600, lineHeight: 1.2, background: 'var(--wa-surface-2)', color: 'inherit', textDecoration: 'none', cursor: 'pointer' };
const move = (value: number | null) => value === null ? 'Not measured' : value > 0 ? `slipped ${number(value)}` : value < 0 ? `gained ${number(-value)}` : 'held steady';

export function MarketPositionPresentation({ data, category, threshold, onProduct, onCategory, onAdjust, editor }: {
  data: Ready; category: string; threshold: number; onProduct?: (asin: string) => void; onCategory?: (category: string) => void; onAdjust?: () => void; editor?: ReactNode;
}) {
  const model = positionModel(data, category, threshold);
  const { bsr, alert, ownMove, theirMove, gap, missing } = model;
  const categories = data.series.filter((series) => series.asin === data.selectedAsin && series.category);
  const percent = gap === null || bsr === null ? null : Math.abs(gap) * 100 / bsr;
  const nearestPercent = model.nearest && bsr !== null ? Math.abs(model.nearest.bsr - bsr) * 100 / bsr : null;
  const thresholdRank = bsr === null ? null : Math.floor(bsr * (1 + threshold / 100));
  const badge = model.point?.bestSellerBadge;
  const subcategory = model.point?.subcategory;
  const cause = alert?.cause === 'own_rank_worsened' ? 'this is your velocity, not their gain.'
    : alert?.cause === 'competitor_improved' ? 'this is their gain, not your velocity.'
    : alert?.cause === 'both' ? 'both your rank worsening and their gain contributed to the movement.' : 'neither your rank worsening nor a competitor gain was measured.';
  const targets = new URLSearchParams({ entity: 'targets', profile: data.profileId, asin: data.selectedAsin, from: data.start, to: data.end });
  return <main aria-label="Market position details" style={{ width: 'calc(100% + 0.5rem)', margin: '-0.25rem', minWidth: 0 }}>
    {!data.products.length ? <EmptyState title="No advertised products yet" body="Products appear after entity sync." action={<a href="/settings/integrations">Manage integrations</a>} /> : <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.25rem', fontSize: 'var(--wa-fs-xs)', color: 'var(--wa-text-muted)', marginBottom: '0.5rem', lineHeight: 1.2, minHeight: '1rem' }}>
        <select aria-label="Product" id="market-product" value={data.selectedAsin} onChange={(event) => onProduct?.(event.target.value)} style={{ font: 'inherit', color: 'inherit', maxWidth: '16rem', background: 'transparent', border: 0, padding: 0 }}>
          {data.products.map((product) => <option key={product.asin} value={product.asin}>{product.name ?? product.asin}</option>)}
        </select><span>·</span><a href={productUrl(data.selectedAsin, data.countryCode)} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{data.selectedAsin}</a><span>·</span>
        {categories.length > 1 ? <select aria-label="Category" value={category} onChange={(event) => onCategory?.(event.target.value)} style={{ font: 'inherit', color: 'inherit', background: 'transparent', border: 0 }}>{categories.map((series) => <option key={series.category}>{series.category}</option>)}</select> : <span>{category || 'Category not measured'}</span>}
        <span>· BSR from Keepa, read daily · {model.links.length} competitors tracked</span>
      </div>
      <section aria-label="Proximity status" data-testid={alert ? 'proximity-alert' : 'proximity-status'} style={{ padding: '0.6875rem 0.8125rem', border: `1px solid var(--wa-${alert ? 'bad-border' : 'border'})`, borderRadius: 'var(--wa-radius)', background: alert ? 'color-mix(in srgb, var(--wa-bad) 10%, var(--wa-bg))' : 'var(--wa-surface)', color: alert ? 'color-mix(in srgb, var(--wa-bad-text) 80%, var(--wa-accent-text))' : 'var(--wa-text-muted)', display: 'grid', gap: '0.375rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.625rem', alignItems: 'center' }}>
          <span style={{ fontSize: '0.625rem', fontWeight: 600, lineHeight: 1.2, borderRadius: 'var(--wa-radius-sm)', background: alert ? 'color-mix(in srgb, var(--wa-bad) 12%, transparent)' : 'var(--wa-surface-3)', padding: '0.1875rem 0.5rem' }}>{alert ? 'PROXIMITY ALERT' : missing ? 'NOT MEASURED' : 'PROXIMITY'}</span>
          <strong style={{ fontSize: 'var(--wa-fs-sm)', fontWeight: 600 }}>{alert ? `${alert.gap >= 0 ? '#2' : 'The leading competitor'} is within ${Math.round(Math.abs(alert.gapPercent))}% of your BSR. Your threshold is ${threshold}%.` : nearestPercent === null ? 'BSR proximity is not measured.' : `The nearest competitor is ${nearestPercent.toFixed(1)}% from your BSR. Your threshold is ${threshold}%.`}</strong>
          {alert ? <span style={{ marginLeft: 'auto', fontSize: 'var(--wa-fs-2xs)' }} title="First daily observation establishing this alert; UTC. No delivery is recorded.">{model.firedAt ? `fired ${model.firedAt.slice(11, 16)} ${model.firedAt.slice(0, 10) === new Date().toISOString().slice(0, 10) ? 'today' : `on ${shortDate(model.firedAt.slice(0, 10))}`} UTC` : `fired ${shortDate(alert.date)} · time not measured`}</span> : null}
        </div>
        <p style={{ margin: 0, fontSize: 'var(--wa-fs-2xs)', lineHeight: 1.3 }}>{alert ? `You are at ${number(bsr)} and ${model.rivalName} is at ${number(alert.competitorBsr)}. ${alert.gap >= 0 ? `For the alert to clear, they need to be worse than ${number(thresholdRank)}. ` : ''}${model.gapClosed ? 'The gap closed because you' : 'Since the previous day you'} ${move(ownMove)} in 1 day while they ${move(theirMove)} — ${cause}` : missing ?? 'The measured distance is outside your saved proximity threshold.'}</p>
        {model.alerts.length > 1 ? <details style={{ fontSize: 'var(--wa-fs-2xs)' }}><summary>{model.alerts.length - 1} other tracked competitors are within your threshold</summary><ul aria-label="Other proximity alerts">{model.alerts.slice(1).map((other) => <li key={other.competitorAsin}>
          <a href={productUrl(other.competitorAsin, data.countryCode)} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{data.series.find((series) => series.asin === other.competitorAsin)?.name ?? other.competitorAsin}</a>{' · '}{Math.abs(other.gapPercent).toFixed(1)}% away · {other.cause === 'both' ? 'your rank worsened and competitor improved' : other.cause === 'own_rank_worsened' ? 'your rank worsened' : other.cause === 'competitor_improved' ? 'competitor improved' : 'no adverse movement on the previous day'}
        </li>)}</ul></details> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.125rem' }}>
          {alert ? <><a href={`/grid?${targets}`} style={{ ...action, color: 'var(--wa-white)', background: 'var(--wa-accent)', borderColor: 'var(--wa-accent)' }}>Raise bids on this ASIN</a><button type="button" disabled title="No pricing write exists. Price discounts are not available in Arcana." style={{ ...action, cursor: 'not-allowed' }}>Create a price discount</button></> : null}
          {data.canEdit ? <button type="button" onClick={onAdjust} aria-expanded={Boolean(editor)} style={action}>Adjust threshold</button> : null}
          {!model.links.length ? <a href="/settings/integrations" style={action}>Manage competitor links</a> : null}
        </div>
        {editor}
      </section>
      <div aria-label="Rank statistics" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 0, marginTop: '0.875rem', marginBottom: '0.875rem' }}>
        <Stat label="YOUR BSR" value={number(bsr)} sub={ownMove === null ? 'Previous day not measured' : `1 day ago ${number(model.prior?.bsr)} · ${move(ownMove)}`} />
        <Stat label="GAP TO #2" value={number(gap)} tone={alert ? 'var(--wa-bad-text)' : undefined} sub={percent === null ? 'Not measured' : `${percent.toFixed(1)}% of your BSR · threshold ${threshold}%`} />
        <Stat label="BEST SELLER BADGE" value={badge == null ? 'Not measured' : badge ? 'held' : 'not held'} sub={badge == null ? 'Badge evidence not collected' : `${badge ? 'held' : 'not held'} for ${model.badgeDays} consecutive ${model.badgeDays === 1 ? 'day' : 'days'}`} />
        <Stat label="SUBCATEGORY" value={subcategory ? `#${number(subcategory.rank)}` : 'Not measured'} sub={subcategory?.name ?? 'Subcategory evidence not collected'} />
        <Stat label="THEIR MOVE" value={theirMove === null ? 'Not measured' : number(Math.abs(theirMove))} sub={`${model.rivalName}${theirMove === null ? '' : ', 1 day'}`} />
        <Stat label="YOUR MOVE" value={ownMove === null ? 'Not measured' : number(Math.abs(ownMove))} sub={ownMove === null || theirMove === null ? 'Adjacent day not measured' : ownMove <= 0 ? move(ownMove) : theirMove >= 0 || ownMove > -theirMove ? 'the larger half of the gap' : ownMove === -theirMove ? 'half of the gap' : 'the smaller half of the gap'} />
      </div>
      {model.chart.some((series) => series.points.some((point) => point.value !== null)) ? <TrendChart title="Best Sellers Rank" ariaLabel="Own and competitor BSR; rank 1 at the top" header={<></>} series={model.chart} invertedAxis rankLabels scale="integer" currencyCode="USD" width={1152} height={274} showNumbers={false} windows={model.firedDate ? [{ label: `alert fires ${shortDate(model.firedDate)}`, start: model.firedDate, end: null }] : []} /> : <div style={{ ...small, minHeight: '17.125rem', display: 'grid', placeContent: 'center', borderBlock: '1px solid var(--wa-border)' }}>BSR not measured in this window. Missing days stay gaps.</div>}
      <div style={{ ...small, display: 'grid', gap: '0.375rem', marginTop: '0.75rem' }}>
        <p style={{ margin: 0 }}>The axis is inverted because #1 is best. A line falling on this chart is a product getting worse. Missing days stay gaps.</p>
        <p style={{ margin: 0 }}>The threshold is a percentage of your own BSR, so it moves as you move.{bsr === null ? '' : ` At ${number(bsr)} it sits at ${number(thresholdRank)}; if you recover, it tightens.`} The alert is about distance, not position.</p>
        <p style={{ margin: 0 }}>The alert names which way the gap closed. You slipping and them gaining need different responses, and an alert that only says “they are close” leaves you to work out which.</p>
        <p style={{ margin: 0 }}>BSR is a metric, not a change marker. It moves several places a day with nothing edited, so rank movement never appears as an event on the Timeline.</p>
        {missing ? <p style={{ margin: 0, color: 'var(--wa-bad-text)' }}>{missing}</p> : null}
      </div>
    </>}
  </main>;
}
function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string | undefined }) {
  return <div data-testid="rank-stat" style={{ minWidth: 0, paddingRight: '1.375rem', display: 'flex', flexDirection: 'column', gap: '0.125rem' }}><div style={{ fontSize: '0.625rem', color: 'var(--wa-text-muted)', fontWeight: 500 }}>{label}</div><div style={{ fontSize: value === 'Not measured' ? 'var(--wa-fs-md)' : '1.25rem', lineHeight: 1.2, color: tone ?? 'var(--wa-text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div><div style={{ ...small, fontSize: '0.625rem' }}>{sub}</div></div>;
}

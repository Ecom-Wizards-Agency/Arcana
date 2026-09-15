import { marketPositionAlerts, marketPositionGap, marketRankWindow } from '@wizard-ads/core';
import type { MarketRankSeries } from '@wizard-ads/shared';
import type { TrendSeries } from '@wizard-ads/ui';
import type { MarketPositionData } from './load';

export type Ready = Extract<MarketPositionData, { view: 'ready' }>;
export const number = (value: number | null | undefined): string => value == null ? 'Not measured' : value.toLocaleString('en-US');
export const shortDate = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const previousDate = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
export function productUrl(asin: string, country: string): string {
  const domains: Record<string, string> = { US: 'com', CA: 'ca', MX: 'com.mx', BR: 'com.br', GB: 'co.uk', UK: 'co.uk', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl', SE: 'se', PL: 'pl', BE: 'com.be', JP: 'co.jp', AU: 'com.au', IN: 'in', AE: 'ae', SA: 'sa', SG: 'sg', TR: 'com.tr' };
  return `https://www.amazon.${domains[country] ?? 'com'}/dp/${encodeURIComponent(asin)}`;
}
export function trackedSeries(data: Ready, asin: string, category: string): MarketRankSeries[] {
  return data.links.filter((link) => link.ownAsin === asin && (link.category === null || link.category === category))
    .map((link) => data.series.find((series) => series.asin === link.competitorAsin && series.category === category)
      ?? { asin: link.competitorAsin, category, points: [] });
}
export function positionModel(data: Ready, category: string, threshold: number) {
  const own = data.series.find((series) => series.asin === data.selectedAsin && series.category === category);
  const point = own?.points.find((point) => point.date === data.end);
  const prior = own?.points.find((point) => point.date === previousDate(data.end));
  const competitors = trackedSeries(data, data.selectedAsin, category);
  const links = data.links.filter((link) => link.ownAsin === data.selectedAsin);
  const measured = competitors.flatMap((series) => {
    const bsr = series.points.find((point) => point.date === data.end)?.bsr;
    return bsr == null ? [] : [{ series, bsr }];
  });
  const bsr = point?.bsr ?? null;
  const nearest = bsr === null ? undefined : measured.sort((a, b) => Math.abs(a.bsr - bsr) - Math.abs(b.bsr - bsr))[0];
  const nearestPrior = nearest?.series.points.find((point) => point.date === previousDate(data.end));
  const best = [...measured].sort((a, b) => a.bsr - b.bsr)[0];
  const alerts = own ? competitors.flatMap((competitor) => marketPositionAlerts(own, competitor, threshold)).filter((alert) => alert.date === data.end).sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap)) : [];
  const alert = alerts[0];
  const rival = competitors.find((series) => series.asin === alert?.competitorAsin) ?? best?.series;
  const rivalPoint = rival?.points.find((point) => point.date === data.end);
  const rivalPrior = rival?.points.find((point) => point.date === previousDate(data.end));
  const ownMove = bsr === null || prior?.bsr == null ? null : bsr - prior.bsr;
  const theirMove = rivalPoint?.bsr == null || rivalPrior?.bsr == null ? null : rivalPoint.bsr - rivalPrior.bsr;
  const gapClosed = bsr !== null && rivalPoint?.bsr != null && prior?.bsr != null && rivalPrior?.bsr != null
    && Math.abs(rivalPoint.bsr - bsr) < Math.abs(rivalPrior.bsr - prior.bsr);
  const nameOf = (series: MarketRankSeries) => series.name ?? data.products.find((product) => product.asin === series.asin)?.name ?? series.asin;
  const gap = own ? marketPositionGap(own, competitors, data.end) : null;
  let firedDate: string | null = null;
  if (alert && own && rival) {
    const dates = new Set(marketPositionAlerts(own, rival, threshold).map((entry) => entry.date));
    firedDate = data.end;
    while (dates.has(previousDate(firedDate))) firedDate = previousDate(firedDate);
  }
  // This is the first observation that establishes this run, not a delivery timestamp.
  const firedTimes = firedDate ? [own, rival].map((series) => series?.points.find((point) => point.date === firedDate)?.observedAt) : [];
  const firedAt = firedTimes.length === 2 && firedTimes.every((value) => value !== undefined) ? [...firedTimes].sort().at(-1) : undefined;
  let badgeDays = 0;
  if (point?.bestSellerBadge != null) {
    let date = data.end;
    while (own?.points.find((entry) => entry.date === date)?.bestSellerBadge === point.bestSellerBadge) {
      badgeDays++; date = previousDate(date);
    }
  }
  const missing = !links.length ? 'Needs ingestion: no competitors are linked to this product. Manage competitor links to start the daily comparison.'
    : bsr === null ? 'Needs ingestion: your BSR is not measured on the selected day.'
    : !nearest ? 'Needs ingestion: tracked competitors have no BSR in this category on the selected day.'
    : prior?.bsr == null || nearestPrior?.bsr == null ? 'Needs ingestion: an adjacent day is missing. The distance is measured; an alert and its cause are not.' : null;
  const chart: TrendSeries[] = own ? [
    { label: 'You', tone: 'own', points: marketRankWindow(own.points, data.start, data.end).map((point) => ({ date: point.date, value: point.bsr })) },
    ...competitors.map((series, index): TrendSeries => ({ label: nameOf(series), tone: series.asin === rival?.asin ? 'competitor' : index % 2 === 0 ? 'muted' : 'faint', points: marketRankWindow(series.points, data.start, data.end).map((point) => ({ date: point.date, value: point.bsr })) })),
    { label: 'alert threshold', tone: 'threshold', points: marketRankWindow(own.points, data.start, data.end).map((point) => ({ date: point.date, value: point.bsr === null ? null : Math.floor(point.bsr * (1 + threshold / 100)) })) },
  ] : [];
  return { own, point, prior, bsr, links, nearest, alerts, alert, rival, rivalPoint, ownMove, theirMove, gap, firedDate, firedAt, badgeDays, missing, chart, gapClosed, rivalName: rival ? nameOf(rival) : 'Not measured' };
}

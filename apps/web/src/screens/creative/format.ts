import { formatShellDate } from '../../ui/date-format';
import type { CreativeWorkspaceChange } from '@wizard-ads/shared';

export const integer = (value: number | null): string => value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
export const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
export const money = (value: number | null, currencyCode: string): string => value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(value);
export const ratio = (top: number | null, bottom: number | null): number | null => top === null || bottom === null || bottom <= 0 ? null : top / bottom;
export const dateLabel = (value: string | null): string => value === null ? 'Not measured' : formatShellDate(new Date(value).toISOString().slice(0, 10));
export const creativeHref = (assetId: string, query: string) => '/creative/' + encodeURIComponent(assetId) + '?' + query;
export const creativeCampaignHref = (campaignId: string, query: string) => '/creative/campaign/' + encodeURIComponent(campaignId) + '?' + query;

function observedNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
  return number !== null && Number.isFinite(number) ? number : null;
}

/** Display recorded values without exposing provider field names or JSON. */
export function creativeChangeText(change: CreativeWorkspaceChange, currencyCode: string): string {
  if (change.kind === 'Creative') return 'First seen in this ad group';
  if (change.kind === 'Listing' || change.kind === 'Promotion') {
    const labels: Record<string, string> = { price: 'Price', buyBoxPrice: 'Buy Box price', lightningDeal: 'Lightning deal',
      coupon: 'Coupon', inStock: 'In stock', ownsBuyBox: 'Owns Buy Box', suppressed: 'Listing suppressed',
      rating: 'Rating', reviewCount: 'Reviews', bsr: 'Sales rank', title: 'Title' };
    const valueText = (value: unknown): string => {
      if (value === null || value === undefined) return 'not observed';
      if (change.field === 'price' || change.field === 'buyBoxPrice') return money(observedNumber(value), currencyCode);
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      // The tuple retains provider units; do not guess currency or percent units.
      if (change.field === 'coupon' && Array.isArray(value) && value.length === 2) return `one-time source value ${value[0]}, Subscribe & Save source value ${value[1]}`;
      if (change.field === 'bsr' && typeof value === 'object' && 'rank' in value && 'category' in value) return `${value.rank} in ${value.category}`;
      return typeof value === 'number' || typeof value === 'string' ? String(value) : 'not observed';
    };
    return `${labels[change.field] ?? 'Listing field'}: ${valueText(change.oldValue)} → ${valueText(change.newValue)}`;
  }
  if (change.kind === 'Bid') {
    const bid = (value: unknown) => {
      const number = observedNumber(value);
      return number === null ? 'not observed' : money(number, currencyCode);
    };
    return `${bid(change.oldValue)} → ${bid(change.newValue)}`;
  }
  const modifier = (value: unknown, key: string): number | null => observedNumber(
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : null,
  );
  const uplift = (value: number | null) => value === null ? 'not observed' : `${value >= 0 ? '+' : ''}${value}%`;
  const changes = ([['topOfSearch', 'Top of search'], ['restOfSearch', 'Rest of search'], ['productPages', 'Product pages']] as const).flatMap(([key, label]) => {
    const before = modifier(change.oldValue, key);
    const after = modifier(change.newValue, key);
    if (before === after) return [];
    return [`${label} ${before === null ? `→ ${uplift(after)} (not observed before)` : `${uplift(before)} → ${uplift(after)}`}`];
  });
  return changes.join('; ') || 'Placement change details not observed';
}

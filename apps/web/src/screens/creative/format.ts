export const integer = (value: number | null): string => value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
export const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
export const money = (value: number | null, currencyCode: string): string => value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(value);
export const ratio = (top: number | null, bottom: number | null): number | null => top === null || bottom === null || bottom <= 0 ? null : top / bottom;
export const dateLabel = (value: string | null): string => value === null ? 'Not measured' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
export const creativeHref = (assetId: string, query: string) => '/creative/' + encodeURIComponent(assetId) + '?' + query;
export const creativeCampaignHref = (campaignId: string, query: string) => '/creative/campaign/' + encodeURIComponent(campaignId) + '?' + query;


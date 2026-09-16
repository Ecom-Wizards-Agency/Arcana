import { amazonEntryFixtures } from '../grid/catalogue-fixtures';
import type { TimelineData } from './load';
import type { TimelineDaily, TimelineEvent } from '@wizard-ads/shared';
const shift = (date: string, i: number) => new Date(Date.parse(date) + 86400000 * i).toISOString().slice(0, 10);
const profile: TimelineDaily[] = Array.from({ length: 100 }, (_, i) => ({ date: shift('2026-05-21', i), spend: 1000 - i * 5, sales: 2000 - i * 8, clicks: 100, orders: 20, impressions: 1000 }));
const event = (id: string, kind: TimelineEvent['kind'], name: string, start: string, end: string | null): TimelineEvent => ({ id, kind, name, start, end, status: end ? 'ended' : 'running', scope: { campaignIds: ['synthetic-campaign'] }, scopeText: 'One campaign', focus: 'acos', note: 'Synthetic recorded observation', actorId: null, createdAt: '2026-08-01T00:00:00Z', supersedesId: null });
const events = [event('rank-test', 'experiment', 'Synthetic rank experiment', '2026-08-01', '2026-08-15'), event('creative-test', 'experiment', 'New video creative', '2026-08-11', null), event('batch', 'apply_batch', 'Bid adjustment', '2026-08-24', '2026-08-24'), event('coupon', 'promotion', 'Coupon 15%', '2026-08-09', '2026-08-30'), event('market', 'market', 'Seasonal event', '2026-07-08', '2026-07-12'), event('listing', 'listing', 'Listing revision', '2026-07-18', '2026-08-01'), event('supply', 'supply', 'Stock interruption', '2026-08-03', '2026-08-06')];
export const ready: Extract<TimelineData, {
    view: 'ready';
}> = { view: 'ready', profileId: '26400000-0000-4000-8000-000000000001', currencyCode: 'USD', countryCode: 'US', canEdit: true, start: '2026-07-11', end: '2026-09-07', savedView: null, snapshot: { syncFailureSince: '2026-09-06', profile, events, scoped: Object.fromEntries(events.map((e) => [e.id, profile])), settings: { minDays: null, minClicks: null }, ranks: [{ mode: 'organic', asin: 'B000000264', keyword: 'synthetic keyword', category: null, points: [{ date: '2026-08-18', value: 12 }, { date: '2026-08-20', value: 8 }, { date: '2026-09-06', value: 1 }] }, { mode: 'bsr', asin: 'B000000264', keyword: null, category: 'Synthetic category', points: [{ date: '2026-08-18', value: 2000 }, { date: '2026-08-20', value: 1500 }, { date: '2026-09-06', value: 900 }] }] } };

export const catalogueReady:typeof ready={...ready,snapshot:{...ready.snapshot,events:[ready.snapshot.events[2]!,...amazonEntryFixtures().map((entry):TimelineEvent=>({
  id:entry.id,name:entry.entity,kind:'amazon_change',start:'2026-09-05',end:'2026-09-05',status:entry.amazonObservation!.identityConflict?'identity conflict':entry.amazonObservation!.resolution,
  scope:{},scopeText:`${entry.amazonObservation!.marketplaceId} · ${entry.amazonObservation!.resolution}`,focus:'acos',
  note:'Amazon Ads Change History v1 · derived identity (provider ID unavailable) · no local actor or restore authority',actorId:null,createdAt:entry.amazonObservation!.retrievedAt,supersedesId:null,
}))]}};

import type { ProviderEvidenceReadResult } from '@wizard-ads/shared';
import { readProviderEvidence } from '@wizard-ads/db';
import { listMarketPositionLinks, listMarketPositionProducts, readMarketPositionSettings, readMarketRankSeries } from '@wizard-ads/db';
import type { MarketPositionLink, MarketPositionProduct, MarketPositionSettings, MarketRankSeries } from '@wizard-ads/shared';
import { addDays, periodFromParams, todayIso } from '../../../app/_lib/periods';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';

export type MarketPositionData = { view: 'gated' } | { view: 'empty' } | {
  view: 'ready'; providerEvidence?: ProviderEvidenceReadResult; profileId: string; countryCode: string; canEdit: boolean;
  start: string; end: string; selectedAsin: string; settings: MarketPositionSettings;
  products: MarketPositionProduct[]; links: MarketPositionLink[]; series: MarketRankSeries[];
};

export async function load(access: ScreenActor, input: ScreenParams): Promise<MarketPositionData> {
  if (access.entry.state !== 'ok') return { view: 'gated' };
  const role = access.entry.context.active?.role;
  const from = typeof input.searchParams['from'] === 'string' ? input.searchParams['from'] : undefined;
  const to = typeof input.searchParams['to'] === 'string' ? input.searchParams['to'] : undefined;
  const period = periodFromParams({ from, to }, todayIso());
  return access.snapshot(async (snapshot) => {
    const orgId = snapshot.actor.orgId;
    const handle = { sql: snapshot.sql };
    const profiles = await listProfiles(handle, orgId);
    const profile = access.selectProfile(profiles);
    if (!profile) return { view: 'empty' };
    const products = await listMarketPositionProducts(handle, orgId, profile.id);
    const links = (await listMarketPositionLinks(handle, orgId, profile.id)).filter((link) => products.some((product) => product.asin === link.ownAsin));
    const settings = await readMarketPositionSettings(handle, orgId, profile.id);
    const asins = [...new Set([...products.map((p) => p.asin), ...links.map((l) => l.competitorAsin)])];
    const series = await readMarketRankSeries(handle, orgId, asins, addDays(period.start, -1), period.end);
    const selectedAsin = products.find((p) => p.asin === input.searchParams['asin'])?.asin ?? products[0]?.asin ?? '';
    const providerEvidence = await readProviderEvidence(handle, { orgId, profileId: profile.id, consumer: 'market-position' });
    return { view: 'ready', providerEvidence, profileId: profile.id, countryCode: profile.countryCode, canEdit: role === 'owner' || role === 'admin' || role === 'analyst',
      start: period.start, end: period.end, selectedAsin, settings, products, links, series };
  });
}

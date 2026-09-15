import { DEFAULT_MARKET_POSITION_THRESHOLD, MarketPositionSettings, MarketPositionSettingsInput } from '@wizard-ads/shared';
import type { MarketPositionLink, MarketPositionProduct, MarketRankSeries } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';

export class MarketPositionNotFound extends Error {
  constructor() { super('Profile not found'); }
}

export async function readMarketPositionSettings(handle: QueryHandle, orgId: string, profileId: string): Promise<MarketPositionSettings> {
  const rows = await handle.sql<{ profileId: string; thresholdPercent: number | null; updatedAt: Date | string | null }[]>`
    select p.id as "profileId", s.threshold_percent as "thresholdPercent", s.updated_at as "updatedAt"
      from public.ad_profiles p left join public.market_position_settings s on s.profile_id=p.id and s.org_id=p.org_id
     where p.org_id=${orgId} and p.id=${profileId}
  `;
  const row = rows[0];
  if (!row) throw new MarketPositionNotFound();
  return MarketPositionSettings.parse({ ...row, thresholdPercent: row.thresholdPercent ?? DEFAULT_MARKET_POSITION_THRESHOLD,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt });
}

/** Current editor authority is locked by the caller until this readback commits. */
export async function saveMarketPositionSettings(context: AuthenticatedEditorTransaction, raw: MarketPositionSettingsInput): Promise<MarketPositionSettings> {
  const input = MarketPositionSettingsInput.parse(raw);
  const { sql, actor } = context;
  const rows = await sql`
    insert into public.market_position_settings(org_id, profile_id, threshold_percent)
    select p.org_id, p.id, ${input.thresholdPercent} from public.ad_profiles p
     where p.org_id=${actor.orgId} and p.id=${input.profileId}
    on conflict (profile_id) do update set threshold_percent=excluded.threshold_percent, updated_at=now()
      where market_position_settings.org_id=${actor.orgId}
    returning profile_id
  `;
  if (rows.length !== 1) throw new MarketPositionNotFound();
  const saved = await readMarketPositionSettings({ sql }, actor.orgId, input.profileId);
  if (saved.thresholdPercent !== input.thresholdPercent) throw new Error('Settings readback mismatch');
  return saved;
}

export async function listMarketPositionProducts(handle: QueryHandle, orgId: string, profileId: string): Promise<MarketPositionProduct[]> {
  return handle.sql<MarketPositionProduct[]>`
    select asin, max(nullif(name, '')) as name from public.product_ads
     where org_id=${orgId} and profile_id=${profileId} and asin is not null and asin <> ''
     group by asin order by asin
  `;
}

export async function listMarketPositionLinks(handle: QueryHandle, orgId: string, profileId: string): Promise<MarketPositionLink[]> {
  return handle.sql<MarketPositionLink[]>`
    select our_asin as "ownAsin", competitor_asin as "competitorAsin", nullif(category, '') as category
      from public.competitor_links
     where org_id=${orgId} and (profile_id=${profileId} or profile_id is null) and enabled
     order by our_asin, competitor_asin
  `;
}

/** Latest sample per UTC day and category, including explicit missing BSR samples. */
export async function readMarketRankSeries(handle: QueryHandle, orgId: string, asins: readonly string[], start: string, end: string): Promise<MarketRankSeries[]> {
  if (!asins.length) return [];
  const rows = await handle.sql<{ asin: string; category: string; date: string; bsr: number | null; observedAt: Date | string }[]>`
    select distinct on (asin, category, (observed_at at time zone 'UTC')::date)
      asin, category, ((observed_at at time zone 'UTC')::date)::text as date, bsr, observed_at as "observedAt"
      from public.keepa_bsr_observations
     where org_id=${orgId} and asin=any(${[...asins]}::text[])
       and observed_at >= ${start}::date::timestamp at time zone 'UTC'
       and observed_at < (${end}::date + 1)::timestamp at time zone 'UTC'
     order by asin, category, (observed_at at time zone 'UTC')::date, observed_at desc, id desc
  `;
  const series = new Map<string, MarketRankSeries>();
  for (const row of rows) {
    const key = JSON.stringify([row.asin, row.category]);
    let entry = series.get(key);
    if (!entry) { entry = { asin: row.asin, category: row.category, points: [] }; series.set(key, entry); }
    entry.points.push({ date: row.date, observedAt: (row.observedAt instanceof Date ? row.observedAt : new Date(row.observedAt)).toISOString(), bsr: row.bsr !== null && row.bsr > 0 ? row.bsr : null });
  }
  if ([...series.values()].reduce((count, entry) => count + entry.points.length, 0) !== rows.length) throw new Error('Rank observation count mismatch');
  return [...series.values()];
}

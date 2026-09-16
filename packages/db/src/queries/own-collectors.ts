import { createHash } from 'node:crypto';
import { CollectorProfile, EffectiveBidHistory, ListingChangeInput, ListingChanges, ListingEvidenceCollection, CollectorExportReferences, type CollectorScope, CollectorReceipt, EffectiveBidObservation, ListingSnapshot, ListingFieldObservation, ListingChange, ListingEvidence, type StoredCollectorExport } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';

export class OwnCollectorConflictError extends Error {}
export class OwnCollectorReferenceError extends Error {}

function key(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Collection time is receipt metadata; replay must compare provider evidence. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (k, v: unknown) => k === 'collectedAt' ? undefined : v);
}
function equalScope(a: CollectorScope, b: CollectorScope): boolean { return a.orgId === b.orgId && a.profileId === b.profileId && a.marketplace === b.marketplace; }
export async function collectorProfile(handle: QueryHandle, input: { orgId: string; profileId: string }): Promise<CollectorProfile> {
  const [p] = await handle.sql<{ marketplace: string; timezone: string; enabled: boolean }[]>`select country_code as marketplace, timezone, sync_enabled as enabled from public.ad_profiles where org_id=${input.orgId} and id=${input.profileId}`;
  if (!p) throw new Error('Collector profile not found');
  return CollectorProfile.parse({ scope: { ...input, marketplace: p.marketplace }, timezone: p.timezone, enabled: p.enabled });
}
async function workerScope(handle: QueryHandle, scope: CollectorScope): Promise<void> {
  const [role] = await handle.sql<{ allowed: boolean }[]>`select current_user not in ('authenticated','anon') as allowed`;
  if (!role?.allowed) throw new Error('Collector persistence requires worker authority');
  const profile = await collectorProfile(handle, scope);
  if (!equalScope(profile.scope, scope) || !profile.enabled) throw new Error('Collector scope disabled or mismatched');
  await handle.sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.orgId}:${scope.profileId}:own-collectors`},0))`;
}
function receipt(sourceRows: number, ids: string[], inserted: number, observedAt: string | null): CollectorReceipt {
  return CollectorReceipt.parse({ counts: { sourceRows, parsedRows: sourceRows, refusedRows: 0, loadedRows: ids.length, verifiedLoadedRows: ids.length },
    inserted, alreadyPresent: ids.length-inserted, outputIdentities: ids, observedAt, state: ids.length ? 'measured' : 'missing' });
}
export async function persistEffectiveBidObservations(handle: DbHandle, scope: CollectorScope, input: readonly EffectiveBidObservation[]): Promise<CollectorReceipt> {
  const rows = input.map((r) => EffectiveBidObservation.parse(r));
  if (rows.some((r) => !equalScope(r.scope, scope))) throw new Error('Cross-profile bid observation');
  return handle.sql.begin(async (sql) => {
    await workerScope({ sql }, scope);
    const ids = new Set<string>(); let inserted = 0;
    for (const r of rows) {
      const id = key([scope, r.targetKind,r.campaignId,r.adGroupId,r.targetId,r.sourceIdentity]);
      const written = await sql`insert into public.own_effective_bid_observations(id,org_id,profile_id,marketplace,target_id,observed_at,collected_at,observation)
        values(${id},${scope.orgId},${scope.profileId},${scope.marketplace},${r.targetId},${r.observedAt},${r.collectedAt},${JSON.stringify(r)}::jsonb) on conflict do nothing returning id`;
      const [stored] = await sql<{ observation: unknown }[]>`select observation from public.own_effective_bid_observations where id=${id} and org_id=${scope.orgId} and profile_id=${scope.profileId}`;
      if (!stored) throw new Error('Bid observation missing readback');
      if (canonical(EffectiveBidObservation.parse(stored.observation)) !== canonical(r)) throw new OwnCollectorConflictError('Bid observation conflict');
      inserted += written.length; ids.add(id);
    }
    // Use the oldest offered observation, so a stale member cannot make profile coverage fresh.
    const verified = await sql<{ id: string }[]>`select id from public.own_effective_bid_observations where org_id=${scope.orgId} and profile_id=${scope.profileId} and id=any(${[...ids]}::text[])`;
    if (verified.length !== ids.size || verified.some((r) => !ids.has(r.id))) throw new Error('Bid output identities missing after persistence');
    return receipt(rows.length, [...ids], inserted, rows.flatMap((r) => [r.observedAt, ...[r.bid?.provenance,r.placementProvenance,r.audienceProvenance].flatMap((p) => p ? [p.observedAt] : [])]).sort()[0] ?? null);
  });
}
export async function readEffectiveBidObservations(handle: QueryHandle, filter: { orgId: string; profileId: string; targetId?: string; from: string; to: string }): Promise<EffectiveBidHistory> {
  const available = await handle.sql<{ timezone: string; marketplace: string; present: boolean }[]>`select timezone,country_code as marketplace,to_regclass('public.own_effective_bid_observations') is not null as present from public.ad_profiles where org_id=${filter.orgId} and id=${filter.profileId}`;
  if (!available[0]?.present) return EffectiveBidHistory.parse({ timezone: available[0]?.timezone ?? 'UTC', observations: [] });
  const profile = { timezone: available[0].timezone, scope: { marketplace: available[0].marketplace } };
  const rows = await handle.sql<{ observation: unknown }[]>`select observation from public.own_effective_bid_observations
    where org_id=${filter.orgId} and profile_id=${filter.profileId} and marketplace=${profile.scope.marketplace}
      and (${filter.targetId ?? null}::text is null or target_id=${filter.targetId ?? null})
      and (observed_at at time zone ${profile.timezone})::date between ${filter.from}::date and ${filter.to}::date order by observed_at,id`;
  return EffectiveBidHistory.parse({ timezone: profile.timezone, observations: rows.map((r) => r.observation) });
}
export async function persistListingSnapshots(handle: DbHandle, scope: CollectorScope, input: readonly ListingSnapshot[], derive: (input: ListingChangeInput) => ListingChange | null): Promise<CollectorReceipt> {
  const rows = input.map((r) => ListingSnapshot.parse(r));
  if (rows.some((r) => !equalScope(r.scope, scope))) throw new Error('Cross-profile listing observation');
  return handle.sql.begin(async (sql) => {
    await workerScope({ sql }, scope);
    const { timezone } = await collectorProfile({ sql }, scope);
    const ids = new Set<string>(); let inserted = 0; const times: string[] = [];
    const fields = rows.flatMap((r) => r.fields.map((current) => ({ asin: r.asin, current })))
      .sort((a,b) => a.current.provenance.observedAt.localeCompare(b.current.provenance.observedAt));
    for (const { asin, current } of fields) {
      const own = await sql`select 1 from public.product_ads where org_id=${scope.orgId} and profile_id=${scope.profileId} and asin=${asin} and deleted_at is null limit 1`;
      if (!own.length) throw new Error('Listing ASIN is not owned in this profile');
      const p = current.provenance; const id = key([scope,asin,current.field,p.source,p.sourceIdentity,p.observedAt]);
      const written = await sql`insert into public.own_listing_observations(id,org_id,profile_id,marketplace,asin,field,observed_at,collected_at,observation)
        values(${id},${scope.orgId},${scope.profileId},${scope.marketplace},${asin},${current.field},${p.observedAt},${p.collectedAt},${JSON.stringify(current)}::jsonb) on conflict do nothing returning id`;
      const [stored] = await sql<{ observation: unknown }[]>`select observation from public.own_listing_observations where id=${id} and org_id=${scope.orgId} and profile_id=${scope.profileId}`;
      if (!stored) throw new Error('Listing observation missing readback');
      if (canonical(ListingFieldObservation.parse(stored.observation)) !== canonical(current)) throw new OwnCollectorConflictError('Listing observation conflict');
      if (written.length) {
        const previous = await sql<{ observation: unknown }[]>`select observation from public.own_listing_observations where org_id=${scope.orgId} and profile_id=${scope.profileId}
          and marketplace=${scope.marketplace} and asin=${asin} and field=${current.field} and observed_at<${p.observedAt} order by observed_at desc,id desc limit 1`;
        const change = derive(ListingChangeInput.parse({ id, scope, asin, previous: previous[0]?.observation ?? null, current, timezone, hasEarlierObservation: false }));
        if (change) {
          const parsed = ListingChange.parse(change);
          await sql`insert into public.own_listing_changes(id,org_id,profile_id,marketplace,asin,observed_at,change)
            values(${id},${scope.orgId},${scope.profileId},${scope.marketplace},${asin},${p.observedAt},${JSON.stringify(parsed)}::jsonb)`;
          const [readback] = await sql<{ change: unknown }[]>`select change from public.own_listing_changes where id=${id}`;
          if (!readback || canonical(ListingChange.parse(readback.change)) !== canonical(parsed)) throw new Error('Listing change readback mismatch');
        }
      }
      inserted += written.length; ids.add(id); times.push(p.observedAt);
    }
    const verified = await sql<{ id: string }[]>`select id from public.own_listing_observations where org_id=${scope.orgId} and profile_id=${scope.profileId} and id=any(${[...ids]}::text[])`;
    if (verified.length !== ids.size || verified.some((r) => !ids.has(r.id))) throw new Error('Listing output identities missing after persistence');
    return receipt(rows.length, [...ids], inserted, times.sort()[0] ?? null);
  });
}
export async function readListingChanges(handle: QueryHandle, filter: { orgId: string; profileId: string; from: string; to: string }): Promise<ListingChange[]> {
  const available = await handle.sql<{ timezone: string; marketplace: string; present: boolean }[]>`select timezone,country_code as marketplace,to_regclass('public.own_listing_changes') is not null as present from public.ad_profiles where org_id=${filter.orgId} and id=${filter.profileId}`;
  if (!available[0]?.present) return [];
  const profile = { timezone: available[0].timezone, scope: { marketplace: available[0].marketplace } };
  const rows = await handle.sql<{ change: unknown }[]>`select change from public.own_listing_changes where org_id=${filter.orgId} and profile_id=${filter.profileId}
    and marketplace=${profile.scope.marketplace} and (observed_at at time zone ${profile.timezone})::date between ${filter.from}::date and ${filter.to}::date order by observed_at,id`;
  return ListingChanges.parse(rows.map((r) => r.change));
}
/** Explicit age bound belongs to the caller; price never supplies eligibility booleans. */
export async function readListingEvidence(handle: QueryHandle, input: { orgId: string; profileId: string; asins?: readonly string[]; asOf: string; maxAgeMs: number }): Promise<ListingEvidence[]> {
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0 || !Number.isFinite(Date.parse(input.asOf))) throw new Error('Invalid listing freshness window');
  const { scope } = await collectorProfile(handle, { orgId: input.orgId, profileId: input.profileId });
  const rows = await handle.sql<{ asin: string; observation: unknown }[]>`select distinct on (asin,field) asin,observation from public.own_listing_observations
    where org_id=${scope.orgId} and profile_id=${scope.profileId} and marketplace=${scope.marketplace} and observed_at<=${input.asOf}
    and exists(select 1 from public.product_ads p where p.org_id=${scope.orgId} and p.profile_id=${scope.profileId} and p.asin=own_listing_observations.asin and p.deleted_at is null)
    and (${input.asins ? [...input.asins] : null}::text[] is null or asin=any(${input.asins ? [...input.asins] : null}::text[])) order by asin,field,observed_at desc,id desc`;
  const asins = input.asins ?? [...new Set(rows.map((r) => r.asin))];
  return ListingEvidenceCollection.parse(asins.map((asin) => {
    const fields = rows.filter((r) => r.asin === asin).map((r) => {
      const observation = ListingFieldObservation.parse(r.observation);
      return { observation, availability: Date.parse(input.asOf)-Date.parse(observation.provenance.observedAt)>input.maxAgeMs ? 'stale' as const : 'measured' as const };
    });
    const measured = fields.filter((f) => f.availability === 'measured');
    return ListingEvidence.parse({ scope, asin, fields, availability: fields.length === 0 ? 'absent' : measured.length === 0 ? 'stale'
      : ['inStock','ownsBuyBox','suppressed'].every((name) => measured.some((f) => f.observation.field === name)) ? 'measured' : 'partial', moderation: 'unavailable' });
  }));
}
export async function readCollectorExports(handle: QueryHandle, scope: CollectorScope, family: StoredCollectorExport['family']): Promise<StoredCollectorExport[]> {
  const rows = await handle.sql<{ id: string; object_key: string; enabled: boolean; marketplace: string }[]>`select id,object_key,enabled,marketplace from public.collector_export_references
    where org_id=${scope.orgId} and profile_id=${scope.profileId} and family=${family} order by id`;
  const result = CollectorExportReferences.safeParse(rows.map((r) => ({ id: r.id, scope: { ...scope, marketplace: r.marketplace }, family, enabled: r.enabled, objectKey: r.object_key })));
  if (!result.success) throw new OwnCollectorReferenceError('Invalid stored export reference');
  return result.data;
}

/** Mirror timestamps are provider observation times; the collector clock is never substituted. */
export async function readOwnBidMirrors(handle: QueryHandle, scope: CollectorScope, collectedAt: string): Promise<EffectiveBidObservation[]> {
  const { timezone } = await collectorProfile(handle, scope);
  const day = (at: string) => new Intl.DateTimeFormat('en-CA',{ timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(at));
  const rows = await handle.sql<{ target_id: string; target_kind: 'keyword'|'target'; campaign_id: string; ad_group_id: string;
    bid: number|null; bid_at: Date|string; default_bid: number|null; default_at: Date|string|null; inherited_evidenced: boolean;
    bidding: unknown; bidding_at: Date|string|null }[]>`
    with targets as (
      select amazon_id as target_id,'keyword'::text as target_kind,campaign_id,ad_group_id,bid,coalesce(bid_observed_at,synced_at) as bid_at
      from public.keywords where org_id=${scope.orgId} and profile_id=${scope.profileId} and ad_product='SP' and deleted_at is null
      union all select amazon_id,'target',campaign_id,ad_group_id,bid,coalesce(bid_observed_at,synced_at)
      from public.targets where org_id=${scope.orgId} and profile_id=${scope.profileId} and ad_product='SP' and deleted_at is null
    ) select t.*,t.bid::float8,g.default_bid::float8,g.synced_at as default_at,c.bidding_control_state as bidding,c.bidding_observed_at as bidding_at,
      exists(select 1 from public.creative_entity_observations o where o.org_id=${scope.orgId} and o.profile_id=${scope.profileId}
        and o.entity_type='ad_group' and o.amazon_id=g.amazon_id and o.observed_at=g.synced_at
        and (o.snapshot->>'defaultBid')::numeric=g.default_bid) as inherited_evidenced
      from targets t left join public.ad_groups g on g.org_id=${scope.orgId} and g.profile_id=${scope.profileId} and g.amazon_id=t.ad_group_id and g.campaign_id=t.campaign_id and g.ad_product='SP'
      left join public.campaigns c on c.org_id=${scope.orgId} and c.profile_id=${scope.profileId} and c.amazon_id=t.campaign_id and c.ad_product='SP' order by t.target_kind,t.target_id`;
  return rows.map((r) => {
    const bidAt = new Date(r.bid_at).toISOString(); const defaultAt = r.default_at ? new Date(r.default_at).toISOString() : null;
    const biddingAt = r.bidding_at ? new Date(r.bidding_at).toISOString() : null;
    const provenance = (at: string, sourceIdentity: string) => ({ source: 'amazon_ads_mirror', sourceIdentity, observedAt: at, collectedAt });
    const inherited = r.bid === null && r.default_bid !== null && defaultAt !== null && r.inherited_evidenced && day(defaultAt) === day(bidAt);
    const sourceIdentity = key([r.target_kind,r.target_id,bidAt,inherited ? defaultAt : null,biddingAt]);
    return EffectiveBidObservation.parse({ scope, sourceIdentity, campaignId: r.campaign_id,adGroupId:r.ad_group_id,targetId:r.target_id,targetKind:r.target_kind,
      observedAt: [bidAt, ...(inherited ? [defaultAt!] : []), ...(biddingAt ? [biddingAt] : [])].sort().at(-1), collectedAt,
      bid: r.bid !== null ? { value:r.bid,provenance:provenance(bidAt,r.target_id) } : inherited ? { value:r.default_bid,provenance:provenance(defaultAt!,r.ad_group_id) } : null,
      ...(inherited ? { inheritance: { targetBidAbsentAt:bidAt,defaultBidObservedAt:defaultAt } } : {}),
      bidOrigin:r.bid !== null ? 'explicit' : inherited ? 'inherited' : 'unknown', bidding:r.bidding,
      placementProvenance:biddingAt ? provenance(biddingAt,r.campaign_id) : null,audienceProvenance:biddingAt ? provenance(biddingAt,r.campaign_id) : null });
  });
}

export async function readOwnListingAsins(handle: QueryHandle, scope: CollectorScope): Promise<string[]> {
  const rows = await handle.sql<{ asin: string }[]>`select distinct asin from public.product_ads
    where org_id=${scope.orgId} and profile_id=${scope.profileId} and deleted_at is null and state<>'archived' and asin is not null order by asin`;
  return rows.map((r) => r.asin);
}

/** Coverage readback is separate from imports: an ASIN is counted once on every replay. */
export async function readListingCollectorCoverage(handle: QueryHandle, scope: CollectorScope, asOf: string): Promise<CollectorReceipt> {
  const asins = await readOwnListingAsins(handle, scope);
  const rows = await handle.sql<{ id: string; asin: string; observation: unknown }[]>`select distinct on (asin,field) id,asin,observation
    from public.own_listing_observations where org_id=${scope.orgId} and profile_id=${scope.profileId} and marketplace=${scope.marketplace}
    and asin=any(${asins}::text[]) and observed_at<=${asOf} order by asin,field,observed_at desc,id desc`;
  const fields = rows.map((row) => ListingFieldObservation.parse(row.observation));
  const represented = new Set(rows.map((row) => row.asin)).size;
  const refusedRows = asins.length - represented;
  return CollectorReceipt.parse({ counts: { sourceRows: asins.length, parsedRows: represented, refusedRows,
    loadedRows: rows.length, verifiedLoadedRows: fields.length }, inserted: 0, alreadyPresent: rows.length,
    outputIdentities: rows.map((row) => row.id), observedAt: fields.map((field) => field.provenance.observedAt).sort()[0] ?? null,
    state: !rows.length ? 'missing' : refusedRows ? 'partial' : 'measured' });
}

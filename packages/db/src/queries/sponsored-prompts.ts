import { normalizeSponsoredPrompt, SponsoredPromptImport, SponsoredPromptImportResult, SponsoredPromptObservation, SponsoredPromptSnapshot, SponsoredPromptVisit } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';

export class SponsoredPromptInputError extends Error {
  constructor(message: string) { super(message); this.name = 'SponsoredPromptInputError'; }
}

export async function importSponsoredPrompts(context: AuthenticatedEditorTransaction, raw: SponsoredPromptImport): Promise<SponsoredPromptImportResult> {
  const input = SponsoredPromptImport.parse(raw);
  const { sql, actor } = context;
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.orgId}:${input.profileId}:sponsored-prompts`},0))`;
  const profiles = await sql`select id from public.ad_profiles where org_id=${actor.orgId} and id=${input.profileId}`;
  if (profiles.length !== 1) throw new SponsoredPromptInputError('Profile not found');
  const [clock] = await sql<{ now: Date | string }[]>`select statement_timestamp() as now`;
  if (!clock || input.rows.some((row) => Date.parse(row.observedAt) > new Date(clock.now).getTime())) throw new SponsoredPromptInputError('Observation times must not be in the future');
  let inserted = 0; let alreadyPresent = 0; let verified = 0;
  const promptIds = new Set<string>();
  const rows = [...input.rows].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  for (const row of rows) {
    const entities = await sql`select c.amazon_id from public.campaigns c join public.ad_groups g
      on g.org_id=c.org_id and g.profile_id=c.profile_id and g.campaign_id=c.amazon_id and g.ad_product=c.ad_product
      where c.org_id=${actor.orgId} and c.profile_id=${input.profileId} and c.amazon_id=${row.campaignId}
        and c.ad_product::text=${row.adProduct} and g.amazon_id=${row.adGroupId}`;
    if (entities.length !== 1) throw new SponsoredPromptInputError('Campaign or ad group not found in this profile');
    const normalized = normalizeSponsoredPrompt(row.promptText);
    await sql`insert into public.sponsored_prompts(org_id,profile_id,ad_product,campaign_id,ad_group_id,prompt_text,normalized_prompt,first_seen_at,last_seen_at,current_status)
      values(${actor.orgId},${input.profileId},${row.adProduct},${row.campaignId},${row.adGroupId},${row.promptText},${normalized},${row.observedAt},${row.observedAt},${row.status})
      on conflict(profile_id,campaign_id,ad_group_id,normalized_prompt) do nothing`;
    const [prompt] = await sql<{ id: string; ad_product: string }[]>`select id,ad_product from public.sponsored_prompts where org_id=${actor.orgId} and profile_id=${input.profileId}
      and campaign_id=${row.campaignId} and ad_group_id=${row.adGroupId} and normalized_prompt=${normalized} for update`;
    if (!prompt || prompt.ad_product !== row.adProduct) throw new SponsoredPromptInputError('Prompt identity conflict');
    promptIds.add(prompt.id);
    const expected = SponsoredPromptObservation.parse(row);
    const readObservation = () => sql<{ observation: unknown }[]>`select jsonb_build_object(
      'observedAt',observed_at,'status',status,'intervalStart',interval_start,'intervalEnd',interval_end,
      'spend',spend,'clicks',clicks,'sales',sales,'orders',orders) as observation
      from public.sponsored_prompt_observations where org_id=${actor.orgId} and profile_id=${input.profileId} and prompt_id=${prompt.id} and observed_at=${row.observedAt}`;
    const [existing] = await readObservation();
    if (existing) {
      if (JSON.stringify(SponsoredPromptObservation.parse(existing.observation)) !== JSON.stringify(expected)) {
        throw new SponsoredPromptInputError('This observation already exists with different values');
      }
      alreadyPresent++;
    } else {
      const overlaps = await sql`select id from public.sponsored_prompt_observations where prompt_id=${prompt.id}
        and tstzrange(interval_start,interval_end,'[)') && tstzrange(${row.intervalStart}::timestamptz,${row.intervalEnd}::timestamptz,'[)')`;
      if (overlaps.length) throw new SponsoredPromptInputError('Metric intervals overlap for this prompt. Import disjoint interval amounts.');
      const written = await sql`insert into public.sponsored_prompt_observations(org_id,profile_id,prompt_id,observed_at,status,interval_start,interval_end,spend,clicks,sales,orders)
        values(${actor.orgId},${input.profileId},${prompt.id},${row.observedAt},${row.status},${row.intervalStart},${row.intervalEnd},${row.spend},${row.clicks},${row.sales},${row.orders}) returning id`;
      if (written.length !== 1) throw new Error('Prompt observation write count mismatch');
      inserted++;
    }
    const [readback] = await readObservation();
    if (!readback || JSON.stringify(SponsoredPromptObservation.parse(readback.observation)) !== JSON.stringify(expected)) throw new Error('Prompt observation readback mismatch');
    verified++;
  }
  return SponsoredPromptImportResult.parse({ offered: input.rows.length, prompts: promptIds.size, inserted, alreadyPresent, verified });
}

/** One SQL statement captures rows and the prior per-user visit under one read snapshot. */
export async function readSponsoredPrompts(handle: QueryHandle, scope: { orgId: string; profileId: string; userId: string }): Promise<SponsoredPromptSnapshot> {
  const [row] = await handle.sql<{ snapshot: unknown }[]>`
    select jsonb_build_object('profileId',p.id,'lastVisitedAt',v.last_visited_at,'viewedThrough',statement_timestamp(),
      'windowStart',(date_trunc('day',statement_timestamp() at time zone p.timezone)-interval '30 days') at time zone p.timezone,
      'windowEnd',date_trunc('day',statement_timestamp() at time zone p.timezone) at time zone p.timezone,
      'latestObservationAt',(select max(o.observed_at) from public.sponsored_prompt_observations o where o.org_id=p.org_id and o.profile_id=p.id),
      'prompts',coalesce((select jsonb_agg(jsonb_build_object(
        'id',s.id,'adProduct',s.ad_product,'campaignId',s.campaign_id,'adGroupId',s.ad_group_id,'campaignName',c.name,'adGroupName',g.name,
        'promptText',s.prompt_text,'normalizedPrompt',s.normalized_prompt,'firstSeenAt',s.first_seen_at,'lastSeenAt',s.last_seen_at,'currentStatus',s.current_status,
        'observations',coalesce((select jsonb_agg(jsonb_build_object('observedAt',o.observed_at,'status',o.status,'intervalStart',o.interval_start,'intervalEnd',o.interval_end,
          'spend',o.spend,'clicks',o.clicks,'sales',o.sales,'orders',o.orders) order by o.observed_at)
          from public.sponsored_prompt_observations o where o.org_id=s.org_id and o.profile_id=s.profile_id and o.prompt_id=s.id),'[]'::jsonb)) order by s.last_seen_at desc,s.id)
        from public.sponsored_prompts s left join public.campaigns c on c.org_id=s.org_id and c.profile_id=s.profile_id and c.amazon_id=s.campaign_id and c.ad_product::text=s.ad_product
        left join public.ad_groups g on g.org_id=s.org_id and g.profile_id=s.profile_id and g.amazon_id=s.ad_group_id and g.campaign_id=s.campaign_id and g.ad_product::text=s.ad_product
        where s.org_id=p.org_id and s.profile_id=p.id),'[]'::jsonb)) as snapshot
    from public.ad_profiles p left join public.sponsored_prompt_visits v on v.org_id=p.org_id and v.profile_id=p.id and v.user_id=${scope.userId}
    where p.org_id=${scope.orgId} and p.id=${scope.profileId}
  `;
  if (!row) throw new SponsoredPromptInputError('Profile not found');
  return SponsoredPromptSnapshot.parse(row.snapshot);
}

export async function recordSponsoredPromptVisit(context: AuthenticatedEditorTransaction, raw: SponsoredPromptVisit): Promise<SponsoredPromptVisit> {
  const input = SponsoredPromptVisit.parse(raw); const { sql, actor } = context;
  const [clock] = await sql<{ now: Date | string }[]>`select statement_timestamp() as now`;
  if (!clock || Date.parse(input.viewedThrough) > new Date(clock.now).getTime()) throw new SponsoredPromptInputError('Future visit marker');
  const [written] = await sql<{ viewedThrough: Date | string }[]>`insert into public.sponsored_prompt_visits(org_id,profile_id,user_id,last_visited_at)
    select p.org_id,p.id,${actor.userId},${input.viewedThrough}::timestamptz from public.ad_profiles p where p.org_id=${actor.orgId} and p.id=${input.profileId}
    on conflict(org_id,profile_id,user_id) do update set last_visited_at=greatest(sponsored_prompt_visits.last_visited_at,excluded.last_visited_at)
    returning last_visited_at as "viewedThrough"`;
  if (!written) throw new SponsoredPromptInputError('Profile not found');
  return SponsoredPromptVisit.parse({ profileId: input.profileId, viewedThrough: new Date(written.viewedThrough).toISOString() });
}

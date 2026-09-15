import { normalizeSponsoredPrompt, SponsoredPromptImport, SponsoredPromptImportResult, SponsoredPromptObservation, SponsoredPromptSnapshot, SponsoredPromptVisit } from '@wizard-ads/shared';
import { createHash } from 'node:crypto';
import { CollectorReceipt, StoredCollectorExport, type CollectorRefusalCode } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';

export class SponsoredPromptInputError extends Error {
  constructor(message: string, readonly refusalCode: CollectorRefusalCode = 'malformed_content') { super(message); this.name = 'SponsoredPromptInputError'; }
}

export async function importSponsoredPrompts(context: AuthenticatedEditorTransaction, raw: SponsoredPromptImport): Promise<SponsoredPromptImportResult> {
  return persistSponsoredPrompts(context, context.actor.orgId, raw);
}

async function persistSponsoredPrompts(context: QueryHandle, orgId: string, raw: SponsoredPromptImport): Promise<SponsoredPromptImportResult> {
  const input = SponsoredPromptImport.parse(raw);
  const { sql } = context;
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${input.profileId}:sponsored-prompts`},0))`;
  const profiles = await sql`select id from public.ad_profiles where org_id=${orgId} and id=${input.profileId}`;
  if (profiles.length !== 1) throw new SponsoredPromptInputError('Profile not found');
  const [clock] = await sql<{ now: Date | string }[]>`select statement_timestamp() as now`;
  if (!clock || input.rows.some((row) => Date.parse(row.observedAt) > new Date(clock.now).getTime())) throw new SponsoredPromptInputError('Observation times must not be in the future');
  let inserted = 0; let alreadyPresent = 0; let verified = 0;
  const promptIds = new Set<string>();
  const rows = [...input.rows].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  for (const row of rows) {
    const entities = await sql`select c.amazon_id from public.campaigns c join public.ad_groups g
      on g.org_id=c.org_id and g.profile_id=c.profile_id and g.campaign_id=c.amazon_id and g.ad_product=c.ad_product
      where c.org_id=${orgId} and c.profile_id=${input.profileId} and c.amazon_id=${row.campaignId}
        and c.ad_product::text=${row.adProduct} and g.amazon_id=${row.adGroupId}`;
    if (entities.length !== 1) throw new SponsoredPromptInputError('Campaign or ad group not found in this profile');
    const normalized = normalizeSponsoredPrompt(row.promptText);
    await sql`insert into public.sponsored_prompts(org_id,profile_id,ad_product,campaign_id,ad_group_id,prompt_text,normalized_prompt,first_seen_at,last_seen_at,current_status)
      values(${orgId},${input.profileId},${row.adProduct},${row.campaignId},${row.adGroupId},${row.promptText},${normalized},${row.observedAt},${row.observedAt},${row.status})
      on conflict(profile_id,campaign_id,ad_group_id,normalized_prompt) do nothing`;
    const [prompt] = await sql<{ id: string; ad_product: string }[]>`select id,ad_product from public.sponsored_prompts where org_id=${orgId} and profile_id=${input.profileId}
      and campaign_id=${row.campaignId} and ad_group_id=${row.adGroupId} and normalized_prompt=${normalized} for update`;
    if (!prompt || prompt.ad_product !== row.adProduct) throw new SponsoredPromptInputError('Prompt identity conflict');
    promptIds.add(prompt.id);
    const expected = SponsoredPromptObservation.parse(row);
    const readObservation = () => sql<{ observation: unknown }[]>`select jsonb_build_object(
      'observedAt',observed_at,'status',status,'intervalStart',interval_start,'intervalEnd',interval_end,
      'spend',spend,'clicks',clicks,'sales',sales,'orders',orders) as observation
      from public.sponsored_prompt_observations where org_id=${orgId} and profile_id=${input.profileId} and prompt_id=${prompt.id} and observed_at=${row.observedAt}`;
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
        values(${orgId},${input.profileId},${prompt.id},${row.observedAt},${row.status},${row.intervalStart},${row.intervalEnd},${row.spend},${row.clicks},${row.sales},${row.orders}) returning id`;
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
  const imports = await handle.sql<{ referenceId:string; observedAt:Date|string; collectedAt:Date|string }[]>`select distinct on(reference_id) reference_id as "referenceId",observed_at as "observedAt",collected_at as "collectedAt"
    from public.collector_import_receipts r where r.org_id=${scope.orgId} and r.profile_id=${scope.profileId}
    and exists(select 1 from public.collector_export_references e where e.id=r.reference_id and e.org_id=r.org_id and e.profile_id=r.profile_id and e.family='prompts') order by reference_id,observed_at desc,collected_at desc`;
  return SponsoredPromptSnapshot.parse({ ...SponsoredPromptSnapshot.parse(row.snapshot),scheduledImports:imports.map((r)=>({ referenceId:r.referenceId,observedAt:new Date(r.observedAt).toISOString(),collectedAt:new Date(r.collectedAt).toISOString() })) });
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

/** Scheduled imports have worker scope, never an interactive actor or visit write. */
export async function importScheduledPrompts(handle: DbHandle, reference: StoredCollectorExport, fingerprint: string, raw: SponsoredPromptImport, collectedAt: string): Promise<CollectorReceipt> {
  const ref = StoredCollectorExport.parse(reference); const input = SponsoredPromptImport.parse(raw);
  if (ref.family !== 'prompts' || !ref.enabled || input.profileId !== ref.scope.profileId || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new SponsoredPromptInputError('Invalid scheduled prompt authority', 'unauthorized_reference');
  return handle.sql.begin(async (sql) => {
    const [role] = await sql<{ allowed: boolean }[]>`select current_user not in ('authenticated','anon') as allowed`;
    if (!role?.allowed) throw new SponsoredPromptInputError('Scheduled imports require worker authority', 'unauthorized_reference');
    const refs = await sql`select r.id from public.collector_export_references r join public.ad_profiles p on p.org_id=r.org_id and p.id=r.profile_id
      where r.id=${ref.id} and r.org_id=${ref.scope.orgId} and r.profile_id=${ref.scope.profileId} and r.marketplace=${ref.scope.marketplace}
      and p.country_code=r.marketplace and p.sync_enabled and r.enabled and r.family='prompts' and r.object_key=${ref.objectKey} for share of r,p`;
    if (refs.length !== 1) throw new SponsoredPromptInputError('Scheduled export reference no longer authorized', 'unauthorized_reference');
    const result = await persistSponsoredPrompts({ sql },ref.scope.orgId,input);
    const id = createHash('sha256').update(`${ref.id}:${fingerprint}`).digest('hex');
    const observedAt = input.rows.map((r) => r.observedAt).sort()[0]!;
    const identities = input.rows.map((r) => {
      const identity = JSON.stringify([r.campaignId,r.adGroupId,normalizeSponsoredPrompt(r.promptText),r.observedAt]);
      return createHash('sha256').update(identity).digest('hex');
    });
    const outputIdentities = [...new Set(identities)];
    const receipt = CollectorReceipt.parse({ counts: { sourceRows:result.offered,parsedRows:result.offered,refusedRows:0,loadedRows:outputIdentities.length,verifiedLoadedRows:outputIdentities.length },
      inserted:result.inserted,alreadyPresent:outputIdentities.length-result.inserted,outputIdentities,observedAt,state:'measured' });
    await sql`insert into public.collector_import_receipts(id,org_id,profile_id,marketplace,reference_id,fingerprint,observed_at,collected_at,receipt)
      values(${id},${ref.scope.orgId},${ref.scope.profileId},${ref.scope.marketplace},${ref.id},${fingerprint},${observedAt},${collectedAt},${JSON.stringify(receipt)}::jsonb) on conflict do nothing`;
    const [stored] = await sql<{ receipt: unknown }[]>`select receipt from public.collector_import_receipts where id=${id} and org_id=${ref.scope.orgId} and profile_id=${ref.scope.profileId}`;
    if (!stored) throw new Error('Scheduled prompt receipt missing');
    const saved = CollectorReceipt.parse(stored.receipt);
    if (saved.observedAt !== observedAt || JSON.stringify(saved.outputIdentities) !== JSON.stringify(outputIdentities)) throw new Error('Scheduled prompt checkpoint conflict');
    return receipt;
  });
}

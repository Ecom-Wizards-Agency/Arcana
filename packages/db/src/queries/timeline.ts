import { TimelineDaily, TimelineEvent, TimelineEventInput, TimelineSnapshot, TimelineEvidenceSettings } from '@wizard-ads/shared';
import type { TimelineRank } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';
import { listExperiments, profileBelongsToOrg } from './experiments.js';
export class TimelineInputError extends Error {
}
export async function appendTimelineEvent(context: AuthenticatedEditorTransaction, raw: TimelineEventInput): Promise<TimelineEvent> {
    const parsed = TimelineEventInput.safeParse(raw);
    if (!parsed.success)
        throw new TimelineInputError('Check the event fields and date order.');
    const input = parsed.data;
    const { actor, sql } = context;
    if (!(await profileBelongsToOrg(context, { orgId: actor.orgId, profileId: input.profileId })))
        throw new TimelineInputError('Profile not found');
    if (input.supersedesId) {
        await sql `select pg_advisory_xact_lock(hashtextextended(${input.supersedesId}, 0))`;
        const previous = await sql `select id from public.timeline_events where org_id=${actor.orgId} and profile_id=${input.profileId} and id=${input.supersedesId}`;
        const successors = await sql `select id from public.timeline_events where supersedes_id=${input.supersedesId}`;
        if (previous.length !== 1 || successors.length)
            throw new TimelineInputError('This event has changed. Reload its latest revision.');
    }
    const rows = await sql<{
        id: string;
    }[]> `insert into public.timeline_events(org_id,profile_id,name,kind,start_on,end_on,scope_text,note,created_by,supersedes_id)
    values(${actor.orgId},${input.profileId},${input.name},${input.kind},${input.start},${input.end},${input.scopeText},${input.note},${actor.userId},${input.supersedesId}) returning id`;
    if (rows.length !== 1)
        throw new Error('Timeline insert count mismatch');
    const history = await readManualTimelineEvents(context, actor.orgId, input.profileId, true);
    const saved = history.find((event) => event.id === rows[0]!.id);
    if (!saved || saved.name !== input.name || saved.start !== input.start || saved.end !== input.end || saved.kind !== input.kind || saved.note !== input.note || saved.scopeText !== input.scopeText || saved.supersedesId !== input.supersedesId)
        throw new Error('Timeline readback mismatch');
    return saved;
}
export async function saveTimelineSettings(context: AuthenticatedEditorTransaction, profileId: string, raw: TimelineEvidenceSettings) {
    const settings = TimelineEvidenceSettings.parse(raw);
    if (!(await profileBelongsToOrg(context, { orgId: context.actor.orgId, profileId })))
        throw new TimelineInputError('Profile not found');
    await context.sql `insert into public.timeline_evidence_settings(org_id,profile_id,min_days,min_clicks)
    values(${context.actor.orgId},${profileId},${settings.minDays},${settings.minClicks})
    on conflict(profile_id) do update set min_days=excluded.min_days,min_clicks=excluded.min_clicks where timeline_evidence_settings.org_id=${context.actor.orgId}`;
    return readTimelineSettings(context, context.actor.orgId, profileId);
}
async function readTimelineSettings(handle: QueryHandle, orgId: string, profileId: string) {
    const [row] = await handle.sql<{
        minDays: number | null;
        minClicks: number | null;
    }[]> `select min_days as "minDays",min_clicks::float8 as "minClicks" from public.timeline_evidence_settings where org_id=${orgId} and profile_id=${profileId}`;
    return TimelineEvidenceSettings.parse(row ?? { minDays: null, minClicks: null });
}
export async function readManualTimelineEvents(handle: QueryHandle, orgId: string, profileId: string, history = false): Promise<TimelineEvent[]> {
    const rows = await handle.sql `select e.id,e.name,e.kind,e.start_on::text as start,e.end_on::text as end,
    case when e.end_on is null then 'running' else 'recorded' end as status,'{}'::jsonb as scope,e.scope_text as "scopeText",'sales' as focus,e.note,
    e.created_by::text as "actorId",e.created_at::text as "createdAt",e.supersedes_id::text as "supersedesId"
    from public.timeline_events e where e.org_id=${orgId} and e.profile_id=${profileId}
    and (${history} or not exists(select 1 from public.timeline_events next where next.supersedes_id=e.id)) order by e.start_on,e.id`;
    const result = rows.map((row) => TimelineEvent.parse(row));
    if (result.length !== rows.length)
        throw new Error('Timeline event count mismatch');
    return result;
}
async function readProfileDays(handle: QueryHandle, orgId: string, profileId: string): Promise<TimelineDaily[]> {
    const rows = await handle.sql `select date::text as date,sum(cost)::float8 as spend,sum(sales_7d)::float8 as sales,
    sum(clicks)::float8 as clicks,sum(purchases_7d)::float8 as orders,sum(impressions)::float8 as impressions
    from public.fact_profile_daily where org_id=${orgId} and profile_id=${profileId} group by date order by date`;
    return rows.map((row) => TimelineDaily.parse(row));
}
async function readScopeDays(handle: QueryHandle, orgId: string, profileId: string, event: TimelineEvent): Promise<TimelineDaily[]> {
    const campaigns = event.scope.campaignIds ?? [], groups = event.scope.adGroupIds ?? [], targets = event.scope.targetIds ?? [];
    if (!campaigns.length && !groups.length && !targets.length)
        return [];
    // OR at one fact grain counts a target selected through several scope rows once.
    const rows = await handle.sql `select date::text as date,sum(cost)::float8 as spend,sum(sales_7d)::float8 as sales,
    sum(clicks)::float8 as clicks,sum(purchases_7d)::float8 as orders,sum(impressions)::float8 as impressions
    from (
      select date,cost,sales_7d,clicks,purchases_7d,impressions from public.fact_sp_target_daily where org_id=${orgId} and profile_id=${profileId}
        and (campaign_id=any(${campaigns}::text[]) or ad_group_id=any(${groups}::text[]) or target_id=any(${targets}::text[]))
      union all select date,cost,sales_7d,clicks,purchases_7d,impressions from public.fact_sb_daily where org_id=${orgId} and profile_id=${profileId}
        and (campaign_id=any(${campaigns}::text[]) or ad_group_id=any(${groups}::text[]))
      union all select date,cost,sales_7d,clicks,purchases_7d,impressions from public.fact_sd_daily where org_id=${orgId} and profile_id=${profileId}
        and (campaign_id=any(${campaigns}::text[]) or ad_group_id=any(${groups}::text[]))
    ) facts group by date order by date`;
    return rows.map((row) => TimelineDaily.parse(row));
}
export async function readTimeline(handle: QueryHandle, orgId: string, profileId: string): Promise<TimelineSnapshot> {
    if (!(await profileBelongsToOrg(handle, { orgId, profileId })))
        throw new TimelineInputError('Profile not found');
    const [profile, experiments, manual, batches, organic, bsr, settings] = await Promise.all([
        readProfileDays(handle, orgId, profileId), listExperiments(handle, { orgId, profileId, limit: 2147483647 }), readManualTimelineEvents(handle, orgId, profileId),
        handle.sql `select b.id,b.tag as name,b.status,coalesce(b.applied_on,(b.applied_at at time zone 'UTC')::date)::text as start,b.note,b.created_by::text as "actorId",b.created_at::text as "createdAt",
      coalesce(jsonb_agg(distinct r.entity_id) filter(where r.entity_type='campaign'),'[]') as campaigns,
      coalesce(jsonb_agg(distinct r.entity_id) filter(where r.entity_type='ad_group'),'[]') as groups,
      coalesce(jsonb_agg(distinct r.entity_id) filter(where r.entity_type in ('target','keyword')),'[]') as targets
      from public.apply_batches b left join public.apply_rows r on r.batch_id=b.id and r.org_id=b.org_id and r.profile_id=b.profile_id
      where b.org_id=${orgId} and b.profile_id=${profileId} and b.status in ('applied','reverted') and (b.applied_on is not null or b.applied_at is not null)
      group by b.id order by start,b.id`,
        handle.sql<{
            asin: string;
            keyword: string;
            date: string;
            value: number | null;
        }[]> `select distinct on(asin,keyword,observed_on) asin,keyword,observed_on::text as date,case when organic_rank>0 then organic_rank end as value
      from public.rank_observations where org_id=${orgId} and profile_id=${profileId} order by asin,keyword,observed_on,created_at desc,id desc`,
        handle.sql<{
            asin: string;
            category: string;
            date: string;
            value: number | null;
        }[]> `select distinct on(asin,category,(observed_at at time zone 'UTC')::date)
      asin,category,((observed_at at time zone 'UTC')::date)::text as date,case when bsr>0 then bsr end as value from public.keepa_bsr_observations
      where org_id=${orgId} and category<>'' and asin in(select asin from public.product_ads where org_id=${orgId} and profile_id=${profileId})
      order by asin,category,(observed_at at time zone 'UTC')::date,observed_at desc,id desc`,
        readTimelineSettings(handle, orgId, profileId),
    ]);
    const events: TimelineEvent[] = [...manual, ...experiments.map((e) => ({ id: e.id, name: e.name, kind: 'experiment' as const, start: e.startAt.toISOString().slice(0, 10), end: e.endAt?.toISOString().slice(0, 10) ?? null,
            status: e.status, scope: e.scope, scopeText: [e.scope.campaignIds?.length ? `${e.scope.campaignIds.length} campaigns` : '', e.scope.adGroupIds?.length ? `${e.scope.adGroupIds.length} ad groups` : '', e.scope.targetIds?.length ? `${e.scope.targetIds.length} targets` : '', e.scope.asins?.length ? `${e.scope.asins.length} products (recorded only)` : ''].filter(Boolean).join(' · ') || 'No measured scope',
            focus: e.metricFocus, note: e.hypothesis, actorId: e.createdBy, createdAt: e.createdAt.toISOString(), supersedesId: null })),
        ...batches.map((b) => TimelineEvent.parse({ ...b, kind: 'apply_batch', end: b['start'], status: b['status'], scope: { campaignIds: b['campaigns'], adGroupIds: b['groups'], targetIds: b['targets'] }, scopeText: 'Applied advertising entities', focus: 'acos', supersedesId: null }))];
    const scoped = Object.fromEntries(await Promise.all(events.map(async (event) => [event.id, await readScopeDays(handle, orgId, profileId, event)])));
    const ranks = new Map<string, TimelineRank>();
    for (const row of organic) {
        const key = JSON.stringify(['organic', row.asin, row.keyword]);
        const rank = ranks.get(key) ?? { mode: 'organic', asin: row.asin, keyword: row.keyword, category: null, points: [] };
        rank.points.push({ date: row.date, value: row.value });
        ranks.set(key, rank);
    }
    for (const row of bsr) {
        const key = JSON.stringify(['bsr', row.asin, row.category]);
        const rank = ranks.get(key) ?? { mode: 'bsr', asin: row.asin, keyword: null, category: row.category, points: [] };
        rank.points.push({ date: row.date, value: row.value });
        ranks.set(key, rank);
    }
    if ([...ranks.values()].reduce((n, r) => n + r.points.length, 0) !== organic.length + bsr.length)
        throw new Error('Rank observation count mismatch');
    if (events.length !== manual.length + experiments.length + batches.length)
        throw new Error('Timeline source count mismatch');
    const [failure] = await handle.sql<{
        since: string | null;
    }[]> `select ((min(r.requested_at) at time zone 'UTC')::date)::text as since
    from public.report_requests r where r.org_id=${orgId} and r.profile_id=${profileId} and r.source='amazon_api' and r.status='failed'
    and not exists(select 1 from public.report_requests ok where ok.org_id=r.org_id and ok.profile_id=r.profile_id and ok.report_type=r.report_type
      and ok.source=r.source and ok.status='completed' and ok.requested_at>r.requested_at)`;
    return TimelineSnapshot.parse({ profile, events, scoped, ranks: [...ranks.values()], settings, syncFailureSince: failure?.since ?? null });
}

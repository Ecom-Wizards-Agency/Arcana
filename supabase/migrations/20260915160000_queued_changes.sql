set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Manual staging is not an Amazon authorization receipt or an execution request.
create table public.queued_changes (
  id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  target_id text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  context jsonb not null,
  request jsonb not null,
  checks jsonb not null check (jsonb_array_length(checks) = 5),
  unique (org_id, profile_id, id),
  foreign key (org_id, profile_id) references public.ad_profiles(org_id, id) on delete cascade
);
create index queued_changes_scope_time on public.queued_changes(org_id,profile_id,target_id,created_at);
create table public.queued_change_approvals (
  change_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  foreign key (org_id, profile_id, change_id) references public.queued_changes(org_id, profile_id, id) on delete cascade
);
select app.install_tenant_rls('public.queued_changes', null);
select app.install_tenant_rls('public.queued_change_approvals', null);
revoke insert, update, delete, truncate on public.queued_changes, public.queued_change_approvals from authenticated;
create function app.reject_queued_change_mutation() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op='DELETE' and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
  raise exception 'Queued changes and approvals are immutable' using errcode = '55000'; end $$;
create trigger queued_changes_immutable before update or delete on public.queued_changes for each row execute function app.reject_queued_change_mutation();
create trigger queued_approvals_immutable before update or delete on public.queued_change_approvals for each row execute function app.reject_queued_change_mutation();
create trigger queued_changes_no_truncate before truncate on public.queued_changes for each statement execute function app.reject_queued_change_mutation();
create trigger queued_approvals_no_truncate before truncate on public.queued_change_approvals for each statement execute function app.reject_queued_change_mutation();

create function app.target_bid_context(p_org uuid, p_profile uuid, p_target text) returns jsonb
language sql stable security invoker set search_path = pg_catalog, public as $$
with entity as (
  select k.amazon_id, k.keyword_text as label, k.campaign_id, k.bid,
    coalesce(k.bid_observed_at,k.synced_at) as read_at
  from public.keywords k where k.org_id=p_org and k.profile_id=p_profile and k.amazon_id=p_target
    and k.ad_product='SP' and k.state in ('enabled','paused') and k.deleted_at is null
  union all
  select t.amazon_id, coalesce(t.resolved_expression,t.name,t.amazon_id),t.campaign_id,t.bid,t.synced_at
  from public.targets t where t.org_id=p_org and t.profile_id=p_profile and t.amazon_id=p_target
    and t.ad_product='SP' and t.state in ('enabled','paused') and t.deleted_at is null
), policy as (
  select doc from public.profile_strategy where org_id=p_org and (profile_id=p_profile or profile_id is null)
  order by profile_id nulls last limit 1
)
select jsonb_build_object(
  'profileId',p_profile,'profileLabel',coalesce(p.account_name,p.country_code),'targetId',p_target,'targetLabel',coalesce(e.label,p_target),
  'campaignId',e.campaign_id,'campaignLabel',coalesce(c.name,e.campaign_id),
  'oldBid',case when e.bid is null then null else jsonb_build_object('amount',trim_scale(e.bid)::text,'currencyCode',p.currency_code) end,
  'readAt',case when e.read_at is null then null else to_char(e.read_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
  'organicRank',r.organic_rank,
  'protectionRank',(s.doc#>>'{rank_protection,protection_rank}')::numeric,
  'suggestedLow',b.suggested_bid_low,'suggestedMedian',b.suggested_bid_median,'suggestedHigh',b.suggested_bid_high,
  'maxIncrease',coalesce(g.bid_increase_cap,(s.doc#>>'{caps,max_bid_increase}')::numeric),
  'maxDecrease',coalesce(g.bid_decrease_cap,(s.doc#>>'{caps,max_bid_decrease}')::numeric),
  'bidFloor',g.bid_floor,'bidCeiling',g.bid_ceiling,'campaignBudget',c.budget_amount,
  'targetAcos',g.target_acos,
  'placementModifiers',c.placement_bidding,
  'settingSource',case when g.id is not null then 'optimization_groups:'||g.id::text else 'profile_strategy' end
)
from entity e join public.ad_profiles p on p.org_id=p_org and p.id=p_profile
join public.campaigns c on c.org_id=p_org and c.profile_id=p_profile and c.amazon_id=e.campaign_id
left join public.campaign_optimization_assignments a on a.org_id=p_org and a.profile_id=p_profile and a.campaign_id=e.campaign_id
left join public.optimization_groups g on g.org_id=p_org and g.profile_id=p_profile and g.id=a.group_id and g.enabled
left join policy s on true
left join lateral (select min(organic_rank) as organic_rank from public.rank_observations where org_id=p_org and profile_id=p_profile
  and keyword=e.label and observed_on=(select max(observed_on) from public.rank_observations where org_id=p_org and profile_id=p_profile and keyword=e.label)) r on true
left join lateral (select suggested_bid_low,suggested_bid_median,suggested_bid_high from public.bid_series_daily
  where org_id=p_org and profile_id=p_profile and target_id=p_target order by date desc limit 1) b on true
where (select count(*) from entity)=1 and exists(select 1 from public.org_members where org_id=p_org and user_id=auth.uid())
$$;

-- Same boundary normalization as normalizeQueuedBidOverride: Unicode White_Space,
-- BOM and zero-width space. Default PostgreSQL trim only removes ASCII spaces.
create function app.normalize_queued_bid_override(reason text) returns text
language sql immutable strict set search_path=pg_catalog as $$
  select btrim(reason,
    U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF\200B')
$$;

create function app.target_bid_checks(c jsonb, bid numeric, override_reason text) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare
  old_bid numeric := (c#>>'{oldBid,amount}')::numeric;
  down boolean := bid < old_bid;
  rank numeric := (c->>'organicRank')::numeric;
  protection numeric := (c->>'protectionRank')::numeric;
  lo numeric := (c->>'suggestedLow')::numeric;
  hi numeric := (c->>'suggestedHigh')::numeric;
  inc numeric := (c->>'maxIncrease')::numeric;
  dec numeric := (c->>'maxDecrease')::numeric;
  floor_bid numeric := (c->>'bidFloor')::numeric;
  ceiling_bid numeric := (c->>'bidCeiling')::numeric;
  budget numeric := (c->>'campaignBudget')::numeric;
  source text := c->>'settingSource';
  placements_known boolean := c#>>'{placementModifiers,topOfSearch}' is not null and c#>>'{placementModifiers,restOfSearch}' is not null and c#>>'{placementModifiers,productPages}' is not null;
  delta numeric := (bid-old_bid)/nullif(old_bid,0);
begin return jsonb_build_array(
  jsonb_build_object('key','rank_gate','passed',coalesce(not down or (rank is not null and protection is not null and (rank>protection or nullif(app.normalize_queued_bid_override(override_reason),'') is not null)),false),
    'source','rank_observations · profile strategy','reason',case when not down then 'No bid decrease.' when rank is null or protection is null then 'Rank protection setting or observation is not measured.' when rank<=protection then coalesce('Rank gate override: '||nullif(app.normalize_queued_bid_override(override_reason),''),'Protected organic rank: record an override reason before reducing the bid.') else 'Organic rank is outside the configured protection rank.' end),
  jsonb_build_object('key','band_position','passed',coalesce(bid between lo and hi,false),'source','bid_series_daily','reason',case when lo is null or hi is null then 'Suggested band is not measured.' when bid<lo then 'Proposed bid is below the suggested band.' when bid>hi then 'Proposed bid is above the suggested band.' else 'Proposed bid is within the suggested band.' end),
  jsonb_build_object('key','max_increase','passed',coalesce(delta<=inc,false),'source',source,'reason',case when inc is null then 'Maximum increase setting is missing.' else 'Maximum increase '||trim_scale(inc*100)::text||'%.' end),
  jsonb_build_object('key','max_decrease','passed',coalesce(-delta<=dec,false),'source',source,'reason',case when dec is null then 'Maximum decrease setting is missing.' else 'Maximum decrease '||trim_scale(dec*100)::text||'%.' end),
  jsonb_build_object('key','campaign_limits','passed',coalesce(placements_known and bid>0 and budget>0 and bid between floor_bid and ceiling_bid,false),'source',source,'reason',case when not placements_known then 'Campaign placement modifiers are not measured.' when floor_bid is null or ceiling_bid is null or budget is null then 'Campaign bid bounds or budget are missing.' else 'Bid bounds '||trim_scale(floor_bid)::text||'–'||trim_scale(ceiling_bid)::text||'; campaign daily budget '||trim_scale(budget)::text||'.' end)
); end $$;

create function app.queue_target_bid(p_org uuid, p_request jsonb) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  c jsonb; checks jsonb; old public.queued_changes;
  queue_id uuid; profile uuid; target text; amount text;
  field text; money jsonb; scale integer; reason text;
begin
  perform app.lock_org_editor(p_org);
  -- Validate JSON types before extraction/casts: #>> coerces numbers into text.
  if jsonb_typeof(p_request) is distinct from 'object' then
    raise exception 'Invalid proposal shape' using errcode='22023'; end if;
  if (select count(*) from jsonb_object_keys(p_request))<>7
    or not (p_request ?& array['requestId','profileId','targetId','expectedBid','expectedReadAt','newBid','overrideReason']) then
    raise exception 'Invalid proposal shape' using errcode='22023'; end if;
  foreach field in array array['requestId','profileId','targetId','expectedReadAt'] loop
    if jsonb_typeof(p_request->field) is distinct from 'string' then
      raise exception 'Invalid proposal shape: % must be a string',field using errcode='22023'; end if;
  end loop;
  foreach field in array array['requestId','profileId'] loop
    if p_request->>field !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and lower(p_request->>field) not in ('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff') then
      raise exception 'Invalid proposal shape: % must be a UUID',field using errcode='22023'; end if;
  end loop;
  target := p_request->>'targetId';
  -- Zod string limits count UTF-16 code units, including two for astral characters.
  if length(target)+(select count(*) from regexp_split_to_table(target,'') ch where ascii(ch)>65535) not between 1 and 200
    or length(p_request->>'expectedReadAt')=0 then
    raise exception 'Invalid proposal shape: target or read time' using errcode='22023'; end if;
  if jsonb_typeof(p_request->'overrideReason') not in ('null','string') then
    raise exception 'Invalid override reason: expected text or null' using errcode='22023'; end if;
  if jsonb_typeof(p_request->'overrideReason')='string' then
    reason := app.normalize_queued_bid_override(p_request->>'overrideReason');
    if length(reason)+(select count(*) from regexp_split_to_table(reason,'') ch where ascii(ch)>65535) not between 1 and 1000 then
      raise exception 'Invalid override reason: provide nonblank text of at most 1000 characters' using errcode='22023'; end if;
    p_request := jsonb_set(p_request,'{overrideReason}',to_jsonb(reason));
  end if;
  foreach field in array array['expectedBid','newBid'] loop
    money := p_request->field;
    if jsonb_typeof(money) is distinct from 'object' then
      raise exception 'Invalid proposal money: % must be an object',field using errcode='22023'; end if;
    if (select count(*) from jsonb_object_keys(money))<>2 or not (money ?& array['amount','currencyCode'])
      or jsonb_typeof(money->'amount') is distinct from 'string'
      or jsonb_typeof(money->'currencyCode') is distinct from 'string' then
      raise exception 'Invalid proposal money: exact string amount and currencyCode required' using errcode='22023'; end if;
    if money->>'amount' !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{0,5}[1-9])?$' then
      raise exception 'Invalid proposal money: amount must be canonical decimal text' using errcode='22023'; end if;
    scale := case when money->>'currencyCode'='JPY' then 0
      when money->>'currencyCode'=any(array['AED','AUD','BRL','CAD','EGP','EUR','GBP','INR','MXN','PLN','SAR','SEK','SGD','TRY','USD','ZAR']) then 2 else null end;
    if scale is null or length(split_part(money->>'amount','.',2))>scale then
      raise exception 'Invalid proposal money: unsupported marketplace precision' using errcode='22023'; end if;
  end loop;
  queue_id := (p_request->>'requestId')::uuid;
  profile := (p_request->>'profileId')::uuid;
  amount := p_request#>>'{newBid,amount}';
  perform pg_advisory_xact_lock(hashtextextended(p_org::text||queue_id::text,0));
  select * into old from public.queued_changes where queued_changes.id=queue_id;
  if found then
    if old.org_id<>p_org or old.created_by<>auth.uid() or old.request<>p_request then raise exception 'Request identity conflict' using errcode='22023'; end if;
    return queue_id;
  end if;
  perform 1 from public.keywords where org_id=p_org and profile_id=profile and amazon_id=target for share;
  perform 1 from public.targets where org_id=p_org and profile_id=profile and amazon_id=target for share;
  c := app.target_bid_context(p_org,profile,target);
  if c is null then raise exception 'Target is unavailable or ambiguous' using errcode='42501'; end if;
  if p_request#>>'{newBid,currencyCode}' is distinct from c#>>'{oldBid,currencyCode}'
    or p_request#>>'{expectedBid,currencyCode}' is distinct from c#>>'{oldBid,currencyCode}' then
    raise exception 'Invalid proposal money: currency must match the profile' using errcode='22023'; end if;
  if c->'oldBid' is distinct from p_request->'expectedBid' or c->>'readAt' is distinct from p_request->>'expectedReadAt' or c->>'readAt' is null then
    raise exception 'The synchronized bid changed. Reload before queueing.' using errcode='55000'; end if;
  if amount is null or amount !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{0,5}[1-9])?$' or amount::numeric<=0 or amount::numeric=(c#>>'{oldBid,amount}')::numeric
    or p_request#>>'{newBid,currencyCode}' is distinct from c#>>'{oldBid,currencyCode}' then
    raise exception 'Invalid proposed money' using errcode='22023'; end if;
  checks := app.target_bid_checks(c,amount::numeric,p_request->>'overrideReason');
  if not (checks->0->>'passed')::boolean then raise exception 'Rank gate refused: %',checks->0->>'reason' using errcode='22023'; end if;
  insert into public.queued_changes(id,org_id,profile_id,target_id,created_by,context,request,checks)
    values(queue_id,p_org,profile,target,auth.uid(),c,p_request,checks);
  return queue_id;
end $$;

create function app.approve_queued_target_bid(p_org uuid,p_profile uuid,p_target text,p_id uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.queued_changes; c jsonb;
begin
  perform app.lock_org_editor(p_org);
  perform 1 from public.org_members where org_id=p_org and user_id=auth.uid() and role in ('owner','admin') for share;
  if not found then raise exception 'Resource not found' using errcode='42501'; end if;
  select * into q from public.queued_changes where org_id=p_org and profile_id=p_profile and target_id=p_target and id=p_id for share;
  if not found then raise exception 'Resource not found' using errcode='42501'; end if;
  if exists(select 1 from public.queued_change_approvals where change_id=p_id) then return p_id; end if;
  perform 1 from public.keywords where org_id=p_org and profile_id=p_profile and amazon_id=p_target for share;
  perform 1 from public.targets where org_id=p_org and profile_id=p_profile and amazon_id=p_target for share;
  perform 1 from public.campaigns where org_id=p_org and profile_id=p_profile and amazon_id=q.context->>'campaignId' for share;
  perform 1 from public.optimization_groups where org_id=p_org and profile_id=p_profile for share;
  perform 1 from public.profile_strategy where org_id=p_org and (profile_id=p_profile or profile_id is null) for share;
  c := app.target_bid_context(p_org,p_profile,p_target);
  if c is distinct from q.context then raise exception 'Target or limits changed. Create a new proposal.' using errcode='55000'; end if;
  if exists(select 1 from jsonb_array_elements(q.checks) check_row where not (check_row->>'passed')::boolean) then
    raise exception 'Every check must pass before approval' using errcode='22023'; end if;
  insert into public.queued_change_approvals(change_id,org_id,profile_id,approved_by) values(p_id,p_org,p_profile,auth.uid()) on conflict(change_id) do nothing;
  return p_id;
end $$;
revoke all on function app.normalize_queued_bid_override(text), app.reject_queued_change_mutation(), app.target_bid_context(uuid,uuid,text), app.target_bid_checks(jsonb,numeric,text), app.queue_target_bid(uuid,jsonb), app.approve_queued_target_bid(uuid,uuid,text,uuid) from public;
grant execute on function app.target_bid_context(uuid,uuid,text), app.queue_target_bid(uuid,jsonb), app.approve_queued_target_bid(uuid,uuid,text,uuid) to authenticated;

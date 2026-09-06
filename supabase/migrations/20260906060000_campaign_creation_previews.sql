-- WP-215: saved review artifacts only. Separate campaign window; no execution authority.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table public.campaign_creation_previews (
  org_id uuid not null,
  profile_id uuid not null,
  plan_id uuid not null,
  artifact_text text not null,
  artifact jsonb not null,
  artifact_sha256 text not null,
  recorded_by uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (org_id, profile_id, plan_id),
  constraint campaign_creation_previews_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint campaign_creation_previews_artifact_agrees check (
    artifact_text::jsonb = artifact
    and jsonb_typeof(artifact) = 'object'
    and (artifact ->> 'orgId')::uuid = org_id
    and (artifact ->> 'profileId')::uuid = profile_id
    and (artifact ->> 'id')::uuid = plan_id
    and artifact ?& array['orgId','profileId','id']
    and artifact -> 'orgId' <> 'null'::jsonb
    and artifact -> 'profileId' <> 'null'::jsonb
    and artifact -> 'id' <> 'null'::jsonb
  ),
  constraint campaign_creation_previews_byte_digest check (
    artifact_sha256 = encode(sha256(convert_to(artifact_text, 'UTF8')), 'hex')
  )
);

alter table public.campaign_creation_previews enable row level security;
create policy campaign_creation_previews_read on public.campaign_creation_previews
  for select to authenticated using (app.has_org_role(org_id, array['owner','admin']));
revoke all on public.campaign_creation_previews from public, anon, authenticated, service_role;
grant select on public.campaign_creation_previews to authenticated, service_role;

create function app.guard_campaign_creation_preview_immutable() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  -- Definer context distinguishes actual parent deletion from RLS invisibility.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  raise exception 'campaign preview is immutable' using errcode = '55000';
end;
$$;
revoke all on function app.guard_campaign_creation_preview_immutable()
  from public, anon, authenticated, service_role;
create trigger campaign_creation_previews_immutable before update or delete
  on public.campaign_creation_previews for each row
  execute function app.guard_campaign_creation_preview_immutable();
create trigger campaign_creation_previews_no_truncate before truncate
  on public.campaign_creation_previews for each statement
  execute function app.guard_campaign_creation_preview_immutable();

-- Storage integrity and current recording authority only. Shared schemas verify
-- the complete graph/payload/fingerprints before insertion AND every product read.
-- A saved artifact, including a direct authenticated RPC insert, cannot grant execution.
create function app.record_campaign_creation_preview(p_plan_text text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app, auth, pg_temp as $$
declare
  v_plan jsonb := p_plan_text::jsonb;
  v_actor uuid := auth.uid();
  v_org uuid := (v_plan ->> 'orgId')::uuid;
  v_profile_id uuid := (v_plan ->> 'profileId')::uuid;
  v_plan_id uuid := (v_plan ->> 'id')::uuid;
  v_profile public.ad_profiles%rowtype;
  v_existing public.campaign_creation_previews%rowtype;
  v_now timestamptz;
begin
  if v_plan is null or jsonb_typeof(v_plan) <> 'object'
    or v_actor is null or v_org is null or v_profile_id is null or v_plan_id is null
    or v_plan ->> 'schemaVersion' is distinct from 'openspell.campaign-creation-plan.v2' then
    raise exception 'invalid campaign preview' using errcode = '22023';
  end if;

  perform 1 from public.orgs where id = v_org for key share;
  if not found then raise exception 'campaign preview unavailable' using errcode = '42501'; end if;
  perform 1 from public.org_members where org_id = v_org and user_id = v_actor
    and role in ('owner','admin') for share;
  if not found then raise exception 'campaign preview unavailable' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'wizard-ads:campaign-preview:' || v_org::text || ':' || v_profile_id::text || ':' || v_plan_id::text, 0));
  select * into v_existing from public.campaign_creation_previews
    where org_id = v_org and profile_id = v_profile_id and plan_id = v_plan_id;
  if found then
    if v_existing.artifact_text is distinct from p_plan_text then
      raise exception 'campaign preview identity conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('profileId', v_profile_id, 'planId', v_plan_id);
  end if;

  select p.* into v_profile from public.ad_profiles p
    join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
    where p.org_id = v_org and p.id = v_profile_id and p.sync_enabled and c.status = 'active'
    for share of p, c;
  if not found or v_plan #>> '{providerScope,amazonProfileId}' is distinct from v_profile.amazon_profile_id
    or v_plan #>> '{providerScope,connectionId}' is distinct from v_profile.connection_id::text
    or v_plan #>> '{providerScope,region}' is distinct from v_profile.region::text
    or v_plan #>> '{providerScope,currencyCode}' is distinct from v_profile.currency_code
    or v_plan #>> '{providerScope,accountType}' is distinct from v_profile.account_type::text then
    raise exception 'campaign preview scope unavailable' using errcode = '42501';
  end if;
  -- Marketplace is a frozen requested value; profiles do not independently store it.
  v_now := clock_timestamp();
  if v_plan ->> 'generatedAt' is null or v_plan ->> 'frozenAt' is null or v_plan ->> 'expiresAt' is null
    or (v_plan ->> 'generatedAt')::timestamptz > (v_plan ->> 'frozenAt')::timestamptz
    or (v_plan ->> 'frozenAt')::timestamptz > v_now
    or (v_plan ->> 'expiresAt')::timestamptz <= v_now then
    raise exception 'campaign preview times unavailable' using errcode = '22023';
  end if;
  insert into public.campaign_creation_previews
    (org_id, profile_id, plan_id, artifact_text, artifact, artifact_sha256, recorded_by, recorded_at)
    values (v_org, v_profile_id, v_plan_id, p_plan_text, v_plan,
      encode(sha256(convert_to(p_plan_text, 'UTF8')), 'hex'), v_actor, v_now);
  return jsonb_build_object('profileId', v_profile_id, 'planId', v_plan_id);
end;
$$;
revoke all on function app.record_campaign_creation_preview(text) from public, anon, authenticated, service_role;
grant execute on function app.record_campaign_creation_preview(text) to authenticated;

comment on table public.campaign_creation_previews is
  'Immutable saved campaign review text. Not approval or provider evidence; shared validation is mandatory on reads.';

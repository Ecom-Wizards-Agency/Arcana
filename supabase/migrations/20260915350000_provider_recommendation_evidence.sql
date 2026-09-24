set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
alter type public.sync_job_type add value if not exists 'provider.evidence.collect';

-- Source admission is explicit and separate from any execution cadence or write key.
create table public.provider_evidence_configs (
  id uuid primary key, org_id uuid not null, profile_id uuid not null,
  enabled boolean not null default false, config jsonb not null,
  unique(org_id,profile_id,id),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(jsonb_typeof(config)='object' and config->>'id' is not distinct from id::text and config#>>'{scope,orgId}' is not distinct from org_id::text and config#>>'{scope,profileId}' is not distinct from profile_id::text)
);
create table public.provider_recommendation_runs (
  id uuid primary key, org_id uuid not null, profile_id uuid not null, config_id uuid not null,
  run jsonb not null, unique(org_id,profile_id,id),
  foreign key(org_id,profile_id,config_id) references public.provider_evidence_configs(org_id,profile_id,id) on delete cascade,
  check(run->>'id' is not distinct from id::text and run#>>'{config,id}' is not distinct from config_id::text and run#>>'{config,scope,orgId}' is not distinct from org_id::text and run#>>'{config,scope,profileId}' is not distinct from profile_id::text)
);
create index provider_recommendation_runs_scope on public.provider_recommendation_runs(org_id,profile_id,config_id);
create table public.provider_recommendations (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, profile_id uuid not null,
  family text not null, namespace text not null, provider_id text not null, version text not null,
  evidence jsonb not null, unique(org_id,profile_id,id),
  unique(org_id,profile_id,family,namespace,provider_id,version),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(version ~ '^[a-f0-9]{64}$'),
  check(evidence#>>'{scope,orgId}' is not distinct from org_id::text and evidence#>>'{scope,profileId}' is not distinct from profile_id::text
    and evidence->>'family' is not distinct from family and evidence->>'namespace' is not distinct from namespace and evidence->>'providerId' is not distinct from provider_id and evidence->>'version' is not distinct from version),
  check(evidence::text !~* 'https?://|"(access_token|refresh_token|authorization|cookie|secret|password|error|details|failureReason)"[[:space:]]*:')
);
create index provider_recommendations_scope on public.provider_recommendations(org_id,profile_id,family);
create index provider_recommendations_entity on public.provider_recommendations(org_id,profile_id,(evidence#>>'{entity,entityId}'));
create table public.provider_recommendation_run_rows (
  org_id uuid not null, profile_id uuid not null, run_id uuid not null, evidence_id uuid not null,
  primary key(run_id,evidence_id),
  foreign key(org_id,profile_id,run_id) references public.provider_recommendation_runs(org_id,profile_id,id) on delete cascade,
  foreign key(org_id,profile_id,evidence_id) references public.provider_recommendations(org_id,profile_id,id) on delete cascade
);
select app.install_tenant_rls('public.provider_evidence_configs',null);
select app.install_tenant_rls('public.provider_recommendation_runs',null);
select app.install_tenant_rls('public.provider_recommendations',null);
select app.install_tenant_rls('public.provider_recommendation_run_rows',null);
revoke all on public.provider_evidence_configs from authenticated;
grant select(org_id,profile_id,id,enabled) on public.provider_evidence_configs to authenticated;
-- Requests/checkpoint tokens remain worker-owned. Readers receive only safe run projections.
revoke all on public.provider_recommendation_runs from authenticated;
grant select(org_id,profile_id,id,config_id) on public.provider_recommendation_runs to authenticated;
create function public.read_provider_run_summaries(p_org_id uuid,p_profile_id uuid)
returns table(run_id uuid, config_id uuid, family text, status text, observed_at text, started_at text, expires_at text, counts jsonb)
language sql stable security definer set search_path=pg_catalog as $$
  select r.id,r.config_id,r.run#>>'{config,family}',r.run->>'status',r.run->>'observedAt',r.run->>'startedAt',
    (select case when count(*)>0 and bool_and(e.evidence->>'expiresAt' is not null) then max(e.evidence->>'expiresAt') else null end from public.provider_recommendation_run_rows m join public.provider_recommendations e on e.id=m.evidence_id and e.org_id=m.org_id and e.profile_id=m.profile_id where m.run_id=r.id and m.org_id=r.org_id and m.profile_id=r.profile_id),r.run->'counts'
  from public.provider_recommendation_runs r where r.org_id=p_org_id and r.profile_id=p_profile_id
    and app.is_org_member(p_org_id)
$$;
revoke all on function public.read_provider_run_summaries(uuid,uuid) from public,anon;
grant execute on function public.read_provider_run_summaries(uuid,uuid) to authenticated,service_role;
create function app.provider_evidence_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
  raise exception 'Provider evidence versions and run membership are immutable' using errcode='23514'; end;
$$;
create trigger provider_evidence_immutable before update or delete on public.provider_recommendations for each row execute function app.provider_evidence_immutable();
create trigger provider_evidence_no_truncate before truncate on public.provider_recommendations for each statement execute function app.provider_evidence_immutable();
create trigger provider_run_rows_immutable before update or delete on public.provider_recommendation_run_rows for each row execute function app.provider_evidence_immutable();
create trigger provider_run_rows_no_truncate before truncate on public.provider_recommendation_run_rows for each statement execute function app.provider_evidence_immutable();
revoke update,delete,truncate on public.provider_recommendations,public.provider_recommendation_run_rows from service_role;

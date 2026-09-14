set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
alter type public.sync_job_type add value if not exists 'translation.request';
-- UTF-8 is fixed, and a database's source encoding cannot change in place.
create function app.translation_text_hash(value text) returns text language sql immutable strict
  set search_path=pg_catalog as $$ select encode(sha256(convert_to(value,'UTF8')),'hex') $$;

create table public.target_translations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  original_text text not null check (length(original_text) between 1 and 2048 and length(btrim(original_text)) > 0),
  original_hash text generated always as (app.translation_text_hash(original_text)) stored,
  language text not null check (language in ('en','de','fr','es','it','pt','ja','zh')),
  status text not null default 'waiting' check (status in ('waiting','available','unavailable')),
  translated_text text,
  reason text,
  provider_id text not null default 'not-configured',
  request_id uuid not null,
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (org_id, profile_id) references public.ad_profiles(org_id, id) on delete cascade,
  unique (org_id, profile_id, original_hash, language),
  constraint target_translations_result_check check (
    (status='waiting' and translated_text is null and reason is null and completed_at is null)
    or (status='available' and translated_text is not null and length(translated_text)>0 and reason is null and completed_at is not null)
    or (status='unavailable' and translated_text is null and reason is not null and length(reason)>0 and completed_at is not null)
  )
);
select app.install_tenant_rls('public.target_translations');

-- Only this command may admit a user request. Queue insertion and waiting state
-- commit together, under current editor authority and exact profile ownership.
create function app.request_target_translation(p_org uuid, p_profile uuid, p_original text, p_language text, p_retry uuid default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_row public.target_translations%rowtype; v_request uuid := gen_random_uuid();
begin
  perform app.lock_org_editor(p_org);
  if not exists(select 1 from public.ad_profiles where org_id=p_org and id=p_profile) then
    raise exception 'Resource not found' using errcode='42501';
  end if;
  if p_retry is not null then
    select * into v_row from public.target_translations where org_id=p_org and profile_id=p_profile and id=p_retry for update;
    if not found then raise exception 'Resource not found' using errcode='42501'; end if;
    p_original := v_row.original_text; p_language := v_row.language;
  else
    if p_original is null or length(p_original) not between 1 and 2048 or length(btrim(p_original))=0
       or p_language is null or p_language not in ('en','de','fr','es','it','pt','ja','zh') then
      raise exception 'Invalid translation request' using errcode='22023';
    end if;
    insert into public.target_translations(org_id,profile_id,original_text,language,request_id,requested_by)
    values(p_org,p_profile,p_original,p_language,v_request,auth.uid())
    on conflict (org_id,profile_id,original_hash,language) do nothing;
    select * into v_row from public.target_translations
      where org_id=p_org and profile_id=p_profile and original_hash=app.translation_text_hash(p_original) and language=p_language for update;
    if v_row.original_text is distinct from p_original then raise exception 'Translation identity mismatch'; end if;
    -- Reopening a column reuses an existing request, including its unavailable result.
    if v_row.request_id <> v_request then return v_row.id; end if;
  end if;
  update public.target_translations set request_id=v_request, requested_by=auth.uid(), requested_at=now(),
    status='waiting', translated_text=null, reason=null, completed_at=null, provider_id='not-configured'
    where id=v_row.id;
  insert into public.sync_jobs(org_id,profile_id,job_type,payload,dedupe_key)
    values(p_org,p_profile,'translation.request',jsonb_build_object('type','translation.request','orgId',p_org,
      'profileId',p_profile,'translationId',v_row.id,'requestId',v_request), 'translation:' || v_request::text);
  return v_row.id;
end $$;
revoke all on function app.request_target_translation(uuid,uuid,text,text,uuid) from public, anon;
grant execute on function app.request_target_translation(uuid,uuid,text,text,uuid) to authenticated;

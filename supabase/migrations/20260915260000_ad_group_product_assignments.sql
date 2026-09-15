set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Operator attribution only; the synchronized Amazon entity remains unchanged.
create table public.ad_group_product_assignments (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  ad_group_id text not null,
  asin text not null check (asin ~ '^[A-Z0-9]{10}$'),
  assigned_by uuid not null references auth.users(id),
  assigned_at timestamptz not null default now(),
  primary key (org_id, profile_id, ad_group_id),
  foreign key (org_id, profile_id) references public.ad_profiles(org_id, id) on delete cascade,
  foreign key (profile_id, ad_group_id) references public.ad_groups(profile_id, amazon_id) on delete cascade
);
select app.install_tenant_rls('public.ad_group_product_assignments', array['owner','admin','analyst']);
create policy assignment_actor_insert on public.ad_group_product_assignments as restrictive
  for insert to authenticated with check (assigned_by = auth.uid());
create policy assignment_actor_update on public.ad_group_product_assignments as restrictive
  for update to authenticated using (true) with check (assigned_by = auth.uid());

create function app.validate_ad_group_product_assignment() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if not exists (select 1 from public.ad_groups g where g.org_id=new.org_id
    and g.profile_id=new.profile_id and g.amazon_id=new.ad_group_id and g.deleted_at is null) then
    raise exception 'Ad group unavailable' using errcode='23514';
  end if;
  perform 1 from public.product_ads p where p.org_id=new.org_id and p.profile_id=new.profile_id
    and p.ad_group_id=new.ad_group_id and p.asin=new.asin and p.deleted_at is null for share;
  if not found then raise exception 'Product is no longer advertised by this ad group' using errcode='23514'; end if;
  new.assigned_at := now();
  return new;
end;
$$;
revoke all on function app.validate_ad_group_product_assignment() from public, anon, authenticated;
create trigger validate_ad_group_product_assignment before insert or update on public.ad_group_product_assignments
  for each row execute function app.validate_ad_group_product_assignment();

set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter table public.ad_group_product_assignments
  alter column asin drop not null,
  alter column assigned_by drop not null,
  add column source text not null default 'manual',
  add column derived_at timestamptz,
  add column derivation jsonb,
  add constraint product_assignment_source check (source in ('manual','derived','derived_parent','proposed','unassigned')),
  add constraint product_assignment_shape check (
    (source='unassigned' and asin is null or source<>'unassigned' and asin is not null)
    and (source<>'manual' or assigned_by is not null)
  );

create or replace function app.validate_ad_group_product_assignment() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if not exists (select 1 from public.ad_groups g where g.org_id=new.org_id
    and g.profile_id=new.profile_id and g.amazon_id=new.ad_group_id and g.deleted_at is null) then
    raise exception 'Ad group unavailable' using errcode='23514';
  end if;
  if current_setting('role',true) = 'authenticated' then
    if new.assigned_by is distinct from auth.uid() then
      raise exception 'Assignment actor mismatch' using errcode='42501';
    end if;
    if tg_op='INSERT' then
      if new.source<>'manual' or new.derivation is not null or new.derived_at is not null then
        raise exception 'Only the worker may derive assignments' using errcode='42501';
      end if;
    else
      if (new.org_id,new.profile_id,new.ad_group_id) is distinct from (old.org_id,old.profile_id,old.ad_group_id) then
        raise exception 'Assignment identity is immutable' using errcode='42501';
      end if;
      if new.derivation is distinct from old.derivation or new.derived_at is distinct from old.derived_at then
        raise exception 'Only the worker may refresh derivation evidence' using errcode='42501';
      end if;
      if new.source<>'manual' and (old.source<>'manual'
        or new.source is distinct from coalesce(old.derivation->>'source','unassigned')
        or new.asin is distinct from (old.derivation->>'assignedAsin')) then
        raise exception 'Revert must restore the saved derivation' using errcode='42501';
      end if;
    end if;
  end if;
  -- Worker baseline refreshes must preserve even a stale manual choice.
  if new.source='manual' and (tg_op='INSERT' or current_setting('role',true)='authenticated'
    or new.asin is distinct from old.asin or new.assigned_by is distinct from old.assigned_by) then
    perform 1 from public.product_ads p where p.org_id=new.org_id and p.profile_id=new.profile_id
      and p.ad_group_id=new.ad_group_id and p.asin=new.asin and p.deleted_at is null
      and p.state in ('enabled','paused') for share;
    if not found then raise exception 'Product is no longer advertised by this ad group' using errcode='23514'; end if;
  end if;
  if tg_op='INSERT' or new.source is distinct from old.source or new.asin is distinct from old.asin
    or new.assigned_by is distinct from old.assigned_by then new.assigned_at := now();
  else new.assigned_at := old.assigned_at;
  end if;
  return new;
end;
$$;

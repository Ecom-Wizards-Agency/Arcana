-- Preserve tag relationships only within one agency, including privileged
-- writes and foreign-key cascades. Existing invalid data refuses this migration;
-- there is deliberately no automatic deletion, reassignment or unvalidated FK.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter table public.tags
  add constraint tags_org_identity_unique unique (org_id, id),
  add constraint tags_org_parent_fkey
    foreign key (org_id, parent_id) references public.tags (org_id, id) on delete cascade;

alter table public.entity_tags
  add constraint entity_tags_org_tag_fkey
    foreign key (org_id, tag_id) references public.tags (org_id, id) on delete cascade,
  add constraint entity_tags_org_profile_fkey
    foreign key (org_id, profile_id) references public.ad_profiles (org_id, id) on delete cascade;

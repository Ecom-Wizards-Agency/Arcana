-- The MCP credential schema remains private. Application users may read only
-- display metadata for an organization in which they currently hold membership.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function public.list_mcp_key_metadata(p_org_id uuid)
returns table(
  id uuid, label text, key_prefix text, scope text, profile_ids uuid[],
  expires_at timestamptz, revoked_at timestamptz,
  last_used_at timestamptz, created_at timestamptz
)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select k.id, k.label, k.key_prefix, k.scope::text, k.profile_ids,
         k.expires_at, k.revoked_at, k.last_used_at, k.created_at
    from mcp.api_keys k
   where k.org_id = p_org_id
     and auth.uid() is not null
     and exists (
       select 1 from public.org_members m
        where m.org_id = p_org_id and m.user_id = auth.uid()
     )
   order by k.created_at desc, k.id desc;
$$;
revoke all on function public.list_mcp_key_metadata(uuid) from public, anon, service_role;
grant execute on function public.list_mcp_key_metadata(uuid) to authenticated;

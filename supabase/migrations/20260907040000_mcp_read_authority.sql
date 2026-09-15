-- The token verifier establishes identity; each MCP operation rechecks its key
-- through this bounded projection, then reads tenant tables as authenticated.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function app.authorize_mcp_read_key(p_key_id uuid, p_org_id uuid)
returns table(org_slug text, profile_ids uuid[])
language sql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select o.slug::text, k.profile_ids
    from mcp.api_keys k
    join public.orgs o on o.id = k.org_id
    join public.org_members m on m.org_id = k.org_id and m.user_id = k.created_by
   where k.id = p_key_id and k.org_id = p_org_id
     and k.created_by = auth.uid() and m.created_at <= k.created_at
     and k.scope = 'read' and k.revoked_at is null
     and k.expires_at > clock_timestamp()
     and k.expires_at <= k.created_at + interval '90 days'
     and cardinality(k.profile_ids) > 0
     and cardinality(k.profile_ids) = (
       select count(*) from public.ad_profiles p
        where p.org_id = p_org_id and p.id = any(k.profile_ids)
     );
$$;

revoke all on function app.authorize_mcp_read_key(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.authorize_mcp_read_key(uuid, uuid) to authenticated;

-- Current manager authority, key mutation and safe audit share one transaction.
-- Commands stay in the non-exposed app schema, behind verified web Auth/MFA.
-- Credential-table access remains limited to the installation/MCP service role.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function app.issue_mcp_read_key(
  p_org_id uuid, p_label text, p_profile_ids uuid[], p_expires_in_days integer,
  p_key_prefix text, p_token_hash text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_count integer; v_id uuid; v_created_at timestamptz;
begin
  perform app.lock_org_manager(p_org_id);
  if p_label is null or char_length(btrim(p_label)) not between 1 and 200
     or p_expires_in_days is null or p_expires_in_days not in (7, 30, 90)
     or p_key_prefix is null or p_key_prefix !~ '^wza_[A-Za-z0-9_-]{8}$'
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_profile_ids is null or cardinality(p_profile_ids) not between 1 and 10000
     or array_position(p_profile_ids, null) is not null
     or cardinality(p_profile_ids) <> (select count(distinct p) from unnest(p_profile_ids) p)
  then
    raise exception using errcode = '22023', message = 'Invalid key settings';
  end if;

  -- Keep each selected profile in the same agency through key admission.
  perform p.id from public.ad_profiles p
   where p.org_id = p_org_id and p.id = any(p_profile_ids)
   order by p.id for share;
  get diagnostics v_count = row_count;
  if v_count <> cardinality(p_profile_ids) then
    raise exception using errcode = '22023', message = 'Invalid key settings';
  end if;
  v_created_at := clock_timestamp();
  insert into mcp.api_keys
    (org_id, label, key_prefix, token_hash, scope, profile_ids, expires_at, created_by, created_at)
  values (p_org_id, btrim(p_label), p_key_prefix, p_token_hash, 'read', p_profile_ids,
          v_created_at + make_interval(days => p_expires_in_days), auth.uid(), v_created_at)
  returning id into v_id;
  insert into public.audit_log
    (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
  values (p_org_id, 'user', auth.uid()::text, 'mcp_key.issued', 'mcp_key', v_id::text,
          jsonb_build_object('profile_count', v_count, 'expires_in_days', p_expires_in_days), 'web');
  return v_id;
end;
$$;

create function app.revoke_mcp_key(p_org_id uuid, p_key_id uuid)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_revoked_at timestamptz;
begin
  perform app.lock_org_manager(p_org_id);
  select k.revoked_at into v_revoked_at from mcp.api_keys k
   where k.org_id = p_org_id and k.id = p_key_id for update;
  if not found then return false; end if;
  if v_revoked_at is not null then return true; end if;
  update mcp.api_keys set revoked_at = clock_timestamp()
   where org_id = p_org_id and id = p_key_id;
  insert into public.audit_log
    (org_id, actor_type, actor_id, action, target_type, target_id, source)
  values (p_org_id, 'user', auth.uid()::text, 'mcp_key.revoked', 'mcp_key', p_key_id::text, 'web');
  return true;
end;
$$;

revoke all on function app.issue_mcp_read_key(uuid, text, uuid[], integer, text, text)
  from public, anon, service_role;
revoke all on function app.revoke_mcp_key(uuid, uuid) from public, anon, service_role;
grant execute on function app.issue_mcp_read_key(uuid, text, uuid[], integer, text, text) to authenticated;
grant execute on function app.revoke_mcp_key(uuid, uuid) to authenticated;

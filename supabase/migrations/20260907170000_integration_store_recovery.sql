-- Keep recoverable Vault failures inside a PostgreSQL subtransaction. The
-- caller retains the complete membership/metadata/audit transaction; a lost
-- connection cannot trigger a client-side savepoint rollback or a new write.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function app.try_store_integration_secret(p_connection_id uuid, p_token text)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  -- Authority refusal must escape, never become a recoverable storage result.
  perform app.assert_service_role('try_store_integration_secret');
  begin
    perform public.store_integration_secret(p_connection_id, p_token);
    return true;
  exception when others then
    -- PostgreSQL has rolled back every inner Vault/metadata change before this
    -- branch runs. Do not expose or persist SQLERRM or submitted parameters.
    return false;
  end;
end;
$$;

revoke all on function app.try_store_integration_secret(uuid, text) from public, anon, authenticated;
grant execute on function app.try_store_integration_secret(uuid, text) to service_role;

comment on function app.try_store_integration_secret(uuid, text) is
  'Service-only recoverable store using the existing Vault RPC; returns no secret or provider error.';

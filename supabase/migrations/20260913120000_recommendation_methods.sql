set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Method identity is independent of engine/configuration versions. Historical runs stay null.
alter table public.recommendation_runs
  add column method_id text,
  add column method_version text;

-- Accept historical snapshots unchanged; new admissions store the canonical method.
create or replace function app.one_time_rpc_snapshot_valid(p_snapshot jsonb)
returns boolean
language plpgsql
stable
set search_path = pg_catalog
as $$
declare
  v_config jsonb;
  v_window jsonb;
  v_key text;
  v_number double precision;
  v_start date;
  v_end date;
  v_today date;
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) is distinct from 'object'
     or p_snapshot - array['version','configuration','profileTimezone','admittedAt','profileToday'] <> '{}'::jsonb
     or p_snapshot -> 'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_snapshot -> 'profileTimezone') is distinct from 'string'
     or jsonb_typeof(p_snapshot -> 'admittedAt') is distinct from 'string'
     or jsonb_typeof(p_snapshot -> 'profileToday') is distinct from 'string'
     or not coalesce(p_snapshot ->> 'admittedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$', false)
     or not coalesce(p_snapshot ->> 'profileToday' ~ '^\d{4}-\d{2}-\d{2}$', false) then
    return false;
  end if;
  v_config := p_snapshot -> 'configuration';
  if jsonb_typeof(v_config) is distinct from 'object'
     or v_config - array['version','method','targetAcos','bidFloor','bidCeiling','bidIncreaseCap','bidDecreaseCap','window'] <> '{}'::jsonb
     or v_config -> 'version' is distinct from '1'::jsonb
     or not coalesce(v_config ->> 'method' in ('rpc', 'sp.reference-efficiency'), false) then
    return false;
  end if;
  foreach v_key in array array['targetAcos','bidFloor','bidCeiling','bidIncreaseCap','bidDecreaseCap'] loop
    if jsonb_typeof(v_config -> v_key) is distinct from 'number' then return false; end if;
    v_number := (v_config ->> v_key)::double precision;
    if v_number < 0 or v_number in ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision) then
      return false;
    end if;
  end loop;
  if (v_config ->> 'targetAcos')::double precision <= 0
     or (v_config ->> 'bidCeiling')::double precision <= 0
     or (v_config ->> 'bidFloor')::double precision > (v_config ->> 'bidCeiling')::double precision
     or (v_config ->> 'bidDecreaseCap')::double precision > 1 then return false; end if;
  v_window := v_config -> 'window';
  if jsonb_typeof(v_window) is distinct from 'object'
     or v_window - array['start','end'] <> '{}'::jsonb
     or not coalesce(v_window ->> 'start' ~ '^\d{4}-\d{2}-\d{2}$', false)
     or not coalesce(v_window ->> 'end' ~ '^\d{4}-\d{2}-\d{2}$', false) then return false; end if;
  v_start := (v_window ->> 'start')::date;
  v_end := (v_window ->> 'end')::date;
  v_today := (p_snapshot ->> 'profileToday')::date;
  return v_end >= v_start and v_end - v_start < 366 and v_end < v_today
     and v_today = ((p_snapshot ->> 'admittedAt')::timestamptz at time zone (p_snapshot ->> 'profileTimezone'))::date;
exception when invalid_text_representation or numeric_value_out_of_range
  or invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then
  return false;
end;
$$;
revoke all on function app.one_time_rpc_snapshot_valid(jsonb) from public;
grant execute on function app.one_time_rpc_snapshot_valid(jsonb)
  to authenticated, service_role, openspell_recommendation_executor;

create or replace function app.one_time_rpc_snapshot_fingerprint(p_snapshot jsonb)
returns text
language plpgsql
stable
strict
set search_path = pg_catalog, app
as $$
declare
  v_config jsonb := p_snapshot -> 'configuration';
  v_values text[] := array['1','1',v_config ->> 'method'];
  v_key text;
  v_number double precision;
  v_value text;
  v_preimage text := E'openspell.one-time-rpc.snapshot.v1\n';
begin
  if not app.one_time_rpc_snapshot_valid(p_snapshot) then
    raise exception 'invalid one-time RPC snapshot' using errcode = '22023';
  end if;
  foreach v_key in array array['targetAcos','bidFloor','bidCeiling','bidIncreaseCap','bidDecreaseCap'] loop
    v_number := (v_config ->> v_key)::double precision;
    if v_number = 0 then v_number := 0; end if;
    v_values := array_append(v_values, encode(float8send(v_number), 'hex'));
  end loop;
  v_values := v_values || array[v_config #>> '{window,start}', v_config #>> '{window,end}',
    p_snapshot ->> 'profileTimezone', p_snapshot ->> 'admittedAt', p_snapshot ->> 'profileToday'];
  foreach v_value in array v_values loop
    v_preimage := v_preimage || octet_length(v_value)::text || ':' || v_value || E'\n';
  end loop;
  return encode(sha256(convert_to(v_preimage, 'UTF8')), 'hex');
end;
$$;
revoke all on function app.one_time_rpc_snapshot_fingerprint(jsonb) from public;
grant execute on function app.one_time_rpc_snapshot_fingerprint(jsonb)
  to authenticated, service_role, openspell_recommendation_executor;

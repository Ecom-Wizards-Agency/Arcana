-- Creator Connections round 3a (WP-334): the sample pre-flight record and the read-only
-- MCF observation. Nothing here places, changes or cancels an Amazon order: a pre-flight
-- is the control runner's result, recorded; an observation is an SP-API read the worker
-- made (getFulfillmentOrder, listAllFulfillmentOrders, getPackageTrackingDetails).
-- Fingerprints only: no column holds a name, address, email, phone or link, and the
-- SP-API client drops every recipient field before a read reaches these tables.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- The worker's read-only observation job. The enum grows in migration order.
alter type public.sync_job_type add value if not exists 'mcf.observe';

-- The derived sample order key, in one place: `CCS-` plus 32 hex of SHA-256 over organisation,
-- creator record and ASIN, no clock. It is the sellerFulfillmentOrderId a later create job
-- must send byte for byte. creator_sample_shipments (WP-332) computes the same expression
-- inline; a database test holds the three tables and packages/db's creatorSampleOrderKey equal.
create function app.creator_sample_order_key(p_org uuid, p_record text, p_asin text) returns text
  language sql immutable strict parallel safe set search_path = pg_catalog as $$
  select 'CCS-' || left(encode(sha256((p_org::text || '|' || p_record || '|' || p_asin)::bytea), 'hex'), 32)
$$;
revoke all on function app.creator_sample_order_key(uuid, text, text) from public, anon;
grant execute on function app.creator_sample_order_key(uuid, text, text) to authenticated, service_role;

-- One row per runner `preflight` or `preflight-switch` run. Append-only; the run id is the
-- idempotency identity a replay collides on. `detail` holds the eight checks (preflight) or
-- the alternate's stock read (preflight-switch), validated by the shared schema.
create table public.creator_sample_preflights (
  -- The stable identity a later order request points at.
  id uuid not null default gen_random_uuid() unique,
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id text not null check (run_id ~ '^[A-Za-z0-9:_.-]{1,80}$'),
  command text not null check (command in ('preflight', 'preflight-switch')),
  creator_record_id text not null,
  -- The selected ASIN for a sample pre-flight; the alternate for a switch.
  asin text not null check (asin ~ '^[A-Z0-9]{10}$'),
  original_asin text check (original_asin ~ '^[A-Z0-9]{10}$'),
  derived_order_key text not null generated always as (app.creator_sample_order_key(org_id, creator_record_id, asin)) stored,
  original_order_key text generated always as (app.creator_sample_order_key(org_id, creator_record_id, original_asin)) stored,
  result text not null check (result in ('PASS', 'HOLD')),
  errors text[] not null check (array_to_string(errors, ',') ~ '^([a-z0-9_]+(,[a-z0-9_]+)*)?$'),
  required_next_state text not null check (required_next_state in ('Locked for MCF', 'Conflict or Held',
    'Product Switch Pending', 'Approved for Sample')),
  -- The runner's HMAC over the complete recipient block; never the block.
  recipient_binding_fp text check (recipient_binding_fp ~ '^[0-9a-f]{64}$'),
  detail jsonb not null check (jsonb_typeof(detail) = 'object'),
  -- The read times a stale-preview check compares, as columns so a later write can test them in SQL.
  preview_read_at timestamptz,
  preview_valid_until timestamptz,
  inventory_checked_at timestamptz,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  source text not null check (source in ('control-runner', 'mcp', 'web')),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid,
  recorded_at timestamptz not null default now(),
  primary key (org_id, run_id),
  foreign key (org_id, creator_record_id) references public.creator_records(org_id, creator_record_id) on delete cascade,
  check (started_at <= completed_at),
  check ((command = 'preflight-switch') = (original_asin is not null)),
  check (command = 'preflight' or recipient_binding_fp is null),
  check ((result = 'PASS') = (cardinality(errors) = 0)),
  check (preview_valid_until is null or preview_read_at is not null),
  check (command = 'preflight' or preview_read_at is null)
);
create index creator_sample_preflights_lane on public.creator_sample_preflights(org_id, derived_order_key, completed_at desc);
create index creator_sample_preflights_original on public.creator_sample_preflights(org_id, original_order_key, completed_at desc)
  where original_order_key is not null;

-- What the observe job last saw, on the lane itself, so the list screen needs no join.
-- `shipments` is the whole `fulfillmentShipments` array, sanitized; the settlement is
-- derived from the observation rows by the trigger below, never written by a caller.
alter table public.creator_sample_shipments
  add column shipments jsonb check (shipments is null or jsonb_typeof(shipments) = 'array'),
  add column mcf_settlement text check (mcf_settlement in ('found', 'not_found', 'escalated')),
  add column mcf_not_found_probes integer not null default 0 check (mcf_not_found_probes >= 0),
  add column mcf_probed_at timestamptz,
  add constraint creator_sample_shipments_settlement_read check ((mcf_settlement is null) = (mcf_probed_at is null)),
  add constraint creator_sample_shipments_shipments_read check (shipments is null or mcf_status is not null);

-- Append-only: one row per read of one lane. A replay of the same job collides on its key.
create table public.creator_mcf_observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  observation_key text not null check (length(observation_key) between 1 and 200),
  creator_record_id text not null,
  asin text not null,
  derived_order_key text not null generated always as (app.creator_sample_order_key(org_id, creator_record_id, asin)) stored,
  queried_order_id text not null check (length(queried_order_id) between 1 and 100),
  operation text not null check (operation in ('getFulfillmentOrder', 'listAllFulfillmentOrders')),
  outcome text not null check (outcome in ('found', 'not_found')),
  mcf_status text check (mcf_status in ('New', 'Received', 'Planning', 'Processing', 'Cancelled', 'Complete',
    'CompletePartialled', 'Unfulfillable', 'Invalid')),
  shipments jsonb check (shipments is null or jsonb_typeof(shipments) = 'array'),
  packages jsonb check (packages is null or jsonb_typeof(packages) = 'array'),
  read_at timestamptz not null,
  job_id text check (length(job_id) between 1 and 100),
  recorded_at timestamptz not null default now(),
  unique (org_id, observation_key),
  foreign key (org_id, creator_record_id, asin)
    references public.creator_sample_shipments(org_id, creator_record_id, asin) on delete cascade,
  check ((outcome = 'found') = (mcf_status is not null)),
  check ((outcome = 'found') = (shipments is not null) and (outcome = 'found') = (packages is not null)),
  check (outcome = 'not_found' or operation = 'getFulfillmentOrder')
);
create index creator_mcf_observations_lane on public.creator_mcf_observations(org_id, derived_order_key, read_at desc);

-- Each read moves the lane's settlement in the same statement. mcf_not_found_probes is the
-- number of consecutive not-found reads in the current ambiguous episode: a found order or a
-- not-found read in any other lane state resets it, and the third one escalates. The
-- runner's lane state and lock are never touched: settling is not releasing.
create function app.creator_mcf_observation_settle() returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.outcome = 'found' then
    update public.creator_sample_shipments s set mcf_status = new.mcf_status, mcf_operation = 'getFulfillmentOrder',
        mcf_read_at = new.read_at, packages = new.packages, shipments = new.shipments, mcf_settlement = 'found',
        mcf_not_found_probes = 0, mcf_probed_at = new.read_at, updated_at = now()
      where s.org_id = new.org_id and s.creator_record_id = new.creator_record_id and s.asin = new.asin
        and (s.mcf_probed_at is null or s.mcf_probed_at <= new.read_at);
  else
    -- Only reads taken while the submit is ambiguous count toward escalation: a lane that
    -- sat in Verified for Submit before its submit starts its ambiguous episode at zero.
    update public.creator_sample_shipments s set mcf_not_found_probes = case when s.lane_state = 'Reconciliation Required'
          then s.mcf_not_found_probes + 1 else 0 end,
        mcf_settlement = case when s.lane_state = 'Reconciliation Required' and s.mcf_not_found_probes + 1 >= 3
          then 'escalated' else 'not_found' end,
        mcf_probed_at = new.read_at, updated_at = now()
      where s.org_id = new.org_id and s.creator_record_id = new.creator_record_id and s.asin = new.asin
        and (s.mcf_probed_at is null or s.mcf_probed_at <= new.read_at);
  end if;
  return null;
end;
$$;
revoke all on function app.creator_mcf_observation_settle() from public, anon, authenticated;
create trigger creator_mcf_observations_settle after insert on public.creator_mcf_observations
  for each row execute function app.creator_mcf_observation_settle();

create trigger creator_sample_preflights_immutable before update or delete on public.creator_sample_preflights
  for each row execute function app.creator_refuse_rewrite();
create trigger creator_mcf_observations_immutable before update or delete on public.creator_mcf_observations
  for each row execute function app.creator_refuse_rewrite();

-- The import may now read `preflight-results.json` (a proposed file the skill must produce).
alter table public.creator_import_runs drop constraint creator_import_runs_files_check;
alter table public.creator_import_runs add constraint creator_import_runs_files_check
  check (files <@ array['registry', 'queue', 'sweep_checkpoint', 'mcf_reservations', 'preflight_results']);
alter table public.creator_import_runs drop constraint creator_import_runs_failed_file_check;
alter table public.creator_import_runs add constraint creator_import_runs_failed_file_check
  check (failed_file in ('registry', 'queue', 'sweep_checkpoint', 'mcf_reservations', 'preflight_results'));

-- Owners, admins and analysts read; viewers do not. Owners and admins record a pre-flight
-- (the creator:write key acts as its issuer). Observations are written by the worker only.
alter table public.creator_sample_preflights enable row level security;
create policy tenant_read on public.creator_sample_preflights for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.creator_sample_preflights for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.creator_sample_preflights from anon, authenticated;
grant select, insert on public.creator_sample_preflights to authenticated;
grant all on public.creator_sample_preflights to service_role;

alter table public.creator_mcf_observations enable row level security;
create policy tenant_read on public.creator_mcf_observations for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
revoke all on public.creator_mcf_observations from anon, authenticated;
grant select on public.creator_mcf_observations to authenticated;
grant all on public.creator_mcf_observations to service_role;

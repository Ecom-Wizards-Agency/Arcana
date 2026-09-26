-- Creator Connections (WP-332): the control runner's registry, queue, sweep and sample
-- lanes, imported. Amazon has no Creator Connections API, and nothing here is an Amazon
-- write. A sample shipment is neither a Sponsored Products write-ledger row nor a
-- Creative. Fingerprints only: no column holds a name, address, email, phone or link.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table public.creator_records (
  org_id uuid not null references public.orgs(id) on delete cascade,
  creator_record_id text not null check (creator_record_id ~ '^CCR-[A-Z0-9]+-[0-9]{2}-[0-9]{4,}$'),
  brand text not null check (length(brand) <= 200),
  campaign_id text not null check (length(campaign_id) <= 200),
  storefront_fp text check (storefront_fp ~ '^[0-9a-f]{64}$'),
  thread_fp text check (thread_fp ~ '^[0-9a-f]{64}$'),
  full_name_fp text check (full_name_fp ~ '^[0-9a-f]{64}$'),
  email_fp text check (email_fp ~ '^[0-9a-f]{64}$'),
  phone_fp text check (phone_fp ~ '^[0-9a-f]{64}$'),
  address_fp text check (address_fp ~ '^[0-9a-f]{64}$'),
  record_state text not null check (length(record_state) between 1 and 40),
  lock_state text not null check (lock_state in ('Unlocked', 'Conflict', 'Locked for MCF')),
  escalation_reason text check (escalation_reason ~ '^[a-z0-9_]+$'),
  runner_version integer not null check (runner_version > 0),
  created_on date not null,
  last_verified_on date,
  -- From the newest queue run that named the record; null until one did.
  status text check (length(status) <= 120),
  computed_score smallint check (computed_score between 0 and 10),
  missing_checks text[] check (missing_checks <@ array['complete_fulfillment_details', 'requested_asin',
    'exact_product_match', 'storefront_visible', 'recent_post_verified', 'content_quality', 'category_fit',
    'performance_or_revenue', 'specific_asin_mentioned', 'low_spam_risk']),
  qualified_on date,
  source text not null check (source in ('control-runner', 'mcp', 'web')),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, creator_record_id),
  check ((computed_score is null) = (missing_checks is null) and (computed_score is null) = (qualified_on is null)
    and (computed_score is null) = (status is null)),
  check (computed_score is null or computed_score + cardinality(missing_checks) = 10)
);

-- Append-only. The event key is the idempotency identity a replay collides on.
create table public.creator_action_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  event_key text not null check (length(event_key) between 1 and 200),
  creator_record_id text not null,
  action text not null check (action in ('identity_conflict_locked', 'mcf_reserved', 'mcf_screen_verified',
    'mcf_reconciliation_required', 'sample_confirmed', 'mcf_reservation_cancelled')),
  occurred_at timestamptz,
  reservation_id text check (reservation_id ~ '^MCFR-([0-9A-Fa-f]{16}|LEGACY-[0-9A-F]{12})$'),
  asin text check (asin ~ '^[A-Z0-9]{10}$'),
  reason_code text check (reason_code ~ '^[a-z0-9_]+$'),
  evidence_reference text check (length(evidence_reference) between 1 and 500),
  record_version integer check (record_version > 0),
  source text not null check (source in ('control-runner', 'mcp', 'web')),
  recorded_at timestamptz not null default now(),
  unique (org_id, event_key),
  foreign key (org_id, creator_record_id) references public.creator_records(org_id, creator_record_id) on delete cascade
);
create index creator_action_log_record on public.creator_action_log(org_id, creator_record_id, recorded_at);

-- One row per runner queue item. A newer run for the same day replaces that day.
create table public.creator_daily_queue (
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_date date not null,
  queue_id text not null check (queue_id ~ '^[0-9]{8}-(CCR-[A-Z0-9]+-[0-9]{2}-[0-9]{4,}|UNRESOLVED)$'),
  occurrence integer not null check (occurrence > 0),
  creator_record_id text check (creator_record_id ~ '^CCR-[A-Z0-9]+-[0-9]{2}-[0-9]{4,}$'),
  brand text not null check (length(brand) <= 200),
  campaign_tab text not null check (length(campaign_tab) <= 200),
  current_status text not null check (length(current_status) <= 120),
  computed_score smallint not null check (computed_score between 0 and 10),
  missing_checks text[] not null check (missing_checks <@ array['complete_fulfillment_details', 'requested_asin',
    'exact_product_match', 'storefront_visible', 'recent_post_verified', 'content_quality', 'category_fit',
    'performance_or_revenue', 'specific_asin_mentioned', 'low_spam_risk']),
  due_date date not null,
  action_type text not null check (action_type in ('IDENTITY_RESOLUTION', 'BACKGROUND_CHECK',
    'SEND_TAILORED_VERIFICATION_FOLLOW_UP', 'ESCALATE_UNRESPONSIVE', 'RECONCILE_QUALIFICATION', 'MCF_PREFLIGHT',
    'RECONCILE_PRODUCT_SWITCH', 'ESCALATE_PRODUCT_SWITCH_UNRESPONSIVE', 'SEND_PRODUCT_SWITCH_FOLLOW_UP',
    'ESCALATE_CONTENT_UNRESPONSIVE', 'SEND_CONTENT_FOLLOW_UP')),
  gate_result text not null check (gate_result in ('BLOCKED', 'HOLD', 'PENDING_APPROVAL')),
  queue_state text not null check (queue_state in ('Queued', 'Escalated')),
  reason text not null check (length(reason) between 1 and 500),
  source text not null check (source in ('control-runner', 'mcp', 'web')),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, run_date, queue_id, occurrence),
  check (computed_score + cardinality(missing_checks) = 10),
  check ((creator_record_id is null) = (queue_id like '%-UNRESOLVED')),
  check (queue_id like to_char(run_date, 'YYYYMMDD') || '-%')
);
create index creator_daily_queue_latest on public.creator_daily_queue(org_id, run_date desc);

create table public.creator_sweep_runs (
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id text not null check (run_id ~ '^[A-Za-z0-9:_.-]{1,80}$'),
  run_date date not null,
  brand text check (length(brand) <= 200),
  started_at timestamptz,
  completed_at timestamptz not null,
  mounted integer not null check (mounted >= 0),
  opened integer not null check (opened >= 0),
  changed integer not null check (changed >= 0),
  messages_examined integer not null check (messages_examined >= 0),
  messages_sent integer not null check (messages_sent >= 0),
  no_action_acknowledgements integer not null check (no_action_acknowledgements >= 0),
  held_or_escalated integer not null check (held_or_escalated >= 0),
  archived_spam integer not null check (archived_spam >= 0 and archived_spam <= changed),
  unmatched integer not null check (unmatched >= 0),
  -- The skill's completion equation, computed here so no file can claim it.
  reconciled boolean generated always as (
    mounted = no_action_acknowledgements + changed + held_or_escalated + unmatched and unmatched = 0
  ) stored,
  outcomes jsonb check (outcomes is null or jsonb_typeof(outcomes) = 'object'),
  unresolved_threads jsonb not null default '[]'::jsonb check (jsonb_typeof(unresolved_threads) = 'array'),
  evidence_reference text check (length(evidence_reference) between 1 and 500),
  source text not null check (source in ('control-runner', 'mcp', 'web')),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, run_id),
  check (started_at is null or started_at <= completed_at)
);
create index creator_sweep_runs_latest on public.creator_sweep_runs(org_id, completed_at desc);

-- One sample lane per creator record and ASIN. The derived key has no clock, so a
-- second attempt for the same pair collides here instead of shipping twice.
create table public.creator_sample_shipments (
  org_id uuid not null references public.orgs(id) on delete cascade,
  creator_record_id text not null check (creator_record_id ~ '^CCR-[A-Z0-9]+-[0-9]{2}-[0-9]{4,}$'),
  asin text not null check (asin ~ '^[A-Z0-9]{10}$'),
  derived_order_key text not null generated always as (
    'CCS-' || left(encode(sha256((org_id::text || '|' || creator_record_id || '|' || asin)::bytea), 'hex'), 32)
  ) stored,
  sku text check (length(sku) between 1 and 50),
  campaign_id text check (length(campaign_id) between 1 and 200),
  reservation_id text check (reservation_id ~ '^MCFR-([0-9A-Fa-f]{16}|LEGACY-[0-9A-F]{12})$'),
  lane_state text not null check (lane_state in ('Reserved', 'Verified for Submit', 'Reconciliation Required',
    'Confirmed', 'Cancelled')),
  runner_order_id text check (length(runner_order_id) between 1 and 100),
  fee_cents integer check (fee_cents >= 0),
  fee_cap_cents integer check (fee_cap_cents >= 0),
  reserved_at timestamptz,
  verified_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text check (cancellation_reason in ('amazon_rejected', 'definitive_not_created',
    'expired_before_submit', 'inventory_unavailable_before_submit', 'operator_aborted_before_submit',
    'validation_failed_before_submit')),
  reconciliation_reason text check (reconciliation_reason in ('confirmation_missing', 'outcome_unknown', 'request_timeout')),
  -- Written only by an SP-API read (a later round). Null is "not read", never a status.
  mcf_status text check (mcf_status in ('New', 'Received', 'Planning', 'Processing', 'Cancelled', 'Complete',
    'CompletePartialled', 'Unfulfillable', 'Invalid')),
  mcf_operation text check (mcf_operation = 'getFulfillmentOrder'),
  mcf_read_at timestamptz,
  packages jsonb check (packages is null or jsonb_typeof(packages) = 'array'),
  source text not null check (source in ('control-runner', 'mcp', 'web')),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, creator_record_id, asin),
  unique (org_id, derived_order_key),
  check ((mcf_status is null) = (mcf_read_at is null) and (mcf_status is null) = (mcf_operation is null)),
  check (packages is null or mcf_status is not null),
  check (lane_state <> 'Confirmed' or (runner_order_id is not null and confirmed_at is not null)),
  check (lane_state <> 'Cancelled' or (cancellation_reason is not null and cancelled_at is not null)),
  check (lane_state <> 'Reconciliation Required' or reservation_id is not null)
);

-- Append-only. The latest row is what the screens call "the last read".
create table public.creator_import_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (status in ('succeeded', 'failed')),
  failure text check (failure in ('directory_unreadable', 'no_runner_files', 'file_unreadable',
    'file_shape_invalid', 'database_write_failed')),
  failed_file text check (failed_file in ('registry', 'queue', 'sweep_checkpoint', 'mcf_reservations')),
  files text[] not null check (files <@ array['registry', 'queue', 'sweep_checkpoint', 'mcf_reservations']),
  -- The run date of the queue file this import read, so a day worked to zero is still that day.
  queue_run_date date,
  counts jsonb not null check (jsonb_typeof(counts) = 'object'
    and counts ?& array['records', 'action_log', 'queue_items', 'sweep_runs', 'sample_shipments']),
  source text not null check (source in ('control-runner', 'mcp', 'web')),
  check ((status = 'failed') = (failure is not null)),
  check (failed_file is null or status = 'failed'),
  check (queue_run_date is null or (status = 'succeeded' and 'queue' = any(files))),
  check (finished_at >= started_at)
);
create index creator_import_runs_latest on public.creator_import_runs(org_id, finished_at desc);

create function app.creator_refuse_rewrite() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  -- Preserve the repository's guarded whole-organisation purge contract.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 and not exists(select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '23514';
end;
$$;
revoke all on function app.creator_refuse_rewrite() from public, anon, authenticated;
create trigger creator_action_log_immutable before update or delete on public.creator_action_log
  for each row execute function app.creator_refuse_rewrite();
create trigger creator_import_runs_immutable before update or delete on public.creator_import_runs
  for each row execute function app.creator_refuse_rewrite();

-- Owners, admins and analysts read; viewers do not. Owners and admins write; the two logs are insert-only.
alter table public.creator_records enable row level security;
create policy tenant_read on public.creator_records for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.creator_records for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_update on public.creator_records for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin'])) with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_delete on public.creator_records for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.creator_records from anon, authenticated;
grant select, insert, update, delete on public.creator_records to authenticated;
grant all on public.creator_records to service_role;

alter table public.creator_action_log enable row level security;
create policy tenant_read on public.creator_action_log for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.creator_action_log for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.creator_action_log from anon, authenticated;
grant select, insert on public.creator_action_log to authenticated;
grant all on public.creator_action_log to service_role;

alter table public.creator_daily_queue enable row level security;
create policy tenant_read on public.creator_daily_queue for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.creator_daily_queue for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_update on public.creator_daily_queue for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin'])) with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_delete on public.creator_daily_queue for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.creator_daily_queue from anon, authenticated;
grant select, insert, update, delete on public.creator_daily_queue to authenticated;
grant all on public.creator_daily_queue to service_role;

alter table public.creator_sweep_runs enable row level security;
create policy tenant_read on public.creator_sweep_runs for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.creator_sweep_runs for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_update on public.creator_sweep_runs for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin'])) with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_delete on public.creator_sweep_runs for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.creator_sweep_runs from anon, authenticated;
grant select, insert, update, delete on public.creator_sweep_runs to authenticated;
grant all on public.creator_sweep_runs to service_role;

alter table public.creator_sample_shipments enable row level security;
create policy tenant_read on public.creator_sample_shipments for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.creator_sample_shipments for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_update on public.creator_sample_shipments for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin'])) with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_delete on public.creator_sample_shipments for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.creator_sample_shipments from anon, authenticated;
grant select, insert, update, delete on public.creator_sample_shipments to authenticated;
grant all on public.creator_sample_shipments to service_role;

alter table public.creator_import_runs enable row level security;
create policy tenant_read on public.creator_import_runs for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.creator_import_runs for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.creator_import_runs from anon, authenticated;
grant select, insert on public.creator_import_runs to authenticated;
grant all on public.creator_import_runs to service_role;

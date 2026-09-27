-- Creator Connections round 3b (WP-338d): the database seam of Arcana's MCF sample sends.
--
-- The operator's browser seals a creator's address to a key only the MCF worker holds. This
-- migration stores that envelope for at most two hours in a table no client role can read,
-- records the worker's immutable, address-free Amazon preview, checks the press on
-- "Send N unit(s) via Amazon" against it, and reserves exactly one createFulfillmentOrder per
-- approval. Every Amazon call happens in the worker; nothing here calls Amazon.
--
-- Authority, in one place:
--   * app.creator_mcf_grants is the database gate (clause 2): an active grant per (org, SP-API
--     connection, marketplace) with its action classes, recipient key ids, daily unit cap, fee
--     cap and expiry. Immutable except revoked_at. Seeded by an operator from an untracked copy
--     of packages/db/src/testing/creator-mcf-grant-seed.TEMPLATE.sql. Revoking it stops seals,
--     approvals and reservations.
--   * app.creator_mcf_recipient_custody holds the ciphertext. Every privilege is revoked from
--     every client role; only the SECURITY DEFINER functions below reach it, and every
--     custody-ending transition deletes the row and writes a tombstone event in the same
--     transaction. Deferred constraint triggers refuse a commit that leaves a custody row
--     behind a custody-free send, or a custody-holding send without its row.
--   * Owners and admins seal, approve, withdraw, release and resolve through the authenticated
--     functions, which lock and recheck membership. The worker claims, reads custody, records
--     previews, reserves and records outcomes through service-role functions. No client role
--     holds insert, update or delete on any table here.
--   * A send's lane changes owner to 'arcana' at reservation; a trigger then refuses every
--     other writer's change to the lane's order columns, so the runner's file import and
--     creators.register_record skip it (and count it) instead of overwriting it.
--
-- No column in any table here holds a name, street, city, phone or email. The mask (country,
-- first two postal characters, line count) lives only on the mutable send row and is nulled 30
-- days after the send ends or delivery is observed. Append-only tables carry ids, states,
-- codes, counts and digests of ciphertext, never a mask or an address fingerprint.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- ---------------------------------------------------------------------------
-- Lane and action-log widening
-- ---------------------------------------------------------------------------

-- Who places the lane's order. Only the send ledger below ever writes 'arcana'.
alter table public.creator_sample_shipments
  add column order_owner text not null default 'runner' check (order_owner in ('runner', 'arcana'));
alter table public.creator_sample_shipments drop constraint creator_sample_shipments_cancellation_reason_check;
alter table public.creator_sample_shipments
  add constraint creator_sample_shipments_cancellation_reason_check check (cancellation_reason in ('amazon_rejected',
    'definitive_not_created', 'expired_before_submit', 'inventory_unavailable_before_submit', 'operator_aborted_before_submit',
    'validation_failed_before_submit', 'amazon_cancelled_after_submit', 'operator_cancelled_in_amazon')),
  -- The two reasons only an order Arcana placed can reach (the shared CreatorSampleShipment refine).
  add constraint creator_sample_shipments_arcana_reason check (order_owner = 'arcana' or cancellation_reason is null
    or cancellation_reason in ('amazon_rejected', 'definitive_not_created', 'expired_before_submit',
      'inventory_unavailable_before_submit', 'operator_aborted_before_submit', 'validation_failed_before_submit'));

alter table public.creator_action_log drop constraint creator_action_log_action_check;
alter table public.creator_action_log
  add constraint creator_action_log_action_check check (action in ('identity_conflict_locked', 'mcf_reserved',
    'mcf_screen_verified', 'mcf_reconciliation_required', 'sample_confirmed', 'mcf_reservation_cancelled',
    'identity_resolved', 'score_recorded', 'message_sent_by_hand', 'status_moved', 'content_verified', 'escalated',
    'preflight_recorded', 'draft_submitted', 'draft_approved', 'draft_sent_by_hand', 'draft_withdrawn',
    'mcf_send_approved', 'mcf_send_placed', 'mcf_send_failed', 'mcf_send_uncertain', 'mcf_send_cancelled'));
alter table public.creator_action_log drop constraint creator_action_log_source_check;
alter table public.creator_action_log
  add constraint creator_action_log_source_check check (source in ('control-runner', 'mcp', 'web', 'worker'));

-- ---------------------------------------------------------------------------
-- Pure helpers
-- ---------------------------------------------------------------------------

-- The shared transition map (packages/shared/src/creators/mcf-send.ts), as data. A database
-- test compares every pair with CREATOR_MCF_SEND_TRANSITIONS.
create function app.creator_mcf_next_states(p_state text) returns text[]
  language sql immutable parallel safe set search_path = pg_catalog as $$
  select case p_state
    when 'sealed' then array['previewing', 'withdrawn', 'expired']
    when 'previewing' then array['preview_ready', 'preview_refused', 'withdrawn', 'expired']
    when 'preview_ready' then array['approved', 'previewing', 'withdrawn', 'expired']
    when 'stale' then array['previewing', 'withdrawn', 'expired']
    when 'approved' then array['dispatching', 'stale', 'withdrawn', 'accepted', 'placed', 'conflict', 'failed_by_amazon',
      'expired_unclaimed', 'expired']
    when 'dispatching' then array['accepted', 'rejected', 'uncertain']
    when 'accepted' then array['placed', 'failed_by_amazon', 'conflict']
    when 'uncertain' then array['accepted', 'placed', 'failed_by_amazon', 'conflict', 'not_created']
    when 'conflict' then array['placed', 'cancel_requested', 'failed_by_amazon']
    when 'placed' then array['failed_after_placement', 'cancel_requested']
    when 'cancel_requested' then array['cancel_dispatching', 'placed']
    when 'cancel_dispatching' then array['cancelled', 'placed']
    else array[]::text[]
  end
$$;

-- Custody is held until the POST outcome; dispatching still holds it.
create function app.creator_mcf_custody_held(p_state text) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog as $$
  select p_state in ('sealed', 'previewing', 'preview_ready', 'stale', 'approved', 'dispatching')
$$;

create function app.creator_mcf_terminal(p_state text) returns boolean
  language sql immutable parallel safe set search_path = pg_catalog as $$
  select p_state in ('preview_refused', 'withdrawn', 'expired', 'expired_unclaimed', 'rejected', 'not_created',
    'failed_by_amazon', 'failed_after_placement', 'cancelled')
$$;

-- The Send button's exact text, the same rule as creatorMcfSendConfirmation. Null outside 1 to 20.
create function app.creator_mcf_send_confirmation(p_units integer) returns text
  language sql immutable parallel safe set search_path = pg_catalog as $$
  select case when p_units between 1 and 20
    then 'Send ' || p_units::text || case when p_units = 1 then ' unit' else ' units' end || ' via Amazon' end
$$;

-- RFC 4648 section 5, unpadded, canonical: null unless re-encoding gives the same text.
create function app.creator_mcf_b64url_decode(p_text text) returns bytea
  language plpgsql immutable set search_path = pg_catalog as $$
declare v_bytes bytea;
begin
  if p_text is null or p_text !~ '^[A-Za-z0-9_-]*$' or length(p_text) % 4 = 1 then return null; end if;
  v_bytes := decode(translate(p_text, '-_', '+/') || repeat('=', (4 - length(p_text) % 4) % 4), 'base64');
  if rtrim(translate(replace(encode(v_bytes, 'base64'), E'\n', ''), '+/', '-_'), '=') <> p_text then return null; end if;
  return v_bytes;
exception when others then
  return null;
end;
$$;

create function app.creator_mcf_b64url(p_bytes bytea) returns text
  language sql immutable parallel safe set search_path = pg_catalog as $$
  select rtrim(translate(replace(encode(p_bytes, 'base64'), E'\n', ''), '+/', '-_'), '=')
$$;

-- An object with exactly these keys (p_keys holds no duplicates).
create function app.creator_mcf_exact_keys(p_value jsonb, p_keys text[]) returns boolean
  language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_typeof(p_value) = 'object'
    and (select count(*) from jsonb_object_keys(p_value)) = cardinality(p_keys)
    and not exists (select 1 from jsonb_object_keys(p_value) k where not (k = any(p_keys))), false)
$$;

-- A JSON integer within bounds, written without a fraction or exponent.
create function app.creator_mcf_json_int(p_value jsonb, p_min numeric, p_max numeric) returns boolean
  language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(p_value) = 'number' and p_value::text ~ '^-?[0-9]{1,16}$'
    then p_value::text::numeric between p_min and p_max else false end
$$;

-- Provider codes are the only provider text kept (DESIGN 4.5): unique, allowlisted characters.
create function app.creator_mcf_codes_valid(p_codes text[]) returns boolean
  language sql immutable set search_path = pg_catalog as $$
  select p_codes is not null and cardinality(p_codes) <= 20
    and not exists (select 1 from unnest(p_codes) c where c is null or c !~ '^[A-Za-z0-9_.]{1,64}$')
    and (select count(distinct c) from unnest(p_codes) c) = cardinality(p_codes)
$$;

create function app.creator_mcf_digests_valid(p_digests jsonb) returns boolean
  language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_typeof(p_digests) = 'object'
    and not exists (select 1 from jsonb_each(p_digests) d where d.key not in ('ciphertextSha256', 'previewFingerprint', 'requestDigest')
      or jsonb_typeof(d.value) <> 'string' or d.value #>> '{}' !~ '^[0-9a-f]{64}$'), false)
$$;

create function app.creator_mcf_counts_valid(p_counts jsonb) returns boolean
  language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_typeof(p_counts) = 'object'
    and not exists (select 1 from jsonb_each(p_counts) c where c.key !~ '^[A-Za-z]{1,40}$'
      or not app.creator_mcf_json_int(c.value, -9007199254740991, 9007199254740991)), false)
$$;

-- connection uuid ':' marketplace id, no duplicates.
create function app.creator_mcf_scope_valid(p_scope text[]) returns boolean
  language sql immutable set search_path = pg_catalog as $$
  select p_scope is not null and cardinality(p_scope) <= 50
    and not exists (select 1 from unnest(p_scope) s
      where s is null or s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Z0-9]{9,16}$')
    and (select count(distinct s) from unnest(p_scope) s) = cardinality(p_scope)
$$;

create function app.creator_mcf_mask_valid(p_mask jsonb) returns boolean
  language sql immutable set search_path = pg_catalog as $$
  select coalesce(app.creator_mcf_exact_keys(p_mask, array['countryCode', 'postalPrefix', 'lines'])
    and jsonb_typeof(p_mask->'countryCode') = 'string' and p_mask->>'countryCode' ~ '^[A-Z]{2}$'
    and jsonb_typeof(p_mask->'postalPrefix') = 'string' and p_mask->>'postalPrefix' ~ '^[A-Z0-9][A-Z0-9 -]$'
    and app.creator_mcf_json_int(p_mask->'lines', 1, 3), false)
$$;

-- The strict CreatorMcfSealedRecipient shape, with the byte bounds the custody columns hold.
create function app.creator_mcf_envelope_valid(p_envelope jsonb) returns boolean
  language plpgsql immutable set search_path = pg_catalog as $$
declare v_enc bytea; v_ciphertext bytea;
begin
  if not app.creator_mcf_exact_keys(p_envelope, array['v', 'suite', 'envelopeId', 'keyId', 'enc', 'ciphertext', 'mask']) then
    return false;
  end if;
  if not app.creator_mcf_json_int(p_envelope->'v', 1, 1)
    or p_envelope->'suite' is distinct from to_jsonb('DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM'::text)
    or jsonb_typeof(p_envelope->'envelopeId') <> 'string'
    or p_envelope->>'envelopeId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_envelope->'keyId') <> 'string' or p_envelope->>'keyId' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_envelope->'enc') <> 'string' or jsonb_typeof(p_envelope->'ciphertext') <> 'string'
    or length(p_envelope->>'ciphertext') > 5462 or not app.creator_mcf_mask_valid(p_envelope->'mask') then
    return false;
  end if;
  v_enc := app.creator_mcf_b64url_decode(p_envelope->>'enc');
  v_ciphertext := app.creator_mcf_b64url_decode(p_envelope->>'ciphertext');
  return v_enc is not null and octet_length(v_enc) = 65 and get_byte(v_enc, 0) = 4
    and v_ciphertext is not null and octet_length(v_ciphertext) between 17 and 4096;
exception when others then
  return false;
end;
$$;

-- The settlement ladder (DESIGN 8, step 10): +1, +5, +15 and +60 minutes, then hourly to 24 hours,
-- then every 6 hours to 7 days. The next read after p_now; null once the ladder is over.
create function app.creator_mcf_next_settle_at(p_start timestamptz, p_now timestamptz) returns timestamptz
  language sql immutable parallel safe set search_path = pg_catalog as $$
  select min(p_start + step) from (
    select unnest(array[interval '1 minute', interval '5 minutes', interval '15 minutes']) as step
    union all select make_interval(hours => h) from generate_series(1, 24) h
    union all select make_interval(hours => 24 + 6 * k) from generate_series(1, 24) k
  ) ladder where p_start + step > p_now
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The database gate. One active grant per (org, connection, marketplace); only revoked_at changes.
create table app.creator_mcf_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  spapi_connection_id uuid not null references public.spapi_connections(id),
  marketplace_id text not null check (marketplace_id ~ '^[A-Z0-9]{9,16}$'),
  action_classes text[] not null check (cardinality(action_classes) between 1 and 2 and action_classes <@ array['send', 'cancel']),
  -- Hex SHA-256 of each recipient public key's SPKI DER; an envelope sealed to any other key is refused.
  recipient_key_ids text[] not null check (cardinality(recipient_key_ids) between 1 and 8
    and array_to_string(recipient_key_ids, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$'),
  max_units_per_day integer not null check (max_units_per_day between 1 and 20),
  max_fee_minor bigint not null check (max_fee_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- An operator label, never a person's contact data.
  enabled_by text not null check (enabled_by ~ '^[A-Za-z0-9 ._:-]{1,80}$'),
  enabled_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > enabled_at and expires_at <= enabled_at + interval '90 days'),
  check (revoked_at is null or revoked_at >= enabled_at)
);
create unique index creator_mcf_grants_one_active on app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id)
  where revoked_at is null;

-- What the MCF unit last reported: its scope (connection:marketplace pairs) and its two flags.
create table app.creator_mcf_worker_heartbeats (
  worker_id text primary key check (worker_id ~ '^[A-Za-z0-9._:-]{1,80}$'),
  scope text[] not null check (app.creator_mcf_scope_valid(scope)),
  preview_enabled boolean not null,
  dispatch_enabled boolean not null,
  worker_revision text not null check (worker_revision ~ '^[A-Za-z0-9._-]{1,64}$'),
  last_authorization_failure_at timestamptz,
  beat_at timestamptz not null default now()
);

-- One row per address entry. State, approval and dispatch; never an address.
create table public.creator_mcf_sends (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  creator_record_id text not null,
  asin text not null check (asin ~ '^[A-Z0-9]{10}$'),
  -- The lane's seller SKU at seal (printable ASCII, at most 40: the model's limit).
  sku text not null check (sku ~ '^[\x21-\x7e]([\x20-\x7e]{0,38}[\x21-\x7e])?$'),
  derived_order_key text not null generated always as (app.creator_sample_order_key(org_id, creator_record_id, asin)) stored,
  reservation_id text not null check (reservation_id ~ '^MCFR-([0-9A-F]{16}|LEGACY-[0-9A-F]{12})$'),
  preflight_id uuid not null references public.creator_sample_preflights(id),
  spapi_connection_id uuid not null references public.spapi_connections(id),
  marketplace_id text not null check (marketplace_id ~ '^[A-Z0-9]{9,16}$'),
  key_id text not null check (key_id ~ '^[0-9a-f]{64}$'),
  envelope_id uuid not null unique,
  -- SHA-256 of the envelope's ciphertext bytes (random per seal, so not an address fingerprint).
  ciphertext_sha256 text not null check (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  membership_created_at timestamptz not null,
  state text not null check (state in ('sealed', 'previewing', 'preview_ready', 'stale', 'approved', 'dispatching',
    'accepted', 'uncertain', 'conflict', 'placed', 'cancel_requested', 'cancel_dispatching', 'preview_refused', 'withdrawn',
    'expired', 'expired_unclaimed', 'rejected', 'not_created', 'failed_by_amazon', 'failed_after_placement', 'cancelled')),
  state_reason text check (state_reason ~ '^[a-z0-9_]{1,64}$'),
  state_changed_at timestamptz not null default now(),
  mask jsonb check (mask is null or app.creator_mcf_mask_valid(mask)),
  mask_purge_after timestamptz,
  escalated_at timestamptz,
  escalation_reason text check (escalation_reason in ('ladder_exhausted', 'conflict')),
  latest_preview_id uuid,
  approved_preview_id uuid,
  approved_by uuid,
  approved_membership_created_at timestamptz,
  approved_at timestamptz,
  confirmation_text text check (length(confirmation_text) between 1 and 40),
  approval_request_id uuid unique,
  -- The grant that authorized the press; reservation refuses under any other grant.
  approved_grant_id uuid,
  -- The units this approval holds against the grant's UTC daily cap.
  approved_units smallint check (approved_units between 1 and 20),
  claim_deadline timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  intent_reserved_at timestamptz,
  -- Digest of the address-free create request (the worker never digests the destination).
  request_digest text check (request_digest ~ '^[0-9a-f]{64}$'),
  posts smallint not null default 0 check (posts between 0 and 1),
  provider_outcome text check (provider_outcome in ('accepted', 'rejected', 'uncertain')),
  provider_reason text check (provider_reason in ('validation', 'authorization', 'throttled', 'other', 'transport',
    'http_5xx', 'http_408', 'decode', 'crash')),
  provider_status integer check (provider_status between 100 and 599),
  provider_codes text[] check (provider_codes is null or app.creator_mcf_codes_valid(provider_codes)),
  amazon_status text check (amazon_status in ('New', 'Received', 'Planning', 'Processing', 'Cancelled', 'Complete',
    'CompletePartialled', 'Unfulfillable', 'Invalid')),
  settle_reads integer not null default 0 check (settle_reads >= 0),
  accepted_at timestamptz,
  placed_at timestamptz,
  resolved_by uuid,
  resolved_membership_created_at timestamptz,
  resolved_at timestamptz,
  resolution_request_id uuid unique,
  custody_destroyed_at timestamptz,
  custody_destroyed_reason text check (custody_destroyed_reason in ('post_outcome', 'found_before_post', 'preview_refused',
    'withdrawn', 'superseded', 'ttl', 'authority_changed', 'grant_revoked', 'lane_changed', 'record_conflict', 'cap_exceeded',
    'unopenable', 'expired_unclaimed', 'lease_expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, creator_record_id, asin) references public.creator_sample_shipments(org_id, creator_record_id, asin),
  -- Custody is held exactly in the custody states; every other state names when and why it ended.
  check (app.creator_mcf_custody_held(state) = (custody_destroyed_at is null)),
  check ((custody_destroyed_at is null) = (custody_destroyed_reason is null)),
  check ((escalated_at is null) = (escalation_reason is null)),
  check ((approved_at is null) = (approved_by is null) and (approved_at is null) = (approved_preview_id is null)
    and (approved_at is null) = (approved_membership_created_at is null) and (approved_at is null) = (confirmation_text is null)
    and (approved_at is null) = (approval_request_id is null) and (approved_at is null) = (approved_units is null)
    and (approved_at is null) = (approved_grant_id is null)
    and (approved_at is null) = (claim_deadline is null)),
  check (claim_deadline is null or claim_deadline = approved_at + interval '15 minutes'),
  check (confirmation_text is null or confirmation_text = app.creator_mcf_send_confirmation(approved_units)),
  check (state not in ('approved', 'dispatching', 'accepted', 'uncertain', 'conflict', 'placed', 'cancel_requested',
    'cancel_dispatching', 'rejected', 'not_created', 'failed_by_amazon', 'failed_after_placement', 'cancelled', 'expired_unclaimed')
    or approved_at is not null),
  -- A reservation is the one permission to POST.
  check ((intent_reserved_at is null) = (posts = 0) and (intent_reserved_at is null) = (request_digest is null)),
  check (state not in ('dispatching', 'rejected', 'uncertain', 'not_created') or posts = 1),
  check (state <> 'dispatching' or (lease_id is not null and lease_until is not null)),
  check (state <> 'accepted' or accepted_at is not null),
  check (state <> 'placed' or placed_at is not null),
  check (provider_outcome is not null or (provider_status is null and provider_codes is null and provider_reason is null)),
  check ((resolved_at is null) = (resolved_by is null) and (resolved_at is null) = (resolution_request_id is null)
    and (resolved_at is null) = (resolved_membership_created_at is null))
);
-- One open or placed send per lane: a second press or a second tab cannot open another.
create unique index creator_mcf_sends_one_open on public.creator_mcf_sends(org_id, derived_order_key)
  where state in ('sealed', 'previewing', 'preview_ready', 'stale', 'approved', 'dispatching', 'accepted', 'uncertain',
    'conflict', 'placed', 'cancel_requested', 'cancel_dispatching');
create index creator_mcf_sends_lane on public.creator_mcf_sends(org_id, derived_order_key, created_at desc);
create index creator_mcf_sends_cap on public.creator_mcf_sends(org_id, spapi_connection_id, marketplace_id, approved_at)
  where approved_at is not null;
create index creator_mcf_sends_open_state on public.creator_mcf_sends(state)
  where state in ('sealed', 'previewing', 'preview_ready', 'stale', 'approved', 'dispatching', 'accepted', 'uncertain', 'conflict');
create index creator_mcf_sends_mask on public.creator_mcf_sends(mask_purge_after) where mask is not null;

-- The sealed envelope, at most two hours, reached only through the functions below.
create table app.creator_mcf_recipient_custody (
  envelope_id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  send_id uuid not null unique references public.creator_mcf_sends(id) on delete cascade,
  key_id text not null check (key_id ~ '^[0-9a-f]{64}$'),
  enc bytea not null check (octet_length(enc) = 65 and get_byte(enc, 0) = 4),
  ciphertext bytea not null check (octet_length(ciphertext) between 17 and 4096),
  ciphertext_sha256 text not null generated always as (encode(sha256(ciphertext), 'hex')) stored,
  created_by uuid not null,
  membership_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at and expires_at <= created_at + interval '2 hours')
);

-- The worker's Amazon previews: address-free, immutable. `body` is the shared CreatorMcfPreview.
create table public.creator_mcf_send_previews (
  id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  send_id uuid not null references public.creator_mcf_sends(id) on delete cascade,
  kind text not null check (kind in ('preview', 'dispatch_reread', 'cancel_preview')),
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  -- SHA-256 of the canonical JSON text the worker recorded; the approval must carry the same value.
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  total_units smallint not null check (total_units between 1 and 20),
  read_at timestamptz not null,
  valid_until timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (body->>'previewId' = id::text and body->>'sendId' = send_id::text and body->>'kind' = kind),
  check (valid_until > read_at and valid_until <= read_at + interval '30 minutes')
);
create index creator_mcf_send_previews_send on public.creator_mcf_send_previews(send_id, recorded_at desc);

-- Append-only audit: actor, states, codes, digests and counts. Never a mask.
create table public.creator_mcf_send_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  send_id uuid not null references public.creator_mcf_sends(id) on delete cascade,
  event text not null check (event in ('sealed', 'superseded', 'preview_claimed', 'custody_read', 'preview_recorded',
    'preview_refused', 'refresh_requested', 'approved', 'dispatch_claimed', 'dispatch_reread', 'stale', 'deferred', 'withdrawn',
    'reserved', 'reserve_refused', 'outcome_recorded', 'late_outcome', 'settlement_read', 'custody_destroyed', 'expired',
    'expired_unclaimed', 'crash_uncertain', 'conflict_resolved', 'ladder_exhausted', 'settle_read_requested', 'released',
    'failed_after_placement', 'mask_purged')),
  actor_type text not null check (actor_type in ('user', 'worker', 'system')),
  actor_id text check (actor_id ~ '^[A-Za-z0-9._:-]{1,80}$'),
  actor_membership_created_at timestamptz,
  before_state text,
  after_state text,
  reason text check (reason ~ '^[a-z0-9_]{1,64}$'),
  codes text[] not null default '{}' check (app.creator_mcf_codes_valid(codes)),
  -- Named hex digests only (ciphertext, preview fingerprint, request digest).
  digests jsonb not null default '{}' check (app.creator_mcf_digests_valid(digests)),
  counts jsonb not null default '{}' check (app.creator_mcf_counts_valid(counts)),
  http_status integer check (http_status between 100 and 599),
  at timestamptz not null default clock_timestamp(),
  check (actor_type <> 'user' or actor_membership_created_at is not null)
);
create index creator_mcf_send_events_send on public.creator_mcf_send_events(send_id, at);

-- Work for the MCF unit. Preview, dispatch and settle are outbox actions, not job types, so a
-- general worker cannot claim a send. No org_id: rows belong to a send and cascade with it.
create table public.creator_mcf_outbox (
  id uuid primary key default gen_random_uuid(),
  send_id uuid not null references public.creator_mcf_sends(id) on delete cascade,
  action text not null check (action in ('preview', 'dispatch', 'settle', 'cancel')),
  available_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  claimed_by text check (claimed_by ~ '^[A-Za-z0-9._:-]{1,80}$'),
  claimed_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((lease_id is null) = (lease_until is null))
);
create unique index creator_mcf_outbox_one_open on public.creator_mcf_outbox(send_id, action) where completed_at is null;
create index creator_mcf_outbox_due on public.creator_mcf_outbox(available_at) where completed_at is null;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- An Arcana-owned lane's order columns are the ledger's. The runner's import and MCP upsert skip
-- such lanes; this backs that up for any other writer. WP-334's observation columns stay writable.
-- The ledger exception is the transaction-local marker the functions below set around their lane
-- writes, honoured only when the statement runs as their owner: this function is deliberately not
-- SECURITY DEFINER, so current_user is the writer, and a client role that sets the marker is refused.
create function app.creator_mcf_lane_guard() returns trigger
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_ledger boolean := coalesce(current_setting('app.creator_mcf_ledger', true), '') = 'on'
  and current_user not in ('authenticated', 'anon', 'service_role');
begin
  if tg_op = 'DELETE' then
    if old.order_owner = 'arcana' then
      if pg_trigger_depth() > 1 and not exists (select 1 from public.orgs where id = old.org_id) then return old; end if;
      raise exception 'an Arcana-owned sample lane cannot be deleted' using errcode = '23514';
    end if;
    return old;
  end if;
  if v_ledger then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.order_owner <> 'runner' then
      raise exception 'order_owner is written by the MCF send ledger only' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.order_owner is distinct from old.order_owner then
    raise exception 'order_owner is written by the MCF send ledger only' using errcode = '23514';
  end if;
  if old.order_owner = 'arcana' and (new.lane_state, new.runner_order_id, new.sku, new.reservation_id, new.reserved_at,
      new.verified_at, new.confirmed_at, new.cancelled_at, new.cancellation_reason, new.reconciliation_reason)
    is distinct from (old.lane_state, old.runner_order_id, old.sku, old.reservation_id, old.reserved_at,
      old.verified_at, old.confirmed_at, old.cancelled_at, old.cancellation_reason, old.reconciliation_reason) then
    raise exception 'an Arcana-owned sample lane''s order columns are written by the MCF send ledger only' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger creator_sample_shipments_arcana_owner before insert or update or delete on public.creator_sample_shipments
  for each row execute function app.creator_mcf_lane_guard();

-- Grants are immutable except one revocation; a whole-org purge may delete them.
create function app.creator_mcf_grant_guard() returns trigger
  language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 and not exists (select 1 from public.orgs where id = old.org_id) then return old; end if;
    raise exception 'creator MCF grants are revoked, never deleted' using errcode = '23514';
  end if;
  if (new.id, new.org_id, new.spapi_connection_id, new.marketplace_id, new.action_classes, new.recipient_key_ids,
      new.max_units_per_day, new.max_fee_minor, new.currency, new.enabled_by, new.enabled_at, new.expires_at, new.created_at)
    is distinct from (old.id, old.org_id, old.spapi_connection_id, old.marketplace_id, old.action_classes, old.recipient_key_ids,
      old.max_units_per_day, old.max_fee_minor, old.currency, old.enabled_by, old.enabled_at, old.expires_at, old.created_at)
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'a creator MCF grant changes only by one revocation' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger creator_mcf_grants_immutable before update or delete on app.creator_mcf_grants
  for each row execute function app.creator_mcf_grant_guard();

create function app.creator_mcf_custody_guard() returns trigger
  language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'creator MCF custody rows are never rewritten' using errcode = '23514';
end;
$$;
create trigger creator_mcf_custody_immutable before update on app.creator_mcf_recipient_custody
  for each row execute function app.creator_mcf_custody_guard();

-- The shared transition map and the write-once fields, for every writer.
create function app.creator_mcf_send_guard() returns trigger
  language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 and not exists (select 1 from public.orgs where id = old.org_id) then return old; end if;
    raise exception 'creator MCF sends are never deleted' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'sealed' then
      raise exception 'a creator MCF send starts sealed' using errcode = '23514';
    end if;
    new.state_changed_at := now();
    return new;
  end if;
  if (new.id, new.org_id, new.creator_record_id, new.asin, new.sku, new.reservation_id, new.preflight_id, new.spapi_connection_id,
      new.marketplace_id, new.key_id, new.envelope_id, new.ciphertext_sha256, new.created_by, new.membership_created_at, new.created_at)
    is distinct from (old.id, old.org_id, old.creator_record_id, old.asin, old.sku, old.reservation_id, old.preflight_id,
      old.spapi_connection_id, old.marketplace_id, old.key_id, old.envelope_id, old.ciphertext_sha256, old.created_by,
      old.membership_created_at, old.created_at) then
    raise exception 'a creator MCF send''s identity is immutable' using errcode = '23514';
  end if;
  if new.state is distinct from old.state and not (new.state = any(app.creator_mcf_next_states(old.state))) then
    raise exception 'a creator MCF send cannot move from % to %', old.state, new.state using errcode = '55000';
  end if;
  if (new.approved_preview_id, new.approved_by, new.approved_membership_created_at, new.approved_at, new.confirmation_text,
      new.approval_request_id, new.approved_units, new.claim_deadline, new.approved_grant_id)
    is distinct from (old.approved_preview_id, old.approved_by, old.approved_membership_created_at, old.approved_at,
      old.confirmation_text, old.approval_request_id, old.approved_units, old.claim_deadline, old.approved_grant_id)
    and not (old.state = 'preview_ready' and new.state = 'approved') then
    raise exception 'a creator MCF approval is written only by the press' using errcode = '23514';
  end if;
  if (new.intent_reserved_at, new.request_digest, new.posts) is distinct from (old.intent_reserved_at, old.request_digest, old.posts)
    and not (old.state = 'approved' and new.state = 'dispatching' and old.posts = 0) then
    raise exception 'a creator MCF reservation is written only once, by the reservation' using errcode = '23514';
  end if;
  if (old.custody_destroyed_at is not null and (new.custody_destroyed_at, new.custody_destroyed_reason)
        is distinct from (old.custody_destroyed_at, old.custody_destroyed_reason))
    or (old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at)
    or (old.placed_at is not null and new.placed_at is distinct from old.placed_at)
    or (old.escalated_at is not null and (new.escalated_at, new.escalation_reason) is distinct from (old.escalated_at, old.escalation_reason))
    or (old.provider_outcome is not null and (new.provider_outcome, new.provider_reason, new.provider_status, new.provider_codes)
        is distinct from (old.provider_outcome, old.provider_reason, old.provider_status, old.provider_codes))
    or (old.resolved_at is not null and (new.resolved_at, new.resolved_by, new.resolved_membership_created_at, new.resolution_request_id)
        is distinct from (old.resolved_at, old.resolved_by, old.resolved_membership_created_at, old.resolution_request_id))
    or (new.mask is distinct from old.mask and new.mask is not null)
    or new.settle_reads < old.settle_reads then
    raise exception 'a creator MCF send''s recorded evidence is write-once' using errcode = '23514';
  end if;
  new.updated_at := now();
  if new.state is distinct from old.state then
    new.state_changed_at := now();
    if app.creator_mcf_terminal(new.state) then
      new.mask_purge_after := coalesce(new.mask_purge_after, now() + interval '30 days');
    end if;
  end if;
  return new;
end;
$$;
create trigger creator_mcf_sends_transition before insert or update or delete on public.creator_mcf_sends
  for each row execute function app.creator_mcf_send_guard();

-- At commit: custody is held exactly while the send is in a custody state. SECURITY DEFINER because a
-- deferred trigger fires as the committing session's role, not as the function that wrote the row.
create function app.creator_mcf_custody_invariant() returns trigger
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send uuid; v_state text;
begin
  if tg_table_name = 'creator_mcf_sends' then v_send := new.id;
  elsif tg_op = 'DELETE' then v_send := old.send_id;
  else v_send := new.send_id;
  end if;
  select state into v_state from public.creator_mcf_sends where id = v_send;
  if not found then return null; end if;
  if app.creator_mcf_custody_held(v_state)
      <> exists (select 1 from app.creator_mcf_recipient_custody where send_id = v_send) then
    raise exception 'creator MCF custody does not match the send state' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger creator_mcf_sends_custody_invariant after insert or update on public.creator_mcf_sends
  deferrable initially deferred for each row execute function app.creator_mcf_custody_invariant();
create constraint trigger creator_mcf_custody_invariant after insert or delete on app.creator_mcf_recipient_custody
  deferrable initially deferred for each row execute function app.creator_mcf_custody_invariant();

create trigger creator_mcf_send_previews_immutable before update or delete on public.creator_mcf_send_previews
  for each row execute function app.creator_refuse_rewrite();
create trigger creator_mcf_send_events_immutable before update or delete on public.creator_mcf_send_events
  for each row execute function app.creator_refuse_rewrite();

-- Deleting an organisation cascades through every table here, except while a send's Amazon
-- outcome is unknown (modelled on the org-delete guard of 20260901020000). Reservation holds a KEY
-- SHARE lock on the org row until it commits, so a purge cannot race a new reservation.
create function app.guard_org_delete_against_unresolved_mcf_send() returns trigger
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if exists (select 1 from public.creator_mcf_sends where org_id = old.id
      and state in ('dispatching', 'uncertain', 'cancel_dispatching')) then
    raise exception 'organisation has an MCF send whose Amazon outcome is unknown' using errcode = '55000';
  end if;
  return old;
end;
$$;
create trigger orgs_block_unresolved_mcf_send_purge before delete on public.orgs
  for each row execute function app.guard_org_delete_against_unresolved_mcf_send();

-- ---------------------------------------------------------------------------
-- Internal helpers (owner only; the SECURITY DEFINER functions below call them)
-- ---------------------------------------------------------------------------

create function app.creator_mcf_refusal(p_reason text) returns jsonb
  language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object('outcome', 'refused', 'reason', p_reason)
$$;

-- The SP-API bindings WP-334's observe job may use (listCreatorMcfObserveScopes), in SQL.
create function app.creator_mcf_usable_bindings(p_org uuid) returns table(connection_id uuid, marketplace_id text)
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select distinct b.connection_id, b.marketplace_id
    from public.spapi_profile_bindings b
    join public.ad_profiles p on p.id = b.profile_id and p.org_id = b.org_id
    join public.spapi_connections c on c.id = b.connection_id and c.org_id = b.org_id
   where b.org_id = p_org and b.enabled and p.sync_enabled and c.status = 'active' and c.vault_secret_id is not null
     and nullif(btrim(c.selling_partner_id), '') is not null and b.marketplace_id = any(c.marketplace_ids)
     and p.region = app.spapi_region_for_marketplace(b.marketplace_id)
$$;

create function app.creator_mcf_active_grant(p_org uuid, p_connection uuid, p_marketplace text) returns app.creator_mcf_grants
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select * from app.creator_mcf_grants where org_id = p_org and spapi_connection_id = p_connection
    and marketplace_id = p_marketplace and revoked_at is null and expires_at > now() and 'send' = any(action_classes)
$$;

-- Units held against the cap on the UTC day containing p_at. A unit is held from approval and
-- released only when the send ends without a POST; a posted send keeps it even when rejected.
create function app.creator_mcf_units_on(p_org uuid, p_connection uuid, p_marketplace text, p_at timestamptz) returns integer
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select coalesce(sum(approved_units), 0)::integer from public.creator_mcf_sends
   where org_id = p_org and spapi_connection_id = p_connection and marketplace_id = p_marketplace
     and approved_at >= (date_trunc('day', p_at at time zone 'UTC') at time zone 'UTC')
     and approved_at < (date_trunc('day', p_at at time zone 'UTC') at time zone 'UTC') + interval '1 day'
     and (state in ('approved', 'dispatching') or posts = 1)
$$;

create function app.creator_mcf_latest_preflight(p_org uuid, p_key text) returns public.creator_sample_preflights
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select * from public.creator_sample_preflights where org_id = p_org and derived_order_key = p_key and command = 'preflight'
   order by completed_at desc, recorded_at desc limit 1
$$;

-- The seal-time lane conditions that approve rechecks: null when they hold, else the refusal.
create function app.creator_mcf_lane_refusal(p_org uuid, p_record text, p_asin text, p_reservation text, p_sku text)
  returns text language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare v_lane public.creator_sample_shipments; v_lock text; v_import text; v_pre public.creator_sample_preflights;
begin
  select * into v_lane from public.creator_sample_shipments where org_id = p_org and creator_record_id = p_record and asin = p_asin;
  if not found then return 'lane_not_found'; end if;
  if v_lane.lane_state <> 'Reserved' or v_lane.reservation_id is null then return 'lane_not_reserved'; end if;
  if v_lane.order_owner <> 'runner' then return 'lane_not_runner'; end if;
  if p_reservation is not null and v_lane.reservation_id is distinct from p_reservation then return 'lane_changed'; end if;
  if v_lane.sku is null or v_lane.sku !~ '^[\x21-\x7e]([\x20-\x7e]{0,38}[\x21-\x7e])?$' then return 'lane_sku_invalid'; end if;
  if p_sku is not null and v_lane.sku is distinct from p_sku then return 'lane_changed'; end if;
  select lock_state into v_lock from public.creator_records where org_id = p_org and creator_record_id = p_record;
  if not found then return 'record_not_found'; end if;
  if v_lock = 'Conflict' then return 'record_conflict'; end if;
  select status into v_import from public.creator_import_runs where org_id = p_org order by finished_at desc, started_at desc limit 1;
  if v_import = 'failed' then return 'import_failed'; end if;
  v_pre := app.creator_mcf_latest_preflight(p_org, v_lane.derived_order_key);
  if v_pre.id is null then return 'preflight_missing'; end if;
  if v_pre.result <> 'PASS' then return 'preflight_hold'; end if;
  if v_pre.completed_at < now() - interval '24 hours' then return 'preflight_stale'; end if;
  if exists (select 1 from public.creator_sample_preflights h where h.org_id = p_org and h.derived_order_key = v_lane.derived_order_key
      and h.command = 'preflight' and h.result = 'HOLD' and (h.completed_at >= v_pre.completed_at or h.recorded_at >= v_pre.recorded_at)) then
    return 'preflight_hold';
  end if;
  if (v_pre.detail->>'sku') is not null and v_pre.detail->>'sku' <> v_lane.sku then return 'preflight_mismatch'; end if;
  if jsonb_typeof(v_pre.detail->'quantity') = 'number' and (v_pre.detail->>'quantity')::numeric <> 1 then return 'preflight_mismatch'; end if;
  return null;
end;
$$;

create function app.creator_mcf_event(p_send public.creator_mcf_sends, p_event text, p_actor_type text, p_actor_id text,
  p_before text, p_after text, p_reason text default null, p_codes text[] default '{}', p_digests jsonb default '{}',
  p_counts jsonb default '{}', p_http_status integer default null, p_membership timestamptz default null) returns void
  language sql set search_path = pg_catalog, pg_temp as $$
  insert into public.creator_mcf_send_events(org_id, send_id, event, actor_type, actor_id, actor_membership_created_at,
      before_state, after_state, reason, codes, digests, counts, http_status)
    values (p_send.org_id, p_send.id, p_event, p_actor_type, p_actor_id, p_membership, p_before, p_after, p_reason,
      coalesce(p_codes, '{}'), coalesce(p_digests, '{}'), coalesce(p_counts, '{}'), p_http_status)
$$;

-- Milestones in the record's action log. Worker-made rows carry source 'worker'.
create function app.creator_mcf_milestone(p_send public.creator_mcf_sends, p_action text, p_reason text, p_source text,
  p_actor uuid, p_suffix text) returns void
  language sql set search_path = pg_catalog, pg_temp as $$
  insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reservation_id, asin,
      reason_code, evidence_reference, source, actor_user_id)
    values (p_send.org_id, 'mcf-send:' || p_send.id::text || ':' || p_suffix, p_send.creator_record_id, p_action, now(),
      p_send.reservation_id, p_send.asin, p_reason, 'arcana:send:' || p_send.id::text, p_source, p_actor)
    on conflict (org_id, event_key) do nothing
$$;

-- The shared CreatorMcfProviderOutcome, checked in order: codes only, statuses matching reasons.
create function app.creator_mcf_outcome_valid(p_outcome jsonb) returns boolean
  language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v_status integer;
begin
  if jsonb_typeof(p_outcome) is distinct from 'object' then return false; end if;
  if p_outcome->>'outcome' = 'accepted' then
    return app.creator_mcf_exact_keys(p_outcome, array['outcome', 'status']) and app.creator_mcf_json_int(p_outcome->'status', 200, 200);
  end if;
  if p_outcome->>'outcome' = 'rejected' then
    if not app.creator_mcf_exact_keys(p_outcome, array['outcome', 'status', 'codes', 'reason'])
      or not app.creator_mcf_json_int(p_outcome->'status', 400, 499) or jsonb_typeof(p_outcome->'codes') <> 'array'
      or exists (select 1 from jsonb_array_elements(p_outcome->'codes') c where jsonb_typeof(c) <> 'string')
      or not app.creator_mcf_codes_valid(array(select jsonb_array_elements_text(p_outcome->'codes')))
      or p_outcome->>'reason' is null or p_outcome->>'reason' not in ('validation', 'authorization', 'throttled', 'other') then
      return false;
    end if;
    v_status := (p_outcome->>'status')::integer;
    return v_status <> 408 and (p_outcome->>'reason' = 'throttled') = (v_status = 429)
      and (p_outcome->>'reason' = 'authorization') = (v_status in (401, 403));
  end if;
  if p_outcome->>'outcome' = 'uncertain' then
    if not app.creator_mcf_exact_keys(p_outcome, array['outcome', 'cause', 'status']) or p_outcome->>'cause' is null
      or p_outcome->>'cause' not in ('transport', 'http_5xx', 'http_408', 'decode', 'crash') then
      return false;
    end if;
    if jsonb_typeof(p_outcome->'status') = 'null' then
      return p_outcome->>'cause' in ('transport', 'crash', 'decode');
    end if;
    if not app.creator_mcf_json_int(p_outcome->'status', 100, 599) then return false; end if;
    v_status := (p_outcome->>'status')::integer;
    return case p_outcome->>'cause' when 'http_5xx' then v_status >= 500 when 'http_408' then v_status = 408
      when 'decode' then true else false end;
  end if;
  return false;
exception when others then
  return false;
end;
$$;

-- One state move: the map check, the custody deletion and its tombstone when custody ends, the
-- event, and closing outbox work that no longer applies. The caller holds the lane and send locks.
create function app.creator_mcf_move(p_send uuid, p_to text, p_event text, p_reason text, p_actor_type text, p_actor_id text,
  p_custody_reason text default null, p_codes text[] default '{}', p_counts jsonb default '{}', p_http_status integer default null,
  p_membership timestamptz default null) returns public.creator_mcf_sends
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_old public.creator_mcf_sends; v_new public.creator_mcf_sends; v_custody_sha text; v_ends boolean;
begin
  select * into strict v_old from public.creator_mcf_sends where id = p_send;
  if not (p_to = any(app.creator_mcf_next_states(v_old.state))) then
    raise exception 'a creator MCF send cannot move from % to %', v_old.state, p_to using errcode = '55000';
  end if;
  v_ends := app.creator_mcf_custody_held(v_old.state) and not app.creator_mcf_custody_held(p_to);
  if v_ends then
    if p_custody_reason is null then
      raise exception 'a custody-ending move names its reason' using errcode = '22023';
    end if;
    delete from app.creator_mcf_recipient_custody where send_id = p_send returning ciphertext_sha256 into v_custody_sha;
    if v_custody_sha is distinct from v_old.ciphertext_sha256 then
      raise exception 'creator MCF custody does not match its send' using errcode = '23514';
    end if;
    perform app.creator_mcf_event(v_old, 'custody_destroyed', p_actor_type, p_actor_id, v_old.state, p_to, p_custody_reason,
      '{}', jsonb_build_object('ciphertextSha256', v_old.ciphertext_sha256), '{}', null, p_membership);
  end if;
  update public.creator_mcf_sends set state = p_to, state_reason = p_reason,
      custody_destroyed_at = case when v_ends then now() else custody_destroyed_at end,
      custody_destroyed_reason = case when v_ends then p_custody_reason else custody_destroyed_reason end,
      accepted_at = case when p_to = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
      placed_at = case when p_to = 'placed' then coalesce(placed_at, now()) else placed_at end,
      escalated_at = case when p_to = 'conflict' then coalesce(escalated_at, now()) else escalated_at end,
      escalation_reason = case when p_to = 'conflict' then coalesce(escalation_reason, 'conflict') else escalation_reason end,
      lease_id = case when v_old.state = 'approved' and p_to <> 'dispatching' then null else lease_id end,
      lease_until = case when p_to = 'dispatching' then lease_until else null end
    where id = p_send returning * into v_new;
  perform app.creator_mcf_event(v_new, p_event, p_actor_type, p_actor_id, v_old.state, p_to, p_reason, p_codes, '{}', p_counts,
    p_http_status, p_membership);
  update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
    where send_id = p_send and completed_at is null
      and ((action = 'preview' and p_to not in ('sealed', 'previewing'))
        or (action = 'dispatch' and p_to not in ('approved', 'dispatching'))
        or (action = 'settle' and p_to not in ('accepted', 'uncertain', 'conflict')));
  return v_new;
end;
$$;

-- What a send does to its lane (DESIGN 6.2), under the ledger marker.
create function app.creator_mcf_lane_effect(p_send public.creator_mcf_sends, p_effect text, p_reconciliation text default null)
  returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  perform set_config('app.creator_mcf_ledger', 'on', true);
  if p_effect = 'reserved' then
    update public.creator_sample_shipments set lane_state = 'Verified for Submit', order_owner = 'arcana', verified_at = now(),
        reconciliation_reason = null, mcf_not_found_probes = 0,
        mcf_settlement = case when mcf_settlement = 'escalated' then 'not_found' else mcf_settlement end, updated_at = now()
      where org_id = p_send.org_id and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  elsif p_effect in ('accepted', 'conflict') then
    update public.creator_sample_shipments set lane_state = 'Verified for Submit', order_owner = 'arcana',
        verified_at = coalesce(verified_at, now()), reconciliation_reason = null, updated_at = now()
      where org_id = p_send.org_id and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  elsif p_effect = 'placed' then
    update public.creator_sample_shipments set lane_state = 'Confirmed', order_owner = 'arcana',
        runner_order_id = p_send.derived_order_key, confirmed_at = now(), verified_at = coalesce(verified_at, now()),
        reconciliation_reason = null, updated_at = now()
      where org_id = p_send.org_id and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  elsif p_effect = 'uncertain' then
    update public.creator_sample_shipments set lane_state = 'Reconciliation Required', order_owner = 'arcana',
        reconciliation_reason = p_reconciliation, updated_at = now()
      where org_id = p_send.org_id and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  elsif p_effect = 'released' then
    update public.creator_sample_shipments set lane_state = 'Reserved', order_owner = 'runner', verified_at = null,
        reconciliation_reason = null, updated_at = now()
      where org_id = p_send.org_id and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  elsif p_effect = 'failed_by_amazon' then
    update public.creator_sample_shipments set lane_state = 'Cancelled', order_owner = 'arcana', cancellation_reason = 'amazon_rejected',
        cancelled_at = now(), reconciliation_reason = null, updated_at = now()
      where org_id = p_send.org_id and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  elsif p_effect = 'failed_after_placement' then
    update public.creator_sample_shipments set lane_state = 'Cancelled', order_owner = 'arcana',
        cancellation_reason = 'amazon_cancelled_after_submit', cancelled_at = now(), reconciliation_reason = null, updated_at = now()
      where org_id = p_send.org_id and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  else
    raise exception 'unknown lane effect %', p_effect using errcode = '22023';
  end if;
  if not found then
    raise exception 'the send''s sample lane is missing' using errcode = '23503';
  end if;
  perform set_config('app.creator_mcf_ledger', '', true);
end;
$$;

-- One open settle row per send, due at p_at; null closes it.
create function app.creator_mcf_schedule_settle(p_send uuid, p_at timestamptz) returns void
  language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if p_at is null then
    update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
      where send_id = p_send and action = 'settle' and completed_at is null;
    return;
  end if;
  update public.creator_mcf_outbox set available_at = p_at, lease_id = null, lease_until = null
    where send_id = p_send and action = 'settle' and completed_at is null;
  if not found then
    insert into public.creator_mcf_outbox(send_id, action, available_at) values (p_send, 'settle', p_at);
  end if;
end;
$$;

create function app.creator_mcf_ladder_start(p_send public.creator_mcf_sends) returns timestamptz
  language sql immutable set search_path = pg_catalog as $$
  select coalesce(p_send.intent_reserved_at, p_send.accepted_at, p_send.state_changed_at)
$$;

-- One Amazon read of the send's order key, in the shape the worker's reader returns once every
-- recipient field is dropped: getOrder found or not found, or a complete order list without the key.
create function app.creator_mcf_lookup_valid(p_send public.creator_mcf_sends, p_lookup jsonb) returns boolean
  language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare v_read_at timestamptz; v_found boolean; v_item jsonb; v_shipment jsonb; v_package jsonb;
begin
  if jsonb_typeof(p_lookup) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(p_lookup) k where k not in ('outcome', 'operation', 'status', 'items', 'shipments',
      'packages', 'readAt', 'sellerFulfillmentOrderId'))
    or p_lookup->>'outcome' is null or p_lookup->>'outcome' not in ('found', 'not_found')
    or p_lookup->>'operation' is null or p_lookup->>'operation' not in ('getFulfillmentOrder', 'listAllFulfillmentOrders')
    or jsonb_typeof(p_lookup->'readAt') is distinct from 'string' then
    return false;
  end if;
  v_read_at := (p_lookup->>'readAt')::timestamptz;
  if v_read_at > now() + interval '1 minute' or v_read_at < now() - interval '1 hour' then return false; end if;
  -- Once a POST may have happened, only a read taken after the reservation says anything about it.
  if p_send.intent_reserved_at is not null and v_read_at <= p_send.intent_reserved_at then return false; end if;
  if p_lookup ? 'sellerFulfillmentOrderId' and p_lookup->'sellerFulfillmentOrderId' is distinct from to_jsonb(p_send.derived_order_key) then
    return false;
  end if;
  v_found := p_lookup->>'outcome' = 'found';
  if not v_found then
    return not (p_lookup ? 'items' or p_lookup ? 'shipments' or p_lookup ? 'packages')
      and coalesce(jsonb_typeof(p_lookup->'status'), 'null') = 'null';
  end if;
  if p_lookup->>'operation' <> 'getFulfillmentOrder' or jsonb_typeof(p_lookup->'status') is distinct from 'string'
    or p_lookup->>'status' not in ('New', 'Received', 'Planning', 'Processing', 'Cancelled', 'Complete', 'CompletePartialled',
      'Unfulfillable', 'Invalid')
    or jsonb_typeof(p_lookup->'items') is distinct from 'array' or jsonb_array_length(p_lookup->'items') not between 1 and 20
    or jsonb_typeof(p_lookup->'shipments') is distinct from 'array' or jsonb_typeof(p_lookup->'packages') is distinct from 'array' then
    return false;
  end if;
  for v_item in select value from jsonb_array_elements(p_lookup->'items') loop
    if jsonb_typeof(v_item) <> 'object'
      or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('sellerSku', 'quantity', 'cancelledQuantity', 'unfulfillableQuantity'))
      or jsonb_typeof(v_item->'sellerSku') is distinct from 'string' or not app.creator_mcf_json_int(v_item->'quantity', 0, 100000) then
      return false;
    end if;
  end loop;
  -- Sanitized shipment and package shapes only (FulfillmentShipmentObservation, CreatorSamplePackage).
  for v_shipment in select value from jsonb_array_elements(p_lookup->'shipments') loop
    if jsonb_typeof(v_shipment) <> 'object'
      or exists (select 1 from jsonb_object_keys(v_shipment) k where k not in ('amazonShipmentId', 'status', 'shippedAt',
        'estimatedArrivalAt', 'packages'))
      or jsonb_typeof(v_shipment->'packages') is distinct from 'array' then
      return false;
    end if;
    for v_package in select value from jsonb_array_elements(v_shipment->'packages') loop
      if jsonb_typeof(v_package) <> 'object' or exists (select 1 from jsonb_object_keys(v_package) k
          where k not in ('packageNumber', 'carrierCode', 'trackingNumber', 'estimatedArrivalAt')) then
        return false;
      end if;
    end loop;
  end loop;
  for v_package in select value from jsonb_array_elements(p_lookup->'packages') loop
    if jsonb_typeof(v_package) <> 'object' or exists (select 1 from jsonb_object_keys(v_package) k
        where k not in ('packageNumber', 'carrierCode', 'trackingNumber', 'estimatedArrivalAt', 'carrierStatus', 'carrierStatusReadAt')) then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

-- Appends one validated read to WP-334's observation table (key mcf-send:{sendId}:{n}); WP-334's
-- trigger moves the lane's settlement in the same statement.
create function app.creator_mcf_observe(p_send public.creator_mcf_sends, p_lookup jsonb) returns jsonb
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_found boolean; v_status text; v_n integer; v_key text; v_read_at timestamptz;
begin
  if not app.creator_mcf_lookup_valid(p_send, p_lookup) then
    raise exception 'Invalid creator MCF order read' using errcode = '22023';
  end if;
  v_found := p_lookup->>'outcome' = 'found';
  v_status := case when v_found then p_lookup->>'status' end;
  v_read_at := (p_lookup->>'readAt')::timestamptz;
  update public.creator_mcf_sends set settle_reads = settle_reads + 1, amazon_status = coalesce(v_status, amazon_status)
    where id = p_send.id returning settle_reads into v_n;
  v_key := 'mcf-send:' || p_send.id::text || ':' || v_n::text;
  insert into public.creator_mcf_observations(org_id, observation_key, creator_record_id, asin, queried_order_id, operation,
      outcome, mcf_status, shipments, packages, read_at, job_id)
    values (p_send.org_id, v_key, p_send.creator_record_id, p_send.asin, p_send.derived_order_key, p_lookup->>'operation',
      p_lookup->>'outcome', v_status, case when v_found then p_lookup->'shipments' end,
      case when v_found then p_lookup->'packages' end, v_read_at, null);
  return jsonb_build_object('observationKey', v_key, 'found', v_found, 'status', v_status, 'readAt', v_read_at);
end;
$$;

-- What a found order means for this send: the target state and any item mismatch codes.
create function app.creator_mcf_classify(p_send public.creator_mcf_sends, p_lookup jsonb) returns jsonb
  language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v_status text := p_lookup->>'status'; v_codes text[] := '{}'; v_item jsonb;
begin
  if jsonb_array_length(p_lookup->'items') <> 1 then
    v_codes := v_codes || 'item_count_mismatch'::text;
  else
    v_item := p_lookup->'items'->0;
    if v_item->>'sellerSku' is distinct from p_send.sku then v_codes := v_codes || 'item_sku_mismatch'::text; end if;
    if (v_item->>'quantity')::integer is distinct from p_send.approved_units::integer then v_codes := v_codes || 'item_quantity_mismatch'::text; end if;
  end if;
  return jsonb_build_object('to', case
      when v_status in ('Invalid', 'Unfulfillable', 'Cancelled') then 'failed_by_amazon'
      when cardinality(v_codes) > 0 then 'conflict'
      when v_status = 'New' then 'accepted'
      else 'placed' end,
    'codes', to_jsonb(v_codes));
end;
$$;

-- Moves a send by one found read, with the lane effect and milestone; returns the new state.
create function app.creator_mcf_apply_found(p_send uuid, p_lookup jsonb, p_actor_type text, p_actor_id text) returns text
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_class jsonb; v_to text; v_codes text[];
begin
  select * into strict v_send from public.creator_mcf_sends where id = p_send;
  v_class := app.creator_mcf_classify(v_send, p_lookup);
  v_to := v_class->>'to';
  v_codes := array(select jsonb_array_elements_text(v_class->'codes'));
  -- A conflict leaves only by an operator's "Record as sent" (or cancel) or a failed read, never by a
  -- read alone; New stays accepted.
  if v_to = v_send.state or not (v_to = any(app.creator_mcf_next_states(v_send.state)))
    or (v_send.state = 'conflict' and v_to = 'placed') then
    perform app.creator_mcf_event(v_send, 'settlement_read', p_actor_type, p_actor_id, v_send.state, v_send.state,
      lower(p_lookup->>'status'), v_codes);
    return v_send.state;
  end if;
  v_send := app.creator_mcf_move(p_send, v_to, 'settlement_read', lower(p_lookup->>'status'), p_actor_type, p_actor_id,
    case when v_send.state = 'approved' then 'found_before_post' end, v_codes);
  if v_to = 'placed' then
    perform app.creator_mcf_lane_effect(v_send, 'placed');
    perform app.creator_mcf_milestone(v_send, 'mcf_send_placed', null, 'worker', null, 'placed');
  elsif v_to = 'failed_by_amazon' then
    perform app.creator_mcf_lane_effect(v_send, 'failed_by_amazon');
    perform app.creator_mcf_milestone(v_send, 'mcf_send_failed', 'failed_by_amazon', 'worker', null, 'failed');
  else
    perform app.creator_mcf_lane_effect(v_send, v_to);
  end if;
  return v_to;
end;
$$;

-- The expiry sweep: three rules and nothing else (DESIGN 4.4).
--   1. sealed, previewing, preview_ready, stale or approved past its custody expiry: expired(ttl).
--   2. approved past its claim deadline: expired_unclaimed.
--   3. dispatching past its lease: uncertain(crash), the lane Reconciliation Required. The POST may
--      have reached Amazon, so the sweep never moves a dispatching send to expired.
-- Rows another transaction holds are skipped; that transaction rechecks them itself.
create function app.creator_mcf_sweep(p_org uuid) returns jsonb
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_row record; v_send public.creator_mcf_sends; v_crash integer := 0; v_unclaimed integer := 0; v_ttl integer := 0;
begin
  for v_row in select id, org_id, creator_record_id, asin from public.creator_mcf_sends
      where state = 'dispatching' and lease_until < now() and (p_org is null or org_id = p_org) order by id loop
    perform 1 from public.creator_sample_shipments where org_id = v_row.org_id and creator_record_id = v_row.creator_record_id
      and asin = v_row.asin for update skip locked;
    if not found then continue; end if;
    select * into v_send from public.creator_mcf_sends where id = v_row.id for update skip locked;
    if not found or v_send.state <> 'dispatching' or not (v_send.lease_until < now()) then continue; end if;
    v_send := app.creator_mcf_move(v_send.id, 'uncertain', 'crash_uncertain', 'crash', 'system', null, 'lease_expired');
    perform app.creator_mcf_lane_effect(v_send, 'uncertain', 'outcome_unknown');
    perform app.creator_mcf_milestone(v_send, 'mcf_send_uncertain', 'crash', 'worker', null, 'uncertain');
    perform app.creator_mcf_schedule_settle(v_send.id, now() + interval '1 minute');
    v_crash := v_crash + 1;
  end loop;
  for v_row in select id, org_id, creator_record_id, asin from public.creator_mcf_sends
      where state = 'approved' and claim_deadline < now() and (p_org is null or org_id = p_org) order by id loop
    perform 1 from public.creator_sample_shipments where org_id = v_row.org_id and creator_record_id = v_row.creator_record_id
      and asin = v_row.asin for update skip locked;
    if not found then continue; end if;
    select * into v_send from public.creator_mcf_sends where id = v_row.id for update skip locked;
    if not found or v_send.state <> 'approved' or not (v_send.claim_deadline < now()) then continue; end if;
    perform app.creator_mcf_move(v_send.id, 'expired_unclaimed', 'expired_unclaimed', 'claim_deadline', 'system', null, 'expired_unclaimed');
    v_unclaimed := v_unclaimed + 1;
  end loop;
  for v_row in select s.id, s.org_id, s.creator_record_id, s.asin from public.creator_mcf_sends s
      join app.creator_mcf_recipient_custody c on c.send_id = s.id
      where s.state in ('sealed', 'previewing', 'preview_ready', 'stale', 'approved') and c.expires_at <= now()
        and (p_org is null or s.org_id = p_org) order by s.id loop
    perform 1 from public.creator_sample_shipments where org_id = v_row.org_id and creator_record_id = v_row.creator_record_id
      and asin = v_row.asin for update skip locked;
    if not found then continue; end if;
    select * into v_send from public.creator_mcf_sends where id = v_row.id for update skip locked;
    if not found or v_send.state not in ('sealed', 'previewing', 'preview_ready', 'stale', 'approved') then continue; end if;
    if not exists (select 1 from app.creator_mcf_recipient_custody where send_id = v_send.id and expires_at <= now()) then continue; end if;
    perform app.creator_mcf_move(v_send.id, 'expired', 'expired', 'ttl', 'system', null, 'ttl');
    v_ttl := v_ttl + 1;
  end loop;
  return jsonb_build_object('expiredTtl', v_ttl, 'expiredUnclaimed', v_unclaimed, 'uncertainCrash', v_crash);
end;
$$;

-- (live custody rows past expiry, live custody rows whose send no longer holds custody). Both 0.
create function app.creator_mcf_residue(p_org uuid) returns jsonb
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'expiredLive', (select count(*)::integer from app.creator_mcf_recipient_custody c
      join public.creator_mcf_sends s on s.id = c.send_id
      where c.expires_at <= now() and not (s.state = 'dispatching' and s.lease_until > now()) and (p_org is null or c.org_id = p_org)),
    'custodyFreeLive', (select count(*)::integer from app.creator_mcf_recipient_custody c
      join public.creator_mcf_sends s on s.id = c.send_id
      where not app.creator_mcf_custody_held(s.state) and (p_org is null or c.org_id = p_org)))
$$;

-- When every package of every live shipment on the lane read DELIVERED; null otherwise.
create function app.creator_mcf_lane_delivered_at(p_lane public.creator_sample_shipments) returns timestamptz
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select case when p_lane.mcf_status in ('Complete', 'CompletePartialled') and jsonb_typeof(p_lane.shipments) = 'array'
      and exists (select 1 from jsonb_array_elements(p_lane.shipments) sh, jsonb_array_elements(sh->'packages') sp
        where sh->>'status' not in ('CANCELLED_BY_FULFILLER', 'CANCELLED_BY_SELLER'))
      and not exists (select 1 from jsonb_array_elements(p_lane.shipments) sh, jsonb_array_elements(sh->'packages') sp
        where sh->>'status' not in ('CANCELLED_BY_FULFILLER', 'CANCELLED_BY_SELLER')
          and not exists (select 1 from jsonb_array_elements(coalesce(p_lane.packages, '[]'::jsonb)) p
            where (p->>'packageNumber')::bigint = (sp->>'packageNumber')::bigint and p->>'carrierStatus' = 'DELIVERED'))
    then coalesce((select max((p->>'carrierStatusReadAt')::timestamptz) from jsonb_array_elements(p_lane.packages) p
      where p->>'carrierStatus' = 'DELIVERED'), p_lane.mcf_read_at) end
$$;

-- Validates a worker preview body against its send, lane, pre-flight and grant; raises on any mismatch.
-- Checks run in order, so no cast is reached before its shape is known.
create function app.creator_mcf_preview_problem(p_send public.creator_mcf_sends, p_body jsonb, p_kind text) returns text
  language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare v_pre public.creator_sample_preflights; v_lane public.creator_sample_shipments; v_grant app.creator_mcf_grants;
  v_read timestamptz; v_until timestamptz; v_fees jsonb := p_body->'fees'; v_item jsonb; v_part jsonb; v_sum numeric := 0;
begin
  select * into strict v_pre from public.creator_sample_preflights where id = p_send.preflight_id;
  select * into strict v_lane from public.creator_sample_shipments where org_id = p_send.org_id
    and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  v_grant := app.creator_mcf_active_grant(p_send.org_id, p_send.spapi_connection_id, p_send.marketplace_id);
  if not app.creator_mcf_exact_keys(p_body, array['previewId', 'sendId', 'derivedOrderKey', 'reservationId', 'spapiConnectionId',
      'marketplaceId', 'readAt', 'validUntil', 'workerRevision', 'kind', 'preflightRunId', 'preflightCompletedAt', 'asin', 'items',
      'totalUnits', 'shippingSpeedCategory', 'fulfillmentAction', 'fulfillmentPolicy', 'featureConstraints', 'existingOrder',
      'isFulfillable', 'fees', 'unfulfillableReasons', 'earliestArrivalDate', 'latestArrivalDate', 'laneFeeCapMinor',
      'grantFeeCapMinor', 'grantCurrency', 'envelopeSha256', 'keyId', 'irreversibility']) then
    return 'preview_shape';
  end if;
  if p_body->>'kind' is distinct from p_kind or jsonb_typeof(p_body->'previewId') <> 'string'
    or p_body->>'previewId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_body->'workerRevision') <> 'string' or p_body->>'workerRevision' !~ '^[A-Za-z0-9._-]{1,64}$' then
    return 'preview_shape';
  end if;
  if p_body->'sendId' is distinct from to_jsonb(p_send.id::text) or p_body->'derivedOrderKey' is distinct from to_jsonb(p_send.derived_order_key)
    or p_body->'reservationId' is distinct from to_jsonb(p_send.reservation_id)
    or p_body->'spapiConnectionId' is distinct from to_jsonb(p_send.spapi_connection_id::text)
    or p_body->'marketplaceId' is distinct from to_jsonb(p_send.marketplace_id) or p_body->'asin' is distinct from to_jsonb(p_send.asin)
    or p_body->'envelopeSha256' is distinct from to_jsonb(p_send.ciphertext_sha256) or p_body->'keyId' is distinct from to_jsonb(p_send.key_id)
    or p_body->'preflightRunId' is distinct from to_jsonb(v_pre.run_id) then
    return 'preview_identity';
  end if;
  if jsonb_typeof(p_body->'readAt') <> 'string' or jsonb_typeof(p_body->'validUntil') <> 'string'
    or jsonb_typeof(p_body->'preflightCompletedAt') <> 'string' then
    return 'preview_timing';
  end if;
  begin
    v_read := (p_body->>'readAt')::timestamptz;
    v_until := (p_body->>'validUntil')::timestamptz;
    -- The worker carries the pre-flight time as an ISO string with milliseconds.
    if date_trunc('milliseconds', (p_body->>'preflightCompletedAt')::timestamptz)
        is distinct from date_trunc('milliseconds', v_pre.completed_at) then
      return 'preview_identity';
    end if;
  exception when others then
    return 'preview_timing';
  end;
  if not (v_until > v_read and v_until <= v_read + interval '30 minutes')
    or v_read > now() + interval '1 minute' or v_read < now() - interval '5 minutes' then
    return 'preview_timing';
  end if;
  if not app.creator_mcf_json_int(p_body->'totalUnits', 1, 20) or jsonb_typeof(p_body->'items') <> 'array'
    or jsonb_array_length(p_body->'items') <> 1 then
    return 'preview_items';
  end if;
  v_item := p_body->'items'->0;
  if not app.creator_mcf_exact_keys(v_item, array['sellerSku', 'sellerFulfillmentOrderItemId', 'quantity'])
    or v_item->'sellerSku' is distinct from to_jsonb(p_send.sku)
    or v_item->'sellerFulfillmentOrderItemId' is distinct from to_jsonb(p_send.derived_order_key || '-1')
    or v_item->'quantity' is distinct from p_body->'totalUnits' then
    return 'preview_items';
  end if;
  if p_body->'shippingSpeedCategory' is distinct from '"Standard"'::jsonb or p_body->'fulfillmentAction' is distinct from '"Ship"'::jsonb
    or p_body->'fulfillmentPolicy' is distinct from '"FillOrKill"'::jsonb or p_body->'featureConstraints' is distinct from '[]'::jsonb
    or p_body->'existingOrder' is distinct from '"none"'::jsonb
    or p_body->'irreversibility' is distinct from
      to_jsonb('Arcana cannot delete an Amazon order. It can ask Amazon to cancel only while the order is Received or Planning.'::text) then
    return 'preview_settings';
  end if;
  if jsonb_typeof(p_body->'isFulfillable') <> 'boolean' or jsonb_typeof(p_body->'unfulfillableReasons') <> 'array'
    or exists (select 1 from jsonb_array_elements(p_body->'unfulfillableReasons') r where jsonb_typeof(r) <> 'string')
    or not app.creator_mcf_codes_valid(array(select jsonb_array_elements_text(p_body->'unfulfillableReasons'))) then
    return 'preview_answer';
  end if;
  if jsonb_typeof(v_fees) <> 'null' then
    if not app.creator_mcf_exact_keys(v_fees, array['parts', 'totalMinor', 'currency']) or jsonb_typeof(v_fees->'parts') <> 'array'
      or jsonb_array_length(v_fees->'parts') not between 1 and 20 or not app.creator_mcf_json_int(v_fees->'totalMinor', 0, 9007199254740991)
      or jsonb_typeof(v_fees->'currency') <> 'string' or v_fees->>'currency' !~ '^[A-Z]{3}$' then
      return 'preview_answer';
    end if;
    for v_part in select value from jsonb_array_elements(v_fees->'parts') loop
      if not app.creator_mcf_exact_keys(v_part, array['feeName', 'amountMinor']) or jsonb_typeof(v_part->'feeName') <> 'string'
        or v_part->>'feeName' !~ '^[A-Za-z0-9_.]{1,64}$' or not app.creator_mcf_json_int(v_part->'amountMinor', 0, 9007199254740991) then
        return 'preview_answer';
      end if;
      v_sum := v_sum + (v_part->>'amountMinor')::numeric;
    end loop;
    if v_sum <> (v_fees->>'totalMinor')::numeric then return 'preview_answer'; end if;
  end if;
  if (p_body->'isFulfillable')::boolean and (jsonb_typeof(v_fees) = 'null' or jsonb_array_length(p_body->'unfulfillableReasons') > 0) then
    return 'preview_answer';
  end if;
  if not (jsonb_typeof(p_body->'earliestArrivalDate') = 'null' or (jsonb_typeof(p_body->'earliestArrivalDate') = 'string'
        and p_body->>'earliestArrivalDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
    or not (jsonb_typeof(p_body->'latestArrivalDate') = 'null' or (jsonb_typeof(p_body->'latestArrivalDate') = 'string'
        and p_body->>'latestArrivalDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')) then
    return 'preview_answer';
  end if;
  begin
    if (p_body->>'earliestArrivalDate')::date > (p_body->>'latestArrivalDate')::date then return 'preview_answer'; end if;
  exception when others then
    return 'preview_answer';
  end;
  -- The caps the preview shows are the current ones.
  if p_body->'laneFeeCapMinor' is distinct from coalesce(to_jsonb(v_lane.fee_cap_cents), 'null'::jsonb)
    or p_body->'grantFeeCapMinor' is distinct from coalesce(to_jsonb(v_grant.max_fee_minor), 'null'::jsonb)
    or p_body->'grantCurrency' is distinct from coalesce(to_jsonb(v_grant.currency), 'null'::jsonb) then
    return 'preview_caps';
  end if;
  return null;
end;
$$;

-- Why a checked preview cannot be sent, as codes; empty when it can.
create function app.creator_mcf_unsendable(p_send public.creator_mcf_sends, p_body jsonb) returns text[]
  language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare v_codes text[] := '{}'; v_lane_cap integer; v_grant app.creator_mcf_grants; v_total numeric;
begin
  select fee_cap_cents into v_lane_cap from public.creator_sample_shipments where org_id = p_send.org_id
    and creator_record_id = p_send.creator_record_id and asin = p_send.asin;
  v_grant := app.creator_mcf_active_grant(p_send.org_id, p_send.spapi_connection_id, p_send.marketplace_id);
  if not (p_body->'isFulfillable')::boolean then
    v_codes := v_codes || 'not_fulfillable'::text || array(select jsonb_array_elements_text(p_body->'unfulfillableReasons'));
  end if;
  if jsonb_typeof(p_body->'fees') = 'null' then
    v_codes := v_codes || 'fee_missing'::text;
  else
    v_total := (p_body->'fees'->>'totalMinor')::numeric;
    if v_grant.id is null then v_codes := v_codes || 'grant_inactive'::text;
    elsif p_body->'fees'->>'currency' <> v_grant.currency then v_codes := v_codes || 'currency_mismatch'::text;
    elsif v_total > v_grant.max_fee_minor then v_codes := v_codes || 'fee_over_grant_cap'::text;
    end if;
    if v_lane_cap is null then v_codes := v_codes || 'lane_cap_missing'::text;
    elsif v_total > v_lane_cap then v_codes := v_codes || 'fee_over_lane_cap'::text;
    end if;
  end if;
  return array(select c from (select distinct c from unnest(v_codes) c) d order by c collate "C");
end;
$$;

-- Owner or admin, locked for this transaction; returns the membership's creation time.
create function app.creator_mcf_manager(p_org uuid) returns timestamptz
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_created timestamptz;
begin
  perform app.lock_org_manager(p_org);
  select created_at into strict v_created from public.org_members where org_id = p_org and user_id = auth.uid();
  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authenticated functions (owner or admin; the gate and lane reads also analyst)
-- ---------------------------------------------------------------------------

-- The browser's CreatorMcfSealRequest {binding, envelope}. The binding must equal the lane byte for
-- byte before anything is stored. Idempotent on envelopeId; supersedes an earlier send still
-- sealed, previewing, preview_ready or stale.
create function app.seal_creator_mcf_recipient(p_org uuid, p_record text, p_asin text, p_request jsonb) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_binding jsonb; v_env jsonb; v_ciphertext bytea; v_digest text; v_refusal text;
  v_lane public.creator_sample_shipments; v_existing public.creator_mcf_sends; v_pre public.creator_sample_preflights;
  v_connections integer; v_connection uuid; v_grants integer; v_grant app.creator_mcf_grants; v_open public.creator_mcf_sends;
  v_send public.creator_mcf_sends;
begin
  v_member := app.creator_mcf_manager(p_org);
  perform app.creator_mcf_sweep(p_org);
  if p_request is null or not app.creator_mcf_exact_keys(p_request, array['binding', 'envelope'])
    or not app.creator_mcf_envelope_valid(p_request->'envelope') then
    return app.creator_mcf_refusal('envelope_invalid');
  end if;
  v_binding := p_request->'binding';
  v_env := p_request->'envelope';
  if not app.creator_mcf_exact_keys(v_binding, array['orgId', 'creatorRecordId', 'asin', 'derivedOrderKey', 'reservationId'])
    or exists (select 1 from jsonb_each(v_binding) b where jsonb_typeof(b.value) <> 'string') then
    return app.creator_mcf_refusal('binding_invalid');
  end if;
  v_ciphertext := app.creator_mcf_b64url_decode(v_env->>'ciphertext');
  v_digest := encode(sha256(v_ciphertext), 'hex');
  select * into v_existing from public.creator_mcf_sends where envelope_id = (v_env->>'envelopeId')::uuid;
  if found then
    if v_existing.org_id = p_org and v_existing.creator_record_id = p_record and v_existing.asin = p_asin
      and v_existing.ciphertext_sha256 = v_digest and v_existing.key_id = v_env->>'keyId' and v_existing.created_by = auth.uid() then
      return jsonb_build_object('outcome', 'sealed', 'replay', true, 'sendId', v_existing.id, 'state', v_existing.state);
    end if;
    return app.creator_mcf_refusal('envelope_reused');
  end if;
  if v_binding->>'orgId' is distinct from p_org::text or v_binding->>'creatorRecordId' is distinct from p_record
    or v_binding->>'asin' is distinct from p_asin then
    return app.creator_mcf_refusal('binding_mismatch');
  end if;
  select * into v_lane from public.creator_sample_shipments where org_id = p_org and creator_record_id = p_record and asin = p_asin
    for update;
  if not found then return app.creator_mcf_refusal('lane_not_found'); end if;
  -- A concurrent replay of the same envelope may have committed while this call waited for the lane.
  select * into v_existing from public.creator_mcf_sends where envelope_id = (v_env->>'envelopeId')::uuid;
  if found then
    if v_existing.org_id = p_org and v_existing.creator_record_id = p_record and v_existing.asin = p_asin
      and v_existing.ciphertext_sha256 = v_digest and v_existing.key_id = v_env->>'keyId' and v_existing.created_by = auth.uid() then
      return jsonb_build_object('outcome', 'sealed', 'replay', true, 'sendId', v_existing.id, 'state', v_existing.state);
    end if;
    return app.creator_mcf_refusal('envelope_reused');
  end if;
  if v_lane.lane_state <> 'Reserved' or v_lane.reservation_id is null then return app.creator_mcf_refusal('lane_not_reserved'); end if;
  if v_lane.order_owner <> 'runner' then return app.creator_mcf_refusal('lane_not_runner'); end if;
  if v_binding->>'derivedOrderKey' is distinct from v_lane.derived_order_key
    or v_binding->>'reservationId' is distinct from v_lane.reservation_id then
    return app.creator_mcf_refusal('binding_mismatch');
  end if;
  v_refusal := app.creator_mcf_lane_refusal(p_org, p_record, p_asin, v_lane.reservation_id, null);
  if v_refusal is not null then return app.creator_mcf_refusal(v_refusal); end if;
  v_pre := app.creator_mcf_latest_preflight(p_org, v_lane.derived_order_key);
  select count(distinct connection_id)::integer, min(connection_id::text)::uuid into v_connections, v_connection
    from app.creator_mcf_usable_bindings(p_org);
  if v_connections <> 1 then return app.creator_mcf_refusal('spapi_connection_count'); end if;
  select count(*)::integer into v_grants from app.creator_mcf_grants g
    where g.org_id = p_org and g.spapi_connection_id = v_connection and g.revoked_at is null and g.expires_at > now()
      and 'send' = any(g.action_classes)
      and g.marketplace_id in (select u.marketplace_id from app.creator_mcf_usable_bindings(p_org) u where u.connection_id = v_connection);
  if v_grants = 0 then return app.creator_mcf_refusal('grant_inactive'); end if;
  if v_grants > 1 then return app.creator_mcf_refusal('grant_ambiguous'); end if;
  select g.* into v_grant from app.creator_mcf_grants g
    where g.org_id = p_org and g.spapi_connection_id = v_connection and g.revoked_at is null and g.expires_at > now()
      and 'send' = any(g.action_classes)
      and g.marketplace_id in (select u.marketplace_id from app.creator_mcf_usable_bindings(p_org) u where u.connection_id = v_connection);
  if not (v_env->>'keyId' = any(v_grant.recipient_key_ids)) then return app.creator_mcf_refusal('key_unknown'); end if;
  for v_open in select * from public.creator_mcf_sends where org_id = p_org and derived_order_key = v_lane.derived_order_key
      and not app.creator_mcf_terminal(state) for update loop
    if v_open.state not in ('sealed', 'previewing', 'preview_ready', 'stale') then
      return app.creator_mcf_refusal('send_open');
    end if;
    perform app.creator_mcf_move(v_open.id, 'withdrawn', 'superseded', 'superseded', 'user', auth.uid()::text, 'superseded',
      '{}', '{}', null, v_member);
  end loop;
  insert into public.creator_mcf_sends(org_id, creator_record_id, asin, sku, reservation_id, preflight_id, spapi_connection_id,
      marketplace_id, key_id, envelope_id, ciphertext_sha256, created_by, membership_created_at, state, mask)
    values (p_org, p_record, p_asin, v_lane.sku, v_lane.reservation_id, v_pre.id, v_connection, v_grant.marketplace_id,
      v_env->>'keyId', (v_env->>'envelopeId')::uuid, v_digest, auth.uid(), v_member, 'sealed', v_env->'mask')
    returning * into v_send;
  insert into app.creator_mcf_recipient_custody(envelope_id, org_id, send_id, key_id, enc, ciphertext, created_by,
      membership_created_at, expires_at)
    values (v_send.envelope_id, p_org, v_send.id, v_send.key_id, app.creator_mcf_b64url_decode(v_env->>'enc'), v_ciphertext,
      auth.uid(), v_member, now() + interval '2 hours');
  insert into public.creator_mcf_outbox(send_id, action) values (v_send.id, 'preview');
  perform app.creator_mcf_event(v_send, 'sealed', 'user', auth.uid()::text, null, 'sealed', null, '{}',
    jsonb_build_object('ciphertextSha256', v_digest), jsonb_build_object('ciphertextBytes', octet_length(v_ciphertext)), null, v_member);
  return jsonb_build_object('outcome', 'sealed', 'replay', false, 'sendId', v_send.id, 'state', 'sealed',
    'custodyExpiresAt', now() + interval '2 hours');
end;
$$;

-- "Preview again": from preview_ready or stale while custody is held.
create function app.refresh_creator_mcf_preview(p_org uuid, p_send uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends; v_refusal text;
begin
  v_member := app.creator_mcf_manager(p_org);
  perform app.creator_mcf_sweep(p_org);
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.state not in ('preview_ready', 'stale') then return app.creator_mcf_refusal('send_not_refreshable'); end if;
  if not exists (select 1 from app.creator_mcf_recipient_custody where send_id = p_send and expires_at > now()) then
    return app.creator_mcf_refusal('custody_expired');
  end if;
  v_refusal := app.creator_mcf_lane_refusal(p_org, v_send.creator_record_id, v_send.asin, v_send.reservation_id, v_send.sku);
  if v_refusal is not null then return app.creator_mcf_refusal(v_refusal); end if;
  perform app.creator_mcf_move(p_send, 'previewing', 'refresh_requested', null, 'user', auth.uid()::text, null, '{}', '{}', null, v_member);
  insert into public.creator_mcf_outbox(send_id, action) values (p_send, 'preview');
  return jsonb_build_object('outcome', 'previewing', 'sendId', p_send, 'state', 'previewing');
end;
$$;

-- The press on "Send N unit(s) via Amazon". The wording is recomputed here from the preview's unit
-- count; the preview must be the latest, unexpired and carry the fingerprint the browser showed.
-- The grant row is locked while the UTC day's units are counted. Idempotent on p_request.
create function app.approve_creator_mcf_send(p_org uuid, p_send uuid, p_preview uuid, p_fingerprint text, p_confirmation text,
  p_request uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends; v_preview public.creator_mcf_send_previews; v_refusal text;
  v_grant app.creator_mcf_grants; v_lane_cap integer; v_used integer; v_total numeric;
begin
  v_member := app.creator_mcf_manager(p_org);
  perform app.creator_mcf_sweep(p_org);
  if p_send is null or p_preview is null or p_request is null or p_fingerprint is null or p_confirmation is null then
    raise exception 'Invalid creator MCF approval' using errcode = '22023';
  end if;
  select * into v_send from public.creator_mcf_sends where approval_request_id = p_request;
  if found then
    if v_send.org_id = p_org and v_send.id = p_send and v_send.approved_preview_id = p_preview and v_send.approved_by = auth.uid()
      and v_send.confirmation_text = p_confirmation
      and exists (select 1 from public.creator_mcf_send_previews where id = p_preview and fingerprint = p_fingerprint) then
      return jsonb_build_object('outcome', 'approved', 'replay', true, 'sendId', v_send.id, 'state', v_send.state,
        'claimDeadline', v_send.claim_deadline, 'units', v_send.approved_units);
    end if;
    return app.creator_mcf_refusal('request_reused');
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  -- A concurrent replay of the same press may have committed while this call waited for the lane.
  if v_send.approval_request_id = p_request and v_send.approved_by = auth.uid() and v_send.approved_preview_id = p_preview
    and v_send.confirmation_text = p_confirmation
    and exists (select 1 from public.creator_mcf_send_previews where id = p_preview and fingerprint = p_fingerprint) then
    return jsonb_build_object('outcome', 'approved', 'replay', true, 'sendId', v_send.id, 'state', v_send.state,
      'claimDeadline', v_send.claim_deadline, 'units', v_send.approved_units);
  end if;
  if v_send.state <> 'preview_ready' then return app.creator_mcf_refusal('send_not_ready'); end if;
  if not exists (select 1 from app.creator_mcf_recipient_custody where send_id = p_send and expires_at > now()) then
    return app.creator_mcf_refusal('custody_expired');
  end if;
  select * into v_preview from public.creator_mcf_send_previews where id = p_preview and send_id = p_send and kind = 'preview';
  if not found or v_send.latest_preview_id is distinct from p_preview then return app.creator_mcf_refusal('preview_not_latest'); end if;
  if v_preview.fingerprint <> p_fingerprint then return app.creator_mcf_refusal('fingerprint_mismatch'); end if;
  if not (now() < v_preview.valid_until and now() < v_preview.read_at + interval '30 minutes') then
    return app.creator_mcf_refusal('preview_expired');
  end if;
  if p_confirmation is distinct from app.creator_mcf_send_confirmation(v_preview.total_units) then
    return app.creator_mcf_refusal('confirmation_mismatch');
  end if;
  if exists (select 1 from public.creator_mcf_sends where org_id = p_org and derived_order_key = v_send.derived_order_key
      and id <> p_send and not app.creator_mcf_terminal(state)) then
    return app.creator_mcf_refusal('send_open');
  end if;
  v_refusal := app.creator_mcf_lane_refusal(p_org, v_send.creator_record_id, v_send.asin, v_send.reservation_id, v_send.sku);
  if v_refusal is not null then return app.creator_mcf_refusal(v_refusal); end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-mcf-cap:' || p_org::text || ':' || v_send.spapi_connection_id::text
    || ':' || v_send.marketplace_id, 0));
  select * into v_grant from app.creator_mcf_grants where org_id = p_org and spapi_connection_id = v_send.spapi_connection_id
    and marketplace_id = v_send.marketplace_id and revoked_at is null and expires_at > now() and 'send' = any(action_classes)
    for update;
  if not found then return app.creator_mcf_refusal('grant_inactive'); end if;
  if not (v_send.key_id = any(v_grant.recipient_key_ids)) then return app.creator_mcf_refusal('key_unknown'); end if;
  select fee_cap_cents into v_lane_cap from public.creator_sample_shipments where org_id = p_org
    and creator_record_id = v_send.creator_record_id and asin = v_send.asin;
  v_total := (v_preview.body->'fees'->>'totalMinor')::numeric;
  if not coalesce((v_preview.body->'isFulfillable')::boolean, false) or v_total is null
    or v_preview.body->'fees'->>'currency' is distinct from v_grant.currency or v_total > v_grant.max_fee_minor
    or v_lane_cap is null or v_total > v_lane_cap then
    return app.creator_mcf_refusal('preview_not_sendable');
  end if;
  v_used := app.creator_mcf_units_on(p_org, v_send.spapi_connection_id, v_send.marketplace_id, now());
  if v_used + v_preview.total_units > v_grant.max_units_per_day then return app.creator_mcf_refusal('daily_cap_reached'); end if;
  update public.creator_mcf_sends set state = 'approved', state_reason = null, approved_preview_id = p_preview,
      approved_by = auth.uid(), approved_membership_created_at = v_member, approved_at = now(), confirmation_text = p_confirmation,
      approval_request_id = p_request, approved_units = v_preview.total_units, claim_deadline = now() + interval '15 minutes',
      approved_grant_id = v_grant.id,
      lease_id = null, lease_until = null
    where id = p_send returning * into v_send;
  insert into public.creator_mcf_outbox(send_id, action) values (p_send, 'dispatch');
  perform app.creator_mcf_event(v_send, 'approved', 'user', auth.uid()::text, 'preview_ready', 'approved', null, '{}',
    jsonb_build_object('previewFingerprint', p_fingerprint),
    jsonb_build_object('units', v_preview.total_units, 'unitsToday', v_used + v_preview.total_units,
      'maxUnitsPerDay', v_grant.max_units_per_day), null, v_member);
  perform app.creator_mcf_milestone(v_send, 'mcf_send_approved', null, 'web', auth.uid(), 'approved:' || p_request::text);
  return jsonb_build_object('outcome', 'approved', 'replay', false, 'sendId', p_send, 'state', 'approved',
    'claimDeadline', v_send.claim_deadline, 'units', v_preview.total_units);
end;
$$;

-- "Withdraw": any custody-held state before dispatching. Destroys custody.
create function app.withdraw_creator_mcf_send(p_org uuid, p_send uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends;
begin
  v_member := app.creator_mcf_manager(p_org);
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.state = 'withdrawn' then
    return jsonb_build_object('outcome', 'withdrawn', 'replay', true, 'sendId', p_send, 'state', 'withdrawn');
  end if;
  if v_send.state not in ('sealed', 'previewing', 'preview_ready', 'stale', 'approved') then
    return app.creator_mcf_refusal('send_not_withdrawable');
  end if;
  perform app.creator_mcf_move(p_send, 'withdrawn', 'withdrawn', 'operator', 'user', auth.uid()::text, 'withdrawn', '{}', '{}', null, v_member);
  return jsonb_build_object('outcome', 'withdrawn', 'replay', false, 'sendId', p_send, 'state', 'withdrawn');
end;
$$;

-- "Ask Amazon for this order id": a settle read now, for an accepted, uncertain or conflict send.
create function app.request_creator_mcf_settle_read(p_org uuid, p_send uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends;
begin
  v_member := app.creator_mcf_manager(p_org);
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.state not in ('accepted', 'uncertain', 'conflict') then return app.creator_mcf_refusal('send_not_settleable'); end if;
  perform app.creator_mcf_schedule_settle(p_send, now());
  perform app.creator_mcf_event(v_send, 'settle_read_requested', 'user', auth.uid()::text, v_send.state, v_send.state,
    null, '{}', '{}', '{}', null, v_member);
  return jsonb_build_object('outcome', 'requested', 'sendId', p_send, 'state', v_send.state);
end;
$$;

-- "Release as not created": from uncertain only, when Amazon has answered not found at least three
-- times after the reservation, over at least 30 minutes, including one complete order list read
-- without the key, and no read after the reservation found it. Reads before the reservation never count.
create function app.release_creator_mcf_send(p_org uuid, p_send uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends; v_evidence record;
begin
  v_member := app.creator_mcf_manager(p_org);
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.state <> 'uncertain' then return app.creator_mcf_refusal('send_not_uncertain'); end if;
  select count(*) filter (where o.outcome = 'found')::integer as found,
      count(*) filter (where o.outcome = 'not_found')::integer as not_found,
      count(*) filter (where o.outcome = 'not_found' and o.operation = 'listAllFulfillmentOrders')::integer as listed,
      coalesce(extract(epoch from max(o.read_at) filter (where o.outcome = 'not_found')
        - min(o.read_at) filter (where o.outcome = 'not_found')), 0)::integer as span_seconds
    into v_evidence
    from public.creator_mcf_observations o
   where o.org_id = p_org and o.derived_order_key = v_send.derived_order_key and o.read_at > v_send.intent_reserved_at
     and o.read_at <= now() + interval '1 minute'
     and (o.operation = 'listAllFulfillmentOrders' or o.queried_order_id = v_send.derived_order_key);
  if v_evidence.found > 0 then return app.creator_mcf_refusal('order_found'); end if;
  if v_evidence.not_found < 3 or v_evidence.listed < 1 or v_evidence.span_seconds < 1800 then
    return app.creator_mcf_refusal('release_evidence_insufficient');
  end if;
  v_send := app.creator_mcf_move(p_send, 'not_created', 'released', 'released', 'user', auth.uid()::text, null, '{}',
    jsonb_build_object('notFoundReads', v_evidence.not_found, 'listReads', v_evidence.listed, 'spanSeconds', v_evidence.span_seconds),
    null, v_member);
  perform app.creator_mcf_lane_effect(v_send, 'released');
  perform app.creator_mcf_milestone(v_send, 'mcf_send_failed', 'not_created', 'web', auth.uid(), 'failed');
  return jsonb_build_object('outcome', 'released', 'sendId', p_send, 'state', 'not_created');
end;
$$;

-- "Record as sent": from conflict only, when the newest read of the order key, at most 30 minutes
-- old, found it in a validated status. The event carries the mismatch codes the conflict recorded.
create function app.resolve_creator_mcf_conflict(p_org uuid, p_send uuid, p_request uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends; v_read record; v_codes text[];
begin
  v_member := app.creator_mcf_manager(p_org);
  if p_request is null then raise exception 'Invalid creator MCF resolution' using errcode = '22023'; end if;
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.resolution_request_id = p_request then
    return jsonb_build_object('outcome', 'placed', 'replay', true, 'sendId', p_send, 'state', v_send.state);
  end if;
  if v_send.state <> 'conflict' then return app.creator_mcf_refusal('send_not_conflict'); end if;
  select o.outcome, o.mcf_status, o.read_at into v_read from public.creator_mcf_observations o
   where o.org_id = p_org and o.derived_order_key = v_send.derived_order_key and o.read_at <= now() + interval '1 minute'
   order by o.read_at desc, o.recorded_at desc limit 1;
  if not found or v_read.outcome <> 'found'
    or v_read.mcf_status not in ('Received', 'Planning', 'Processing', 'Complete', 'CompletePartialled')
    or v_read.read_at < now() - interval '30 minutes' then
    return app.creator_mcf_refusal('settlement_read_required');
  end if;
  select coalesce(e.codes, '{}') into v_codes from public.creator_mcf_send_events e
    where e.send_id = p_send and e.after_state = 'conflict' and e.before_state is distinct from 'conflict'
      and e.event <> 'custody_destroyed' order by e.at desc limit 1;
  update public.creator_mcf_sends set resolved_by = auth.uid(), resolved_membership_created_at = v_member, resolved_at = now(),
      resolution_request_id = p_request, amazon_status = v_read.mcf_status
    where id = p_send;
  v_send := app.creator_mcf_move(p_send, 'placed', 'conflict_resolved', lower(v_read.mcf_status), 'user', auth.uid()::text, null,
    coalesce(v_codes, '{}'), '{}', null, v_member);
  perform app.creator_mcf_lane_effect(v_send, 'placed');
  perform app.creator_mcf_milestone(v_send, 'mcf_send_placed', 'recorded_as_sent', 'web', auth.uid(), 'placed');
  return jsonb_build_object('outcome', 'placed', 'replay', false, 'sendId', p_send, 'state', 'placed');
end;
$$;

-- What sending needs, for owners, admins and analysts: the grant, today's units (UTC) against the
-- cap, the newest heartbeat and whether its scope covers this org's connection and marketplace.
create function app.creator_mcf_send_gate(p_org uuid) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_connections integer; v_connection uuid; v_grants integer; v_grant app.creator_mcf_grants;
  v_beat app.creator_mcf_worker_heartbeats; v_covers boolean := false; v_fresh boolean := false; v_missing text[] := '{}';
  v_units integer;
begin
  if not app.has_org_role(p_org, array['owner', 'admin', 'analyst']) then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  select count(distinct connection_id)::integer, min(connection_id::text)::uuid into v_connections, v_connection
    from app.creator_mcf_usable_bindings(p_org);
  if v_connections = 1 then
    select count(*)::integer into v_grants from app.creator_mcf_grants g where g.org_id = p_org and g.spapi_connection_id = v_connection
      and g.revoked_at is null and g.expires_at > now()
      and g.marketplace_id in (select u.marketplace_id from app.creator_mcf_usable_bindings(p_org) u where u.connection_id = v_connection);
    if v_grants = 1 then
      select g.* into v_grant from app.creator_mcf_grants g where g.org_id = p_org and g.spapi_connection_id = v_connection
        and g.revoked_at is null and g.expires_at > now()
        and g.marketplace_id in (select u.marketplace_id from app.creator_mcf_usable_bindings(p_org) u where u.connection_id = v_connection);
    end if;
  end if;
  select * into v_beat from app.creator_mcf_worker_heartbeats order by beat_at desc limit 1;
  if v_grant.id is not null then
    v_units := app.creator_mcf_units_on(p_org, v_grant.spapi_connection_id, v_grant.marketplace_id, now());
    v_covers := v_beat.worker_id is not null and (v_grant.spapi_connection_id::text || ':' || v_grant.marketplace_id) = any(v_beat.scope);
  end if;
  v_fresh := v_beat.worker_id is not null and v_beat.beat_at >= now() - interval '5 minutes';
  if coalesce(v_connections, 0) <> 1 then v_missing := v_missing || 'connection'::text; end if;
  if v_grant.id is null or not ('send' = any(v_grant.action_classes)) then v_missing := v_missing || 'grant'::text; end if;
  if not v_fresh then v_missing := v_missing || 'heartbeat'::text; end if;
  if v_grant.id is not null and not v_covers then v_missing := v_missing || 'scope'::text; end if;
  if v_fresh and not v_beat.dispatch_enabled then v_missing := v_missing || 'dispatch_disabled'::text; end if;
  return jsonb_build_object(
    'active', v_grant.id is not null,
    'sendingOn', cardinality(v_missing) = 0,
    'missing', to_jsonb(v_missing),
    'actions', coalesce(to_jsonb(v_grant.action_classes), '[]'::jsonb),
    'expiresAt', v_grant.expires_at,
    'keyIds', coalesce(to_jsonb(v_grant.recipient_key_ids), '[]'::jsonb),
    'spapiConnectionId', v_grant.spapi_connection_id,
    'marketplaceId', v_grant.marketplace_id,
    'maxFeeMinor', v_grant.max_fee_minor,
    'currency', v_grant.currency,
    'unitsToday', v_units,
    'maxUnitsPerDay', v_grant.max_units_per_day,
    'heartbeat', case when v_beat.worker_id is null then null else jsonb_build_object(
      'beatAt', v_beat.beat_at, 'previewEnabled', v_beat.preview_enabled, 'dispatchEnabled', v_beat.dispatch_enabled,
      'scopeCovers', v_covers, 'workerRevision', v_beat.worker_revision,
      'lastAuthorizationFailureAt', v_beat.last_authorization_failure_at) end,
    'residue', app.creator_mcf_residue(p_org));
end;
$$;

-- The lane and its newest send, sanitized, for the screens (owners, admins, analysts). No
-- ciphertext and no custody bytes; the mask until it is purged.
create function app.read_creator_mcf_lane(p_org uuid, p_record text, p_asin text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_lane public.creator_sample_shipments; v_send public.creator_mcf_sends; v_preview public.creator_mcf_send_previews;
  v_custody timestamptz;
begin
  if not app.has_org_role(p_org, array['owner', 'admin', 'analyst']) then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  select * into v_lane from public.creator_sample_shipments where org_id = p_org and creator_record_id = p_record and asin = p_asin;
  if not found then return null; end if;
  select * into v_send from public.creator_mcf_sends where org_id = p_org and derived_order_key = v_lane.derived_order_key
    order by created_at desc, id desc limit 1;
  if v_send.id is not null then
    select * into v_preview from public.creator_mcf_send_previews where id = v_send.latest_preview_id;
    select expires_at into v_custody from app.creator_mcf_recipient_custody where send_id = v_send.id;
  end if;
  return jsonb_build_object(
    'lane', jsonb_build_object('creatorRecordId', v_lane.creator_record_id, 'asin', v_lane.asin, 'derivedOrderKey', v_lane.derived_order_key,
      'sku', v_lane.sku, 'reservationId', v_lane.reservation_id, 'laneState', v_lane.lane_state, 'orderOwner', v_lane.order_owner,
      'feeCapCents', v_lane.fee_cap_cents, 'mcfStatus', v_lane.mcf_status,
      'settlement', case when v_lane.mcf_settlement is null then null else jsonb_build_object('settlement', v_lane.mcf_settlement,
        'notFoundProbes', v_lane.mcf_not_found_probes, 'lastProbeAt', v_lane.mcf_probed_at) end),
    'send', case when v_send.id is null then null else jsonb_build_object(
      'sendId', v_send.id, 'state', v_send.state, 'stateReason', v_send.state_reason, 'stateChangedAt', v_send.state_changed_at,
      'mask', v_send.mask, 'maskPurged', v_send.mask is null, 'custodyExpiresAt', v_custody,
      'escalatedAt', v_send.escalated_at, 'escalationReason', v_send.escalation_reason,
      'approvedAt', v_send.approved_at, 'claimDeadline', v_send.claim_deadline, 'units', v_send.approved_units,
      'intentReservedAt', v_send.intent_reserved_at, 'providerOutcome', v_send.provider_outcome,
      'providerReason', v_send.provider_reason, 'providerStatus', v_send.provider_status, 'providerCodes', v_send.provider_codes,
      'amazonStatus', v_send.amazon_status, 'acceptedAt', v_send.accepted_at, 'placedAt', v_send.placed_at,
      'createdAt', v_send.created_at,
      'latestPreview', case when v_preview.id is null then null else jsonb_build_object('previewId', v_preview.id,
        'kind', v_preview.kind, 'fingerprint', v_preview.fingerprint, 'body', v_preview.body, 'readAt', v_preview.read_at,
        'validUntil', v_preview.valid_until) end,
      'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'actorType', e.actor_type,
          'beforeState', e.before_state, 'afterState', e.after_state, 'reason', e.reason, 'codes', e.codes, 'httpStatus', e.http_status,
          'at', e.at) order by e.at desc, e.id desc)
        from (select * from public.creator_mcf_send_events where send_id = v_send.id order by at desc, id desc limit 20) e), '[]'::jsonb)
    ) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role functions (the MCF worker; the general worker's housekeeping; pg_cron)
-- ---------------------------------------------------------------------------

-- The next piece of work in scope, leased for 120 seconds, with what the worker needs to do it.
-- Runs the sweep first. Preview and dispatch need an active grant; settle reads continue after a
-- revocation so an order that may exist is always observed. A dispatch past its claim deadline
-- is never returned.
create function app.claim_creator_mcf_outbox(p_claimant text, p_scope text[], p_actions text[]) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_row record; v_send public.creator_mcf_sends; v_lease uuid; v_until timestamptz := now() + interval '120 seconds';
  v_grant app.creator_mcf_grants; v_pre public.creator_sample_preflights; v_lane public.creator_sample_shipments;
  v_approved public.creator_mcf_send_previews; v_attempts integer;
begin
  perform app.assert_service_role('claim_creator_mcf_outbox');
  if p_claimant is null or p_claimant !~ '^[A-Za-z0-9._:-]{1,80}$' or p_scope is null or p_actions is null
    or cardinality(p_actions) = 0 or not (p_actions <@ array['preview', 'dispatch', 'settle'])
    or not app.creator_mcf_scope_valid(p_scope) then
    raise exception 'Invalid creator MCF claim' using errcode = '22023';
  end if;
  perform app.creator_mcf_sweep(null);
  for v_row in select o.id, o.send_id, o.action, s.org_id, s.creator_record_id, s.asin from public.creator_mcf_outbox o
      join public.creator_mcf_sends s on s.id = o.send_id
     where o.completed_at is null and o.available_at <= now() and (o.lease_until is null or o.lease_until < now())
       and o.action = any(p_actions) and (s.spapi_connection_id::text || ':' || s.marketplace_id) = any(p_scope)
       and (o.action = 'settle' or (exists (select 1 from app.creator_mcf_grants g where g.org_id = s.org_id
           and g.spapi_connection_id = s.spapi_connection_id and g.marketplace_id = s.marketplace_id and g.revoked_at is null
           and g.expires_at > now() and 'send' = any(g.action_classes) and s.key_id = any(g.recipient_key_ids))
         and exists (select 1 from app.creator_mcf_recipient_custody c where c.send_id = s.id and c.expires_at > now())))
     order by o.available_at, o.created_at, o.id limit 25 loop
    select * into v_lane from public.creator_sample_shipments where org_id = v_row.org_id and creator_record_id = v_row.creator_record_id
      and asin = v_row.asin for update skip locked;
    if not found then continue; end if;
    select * into v_send from public.creator_mcf_sends where id = v_row.send_id for update skip locked;
    if not found then continue; end if;
    perform 1 from public.creator_mcf_outbox where id = v_row.id and completed_at is null and (lease_until is null or lease_until < now())
      for update skip locked;
    if not found then continue; end if;
    v_grant := app.creator_mcf_active_grant(v_send.org_id, v_send.spapi_connection_id, v_send.marketplace_id);
    if v_row.action = 'preview' then
      if v_send.state not in ('sealed', 'previewing') then
        update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null where id = v_row.id;
        continue;
      end if;
      if v_grant.id is null or not (v_send.key_id = any(v_grant.recipient_key_ids))
        or not exists (select 1 from app.creator_mcf_recipient_custody where send_id = v_send.id and expires_at > now()) then
        continue;
      end if;
      if v_send.state = 'sealed' then
        v_send := app.creator_mcf_move(v_send.id, 'previewing', 'preview_claimed', null, 'worker', p_claimant);
      end if;
    elsif v_row.action = 'dispatch' then
      if v_send.state <> 'approved' then
        update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null where id = v_row.id;
        continue;
      end if;
      if not (v_send.claim_deadline > now()) or v_grant.id is null or not (v_send.key_id = any(v_grant.recipient_key_ids))
        or not exists (select 1 from app.creator_mcf_recipient_custody where send_id = v_send.id and expires_at > now()) then
        continue;
      end if;
    else
      if v_send.state not in ('accepted', 'uncertain', 'conflict') then
        update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null where id = v_row.id;
        continue;
      end if;
    end if;
    v_lease := gen_random_uuid();
    update public.creator_mcf_outbox set lease_id = v_lease, lease_until = v_until, claimed_by = p_claimant, claimed_at = now(),
        attempts = attempts + 1
      where id = v_row.id returning attempts into v_attempts;
    if v_row.action = 'dispatch' then
      update public.creator_mcf_sends set lease_id = v_lease, lease_until = v_until where id = v_send.id returning * into v_send;
      perform app.creator_mcf_event(v_send, 'dispatch_claimed', 'worker', p_claimant, v_send.state, v_send.state);
      select * into v_approved from public.creator_mcf_send_previews where id = v_send.approved_preview_id;
    end if;
    select * into v_pre from public.creator_sample_preflights where id = v_send.preflight_id;
    return jsonb_build_object(
      'outboxId', v_row.id, 'action', v_row.action, 'leaseId', v_lease, 'leaseUntil', v_until, 'attempts', v_attempts,
      'sendId', v_send.id, 'orgId', v_send.org_id, 'state', v_send.state,
      'binding', jsonb_build_object('orgId', v_send.org_id::text, 'creatorRecordId', v_send.creator_record_id, 'asin', v_send.asin,
        'derivedOrderKey', v_send.derived_order_key, 'reservationId', v_send.reservation_id),
      'sku', v_send.sku, 'spapiConnectionId', v_send.spapi_connection_id, 'marketplaceId', v_send.marketplace_id,
      'keyId', v_send.key_id, 'envelopeId', v_send.envelope_id, 'envelopeSha256', v_send.ciphertext_sha256,
      'mask', case when v_row.action in ('preview', 'dispatch') then v_send.mask end,
      'preflight', jsonb_build_object('id', v_pre.id, 'runId', v_pre.run_id, 'completedAt', v_pre.completed_at),
      'caps', jsonb_build_object('laneFeeCapMinor', v_lane.fee_cap_cents, 'grantFeeCapMinor', v_grant.max_fee_minor,
        'grantCurrency', v_grant.currency),
      'approval', case when v_row.action = 'dispatch' then jsonb_build_object('approvedAt', v_send.approved_at,
        'claimDeadline', v_send.claim_deadline, 'units', v_send.approved_units, 'previewId', v_approved.id,
        'fingerprint', v_approved.fingerprint, 'preview', v_approved.body) end,
      'settle', case when v_row.action = 'settle' then jsonb_build_object('intentReservedAt', v_send.intent_reserved_at,
        'acceptedAt', v_send.accepted_at, 'reads', v_send.settle_reads, 'ladderStart', app.creator_mcf_ladder_start(v_send)) end);
  end loop;
  return null;
end;
$$;

-- The sealed envelope for one open preview or dispatch lease: ciphertext only, never plaintext.
create function app.read_creator_mcf_custody(p_send uuid, p_lease uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_custody app.creator_mcf_recipient_custody;
begin
  perform app.assert_service_role('read_creator_mcf_custody');
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found or p_lease is null then return null; end if;
  if not ((v_send.state = 'previewing' and exists (select 1 from public.creator_mcf_outbox where send_id = p_send and action = 'preview'
        and completed_at is null and lease_id = p_lease and lease_until > now()))
      or (v_send.state = 'approved' and v_send.lease_id = p_lease and v_send.lease_until > now())) then
    return null;
  end if;
  select * into v_custody from app.creator_mcf_recipient_custody where send_id = p_send and expires_at > now();
  if not found then return null; end if;
  perform app.creator_mcf_event(v_send, 'custody_read', 'worker', null, v_send.state, v_send.state);
  return jsonb_build_object(
    'binding', jsonb_build_object('orgId', v_send.org_id::text, 'creatorRecordId', v_send.creator_record_id, 'asin', v_send.asin,
      'derivedOrderKey', v_send.derived_order_key, 'reservationId', v_send.reservation_id),
    'envelope', jsonb_build_object('v', 1, 'suite', 'DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM',
      'envelopeId', v_custody.envelope_id, 'keyId', v_custody.key_id, 'enc', app.creator_mcf_b64url(v_custody.enc),
      'ciphertext', app.creator_mcf_b64url(v_custody.ciphertext), 'mask', v_send.mask),
    'ciphertextSha256', v_custody.ciphertext_sha256, 'expiresAt', v_custody.expires_at);
end;
$$;

-- Records one preview row. `preview`: previewing becomes preview_ready when Amazon's answer is
-- sendable against the current caps, else preview_refused (custody destroyed). `dispatch_reread`:
-- compared with the approved preview, read ids and times aside; any difference moves the send to
-- stale (custody kept, no POST). p_preview_text is the canonical JSON the fingerprint covers.
create function app.record_creator_mcf_preview(p_send uuid, p_lease uuid, p_preview_text text) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_body jsonb; v_kind text; v_fingerprint text; v_existing public.creator_mcf_send_previews;
  v_approved public.creator_mcf_send_previews; v_codes text[]; v_problem text;
  v_strip text[] := array['previewId', 'kind', 'readAt', 'validUntil', 'workerRevision'];
begin
  perform app.assert_service_role('record_creator_mcf_preview');
  if p_preview_text is null or octet_length(p_preview_text) > 32768 then
    raise exception 'Invalid creator MCF preview' using errcode = '22023';
  end if;
  begin
    v_body := p_preview_text::jsonb;
  exception when others then
    raise exception 'Invalid creator MCF preview' using errcode = '22023';
  end;
  if jsonb_typeof(v_body) <> 'object' or jsonb_typeof(v_body->'previewId') <> 'string'
    or v_body->>'previewId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid creator MCF preview' using errcode = '22023';
  end if;
  v_kind := v_body->>'kind';
  v_fingerprint := encode(sha256(convert_to(p_preview_text, 'UTF8')), 'hex');
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  select * into v_existing from public.creator_mcf_send_previews where id = (v_body->>'previewId')::uuid;
  if found then
    if v_existing.send_id = p_send and v_existing.fingerprint = v_fingerprint then
      return jsonb_build_object('decision', 'unchanged', 'previewId', v_existing.id, 'fingerprint', v_fingerprint, 'state', v_send.state);
    end if;
    raise exception 'creator MCF preview id reused' using errcode = '23505';
  end if;
  if v_kind = 'preview' then
    if v_send.state <> 'previewing' or not exists (select 1 from public.creator_mcf_outbox where send_id = p_send and action = 'preview'
        and completed_at is null and lease_id = p_lease and lease_until > now()) then
      return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
    end if;
  elsif v_kind = 'dispatch_reread' then
    if v_send.state <> 'approved' or v_send.lease_id is distinct from p_lease or not (v_send.lease_until > now()) then
      return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
    end if;
  else
    raise exception 'creator MCF preview refused: preview_shape' using errcode = '22023';
  end if;
  v_problem := app.creator_mcf_preview_problem(v_send, v_body, v_kind);
  if v_problem is not null then
    raise exception 'creator MCF preview refused: %', v_problem using errcode = '22023';
  end if;
  insert into public.creator_mcf_send_previews(id, org_id, send_id, kind, body, fingerprint, total_units, read_at, valid_until)
    values ((v_body->>'previewId')::uuid, v_send.org_id, p_send, v_kind, v_body, v_fingerprint, (v_body->>'totalUnits')::smallint,
      (v_body->>'readAt')::timestamptz, (v_body->>'validUntil')::timestamptz);
  if v_kind = 'preview' then
    update public.creator_mcf_sends set latest_preview_id = (v_body->>'previewId')::uuid where id = p_send;
    v_codes := app.creator_mcf_unsendable(v_send, v_body);
    if cardinality(v_codes) = 0 then
      perform app.creator_mcf_move(p_send, 'preview_ready', 'preview_recorded', null, 'worker', null);
      update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
        where send_id = p_send and action = 'preview' and completed_at is null;
      return jsonb_build_object('decision', 'preview_ready', 'previewId', v_body->>'previewId', 'fingerprint', v_fingerprint,
        'state', 'preview_ready');
    end if;
    perform app.creator_mcf_move(p_send, 'preview_refused', 'preview_refused', 'not_sendable', 'worker', null, 'preview_refused',
      v_codes[1:20]);
    return jsonb_build_object('decision', 'preview_refused', 'previewId', v_body->>'previewId', 'fingerprint', v_fingerprint,
      'state', 'preview_refused', 'codes', to_jsonb(v_codes[1:20]));
  end if;
  select * into strict v_approved from public.creator_mcf_send_previews where id = v_send.approved_preview_id;
  v_codes := array(select k from (select jsonb_object_keys(v_approved.body - v_strip) k
      union select jsonb_object_keys(v_body - v_strip)) keys
    where (v_approved.body - v_strip)->k is distinct from (v_body - v_strip)->k order by k collate "C");
  perform app.creator_mcf_event(v_send, 'dispatch_reread', 'worker', null, 'approved', 'approved', null, v_codes,
    jsonb_build_object('previewFingerprint', v_fingerprint));
  if cardinality(v_codes) = 0 then
    return jsonb_build_object('decision', 'same', 'previewId', v_body->>'previewId', 'fingerprint', v_fingerprint, 'state', 'approved');
  end if;
  perform app.creator_mcf_move(p_send, 'stale', 'stale', 'dispatch_reread_differs', 'worker', null, null, v_codes);
  return jsonb_build_object('decision', 'stale', 'previewId', v_body->>'previewId', 'fingerprint', v_fingerprint, 'state', 'stale',
    'fields', to_jsonb(v_codes));
end;
$$;

-- A refusal the worker found without a sendable Amazon answer: the order already exists, the
-- envelope does not open, the mask or recipient is invalid. At preview the send becomes
-- preview_refused; at dispatch (approved) it expires. Custody is destroyed either way.
create function app.refuse_creator_mcf_preview(p_send uuid, p_lease uuid, p_reason text, p_codes text[]) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends;
begin
  perform app.assert_service_role('refuse_creator_mcf_preview');
  if p_reason is null or p_reason not in ('order_exists', 'recipient_invalid', 'mask_mismatch', 'envelope_invalid',
      'envelope_unopenable', 'key_mismatch', 'key_unavailable', 'country_not_allowed', 'provider_refused')
    or not app.creator_mcf_codes_valid(coalesce(p_codes, '{}')) then
    raise exception 'Invalid creator MCF refusal' using errcode = '22023';
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.state = 'previewing' and exists (select 1 from public.creator_mcf_outbox where send_id = p_send and action = 'preview'
      and completed_at is null and lease_id = p_lease and lease_until > now()) then
    perform app.creator_mcf_move(p_send, 'preview_refused', 'preview_refused', p_reason, 'worker', null, 'preview_refused',
      coalesce(p_codes, '{}'));
    return jsonb_build_object('decision', 'preview_refused', 'state', 'preview_refused');
  end if;
  if v_send.state = 'approved' and v_send.lease_id = p_lease and v_send.lease_until > now() and p_reason <> 'order_exists' then
    perform app.creator_mcf_move(p_send, 'expired', 'expired', p_reason, 'worker', null, 'unopenable', coalesce(p_codes, '{}'));
    return jsonb_build_object('decision', 'expired', 'state', 'expired');
  end if;
  return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
end;
$$;

-- Gives back a lease without an outcome (a read error, a flag turned off): the work is due again
-- after p_retry_seconds. The send keeps its state, so a dispatch stays approved.
create function app.release_creator_mcf_claim(p_send uuid, p_lease uuid, p_retry_seconds integer) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_action text;
begin
  perform app.assert_service_role('release_creator_mcf_claim');
  if p_lease is null or p_retry_seconds is null or p_retry_seconds not between 1 and 3600 then
    raise exception 'Invalid creator MCF lease release' using errcode = '22023';
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  update public.creator_mcf_outbox set lease_id = null, lease_until = null, available_at = now() + make_interval(secs => p_retry_seconds)
    where send_id = p_send and completed_at is null and lease_id = p_lease returning action into v_action;
  if v_action is null then return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state); end if;
  if v_action = 'dispatch' and v_send.state = 'approved' and v_send.lease_id = p_lease then
    update public.creator_mcf_sends set lease_id = null, lease_until = null where id = p_send;
  end if;
  if v_action in ('preview', 'dispatch') then
    perform app.creator_mcf_event(v_send, 'deferred', 'worker', null, v_send.state, v_send.state, v_action);
  end if;
  return jsonb_build_object('decision', 'released', 'action', v_action, 'state', v_send.state);
end;
$$;

-- The clause-9 recheck immediately before the provider intent. Holds a KEY SHARE lock on the org
-- (see orgs_block_unresolved_mcf_send_purge). On success the send is dispatching, the lane is
-- Verified for Submit and Arcana's, and the answer is dispatch_once. A second call returns
-- already_reserved and never grants a POST. An authority, grant, cap or lane refusal expires the
-- send with its reason and destroys custody.
create function app.reserve_creator_mcf_dispatch(p_send uuid, p_lease uuid, p_request_digest text) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_grant app.creator_mcf_grants; v_lane public.creator_sample_shipments; v_claimed timestamptz;
  v_reread public.creator_mcf_send_previews; v_approved public.creator_mcf_send_previews; v_expire text; v_lock text; v_until timestamptz;
  v_codes text[];
  v_strip text[] := array['previewId', 'kind', 'readAt', 'validUntil', 'workerRevision'];
begin
  perform app.assert_service_role('reserve_creator_mcf_dispatch');
  if p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$' or p_lease is null then
    raise exception 'Invalid creator MCF reservation' using errcode = '22023';
  end if;
  perform app.creator_mcf_sweep(null);
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.orgs where id = v_send.org_id for key share;
  select * into v_lane from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.posts = 1 or v_send.state = 'dispatching' then
    return jsonb_build_object('decision', 'already_reserved', 'state', v_send.state);
  end if;
  if v_send.state <> 'approved' then
    return jsonb_build_object('decision', 'refused', 'reason', 'state', 'state', v_send.state);
  end if;
  if v_send.lease_id is distinct from p_lease or not (v_send.lease_until > now()) then
    return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
  end if;
  if not (v_send.claim_deadline > now()) then
    perform app.creator_mcf_move(p_send, 'expired_unclaimed', 'reserve_refused', 'claim_deadline', 'worker', null, 'expired_unclaimed');
    return jsonb_build_object('decision', 'refused', 'reason', 'claim_deadline', 'state', 'expired_unclaimed');
  end if;
  -- The approver is still an owner or admin, with the same membership.
  perform 1 from public.org_members where org_id = v_send.org_id and user_id = v_send.approved_by
    and created_at = v_send.approved_membership_created_at and role in ('owner', 'admin') for share;
  if not found then v_expire := 'authority_changed'; end if;
  if v_expire is null then
    perform pg_advisory_xact_lock(hashtextextended('creator-mcf-cap:' || v_send.org_id::text || ':'
      || v_send.spapi_connection_id::text || ':' || v_send.marketplace_id, 0));
    select * into v_grant from app.creator_mcf_grants where org_id = v_send.org_id and spapi_connection_id = v_send.spapi_connection_id
      and marketplace_id = v_send.marketplace_id and revoked_at is null and expires_at > now() and 'send' = any(action_classes)
      for update;
    if not found or v_grant.id is distinct from v_send.approved_grant_id or not (v_send.key_id = any(v_grant.recipient_key_ids)) then
      v_expire := 'grant_revoked';
    elsif app.creator_mcf_units_on(v_send.org_id, v_send.spapi_connection_id, v_send.marketplace_id, v_send.approved_at)
        > v_grant.max_units_per_day then
      v_expire := 'cap_exceeded';
    end if;
  end if;
  if v_expire is null and (v_lane.lane_state <> 'Reserved' or v_lane.order_owner <> 'runner'
      or v_lane.reservation_id is distinct from v_send.reservation_id or v_lane.sku is distinct from v_send.sku) then
    v_expire := 'lane_changed';
  end if;
  if v_expire is null then
    select lock_state into v_lock from public.creator_records where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id;
    if v_lock is distinct from 'Unlocked' and v_lock is distinct from 'Locked for MCF' then v_expire := 'record_conflict'; end if;
  end if;
  if v_expire is not null then
    perform app.creator_mcf_move(p_send, 'expired', 'reserve_refused', v_expire, 'worker', null, v_expire);
    return jsonb_build_object('decision', 'refused', 'reason', v_expire, 'state', 'expired');
  end if;
  -- The approved preview is still the latest, and a re-read during this lease matched it.
  select claimed_at into v_claimed from public.creator_mcf_outbox where send_id = p_send and action = 'dispatch'
    and completed_at is null and lease_id = p_lease;
  select * into v_approved from public.creator_mcf_send_previews where id = v_send.approved_preview_id;
  select * into v_reread from public.creator_mcf_send_previews where send_id = p_send and kind = 'dispatch_reread'
    and recorded_at >= coalesce(v_claimed, 'infinity'::timestamptz) order by recorded_at desc, id desc limit 1;
  if v_send.latest_preview_id is distinct from v_send.approved_preview_id or v_reread.id is null then
    return jsonb_build_object('decision', 'refused', 'reason', 'reread_missing', 'state', v_send.state);
  end if;
  if (v_approved.body - v_strip) is distinct from (v_reread.body - v_strip) then
    perform app.creator_mcf_move(p_send, 'stale', 'stale', 'dispatch_reread_differs', 'worker', null);
    return jsonb_build_object('decision', 'refused', 'reason', 'stale', 'state', 'stale');
  end if;
  -- The approved fees against the caps as they are now (a lane fee cap the runner lowered).
  v_codes := app.creator_mcf_unsendable(v_send, v_approved.body);
  if cardinality(v_codes) > 0 then
    perform app.creator_mcf_move(p_send, 'stale', 'stale', 'caps_changed', 'worker', null, null, v_codes);
    return jsonb_build_object('decision', 'refused', 'reason', 'stale', 'state', 'stale');
  end if;
  -- The POST has 60 seconds; keep the lease at least 90 seconds past the reservation.
  v_until := greatest(v_send.lease_until, now() + interval '90 seconds');
  update public.creator_mcf_sends set state = 'dispatching', state_reason = null, intent_reserved_at = now(), posts = 1,
      request_digest = p_request_digest, lease_until = v_until
    where id = p_send returning * into v_send;
  update public.creator_mcf_outbox set lease_until = v_until where send_id = p_send and action = 'dispatch' and completed_at is null
    and lease_id = p_lease;
  perform app.creator_mcf_event(v_send, 'reserved', 'worker', null, 'approved', 'dispatching', null, '{}',
    jsonb_build_object('requestDigest', p_request_digest, 'previewFingerprint', v_approved.fingerprint));
  perform app.creator_mcf_lane_effect(v_send, 'reserved');
  return jsonb_build_object('decision', 'dispatch_once', 'sendId', p_send, 'state', 'dispatching', 'derivedOrderKey', v_send.derived_order_key,
    'sku', v_send.sku, 'quantity', v_send.approved_units, 'marketplaceId', v_send.marketplace_id, 'approvedAt', v_send.approved_at,
    'reservedAt', v_send.intent_reserved_at, 'leaseUntil', v_until, 'requestDigest', p_request_digest);
end;
$$;

-- The first POST outcome, and custody destroyed in the same transaction (DESIGN 6.2 for the lane).
-- p_outcome is the shared CreatorMcfProviderOutcome. A rejected create other than 401/403 needs the
-- getOrder read that followed it (p_lookup): not found is rejected; found is classified like a
-- settlement read. A late outcome for the lease on a send the sweep moved to uncertain(crash) is
-- recorded as an event; a 200 moves it to accepted, anything else leaves it for the ladder.
create function app.record_creator_mcf_outcome(p_send uuid, p_lease uuid, p_outcome jsonb, p_lookup jsonb default null) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_kind text := p_outcome->>'outcome'; v_status integer; v_codes text[] := '{}';
  v_reason text; v_to text; v_observed jsonb;
begin
  perform app.assert_service_role('record_creator_mcf_outcome');
  if not app.creator_mcf_outcome_valid(p_outcome) then
    raise exception 'Invalid creator MCF provider outcome' using errcode = '22023';
  end if;
  v_status := (p_outcome->>'status')::integer;
  if v_kind = 'rejected' then
    v_codes := array(select jsonb_array_elements_text(p_outcome->'codes'));
    v_reason := p_outcome->>'reason';
  elsif v_kind = 'uncertain' then
    v_reason := p_outcome->>'cause';
  end if;
  if v_kind = 'rejected' and v_reason <> 'authorization'
    and (p_lookup is null or p_lookup->>'outcome' not in ('found', 'not_found')) then
    raise exception 'A rejected create needs the getOrder read that followed it' using errcode = '22023';
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.lease_id is distinct from p_lease or p_lease is null then
    return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
  end if;
  if v_send.state = 'dispatching' then
    update public.creator_mcf_sends set provider_outcome = v_kind, provider_reason = v_reason, provider_status = v_status,
        provider_codes = v_codes
      where id = p_send;
    if v_kind = 'accepted' or (v_kind = 'rejected' and p_lookup->>'outcome' = 'found') then
      v_send := app.creator_mcf_move(p_send, 'accepted', 'outcome_recorded', v_kind, 'worker', null, 'post_outcome', v_codes, '{}', v_status);
      perform app.creator_mcf_lane_effect(v_send, 'accepted');
      v_to := 'accepted';
      if v_kind = 'rejected' then
        v_observed := app.creator_mcf_observe(v_send, p_lookup);
        v_to := app.creator_mcf_apply_found(p_send, p_lookup, 'worker', null);
      end if;
      select * into v_send from public.creator_mcf_sends where id = p_send;
      if v_to in ('accepted', 'conflict') then
        perform app.creator_mcf_schedule_settle(p_send, case when v_kind = 'accepted' then now() + interval '5 seconds'
          else app.creator_mcf_next_settle_at(app.creator_mcf_ladder_start(v_send), now()) end);
      end if;
    elsif v_kind = 'rejected' then
      v_send := app.creator_mcf_move(p_send, 'rejected', 'outcome_recorded', v_reason, 'worker', null, 'post_outcome', v_codes, '{}', v_status);
      if p_lookup is not null then v_observed := app.creator_mcf_observe(v_send, p_lookup); end if;
      perform app.creator_mcf_lane_effect(v_send, 'released');
      perform app.creator_mcf_milestone(v_send, 'mcf_send_failed', 'rejected_' || v_reason, 'worker', null, 'failed');
      v_to := 'rejected';
    else
      v_send := app.creator_mcf_move(p_send, 'uncertain', 'outcome_recorded', v_reason, 'worker', null, 'post_outcome', '{}', '{}', v_status);
      perform app.creator_mcf_lane_effect(v_send, 'uncertain',
        case when v_reason in ('transport', 'http_408') then 'request_timeout' else 'outcome_unknown' end);
      perform app.creator_mcf_milestone(v_send, 'mcf_send_uncertain', v_reason, 'worker', null, 'uncertain');
      perform app.creator_mcf_schedule_settle(p_send, now() + interval '1 minute');
      v_to := 'uncertain';
    end if;
    return jsonb_build_object('decision', 'recorded', 'state', v_to);
  end if;
  -- A late answer for this lease after the send left dispatching (the sweep's crash rule, then
  -- perhaps a settlement read). The only POST's answer is still evidence, so it is recorded
  -- whatever the state. Only the crash case moves on the answer itself (a 200 is accepted); a
  -- found read that came with it counts as a settlement read.
  if v_send.posts = 1 and v_send.provider_outcome is null then
    update public.creator_mcf_sends set provider_outcome = v_kind, provider_reason = v_reason, provider_status = v_status,
        provider_codes = v_codes
      where id = p_send returning * into v_send;
    perform app.creator_mcf_event(v_send, 'late_outcome', 'worker', null, v_send.state, v_send.state, v_kind, v_codes, '{}', '{}', v_status);
    if v_send.state = 'uncertain' and v_send.state_reason = 'crash' and v_kind = 'accepted' then
      v_send := app.creator_mcf_move(p_send, 'accepted', 'outcome_recorded', 'late_accepted', 'worker', null, null, '{}', '{}', 200);
      perform app.creator_mcf_lane_effect(v_send, 'accepted');
      perform app.creator_mcf_schedule_settle(p_send, now() + interval '5 seconds');
      return jsonb_build_object('decision', 'late_recorded', 'state', 'accepted');
    end if;
    if p_lookup is not null and v_send.state in ('accepted', 'uncertain', 'conflict') then
      v_observed := app.creator_mcf_observe(v_send, p_lookup);
      if (v_observed->>'found')::boolean then
        perform app.creator_mcf_apply_found(p_send, p_lookup, 'worker', null);
      end if;
      select * into v_send from public.creator_mcf_sends where id = p_send;
      perform app.creator_mcf_schedule_settle(p_send, case when v_send.state in ('accepted', 'uncertain', 'conflict')
        then app.creator_mcf_next_settle_at(app.creator_mcf_ladder_start(v_send), now()) end);
    end if;
    return jsonb_build_object('decision', 'late_recorded', 'state', v_send.state);
  end if;
  if v_send.provider_outcome is not null and v_send.provider_outcome = v_kind and v_send.provider_status is not distinct from v_status then
    return jsonb_build_object('decision', 'unchanged', 'state', v_send.state);
  end if;
  return jsonb_build_object('decision', 'refused', 'reason', 'state', 'state', v_send.state);
end;
$$;

-- One getOrder (or complete order-list) read of the send's key: appended to WP-334's observations and
-- classified. Validated with the approved SKU and quantity is placed (lane Confirmed, runner_order_id =
-- key); New is accepted; Invalid, Unfulfillable and Cancelled are failed_by_amazon; an item mismatch
-- is conflict with escalation; not found moves nothing. Called on an approved send under its
-- dispatch lease, it is the read before the POST: a found order ends custody and no POST follows.
create function app.record_creator_mcf_settlement(p_send uuid, p_lookup jsonb, p_lease uuid default null) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_before text; v_to text; v_observed jsonb; v_next timestamptz;
begin
  perform app.assert_service_role('record_creator_mcf_settlement');
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  v_before := v_send.state;
  if v_send.state = 'approved' then
    if p_lease is null or v_send.lease_id is distinct from p_lease or not (v_send.lease_until > now()) then
      return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
    end if;
  elsif v_send.state in ('accepted', 'uncertain', 'conflict') then
    if p_lease is not null and not exists (select 1 from public.creator_mcf_outbox where send_id = p_send and action = 'settle'
        and completed_at is null and lease_id = p_lease and lease_until > now()) then
      return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
    end if;
  else
    return jsonb_build_object('decision', 'refused', 'reason', 'state', 'state', v_send.state);
  end if;
  v_observed := app.creator_mcf_observe(v_send, p_lookup);
  v_to := v_send.state;
  if (v_observed->>'found')::boolean then
    v_to := app.creator_mcf_apply_found(p_send, p_lookup, 'worker', null);
  else
    select * into v_send from public.creator_mcf_sends where id = p_send;
    perform app.creator_mcf_event(v_send, 'settlement_read', 'worker', null, v_send.state, v_send.state, 'not_found', '{}', '{}',
      jsonb_build_object('reads', v_send.settle_reads));
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if v_send.state in ('accepted', 'uncertain', 'conflict') then
    v_next := app.creator_mcf_next_settle_at(app.creator_mcf_ladder_start(v_send), now());
    perform app.creator_mcf_schedule_settle(p_send, v_next);
  else
    perform app.creator_mcf_schedule_settle(p_send, null);
  end if;
  return jsonb_build_object('decision', 'recorded', 'observationKey', v_observed->>'observationKey', 'before', v_before,
    'state', v_send.state, 'nextReadAt', v_next,
    'ladderDue', v_send.state in ('accepted', 'uncertain') and now() >= app.creator_mcf_ladder_start(v_send) + interval '7 days');
end;
$$;

-- Seven days of reads and Amazon has not settled the order: escalate an accepted or uncertain send.
create function app.mark_creator_mcf_ladder_exhausted(p_send uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends;
begin
  perform app.assert_service_role('mark_creator_mcf_ladder_exhausted');
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.escalation_reason = 'ladder_exhausted' then
    return jsonb_build_object('decision', 'unchanged', 'state', v_send.state);
  end if;
  if v_send.state not in ('accepted', 'uncertain') or v_send.escalated_at is not null then
    return jsonb_build_object('decision', 'refused', 'reason', 'state', 'state', v_send.state);
  end if;
  if now() < app.creator_mcf_ladder_start(v_send) + interval '7 days' then
    return jsonb_build_object('decision', 'refused', 'reason', 'too_early', 'state', v_send.state);
  end if;
  update public.creator_mcf_sends set escalated_at = now(), escalation_reason = 'ladder_exhausted' where id = p_send returning * into v_send;
  perform app.creator_mcf_schedule_settle(p_send, null);
  perform app.creator_mcf_event(v_send, 'ladder_exhausted', 'worker', null, v_send.state, v_send.state, 'ladder_exhausted', '{}', '{}',
    jsonb_build_object('reads', v_send.settle_reads));
  return jsonb_build_object('decision', 'escalated', 'state', v_send.state);
end;
$$;

create function app.expire_creator_mcf_custody() returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform app.assert_service_role('expire_creator_mcf_custody');
  return app.creator_mcf_sweep(null);
end;
$$;

create function app.creator_mcf_custody_residue() returns table(expired_live integer, custody_free_live integer)
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v jsonb;
begin
  perform app.assert_service_role('creator_mcf_custody_residue');
  v := app.creator_mcf_residue(null);
  return query select (v->>'expiredLive')::integer, (v->>'custodyFreeLive')::integer;
end;
$$;

create function app.record_creator_mcf_heartbeat(p_worker text, p_scope text[], p_preview_enabled boolean, p_dispatch_enabled boolean,
  p_worker_revision text, p_last_authorization_failure_at timestamptz) returns void
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform app.assert_service_role('record_creator_mcf_heartbeat');
  if not app.creator_mcf_scope_valid(p_scope) or p_preview_enabled is null or p_dispatch_enabled is null then
    raise exception 'Invalid creator MCF heartbeat' using errcode = '22023';
  end if;
  insert into app.creator_mcf_worker_heartbeats(worker_id, scope, preview_enabled, dispatch_enabled, worker_revision,
      last_authorization_failure_at, beat_at)
    values (p_worker, p_scope, p_preview_enabled, p_dispatch_enabled, p_worker_revision, p_last_authorization_failure_at, now())
    on conflict (worker_id) do update set scope = excluded.scope, preview_enabled = excluded.preview_enabled,
      dispatch_enabled = excluded.dispatch_enabled, worker_revision = excluded.worker_revision,
      last_authorization_failure_at = excluded.last_authorization_failure_at, beat_at = excluded.beat_at;
end;
$$;

-- Masks are nulled 30 days after the send ends, or after delivery is observed on a placed send
-- (Amazon's 30-days-after-delivery limit), and at most 37 days after sealing for a send that does
-- neither. Returns how many were scheduled by delivery, by the backstop, and purged.
create function app.purge_creator_mcf_masks() returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_scheduled integer; v_backstop integer; v_purged integer;
begin
  perform app.assert_service_role('purge_creator_mcf_masks');
  update public.creator_mcf_sends s set mask_purge_after = app.creator_mcf_lane_delivered_at(l) + interval '30 days'
    from public.creator_sample_shipments l
   where l.org_id = s.org_id and l.creator_record_id = s.creator_record_id and l.asin = s.asin
     and s.state = 'placed' and s.mask is not null and s.mask_purge_after is null and app.creator_mcf_lane_delivered_at(l) is not null;
  get diagnostics v_scheduled = row_count;
  -- Backstop for a send that never ends and never reads delivered (a lost carrier scan, a send left
  -- escalated): its mask lasts no longer than the 7-day settlement ladder plus 30 days after sealing.
  update public.creator_mcf_sends set mask_purge_after = now()
   where mask is not null and mask_purge_after is null and created_at <= now() - interval '37 days';
  get diagnostics v_backstop = row_count;
  with purged as (
    update public.creator_mcf_sends set mask = null where mask is not null and mask_purge_after <= now() returning *
  )
  insert into public.creator_mcf_send_events(org_id, send_id, event, actor_type, before_state, after_state, reason)
    select org_id, id, 'mask_purged', 'system', state, state, 'retention' from purged;
  get diagnostics v_purged = row_count;
  return jsonb_build_object('scheduled', v_scheduled, 'backstop', v_backstop, 'purged', v_purged);
end;
$$;

-- For WP-338n's alerts: condition codes, counts and send ids. No mask, address or creator record id.
create function app.creator_mcf_alert_summary() returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_residue jsonb;
begin
  perform app.assert_service_role('creator_mcf_alert_summary');
  v_residue := app.creator_mcf_residue(null);
  return jsonb_build_object('generatedAt', now(), 'conditions', jsonb_build_array(
    (select jsonb_build_object('code', 'uncertain_over_15m', 'count', count(*)::integer,
        'sendIds', coalesce(jsonb_agg(id order by state_changed_at) filter (where rn <= 50), '[]'::jsonb))
      from (select id, state_changed_at, row_number() over (order by state_changed_at) rn from public.creator_mcf_sends
        where state = 'uncertain' and state_changed_at < now() - interval '15 minutes') x),
    (select jsonb_build_object('code', 'lane_escalated', 'count', count(*)::integer,
        'sendIds', coalesce(jsonb_agg(id order by id) filter (where rn <= 50), '[]'::jsonb))
      from (select s.id, row_number() over (order by s.id) rn from public.creator_mcf_sends s
        join public.creator_sample_shipments l on l.org_id = s.org_id and l.creator_record_id = s.creator_record_id and l.asin = s.asin
        where s.state = 'uncertain' and l.order_owner = 'arcana' and l.mcf_settlement = 'escalated') x),
    (select jsonb_build_object('code', 'ladder_exhausted', 'count', count(*)::integer,
        'sendIds', coalesce(jsonb_agg(id order by escalated_at) filter (where rn <= 50), '[]'::jsonb))
      from (select id, escalated_at, row_number() over (order by escalated_at) rn from public.creator_mcf_sends
        where escalation_reason = 'ladder_exhausted' and state in ('accepted', 'uncertain')) x),
    (select jsonb_build_object('code', 'conflict', 'count', count(*)::integer,
        'sendIds', coalesce(jsonb_agg(id order by state_changed_at) filter (where rn <= 50), '[]'::jsonb))
      from (select id, state_changed_at, row_number() over (order by state_changed_at) rn from public.creator_mcf_sends
        where state = 'conflict') x),
    (select jsonb_build_object('code', 'heartbeat_stale', 'count', count(*)::integer, 'sendIds', '[]'::jsonb)
      from app.creator_mcf_grants g where g.revoked_at is null and g.expires_at > now()
        and not exists (select 1 from app.creator_mcf_worker_heartbeats h where h.beat_at >= now() - interval '5 minutes'
          and (g.spapi_connection_id::text || ':' || g.marketplace_id) = any(h.scope))),
    jsonb_build_object('code', 'custody_residue', 'count', (v_residue->>'expiredLive')::integer + (v_residue->>'custodyFreeLive')::integer,
      'sendIds', coalesce((select jsonb_agg(c.send_id order by c.send_id) from (select c.send_id from app.creator_mcf_recipient_custody c
        join public.creator_mcf_sends s on s.id = c.send_id
        where (c.expires_at <= now() and not (s.state = 'dispatching' and s.lease_until > now())) or not app.creator_mcf_custody_held(s.state)
        order by c.send_id limit 50) c), '[]'::jsonb)),
    jsonb_build_object('code', 'authorization_failure', 'count',
      (select count(*)::integer from app.creator_mcf_worker_heartbeats where last_authorization_failure_at >= now() - interval '1 hour')
      + (select count(*)::integer from public.creator_mcf_sends where provider_reason = 'authorization' and updated_at >= now() - interval '1 hour'),
      'sendIds', coalesce((select jsonb_agg(id order by id) from (select id from public.creator_mcf_sends
        where provider_reason = 'authorization' and updated_at >= now() - interval '1 hour' order by id limit 50) a), '[]'::jsonb))
  ));
end;
$$;

-- A placed order Amazon later reports Cancelled or Unfulfillable: failed_after_placement, lane Cancelled.
create function app.creator_mcf_after_observation() returns trigger
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends;
begin
  if new.outcome <> 'found' or new.mcf_status not in ('Cancelled', 'Unfulfillable') then return null; end if;
  perform 1 from public.creator_sample_shipments where org_id = new.org_id and creator_record_id = new.creator_record_id
    and asin = new.asin for update;
  select * into v_send from public.creator_mcf_sends where org_id = new.org_id and derived_order_key = new.derived_order_key
    and state = 'placed' for update;
  if not found or new.read_at <= v_send.placed_at then return null; end if;
  update public.creator_mcf_sends set amazon_status = new.mcf_status where id = v_send.id;
  v_send := app.creator_mcf_move(v_send.id, 'failed_after_placement', 'failed_after_placement', lower(new.mcf_status), 'system', null);
  perform app.creator_mcf_lane_effect(v_send, 'failed_after_placement');
  perform app.creator_mcf_milestone(v_send, 'mcf_send_failed', 'failed_after_placement', 'worker', null, 'failed');
  return null;
end;
$$;
-- Named to fire after WP-334's creator_mcf_observations_settle (AFTER triggers fire by name).
create trigger creator_mcf_observations_settle_placed after insert on public.creator_mcf_observations
  for each row execute function app.creator_mcf_after_observation();

-- ---------------------------------------------------------------------------
-- Privileges and row level security
-- ---------------------------------------------------------------------------

alter table app.creator_mcf_grants enable row level security;
alter table app.creator_mcf_recipient_custody enable row level security;
alter table app.creator_mcf_worker_heartbeats enable row level security;
revoke all on app.creator_mcf_grants, app.creator_mcf_recipient_custody, app.creator_mcf_worker_heartbeats
  from public, anon, authenticated, service_role;

alter table public.creator_mcf_sends enable row level security;
create policy tenant_read on public.creator_mcf_sends for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
alter table public.creator_mcf_send_previews enable row level security;
create policy tenant_read on public.creator_mcf_send_previews for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
alter table public.creator_mcf_send_events enable row level security;
create policy tenant_read on public.creator_mcf_send_events for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
alter table public.creator_mcf_outbox enable row level security;
revoke all on public.creator_mcf_sends, public.creator_mcf_send_previews, public.creator_mcf_send_events, public.creator_mcf_outbox
  from public, anon, authenticated, service_role;
-- Reads only: every write goes through the functions above.
grant select on public.creator_mcf_sends, public.creator_mcf_send_previews, public.creator_mcf_send_events to authenticated;
grant select on public.creator_mcf_sends, public.creator_mcf_send_previews, public.creator_mcf_send_events, public.creator_mcf_outbox
  to service_role;

revoke all on function app.creator_mcf_next_states(text), app.creator_mcf_custody_held(text), app.creator_mcf_terminal(text),
  app.creator_mcf_send_confirmation(integer), app.creator_mcf_b64url_decode(text), app.creator_mcf_b64url(bytea),
  app.creator_mcf_exact_keys(jsonb, text[]), app.creator_mcf_json_int(jsonb, numeric, numeric), app.creator_mcf_codes_valid(text[]),
  app.creator_mcf_mask_valid(jsonb), app.creator_mcf_envelope_valid(jsonb), app.creator_mcf_next_settle_at(timestamptz, timestamptz),
  app.creator_mcf_lane_guard(), app.creator_mcf_grant_guard(), app.creator_mcf_custody_guard(),
  app.creator_mcf_send_guard(), app.creator_mcf_custody_invariant(), app.guard_org_delete_against_unresolved_mcf_send(),
  app.creator_mcf_refusal(text), app.creator_mcf_outcome_valid(jsonb), app.creator_mcf_digests_valid(jsonb),
  app.creator_mcf_counts_valid(jsonb), app.creator_mcf_scope_valid(text[]), app.creator_mcf_usable_bindings(uuid), app.creator_mcf_active_grant(uuid, uuid, text),
  app.creator_mcf_units_on(uuid, uuid, text, timestamptz), app.creator_mcf_latest_preflight(uuid, text),
  app.creator_mcf_lane_refusal(uuid, text, text, text, text),
  app.creator_mcf_event(public.creator_mcf_sends, text, text, text, text, text, text, text[], jsonb, jsonb, integer, timestamptz),
  app.creator_mcf_milestone(public.creator_mcf_sends, text, text, text, uuid, text),
  app.creator_mcf_move(uuid, text, text, text, text, text, text, text[], jsonb, integer, timestamptz),
  app.creator_mcf_lane_effect(public.creator_mcf_sends, text, text), app.creator_mcf_schedule_settle(uuid, timestamptz),
  app.creator_mcf_ladder_start(public.creator_mcf_sends), app.creator_mcf_lookup_valid(public.creator_mcf_sends, jsonb),
  app.creator_mcf_observe(public.creator_mcf_sends, jsonb),
  app.creator_mcf_classify(public.creator_mcf_sends, jsonb), app.creator_mcf_apply_found(uuid, jsonb, text, text),
  app.creator_mcf_sweep(uuid), app.creator_mcf_residue(uuid),
  app.creator_mcf_lane_delivered_at(public.creator_sample_shipments),
  app.creator_mcf_preview_problem(public.creator_mcf_sends, jsonb, text), app.creator_mcf_unsendable(public.creator_mcf_sends, jsonb),
  app.creator_mcf_manager(uuid), app.creator_mcf_after_observation(),
  app.seal_creator_mcf_recipient(uuid, text, text, jsonb), app.refresh_creator_mcf_preview(uuid, uuid),
  app.approve_creator_mcf_send(uuid, uuid, uuid, text, text, uuid), app.withdraw_creator_mcf_send(uuid, uuid),
  app.request_creator_mcf_settle_read(uuid, uuid), app.release_creator_mcf_send(uuid, uuid),
  app.resolve_creator_mcf_conflict(uuid, uuid, uuid), app.creator_mcf_send_gate(uuid), app.read_creator_mcf_lane(uuid, text, text),
  app.claim_creator_mcf_outbox(text, text[], text[]), app.read_creator_mcf_custody(uuid, uuid),
  app.record_creator_mcf_preview(uuid, uuid, text), app.refuse_creator_mcf_preview(uuid, uuid, text, text[]),
  app.release_creator_mcf_claim(uuid, uuid, integer), app.reserve_creator_mcf_dispatch(uuid, uuid, text),
  app.record_creator_mcf_outcome(uuid, uuid, jsonb, jsonb), app.record_creator_mcf_settlement(uuid, jsonb, uuid),
  app.mark_creator_mcf_ladder_exhausted(uuid), app.expire_creator_mcf_custody(), app.creator_mcf_custody_residue(),
  app.record_creator_mcf_heartbeat(text, text[], boolean, boolean, text, timestamptz), app.purge_creator_mcf_masks(),
  app.creator_mcf_alert_summary()
  from public, anon, authenticated, service_role;

grant execute on function app.seal_creator_mcf_recipient(uuid, text, text, jsonb), app.refresh_creator_mcf_preview(uuid, uuid),
  app.approve_creator_mcf_send(uuid, uuid, uuid, text, text, uuid), app.withdraw_creator_mcf_send(uuid, uuid),
  app.request_creator_mcf_settle_read(uuid, uuid), app.release_creator_mcf_send(uuid, uuid),
  app.resolve_creator_mcf_conflict(uuid, uuid, uuid), app.creator_mcf_send_gate(uuid), app.read_creator_mcf_lane(uuid, text, text)
  to authenticated;
grant execute on function app.creator_mcf_send_confirmation(integer) to authenticated, service_role;
grant execute on function app.claim_creator_mcf_outbox(text, text[], text[]), app.read_creator_mcf_custody(uuid, uuid),
  app.record_creator_mcf_preview(uuid, uuid, text), app.refuse_creator_mcf_preview(uuid, uuid, text, text[]),
  app.release_creator_mcf_claim(uuid, uuid, integer), app.reserve_creator_mcf_dispatch(uuid, uuid, text),
  app.record_creator_mcf_outcome(uuid, uuid, jsonb, jsonb), app.record_creator_mcf_settlement(uuid, jsonb, uuid),
  app.mark_creator_mcf_ladder_exhausted(uuid), app.expire_creator_mcf_custody(), app.creator_mcf_custody_residue(),
  app.record_creator_mcf_heartbeat(text, text[], boolean, boolean, text, timestamptz), app.purge_creator_mcf_masks(),
  app.creator_mcf_alert_summary()
  to service_role;

-- ---------------------------------------------------------------------------
-- Scheduled maintenance (the 20260813121000_cron.sql pattern: pg_cron is the trigger, never the
-- logic). The general worker's housekeeping pass (WP-338n) runs the same two functions, so a
-- project without pg_cron still expires custody every 5 minutes and purges masks daily. Migrations
-- after WP-186 carry no top-level DO block (migration-lock-safety), so the conditional runs in a
-- one-shot function that is dropped again.
-- ---------------------------------------------------------------------------
create function app.creator_mcf_schedule_maintenance() returns void
  language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule() not present; creator MCF custody expiry and mask purge not scheduled. The functions remain callable.';
    return;
  end if;
  perform cron.schedule('wizard-ads-creator-mcf-expire', '*/5 * * * *', 'select app.expire_creator_mcf_custody()');
  perform cron.schedule('wizard-ads-creator-mcf-mask-purge', '20 3 * * *', 'select app.purge_creator_mcf_masks()');
end;
$$;
select app.creator_mcf_schedule_maintenance();
drop function app.creator_mcf_schedule_maintenance();

-- Creator Connections round 3b (WP-338i): the guarded Amazon cancel of an order Arcana placed, and
-- two ledger follow-ups from the WP-338e review. Follows 20260928120000_creator_mcf_send.
--
-- Cancelling an Amazon order is an Amazon write under the ten clauses of AGENTS.md. Nothing here
-- calls Amazon; the MCF worker does, and only after these functions allow it:
--
--   1. An owner or admin asks for a cancel preview of a placed or conflicting send
--      (request_creator_mcf_cancel_preview). The worker reads getFulfillmentOrder for the send's
--      order key and records it (record_creator_mcf_cancel_preview). Only a read showing Received
--      or Planning becomes a cancel preview: an immutable, address-free row of kind cancel_preview,
--      valid for at most 5 minutes after the read.
--   2. The press on "Cancel 1 order in Amazon" (approve_creator_mcf_cancel) recomputes the wording
--      here, and needs the newest cancel preview, its fingerprint, a read at most 5 minutes old, a
--      newest observation of the key that still shows Received or Planning, an owner or admin, and
--      an active grant carrying the action class 'cancel'. It records one cancel row and queues
--      cancel work. The send does not move: a refusal before the PUT leaves it where it was.
--   3. The worker claims the work within 15 minutes, reads the order again and hands that read to
--      reserve_creator_mcf_cancel, which rechecks the approver, the grant and the send, records the
--      read, and grants exactly one PUT (cancel_once) only while the read shows Received or
--      Planning. Processing or later ends the cancel as refused ("Amazon is already picking this
--      unit"). A reservation moves the send placed|conflict -> cancel_requested -> cancel_dispatching
--      in one transaction; a second call answers already_reserved and never grants another PUT.
--   4. The PUT's answer is recorded (record_creator_mcf_cancel_outcome) but settles nothing by
--      itself. Only a read of the order key taken after the reservation does: Cancelled ends the
--      send cancelled and the lane Cancelled with operator_cancelled_in_amazon; a status that can
--      no longer be cancelled ends it placed (the cancel was not honoured). The observation trigger
--      applies every such read, from the worker's settlement ladder or from mcf.observe, so an
--      ambiguous PUT is settled by reads and never sent again.
--
-- A request that certainly did not take (the worker withheld it before it left, or Amazon answered 429
-- or 401/403) ends the cancel as not_sent; a send cancelled from placed then returns to placed, so the
-- operator can try again while the order is still Received or Planning. A cancel_dispatching send
-- takes "Ask Amazon for this order id", and one unsettled for 15 minutes is in the alert summary.
--
-- A sent order's recipient custody is already destroyed; no cancel step reads or writes custody.
--
-- Follow-ups folded in: record_creator_mcf_settlement marks a 7-day ladder exhausted in the read's
-- own transaction (a crash between the last read and the worker's mark cannot leave it unmarked),
-- and app.creator_mcf_active_key_ids lets the MCF unit check at start-up that it holds a key file for
-- every recipient key id an active grant in its scope names.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- ---------------------------------------------------------------------------
-- Widening
-- ---------------------------------------------------------------------------

alter table public.creator_mcf_send_events drop constraint creator_mcf_send_events_event_check;
alter table public.creator_mcf_send_events add constraint creator_mcf_send_events_event_check check (event in ('sealed', 'superseded',
  'preview_claimed', 'custody_read', 'preview_recorded', 'preview_refused', 'refresh_requested', 'approved', 'dispatch_claimed',
  'dispatch_reread', 'stale', 'deferred', 'withdrawn', 'reserved', 'reserve_refused', 'outcome_recorded', 'late_outcome',
  'settlement_read', 'custody_destroyed', 'expired', 'expired_unclaimed', 'crash_uncertain', 'conflict_resolved', 'ladder_exhausted',
  'settle_read_requested', 'released', 'failed_after_placement', 'mask_purged',
  'cancel_preview_requested', 'cancel_preview_recorded', 'cancel_preview_refused', 'cancel_approved', 'cancel_claimed',
  'cancel_requested', 'cancel_reserved', 'cancel_refused', 'cancel_expired', 'cancel_outcome', 'cancel_late_outcome', 'cancelled',
  'cancel_not_honoured', 'cancel_not_sent'));

-- A cancel preview is a getOrder read at most 5 minutes old (CREATOR_MCF_CANCEL_PREVIEW_VALID_MS).
alter table public.creator_mcf_send_previews add constraint creator_mcf_send_previews_cancel_window
  check (kind <> 'cancel_preview' or valid_until <= read_at + interval '5 minutes');

-- The cancel button's exact text, the same rule as creatorMcfCancelConfirmation. Null outside 1 to 20.
create function app.creator_mcf_cancel_confirmation(p_orders integer) returns text
  language sql immutable parallel safe set search_path = pg_catalog as $$
  select case when p_orders between 1 and 20
    then 'Cancel ' || p_orders::text || case when p_orders = 1 then ' order' else ' orders' end || ' in Amazon' end
$$;

-- ---------------------------------------------------------------------------
-- The cancel ledger
-- ---------------------------------------------------------------------------

-- One row per press on "Cancel 1 order in Amazon". The approval is immutable; the reservation, the
-- PUT's answer and the ending are each written once. At most one open cancel per send. Like the
-- grants and the custody table, no client role holds any privilege on it: only the functions below
-- reach it, and read_creator_mcf_lane shows owners, admins and analysts what it says.
create table app.creator_mcf_cancels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  send_id uuid not null references public.creator_mcf_sends(id) on delete cascade,
  -- The send's state at the press; the reservation requires it unchanged.
  origin_state text not null check (origin_state in ('placed', 'conflict')),
  preview_id uuid not null references public.creator_mcf_send_previews(id) on delete cascade,
  preview_fingerprint text not null check (preview_fingerprint ~ '^[0-9a-f]{64}$'),
  approved_by uuid not null,
  approved_membership_created_at timestamptz not null,
  approved_at timestamptz not null,
  confirmation_text text not null check (confirmation_text = app.creator_mcf_cancel_confirmation(1)),
  request_id uuid not null unique,
  -- The grant that allowed the press; the reservation refuses under any other.
  grant_id uuid not null,
  claim_deadline timestamptz not null,
  -- The one permission to PUT, and the lease that holds it.
  lease_id uuid,
  reserved_at timestamptz,
  -- Digest of the address-free cancel request (the order key, the marketplace and the operation).
  request_digest text check (request_digest ~ '^[0-9a-f]{64}$'),
  puts smallint not null default 0 check (puts between 0 and 1),
  provider_outcome text check (provider_outcome in ('accepted', 'rejected', 'uncertain')),
  provider_reason text check (provider_reason in ('validation', 'authorization', 'throttled', 'other', 'transport', 'http_5xx',
    'http_408', 'decode', 'crash')),
  provider_status integer check (provider_status between 100 and 599),
  provider_codes text[] check (provider_codes is null or app.creator_mcf_codes_valid(provider_codes)),
  outcome_recorded_at timestamptz,
  ended_at timestamptz,
  -- cancelled and not_honoured follow a PUT that may have taken; not_sent is a reserved PUT that certainly did not (never
  -- left, or answered 429 or 401/403); refused and expired end before any reservation.
  ending text check (ending in ('cancelled', 'not_honoured', 'not_sent', 'refused', 'expired')),
  ending_reason text check (ending_reason ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  check (claim_deadline = approved_at + interval '15 minutes'),
  check ((reserved_at is null) = (puts = 0) and (reserved_at is null) = (request_digest is null) and (reserved_at is null) = (lease_id is null)),
  check ((ended_at is null) = (ending is null) and (ended_at is null) = (ending_reason is null)),
  check ((provider_outcome is null) = (outcome_recorded_at is null)),
  check (provider_outcome is null or reserved_at is not null),
  check (provider_outcome is not null or (provider_status is null and provider_codes is null and provider_reason is null)),
  check (ending is null or (ending in ('cancelled', 'not_honoured', 'not_sent')) = (reserved_at is not null))
);
create unique index creator_mcf_cancels_one_open on app.creator_mcf_cancels(send_id) where ended_at is null;
create index creator_mcf_cancels_send on app.creator_mcf_cancels(send_id, approved_at desc);
create index creator_mcf_cancels_due on app.creator_mcf_cancels(claim_deadline) where ended_at is null and reserved_at is null;

-- The approval never changes; the reservation, the answer and the ending are each written once; a
-- whole-org purge may delete (the creator_refuse_rewrite rule).
create function app.creator_mcf_cancel_guard() returns trigger
  language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 and not exists (select 1 from public.orgs where id = old.org_id) then return old; end if;
    raise exception 'creator MCF cancels are never deleted' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.reserved_at is not null or new.puts <> 0 or new.provider_outcome is not null or new.ended_at is not null then
      raise exception 'a creator MCF cancel starts approved and open' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.id, new.org_id, new.send_id, new.origin_state, new.preview_id, new.preview_fingerprint, new.approved_by,
      new.approved_membership_created_at, new.approved_at, new.confirmation_text, new.request_id, new.grant_id, new.claim_deadline,
      new.created_at)
    is distinct from (old.id, old.org_id, old.send_id, old.origin_state, old.preview_id, old.preview_fingerprint, old.approved_by,
      old.approved_membership_created_at, old.approved_at, old.confirmation_text, old.request_id, old.grant_id, old.claim_deadline,
      old.created_at) then
    raise exception 'a creator MCF cancel approval is immutable' using errcode = '23514';
  end if;
  if (old.reserved_at is not null and (new.reserved_at, new.request_digest, new.puts, new.lease_id)
        is distinct from (old.reserved_at, old.request_digest, old.puts, old.lease_id))
    or (old.reserved_at is null and new.reserved_at is not null and old.ended_at is not null)
    or (old.provider_outcome is not null and (new.provider_outcome, new.provider_reason, new.provider_status, new.provider_codes,
        new.outcome_recorded_at) is distinct from (old.provider_outcome, old.provider_reason, old.provider_status, old.provider_codes,
        old.outcome_recorded_at))
    or (old.ended_at is not null and (new.ended_at, new.ending, new.ending_reason) is distinct from (old.ended_at, old.ending, old.ending_reason)) then
    raise exception 'a creator MCF cancel''s recorded evidence is write-once' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger creator_mcf_cancels_guard before insert or update or delete on app.creator_mcf_cancels
  for each row execute function app.creator_mcf_cancel_guard();

alter table app.creator_mcf_cancels enable row level security;
revoke all on app.creator_mcf_cancels from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Internal helpers (owner only)
-- ---------------------------------------------------------------------------

-- The active grant that allows cancels for (org, connection, marketplace).
create function app.creator_mcf_cancel_grant(p_org uuid, p_connection uuid, p_marketplace text) returns app.creator_mcf_grants
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select * from app.creator_mcf_grants where org_id = p_org and spapi_connection_id = p_connection
    and marketplace_id = p_marketplace and revoked_at is null and expires_at > now() and 'cancel' = any(action_classes)
$$;

-- Ends one open cancel, with its event when p_event is given, and closes its queued work.
create function app.creator_mcf_end_cancel(p_cancel uuid, p_ending text, p_reason text, p_event text, p_actor_type text,
  p_actor_id text, p_codes text[] default '{}') returns app.creator_mcf_cancels
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_cancel app.creator_mcf_cancels; v_send public.creator_mcf_sends;
begin
  update app.creator_mcf_cancels set ended_at = now(), ending = p_ending, ending_reason = p_reason
    where id = p_cancel and ended_at is null returning * into v_cancel;
  if not found then
    raise exception 'the creator MCF cancel already ended' using errcode = '55000';
  end if;
  if p_event is not null then
    select * into strict v_send from public.creator_mcf_sends where id = v_cancel.send_id;
    perform app.creator_mcf_event(v_send, p_event, p_actor_type, p_actor_id, v_send.state, v_send.state, p_reason, coalesce(p_codes, '{}'));
  end if;
  update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
    where send_id = v_cancel.send_id and action = 'cancel' and completed_at is null;
  return v_cancel;
end;
$$;

-- Approvals the worker did not reserve within 15 minutes end as expired. Nothing was sent. A queued
-- preview read that can no longer be served (the send moved, or no active grant carries 'cancel') is
-- closed with a recorded refusal, so the screens stop waiting for it.
create function app.creator_mcf_cancel_sweep(p_org uuid) returns integer
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_row record; v_cancel app.creator_mcf_cancels; v_send public.creator_mcf_sends; v_n integer := 0;
begin
  for v_row in select o.id, s.id as send_id, s.org_id, s.creator_record_id, s.asin from public.creator_mcf_outbox o
      join public.creator_mcf_sends s on s.id = o.send_id
      where o.action = 'cancel' and o.completed_at is null and (o.lease_until is null or o.lease_until < now())
        and (p_org is null or s.org_id = p_org)
        and not exists (select 1 from app.creator_mcf_cancels c where c.send_id = s.id and c.ended_at is null)
        and (s.state not in ('placed', 'conflict') or not exists (select 1 from app.creator_mcf_grants g where g.org_id = s.org_id
          and g.spapi_connection_id = s.spapi_connection_id and g.marketplace_id = s.marketplace_id and g.revoked_at is null
          and g.expires_at > now() and 'cancel' = any(g.action_classes)))
      order by o.id loop
    perform 1 from public.creator_sample_shipments where org_id = v_row.org_id and creator_record_id = v_row.creator_record_id
      and asin = v_row.asin for update skip locked;
    if not found then continue; end if;
    select * into v_send from public.creator_mcf_sends where id = v_row.send_id for update skip locked;
    if not found then continue; end if;
    update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
      where id = v_row.id and completed_at is null and (lease_until is null or lease_until < now());
    if not found then continue; end if;
    perform app.creator_mcf_event(v_send, 'cancel_preview_refused', 'system', null, v_send.state, v_send.state,
      case when v_send.state in ('placed', 'conflict') then 'grant_inactive' else 'state_changed' end);
  end loop;
  for v_row in select c.id, s.org_id, s.creator_record_id, s.asin from app.creator_mcf_cancels c
      join public.creator_mcf_sends s on s.id = c.send_id
      where c.ended_at is null and c.reserved_at is null and c.claim_deadline < now() and (p_org is null or c.org_id = p_org)
      order by c.id loop
    perform 1 from public.creator_sample_shipments where org_id = v_row.org_id and creator_record_id = v_row.creator_record_id
      and asin = v_row.asin for update skip locked;
    if not found then continue; end if;
    select * into v_cancel from app.creator_mcf_cancels where id = v_row.id for update skip locked;
    if not found or v_cancel.ended_at is not null or v_cancel.reserved_at is not null or not (v_cancel.claim_deadline < now()) then
      continue;
    end if;
    perform app.creator_mcf_end_cancel(v_cancel.id, 'expired', 'claim_deadline', 'cancel_expired', 'system', null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Checks a worker cancel preview body against its send and the read it was built from; returns the
-- problem, or null. The shared CreatorMcfCancelPreview: identity, the order's status (Received or
-- Planning), its items in Amazon's order with positional line ids, the unit total and a 5-minute
-- validity. Checks run in order, so no cast is reached before its shape is known.
create function app.creator_mcf_cancel_preview_problem(p_send public.creator_mcf_sends, p_body jsonb, p_lookup jsonb) returns text
  language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare v_read timestamptz; v_until timestamptz; v_item jsonb; v_read_item jsonb; v_index integer := 0; v_sum integer := 0;
begin
  if not app.creator_mcf_exact_keys(p_body, array['previewId', 'sendId', 'derivedOrderKey', 'reservationId', 'spapiConnectionId',
      'marketplaceId', 'readAt', 'validUntil', 'workerRevision', 'kind', 'existingOrder', 'items', 'totalUnits']) then
    return 'preview_shape';
  end if;
  if p_body->'kind' is distinct from '"cancel_preview"'::jsonb or jsonb_typeof(p_body->'previewId') <> 'string'
    or p_body->>'previewId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_body->'workerRevision') <> 'string' or p_body->>'workerRevision' !~ '^[A-Za-z0-9._-]{1,64}$' then
    return 'preview_shape';
  end if;
  if p_body->'sendId' is distinct from to_jsonb(p_send.id::text) or p_body->'derivedOrderKey' is distinct from to_jsonb(p_send.derived_order_key)
    or p_body->'reservationId' is distinct from to_jsonb(p_send.reservation_id)
    or p_body->'spapiConnectionId' is distinct from to_jsonb(p_send.spapi_connection_id::text)
    or p_body->'marketplaceId' is distinct from to_jsonb(p_send.marketplace_id) then
    return 'preview_identity';
  end if;
  if jsonb_typeof(p_body->'readAt') <> 'string' or jsonb_typeof(p_body->'validUntil') <> 'string' then return 'preview_timing'; end if;
  begin
    v_read := (p_body->>'readAt')::timestamptz;
    v_until := (p_body->>'validUntil')::timestamptz;
  exception when others then
    return 'preview_timing';
  end;
  if not (v_until > v_read and v_until <= v_read + interval '5 minutes')
    or v_read > now() + interval '1 minute' or v_read < now() - interval '5 minutes'
    or v_read is distinct from (p_lookup->>'readAt')::timestamptz then
    return 'preview_timing';
  end if;
  if not app.creator_mcf_exact_keys(p_body->'existingOrder', array['status'])
    or p_body->'existingOrder'->'status' not in ('"Received"'::jsonb, '"Planning"'::jsonb)
    or p_body->'existingOrder'->'status' is distinct from p_lookup->'status' then
    return 'preview_order';
  end if;
  if jsonb_typeof(p_body->'items') <> 'array' or jsonb_array_length(p_body->'items') not between 1 and 20
    or jsonb_array_length(p_body->'items') <> jsonb_array_length(p_lookup->'items') or not app.creator_mcf_json_int(p_body->'totalUnits', 1, 20) then
    return 'preview_items';
  end if;
  for v_item in select value from jsonb_array_elements(p_body->'items') loop
    v_read_item := p_lookup->'items'->v_index;
    v_index := v_index + 1;
    if not app.creator_mcf_exact_keys(v_item, array['sellerSku', 'sellerFulfillmentOrderItemId', 'quantity'])
      or jsonb_typeof(v_item->'sellerSku') <> 'string' or v_item->>'sellerSku' !~ '^[\x20-\x7e]{1,50}$'
      or v_item->'sellerSku' is distinct from v_read_item->'sellerSku'
      or v_item->'sellerFulfillmentOrderItemId' is distinct from to_jsonb(p_send.derived_order_key || '-' || v_index::text)
      or not app.creator_mcf_json_int(v_item->'quantity', 1, 20) or v_item->'quantity' is distinct from v_read_item->'quantity' then
      return 'preview_items';
    end if;
    v_sum := v_sum + (v_item->>'quantity')::integer;
  end loop;
  if v_sum <> (p_body->>'totalUnits')::integer then return 'preview_items'; end if;
  return null;
end;
$$;

-- What the send's lane becomes (DESIGN 6.2), under the ledger marker. Replaces WP-338d's version to
-- add 'cancelled' (cancelled through Arcana: lane Cancelled, operator_cancelled_in_amazon).
create or replace function app.creator_mcf_lane_effect(p_send public.creator_mcf_sends, p_effect text, p_reconciliation text default null)
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
  elsif p_effect = 'cancelled' then
    update public.creator_sample_shipments set lane_state = 'Cancelled', order_owner = 'arcana',
        cancellation_reason = 'operator_cancelled_in_amazon', cancelled_at = now(), reconciliation_reason = null, updated_at = now()
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

-- One read of the order key, taken after the cancel's reservation, applied to a cancel_dispatching
-- send. Cancelled ends it cancelled; a status that can no longer be cancelled ends it placed (the
-- cancel was not honoured), and a failed one then failed_after_placement; New, Received and Planning
-- leave it waiting. The caller holds the lane lock. Returns the send's state.
create function app.creator_mcf_apply_cancel_read(p_send uuid, p_status text, p_read_at timestamptz) returns text
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_cancel app.creator_mcf_cancels;
begin
  select * into strict v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.state <> 'cancel_dispatching' then return v_send.state; end if;
  select * into v_cancel from app.creator_mcf_cancels where send_id = p_send and ended_at is null and reserved_at is not null for update;
  -- Only a read after the reservation says anything about the cancel.
  if not found or p_read_at <= v_cancel.reserved_at or p_status in ('New', 'Received', 'Planning') then return v_send.state; end if;
  update public.creator_mcf_sends set amazon_status = p_status where id = p_send;
  if p_status = 'Cancelled' then
    v_send := app.creator_mcf_move(p_send, 'cancelled', 'cancelled', 'operator_cancelled_in_amazon', 'system', null);
    perform app.creator_mcf_lane_effect(v_send, 'cancelled');
    perform app.creator_mcf_milestone(v_send, 'mcf_send_cancelled', 'operator_cancelled_in_amazon', 'worker', null, 'cancelled');
    perform app.creator_mcf_end_cancel(v_cancel.id, 'cancelled', 'operator_cancelled_in_amazon', null, null, null);
    return 'cancelled';
  end if;
  -- Processing, Complete, CompletePartialled, Invalid or Unfulfillable: Amazon did not cancel at Arcana's request.
  -- The shared map's only way on from cancel_dispatching is placed.
  v_send := app.creator_mcf_move(p_send, 'placed', 'cancel_not_honoured', lower(p_status), 'system', null);
  if v_cancel.origin_state = 'conflict' and p_status not in ('Invalid', 'Unfulfillable') then
    -- A placed origin's lane is already Confirmed; a conflicting order Amazon is fulfilling becomes Confirmed now. The send
    -- keeps its write-once conflict escalation, so screens and the MCP outcome still flag it. (A failed order passes
    -- through placed only as a state and is never recorded as a placement.)
    perform app.creator_mcf_lane_effect(v_send, 'placed');
    perform app.creator_mcf_milestone(v_send, 'mcf_send_placed', 'cancel_not_honoured', 'worker', null, 'placed');
  end if;
  perform app.creator_mcf_end_cancel(v_cancel.id, 'not_honoured', lower(p_status), null, null, null);
  if p_status in ('Invalid', 'Unfulfillable') then
    v_send := app.creator_mcf_move(p_send, 'failed_after_placement', 'failed_after_placement', lower(p_status), 'system', null);
    perform app.creator_mcf_lane_effect(v_send, 'failed_after_placement');
    perform app.creator_mcf_milestone(v_send, 'mcf_send_failed', 'failed_after_placement', 'worker', null, 'failed');
    return 'failed_after_placement';
  end if;
  return 'placed';
end;
$$;

-- A reserved cancel request that certainly did not take. From placed the send returns to placed and the
-- cancel ends not_sent, so a new press can follow while the order is still cancellable. From conflict the
-- shared map has no way back to conflict, so the send stays cancel_dispatching (reads settle it) and only
-- the event is recorded. The caller holds the lane and send locks. Returns the send's state.
create function app.creator_mcf_cancel_not_sent(p_send uuid, p_cancel uuid, p_reason text) returns text
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_cancel app.creator_mcf_cancels;
begin
  select * into strict v_send from public.creator_mcf_sends where id = p_send;
  select * into strict v_cancel from app.creator_mcf_cancels where id = p_cancel;
  if v_send.state <> 'cancel_dispatching' or v_cancel.ended_at is not null then return v_send.state; end if;
  if v_cancel.origin_state <> 'placed' then
    perform app.creator_mcf_event(v_send, 'cancel_not_sent', 'worker', null, v_send.state, v_send.state, p_reason);
    return v_send.state;
  end if;
  v_send := app.creator_mcf_move(p_send, 'placed', 'cancel_not_sent', p_reason, 'worker', null);
  perform app.creator_mcf_end_cancel(v_cancel.id, 'not_sent', p_reason, null, null, null);
  return 'placed';
end;
$$;

-- Replaces WP-338d's trigger function: a placed order Amazon later reports Cancelled or Unfulfillable
-- is failed_after_placement (unchanged), and a read of a cancel_dispatching send's own key settles
-- the cancel (WP-338i). Named to fire after WP-334's creator_mcf_observations_settle.
create or replace function app.creator_mcf_after_observation() returns trigger
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends;
begin
  if new.outcome <> 'found' or new.mcf_status in ('New', 'Received', 'Planning') then return null; end if;
  perform 1 from public.creator_sample_shipments where org_id = new.org_id and creator_record_id = new.creator_record_id
    and asin = new.asin for update;
  select * into v_send from public.creator_mcf_sends where org_id = new.org_id and derived_order_key = new.derived_order_key
    and state in ('placed', 'cancel_dispatching') for update;
  if not found then return null; end if;
  if v_send.state = 'cancel_dispatching' then
    if new.operation = 'getFulfillmentOrder' and new.queried_order_id = v_send.derived_order_key then
      perform app.creator_mcf_apply_cancel_read(v_send.id, new.mcf_status, new.read_at);
    end if;
    return null;
  end if;
  if new.mcf_status not in ('Cancelled', 'Unfulfillable') or new.read_at <= v_send.placed_at then return null; end if;
  update public.creator_mcf_sends set amazon_status = new.mcf_status where id = v_send.id;
  v_send := app.creator_mcf_move(v_send.id, 'failed_after_placement', 'failed_after_placement', lower(new.mcf_status), 'system', null);
  perform app.creator_mcf_lane_effect(v_send, 'failed_after_placement');
  perform app.creator_mcf_milestone(v_send, 'mcf_send_failed', 'failed_after_placement', 'worker', null, 'failed');
  return null;
end;
$$;

-- Escalates an accepted or uncertain send whose 7-day ladder is over. True when this call escalated it.
create function app.creator_mcf_ladder_mark(p_send uuid) returns boolean
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends;
begin
  select * into strict v_send from public.creator_mcf_sends where id = p_send;
  if v_send.state not in ('accepted', 'uncertain') or v_send.escalated_at is not null
    or now() < app.creator_mcf_ladder_start(v_send) + interval '7 days' then
    return false;
  end if;
  update public.creator_mcf_sends set escalated_at = now(), escalation_reason = 'ladder_exhausted' where id = p_send returning * into v_send;
  perform app.creator_mcf_schedule_settle(p_send, null);
  perform app.creator_mcf_event(v_send, 'ladder_exhausted', 'worker', null, v_send.state, v_send.state, 'ladder_exhausted', '{}', '{}',
    jsonb_build_object('reads', v_send.settle_reads));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authenticated functions (owner or admin)
-- ---------------------------------------------------------------------------

-- "Cancel in Amazon": asks the worker for a cancel preview (one getOrder read) of a placed or
-- conflicting send. Needs an active grant with the action class 'cancel'. Idempotent while a read is
-- queued.
create function app.request_creator_mcf_cancel_preview(p_org uuid, p_send uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends; v_grant app.creator_mcf_grants;
begin
  v_member := app.creator_mcf_manager(p_org);
  perform app.creator_mcf_cancel_sweep(p_org);
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.state not in ('placed', 'conflict') then return app.creator_mcf_refusal('send_not_cancellable'); end if;
  if exists (select 1 from app.creator_mcf_cancels where send_id = p_send and ended_at is null) then
    return app.creator_mcf_refusal('cancel_open');
  end if;
  v_grant := app.creator_mcf_cancel_grant(p_org, v_send.spapi_connection_id, v_send.marketplace_id);
  if v_grant.id is null then return app.creator_mcf_refusal('cancel_grant_inactive'); end if;
  update public.creator_mcf_outbox set available_at = now() where send_id = p_send and action = 'cancel' and completed_at is null;
  if not found then
    insert into public.creator_mcf_outbox(send_id, action) values (p_send, 'cancel');
  end if;
  perform app.creator_mcf_event(v_send, 'cancel_preview_requested', 'user', auth.uid()::text, v_send.state, v_send.state, null, '{}', '{}',
    '{}', null, v_member);
  return jsonb_build_object('outcome', 'cancel_preview_requested', 'replay', false, 'sendId', p_send, 'state', v_send.state);
end;
$$;

-- The press on "Cancel 1 order in Amazon". The wording is recomputed here; the preview must be this
-- send's newest cancel preview, carry the fingerprint the browser showed, be at most 5 minutes old and
-- show Received or Planning; the newest observation of the key must agree and be at most 5 minutes
-- old; the grant must carry 'cancel' (its row is locked). Records the cancel and queues the work;
-- the send stays placed or conflict until the worker reserves. Idempotent on p_request.
create function app.approve_creator_mcf_cancel(p_org uuid, p_send uuid, p_preview uuid, p_fingerprint text, p_confirmation text,
  p_request uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends; v_preview public.creator_mcf_send_previews; v_newest uuid;
  v_read record; v_grant app.creator_mcf_grants; v_cancel app.creator_mcf_cancels;
begin
  v_member := app.creator_mcf_manager(p_org);
  perform app.creator_mcf_cancel_sweep(p_org);
  if p_send is null or p_preview is null or p_request is null or p_fingerprint is null or p_confirmation is null then
    raise exception 'Invalid creator MCF cancel approval' using errcode = '22023';
  end if;
  select * into v_cancel from app.creator_mcf_cancels where request_id = p_request;
  if found then
    if v_cancel.org_id = p_org and v_cancel.send_id = p_send and v_cancel.preview_id = p_preview and v_cancel.approved_by = auth.uid()
      and v_cancel.preview_fingerprint = p_fingerprint and v_cancel.confirmation_text = p_confirmation then
      select * into v_send from public.creator_mcf_sends where id = p_send;
      return jsonb_build_object('outcome', 'cancel_approved', 'replay', true, 'sendId', p_send, 'state', v_send.state,
        'cancelId', v_cancel.id, 'claimDeadline', v_cancel.claim_deadline);
    end if;
    return app.creator_mcf_refusal('request_reused');
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  -- A concurrent replay of the same press may have committed while this call waited for the lane.
  select * into v_cancel from app.creator_mcf_cancels where request_id = p_request;
  if found then
    if v_cancel.send_id = p_send and v_cancel.preview_id = p_preview and v_cancel.approved_by = auth.uid()
      and v_cancel.preview_fingerprint = p_fingerprint and v_cancel.confirmation_text = p_confirmation then
      return jsonb_build_object('outcome', 'cancel_approved', 'replay', true, 'sendId', p_send, 'state', v_send.state,
        'cancelId', v_cancel.id, 'claimDeadline', v_cancel.claim_deadline);
    end if;
    return app.creator_mcf_refusal('request_reused');
  end if;
  if v_send.state not in ('placed', 'conflict') then return app.creator_mcf_refusal('send_not_cancellable'); end if;
  if exists (select 1 from app.creator_mcf_cancels where send_id = p_send and ended_at is null) then
    return app.creator_mcf_refusal('cancel_open');
  end if;
  select id into v_newest from public.creator_mcf_send_previews where send_id = p_send and kind = 'cancel_preview'
    order by recorded_at desc, id desc limit 1;
  select * into v_preview from public.creator_mcf_send_previews where id = p_preview and send_id = p_send and kind = 'cancel_preview';
  if not found or v_newest is distinct from p_preview then return app.creator_mcf_refusal('preview_not_latest'); end if;
  if v_preview.fingerprint <> p_fingerprint then return app.creator_mcf_refusal('fingerprint_mismatch'); end if;
  if not (now() < v_preview.valid_until and now() < v_preview.read_at + interval '5 minutes') then
    return app.creator_mcf_refusal('cancel_preview_expired');
  end if;
  if v_preview.body->'existingOrder'->>'status' is null or v_preview.body->'existingOrder'->>'status' not in ('Received', 'Planning') then
    return app.creator_mcf_refusal('order_not_cancellable');
  end if;
  -- The newest read of this order key, from any reader, must still say the order can be cancelled.
  select o.outcome, o.mcf_status, o.read_at into v_read from public.creator_mcf_observations o
   where o.org_id = p_org and o.derived_order_key = v_send.derived_order_key and o.read_at <= now() + interval '1 minute'
   order by o.read_at desc, o.recorded_at desc limit 1;
  if not found or v_read.read_at < now() - interval '5 minutes' then return app.creator_mcf_refusal('observation_stale'); end if;
  if v_read.outcome <> 'found' or v_read.mcf_status not in ('Received', 'Planning') then
    return app.creator_mcf_refusal('order_not_cancellable');
  end if;
  -- One send is one order: the button names exactly one.
  if p_confirmation is distinct from app.creator_mcf_cancel_confirmation(1) then return app.creator_mcf_refusal('confirmation_mismatch'); end if;
  select * into v_grant from app.creator_mcf_grants where org_id = p_org and spapi_connection_id = v_send.spapi_connection_id
    and marketplace_id = v_send.marketplace_id and revoked_at is null and expires_at > now() and 'cancel' = any(action_classes)
    for update;
  if not found then return app.creator_mcf_refusal('cancel_grant_inactive'); end if;
  insert into app.creator_mcf_cancels(org_id, send_id, origin_state, preview_id, preview_fingerprint, approved_by,
      approved_membership_created_at, approved_at, confirmation_text, request_id, grant_id, claim_deadline)
    values (p_org, p_send, v_send.state, p_preview, p_fingerprint, auth.uid(), v_member, now(), p_confirmation, p_request, v_grant.id,
      now() + interval '15 minutes')
    returning * into v_cancel;
  update public.creator_mcf_outbox set available_at = now() where send_id = p_send and action = 'cancel' and completed_at is null;
  if not found then
    insert into public.creator_mcf_outbox(send_id, action) values (p_send, 'cancel');
  end if;
  perform app.creator_mcf_event(v_send, 'cancel_approved', 'user', auth.uid()::text, v_send.state, v_send.state, null, '{}',
    jsonb_build_object('previewFingerprint', p_fingerprint), jsonb_build_object('orders', 1), null, v_member);
  return jsonb_build_object('outcome', 'cancel_approved', 'replay', false, 'sendId', p_send, 'state', v_send.state,
    'cancelId', v_cancel.id, 'claimDeadline', v_cancel.claim_deadline);
end;
$$;

-- Replaces WP-338d's lane read: the same answer, plus the send's newest cancel, its newest cancel
-- preview, whether a cancel preview read is queued, and the refusal of the newest cancel preview request.
create or replace function app.read_creator_mcf_lane(p_org uuid, p_record text, p_asin text) returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_lane public.creator_sample_shipments; v_send public.creator_mcf_sends; v_preview public.creator_mcf_send_previews;
  v_custody timestamptz; v_cancel app.creator_mcf_cancels; v_cancel_preview public.creator_mcf_send_previews;
  v_requested timestamptz; v_refusal public.creator_mcf_send_events;
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
    select * into v_cancel from app.creator_mcf_cancels where send_id = v_send.id order by approved_at desc, id desc limit 1;
    select * into v_cancel_preview from public.creator_mcf_send_previews where send_id = v_send.id and kind = 'cancel_preview'
      order by recorded_at desc, id desc limit 1;
    select max(at) into v_requested from public.creator_mcf_send_events where send_id = v_send.id and event = 'cancel_preview_requested';
    select * into v_refusal from public.creator_mcf_send_events where send_id = v_send.id and event = 'cancel_preview_refused'
      and at > coalesce(v_requested, '-infinity'::timestamptz) order by at desc, id desc limit 1;
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
        from (select * from public.creator_mcf_send_events where send_id = v_send.id order by at desc, id desc limit 20) e), '[]'::jsonb),
      'cancel', case when v_cancel.id is null then null else jsonb_build_object('cancelId', v_cancel.id,
        'originState', v_cancel.origin_state, 'approvedAt', v_cancel.approved_at, 'claimDeadline', v_cancel.claim_deadline,
        'reservedAt', v_cancel.reserved_at, 'providerOutcome', v_cancel.provider_outcome, 'providerReason', v_cancel.provider_reason,
        'providerStatus', v_cancel.provider_status, 'providerCodes', v_cancel.provider_codes, 'endedAt', v_cancel.ended_at,
        'ending', v_cancel.ending, 'endingReason', v_cancel.ending_reason) end,
      'latestCancelPreview', case when v_cancel_preview.id is null then null else jsonb_build_object('previewId', v_cancel_preview.id,
        'fingerprint', v_cancel_preview.fingerprint, 'body', v_cancel_preview.body, 'readAt', v_cancel_preview.read_at,
        'validUntil', v_cancel_preview.valid_until) end,
      'cancelPreviewPending', exists (select 1 from public.creator_mcf_outbox o where o.send_id = v_send.id and o.action = 'cancel'
          and o.completed_at is null)
        and not exists (select 1 from app.creator_mcf_cancels c where c.send_id = v_send.id and c.ended_at is null),
      'cancelPreviewRefusal', case when v_refusal.id is null then null else jsonb_build_object('reason', v_refusal.reason,
        'codes', v_refusal.codes, 'at', v_refusal.at) end
    ) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role functions (the MCF worker)
-- ---------------------------------------------------------------------------

-- Replaces WP-338d's claim. Unchanged for preview, dispatch and settle, except that settle work now
-- also covers a cancel_dispatching send (its ladder starts at the cancel's reservation, and
-- `settle.intentReservedAt` carries that time: a read counts only after it). New: 'cancel' work,
-- claimable only with an active grant carrying 'cancel'. Without an open cancel it is a preview read
-- (`cancel.mode` 'preview'); with an approved, unreserved one inside its claim deadline it is the
-- execution (`cancel.mode` 'execute', with the approved preview). A reserved cancel is never claimed
-- again.
create or replace function app.claim_creator_mcf_outbox(p_claimant text, p_scope text[], p_actions text[]) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_row record; v_send public.creator_mcf_sends; v_lease uuid; v_until timestamptz := now() + interval '120 seconds';
  v_grant app.creator_mcf_grants; v_cancel_grant app.creator_mcf_grants; v_pre public.creator_sample_preflights;
  v_lane public.creator_sample_shipments; v_approved public.creator_mcf_send_previews; v_attempts integer;
  v_cancel app.creator_mcf_cancels; v_cancel_preview public.creator_mcf_send_previews; v_start timestamptz; v_reserved timestamptz;
begin
  perform app.assert_service_role('claim_creator_mcf_outbox');
  if p_claimant is null or p_claimant !~ '^[A-Za-z0-9._:-]{1,80}$' or p_scope is null or p_actions is null
    or cardinality(p_actions) = 0 or not (p_actions <@ array['preview', 'dispatch', 'settle', 'cancel'])
    or not app.creator_mcf_scope_valid(p_scope) then
    raise exception 'Invalid creator MCF claim' using errcode = '22023';
  end if;
  perform app.creator_mcf_sweep(null);
  perform app.creator_mcf_cancel_sweep(null);
  for v_row in select o.id, o.send_id, o.action, s.org_id, s.creator_record_id, s.asin from public.creator_mcf_outbox o
      join public.creator_mcf_sends s on s.id = o.send_id
     where o.completed_at is null and o.available_at <= now() and (o.lease_until is null or o.lease_until < now())
       and o.action = any(p_actions) and (s.spapi_connection_id::text || ':' || s.marketplace_id) = any(p_scope)
       and (o.action = 'settle'
         or (o.action = 'cancel' and exists (select 1 from app.creator_mcf_grants g where g.org_id = s.org_id
           and g.spapi_connection_id = s.spapi_connection_id and g.marketplace_id = s.marketplace_id and g.revoked_at is null
           and g.expires_at > now() and 'cancel' = any(g.action_classes)))
         or (o.action in ('preview', 'dispatch') and exists (select 1 from app.creator_mcf_grants g where g.org_id = s.org_id
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
    v_cancel := null;
    v_cancel_preview := null;
    v_reserved := null;
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
    elsif v_row.action = 'cancel' then
      select * into v_cancel from app.creator_mcf_cancels where send_id = v_send.id and ended_at is null for update;
      if v_send.state not in ('placed', 'conflict') or v_cancel.reserved_at is not null then
        update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null where id = v_row.id;
        continue;
      end if;
      v_cancel_grant := app.creator_mcf_cancel_grant(v_send.org_id, v_send.spapi_connection_id, v_send.marketplace_id);
      if v_cancel_grant.id is null or (v_cancel.id is not null
          and (v_cancel_grant.id is distinct from v_cancel.grant_id or not (v_cancel.claim_deadline > now()))) then
        continue;
      end if;
      if v_cancel.id is not null then
        select * into v_cancel_preview from public.creator_mcf_send_previews where id = v_cancel.preview_id;
      end if;
    else
      if v_send.state not in ('accepted', 'uncertain', 'conflict', 'cancel_dispatching') then
        update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null where id = v_row.id;
        continue;
      end if;
      if v_send.state = 'cancel_dispatching' then
        select reserved_at into v_reserved from app.creator_mcf_cancels where send_id = v_send.id and ended_at is null
          and reserved_at is not null;
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
    elsif v_row.action = 'cancel' then
      perform app.creator_mcf_event(v_send, 'cancel_claimed', 'worker', p_claimant, v_send.state, v_send.state,
        case when v_cancel.id is null then 'preview' else 'execute' end);
    end if;
    v_start := case when v_reserved is not null then v_reserved else app.creator_mcf_ladder_start(v_send) end;
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
      'settle', case when v_row.action = 'settle' then jsonb_build_object('intentReservedAt', coalesce(v_reserved, v_send.intent_reserved_at),
        'acceptedAt', v_send.accepted_at, 'reads', v_send.settle_reads, 'ladderStart', v_start) end,
      'cancel', case when v_row.action = 'cancel' then jsonb_build_object('mode', case when v_cancel.id is null then 'preview' else 'execute' end,
        'cancelId', v_cancel.id, 'originState', coalesce(v_cancel.origin_state, v_send.state), 'approvedAt', v_cancel.approved_at,
        'claimDeadline', v_cancel.claim_deadline, 'previewId', v_cancel.preview_id, 'fingerprint', v_cancel.preview_fingerprint,
        'preview', v_cancel_preview.body) end);
  end loop;
  return null;
end;
$$;

-- The worker's cancel preview read under its cancel lease: one getOrder read of the order key
-- (p_lookup) and, when it shows Received or Planning, the address-free CreatorMcfCancelPreview built
-- from it (p_preview_text, the canonical JSON the fingerprint covers). The read is recorded as an
-- observation either way. Anything else (not found, New, Processing or later, a send that moved, an
-- order the preview cannot describe) is a recorded refusal, not a preview.
create function app.record_creator_mcf_cancel_preview(p_send uuid, p_lease uuid, p_lookup jsonb, p_preview_text text) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_before text; v_body jsonb; v_fingerprint text; v_problem text; v_status text;
  v_reason text; v_existing public.creator_mcf_send_previews;
begin
  perform app.assert_service_role('record_creator_mcf_cancel_preview');
  if p_lease is null or jsonb_typeof(p_lookup) is distinct from 'object'
    or (p_preview_text is not null and octet_length(p_preview_text) > 32768) then
    raise exception 'Invalid creator MCF cancel preview' using errcode = '22023';
  end if;
  if p_preview_text is not null then
    begin
      v_body := p_preview_text::jsonb;
    exception when others then
      raise exception 'Invalid creator MCF cancel preview' using errcode = '22023';
    end;
    if jsonb_typeof(v_body) <> 'object' or jsonb_typeof(v_body->'previewId') <> 'string'
      or v_body->>'previewId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Invalid creator MCF cancel preview' using errcode = '22023';
    end if;
    v_fingerprint := encode(sha256(convert_to(p_preview_text, 'UTF8')), 'hex');
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_body is not null then
    select * into v_existing from public.creator_mcf_send_previews where id = (v_body->>'previewId')::uuid;
    if found then
      if v_existing.send_id = p_send and v_existing.fingerprint = v_fingerprint then
        return jsonb_build_object('decision', 'unchanged', 'previewId', v_existing.id, 'fingerprint', v_fingerprint, 'state', v_send.state);
      end if;
      raise exception 'creator MCF preview id reused' using errcode = '23505';
    end if;
  end if;
  if not exists (select 1 from public.creator_mcf_outbox where send_id = p_send and action = 'cancel' and completed_at is null
      and lease_id = p_lease and lease_until > now()) then
    return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
  end if;
  -- A press arrived meanwhile: the execution reads the order again itself.
  if exists (select 1 from app.creator_mcf_cancels where send_id = p_send and ended_at is null) then
    return jsonb_build_object('decision', 'refused', 'reason', 'cancel_open', 'state', v_send.state);
  end if;
  if v_send.state not in ('placed', 'conflict') then
    update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
      where send_id = p_send and action = 'cancel' and completed_at is null;
    return jsonb_build_object('decision', 'refused', 'reason', 'state', 'state', v_send.state);
  end if;
  v_before := v_send.state;
  -- The read is evidence whatever it shows. On a placed send the observation trigger may end it
  -- failed_after_placement; on a conflicting one a failed status ends it failed_by_amazon.
  perform app.creator_mcf_observe(v_send, p_lookup);
  if v_before = 'conflict' and p_lookup->>'outcome' = 'found' then
    perform app.creator_mcf_apply_found(p_send, p_lookup, 'worker', null);
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  v_status := case when p_lookup->>'outcome' = 'found' then p_lookup->>'status' end;
  if v_send.state <> v_before then v_reason := 'state_changed';
  elsif v_status is null then v_reason := 'order_not_found';
  elsif v_status not in ('Received', 'Planning') then v_reason := 'status_' || lower(v_status);
  elsif v_body is null then v_reason := 'order_shape';
  end if;
  if v_reason is not null then
    perform app.creator_mcf_event(v_send, 'cancel_preview_refused', 'worker', null, v_send.state, v_send.state, v_reason,
      case when v_status is null then '{}'::text[] else array['status_' || lower(v_status)] end);
    update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
      where send_id = p_send and action = 'cancel' and completed_at is null;
    return jsonb_build_object('decision', 'cancel_preview_refused', 'reason', v_reason, 'state', v_send.state);
  end if;
  v_problem := app.creator_mcf_cancel_preview_problem(v_send, v_body, p_lookup);
  if v_problem is not null then
    raise exception 'creator MCF cancel preview refused: %', v_problem using errcode = '22023';
  end if;
  insert into public.creator_mcf_send_previews(id, org_id, send_id, kind, body, fingerprint, total_units, read_at, valid_until)
    values ((v_body->>'previewId')::uuid, v_send.org_id, p_send, 'cancel_preview', v_body, v_fingerprint, (v_body->>'totalUnits')::smallint,
      (v_body->>'readAt')::timestamptz, (v_body->>'validUntil')::timestamptz);
  perform app.creator_mcf_event(v_send, 'cancel_preview_recorded', 'worker', null, v_send.state, v_send.state, lower(v_status), '{}',
    jsonb_build_object('previewFingerprint', v_fingerprint));
  update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
    where send_id = p_send and action = 'cancel' and completed_at is null;
  return jsonb_build_object('decision', 'cancel_preview_ready', 'previewId', v_body->>'previewId', 'fingerprint', v_fingerprint,
    'state', v_send.state);
end;
$$;

-- The clause-9 recheck immediately before the cancel PUT, with the worker's re-read of the order
-- (p_lookup, taken after the approval and at most 2 minutes old). Holds a KEY SHARE lock on the org.
-- Refuses, and ends the cancel, when the claim deadline passed, the approver is no longer an owner
-- or admin with the same membership, the approving grant is no longer the active 'cancel' grant, the
-- send moved, or the re-read does not show Received or Planning (cancel_refused). Otherwise the send
-- becomes cancel_dispatching and the answer is cancel_once, the one permission to PUT; a settle read
-- is queued behind the PUT's window so a stopped worker still settles it. A second call answers
-- already_reserved and never grants another PUT.
create function app.reserve_creator_mcf_cancel(p_send uuid, p_lease uuid, p_lookup jsonb, p_request_digest text) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_cancel app.creator_mcf_cancels; v_grant app.creator_mcf_grants; v_before text;
  v_status text; v_end text; v_read_at timestamptz;
begin
  perform app.assert_service_role('reserve_creator_mcf_cancel');
  if p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$' or p_lease is null or jsonb_typeof(p_lookup) is distinct from 'object'
    or jsonb_typeof(p_lookup->'readAt') is distinct from 'string' then
    raise exception 'Invalid creator MCF cancel reservation' using errcode = '22023';
  end if;
  begin
    v_read_at := (p_lookup->>'readAt')::timestamptz;
  exception when others then
    raise exception 'Invalid creator MCF cancel reservation' using errcode = '22023';
  end;
  perform app.creator_mcf_sweep(null);
  perform app.creator_mcf_cancel_sweep(null);
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.orgs where id = v_send.org_id for key share;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if exists (select 1 from app.creator_mcf_cancels where send_id = p_send and lease_id = p_lease and puts = 1) then
    return jsonb_build_object('decision', 'already_reserved', 'state', v_send.state);
  end if;
  select * into v_cancel from app.creator_mcf_cancels where send_id = p_send and ended_at is null for update;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'no_cancel', 'state', v_send.state); end if;
  if v_cancel.reserved_at is not null then
    return jsonb_build_object('decision', 'already_reserved', 'state', v_send.state);
  end if;
  if not exists (select 1 from public.creator_mcf_outbox where send_id = p_send and action = 'cancel' and completed_at is null
      and lease_id = p_lease and lease_until > now()) then
    return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
  end if;
  if not (v_cancel.claim_deadline > now()) then
    perform app.creator_mcf_end_cancel(v_cancel.id, 'expired', 'claim_deadline', 'cancel_expired', 'worker', null);
    return jsonb_build_object('decision', 'refused', 'reason', 'claim_deadline', 'state', v_send.state);
  end if;
  perform 1 from public.org_members where org_id = v_send.org_id and user_id = v_cancel.approved_by
    and created_at = v_cancel.approved_membership_created_at and role in ('owner', 'admin') for share;
  if not found then v_end := 'authority_changed'; end if;
  if v_end is null then
    v_grant := app.creator_mcf_cancel_grant(v_send.org_id, v_send.spapi_connection_id, v_send.marketplace_id);
    if v_grant.id is null or v_grant.id is distinct from v_cancel.grant_id then v_end := 'grant_revoked'; end if;
  end if;
  if v_end is null and v_send.state <> v_cancel.origin_state then v_end := 'state_changed'; end if;
  if v_end is not null then
    perform app.creator_mcf_end_cancel(v_cancel.id, 'refused', v_end, 'cancel_refused', 'worker', null);
    return jsonb_build_object('decision', 'refused', 'reason', v_end, 'state', v_send.state);
  end if;
  -- The re-read happened after the press, just now.
  if v_read_at <= v_cancel.approved_at or v_read_at < now() - interval '2 minutes' then
    raise exception 'The cancel re-read must follow the approval' using errcode = '22023';
  end if;
  v_before := v_send.state;
  perform app.creator_mcf_observe(v_send, p_lookup);
  if v_before = 'conflict' and p_lookup->>'outcome' = 'found' then
    perform app.creator_mcf_apply_found(p_send, p_lookup, 'worker', null);
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  v_status := case when p_lookup->>'outcome' = 'found' then p_lookup->>'status' end;
  if v_send.state <> v_before then v_end := 'state_changed';
  elsif v_status is null then v_end := 'order_not_found';
  elsif v_status not in ('Received', 'Planning') then v_end := 'status_' || lower(v_status);
  end if;
  if v_end is not null then
    perform app.creator_mcf_end_cancel(v_cancel.id, 'refused', v_end, 'cancel_refused', 'worker', null,
      case when v_status is null then '{}'::text[] else array['status_' || lower(v_status)] end);
    return jsonb_build_object('decision', 'refused', 'reason', 'cancel_refused', 'ending', v_end, 'orderStatus', v_status,
      'state', v_send.state);
  end if;
  -- The one permission to PUT.
  v_send := app.creator_mcf_move(p_send, 'cancel_requested', 'cancel_requested', v_cancel.origin_state, 'worker', null);
  update public.creator_mcf_sends set state = 'cancel_dispatching', state_reason = lower(v_status) where id = p_send returning * into v_send;
  update app.creator_mcf_cancels set reserved_at = now(), puts = 1, request_digest = p_request_digest, lease_id = p_lease
    where id = v_cancel.id returning * into v_cancel;
  perform app.creator_mcf_event(v_send, 'cancel_reserved', 'worker', null, 'cancel_requested', 'cancel_dispatching', lower(v_status), '{}',
    jsonb_build_object('requestDigest', p_request_digest, 'previewFingerprint', v_cancel.preview_fingerprint));
  update public.creator_mcf_outbox set completed_at = now(), lease_id = null, lease_until = null
    where send_id = p_send and action = 'cancel' and completed_at is null;
  perform app.creator_mcf_schedule_settle(p_send, now() + interval '2 minutes');
  return jsonb_build_object('decision', 'cancel_once', 'sendId', p_send, 'cancelId', v_cancel.id, 'state', 'cancel_dispatching',
    'derivedOrderKey', v_send.derived_order_key, 'marketplaceId', v_send.marketplace_id, 'reservedAt', v_cancel.reserved_at,
    'orderStatus', v_status, 'requestDigest', p_request_digest);
end;
$$;

-- The cancel PUT's answer (the shared CreatorMcfProviderOutcome), recorded once under the reserved
-- lease. It settles nothing by itself: a 200 means Amazon took the request, not that the order is
-- cancelled. A rejected answer other than 401/403 needs the getOrder read that followed it; that
-- read, like every read after the reservation, is applied by the observation trigger. The next
-- settle read is queued. An answer that arrives after reads already settled the send is recorded
-- as a late outcome.
create function app.record_creator_mcf_cancel_outcome(p_send uuid, p_lease uuid, p_outcome jsonb, p_lookup jsonb default null) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_cancel app.creator_mcf_cancels; v_kind text := p_outcome->>'outcome'; v_status integer;
  v_codes text[] := '{}'; v_reason text; v_late boolean;
begin
  perform app.assert_service_role('record_creator_mcf_cancel_outcome');
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
    raise exception 'A rejected cancel needs the getOrder read that followed it' using errcode = '22023';
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  select * into v_cancel from app.creator_mcf_cancels where send_id = p_send and lease_id = p_lease and puts = 1 for update;
  if not found or p_lease is null then
    return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
  end if;
  if v_cancel.provider_outcome is not null then
    if v_cancel.provider_outcome = v_kind and v_cancel.provider_status is not distinct from v_status then
      return jsonb_build_object('decision', 'unchanged', 'state', v_send.state);
    end if;
    return jsonb_build_object('decision', 'refused', 'reason', 'recorded', 'state', v_send.state);
  end if;
  update app.creator_mcf_cancels set provider_outcome = v_kind, provider_reason = v_reason, provider_status = v_status,
      provider_codes = case when v_kind = 'accepted' then null else v_codes end, outcome_recorded_at = now()
    where id = v_cancel.id;
  v_late := v_send.state <> 'cancel_dispatching';
  perform app.creator_mcf_event(v_send, case when v_late then 'cancel_late_outcome' else 'cancel_outcome' end, 'worker', null,
    v_send.state, v_send.state, coalesce(v_reason, v_kind), v_codes, '{}', '{}', v_status);
  if not v_late then
    if p_lookup is not null then
      perform app.creator_mcf_observe(v_send, p_lookup);
    end if;
    select * into v_send from public.creator_mcf_sends where id = p_send;
    -- Throttled or unauthorized: Amazon did not act on the request, and the read after it did not settle the send.
    if v_send.state = 'cancel_dispatching' and v_kind = 'rejected' and v_reason in ('throttled', 'authorization') then
      perform app.creator_mcf_cancel_not_sent(p_send, v_cancel.id, 'rejected_' || v_reason);
      select * into v_send from public.creator_mcf_sends where id = p_send;
    end if;
    if v_send.state = 'cancel_dispatching' then
      perform app.creator_mcf_schedule_settle(p_send, case v_kind when 'accepted' then now() + interval '5 seconds'
        when 'uncertain' then now() + interval '1 minute'
        else coalesce(app.creator_mcf_next_settle_at(v_cancel.reserved_at, now()), now() + interval '1 minute') end);
    end if;
  end if;
  return jsonb_build_object('decision', case when v_late then 'late_recorded' else 'recorded' end, 'state', v_send.state);
end;
$$;

-- Replaces WP-338d's settlement read: unchanged for approved, accepted, uncertain and conflict sends,
-- plus two changes. A cancel_dispatching send takes settle reads too; the observation trigger applies
-- them (Cancelled, or a status that can no longer be cancelled), and its ladder starts at the
-- cancel's reservation. And when the 7-day ladder of an accepted or uncertain send is over, the read
-- marks it ladder_exhausted in its own transaction (idempotent); `ladderMarked` says this call did.
create or replace function app.record_creator_mcf_settlement(p_send uuid, p_lookup jsonb, p_lease uuid default null) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_before text; v_to text; v_observed jsonb; v_next timestamptz; v_start timestamptz;
  v_due boolean; v_marked boolean := false;
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
  elsif v_send.state in ('accepted', 'uncertain', 'conflict', 'cancel_dispatching') then
    if p_lease is not null and not exists (select 1 from public.creator_mcf_outbox where send_id = p_send and action = 'settle'
        and completed_at is null and lease_id = p_lease and lease_until > now()) then
      return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state);
    end if;
  else
    return jsonb_build_object('decision', 'refused', 'reason', 'state', 'state', v_send.state);
  end if;
  v_observed := app.creator_mcf_observe(v_send, p_lookup);
  v_to := v_send.state;
  if (v_observed->>'found')::boolean and v_before <> 'cancel_dispatching' then
    v_to := app.creator_mcf_apply_found(p_send, p_lookup, 'worker', null);
  else
    select * into v_send from public.creator_mcf_sends where id = p_send;
    if v_send.state = v_before then
      perform app.creator_mcf_event(v_send, 'settlement_read', 'worker', null, v_send.state, v_send.state,
        case when (v_observed->>'found')::boolean then lower(p_lookup->>'status') else 'not_found' end, '{}', '{}',
        jsonb_build_object('reads', v_send.settle_reads));
    end if;
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if v_send.state in ('accepted', 'uncertain', 'conflict', 'cancel_dispatching') then
    v_start := app.creator_mcf_ladder_start(v_send);
    if v_send.state = 'cancel_dispatching' then
      v_start := coalesce((select reserved_at from app.creator_mcf_cancels where send_id = p_send and ended_at is null
        and reserved_at is not null), v_start);
    end if;
    v_next := app.creator_mcf_next_settle_at(v_start, now());
    perform app.creator_mcf_schedule_settle(p_send, v_next);
  else
    perform app.creator_mcf_schedule_settle(p_send, null);
  end if;
  v_due := v_send.state in ('accepted', 'uncertain') and now() >= app.creator_mcf_ladder_start(v_send) + interval '7 days';
  if v_due then
    v_marked := app.creator_mcf_ladder_mark(p_send);
    select * into v_send from public.creator_mcf_sends where id = p_send;
  end if;
  return jsonb_build_object('decision', 'recorded', 'observationKey', v_observed->>'observationKey', 'before', v_before,
    'state', v_send.state, 'nextReadAt', v_next, 'ladderDue', v_due, 'ladderMarked', v_marked);
end;
$$;

-- A reserved cancel request the worker did not send (it never left: withheld at the last policy check, on
-- stopping, past its start budget, without a token, or refused by the writer before sending). Recorded once
-- under the reserved lease; see creator_mcf_cancel_not_sent for what it does to the send.
create function app.record_creator_mcf_cancel_unsent(p_send uuid, p_lease uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_cancel app.creator_mcf_cancels;
begin
  perform app.assert_service_role('record_creator_mcf_cancel_unsent');
  if p_lease is null or p_reason is null or p_reason not in ('reservation_mismatch', 'stopping', 'policy_off', 'lease_budget',
      'token_unavailable', 'request_invalid', 'cancel_failed') then
    raise exception 'Invalid creator MCF cancel record' using errcode = '22023';
  end if;
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = v_send.org_id and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  select * into v_cancel from app.creator_mcf_cancels where send_id = p_send and lease_id = p_lease and puts = 1 for update;
  if not found then return jsonb_build_object('decision', 'refused', 'reason', 'lease', 'state', v_send.state); end if;
  -- A replay: already ended not_sent (from placed), or its not_sent event already recorded (from conflict).
  if v_cancel.ending = 'not_sent' or (v_cancel.ended_at is null and exists (select 1 from public.creator_mcf_send_events e
      where e.send_id = p_send and e.event = 'cancel_not_sent' and e.at >= v_cancel.reserved_at)) then
    return jsonb_build_object('decision', 'unchanged', 'state', v_send.state);
  end if;
  if v_cancel.provider_outcome is not null or v_cancel.ended_at is not null or v_send.state <> 'cancel_dispatching' then
    return jsonb_build_object('decision', 'refused', 'reason', 'state', 'state', v_send.state);
  end if;
  perform app.creator_mcf_cancel_not_sent(p_send, v_cancel.id, p_reason);
  select * into v_send from public.creator_mcf_sends where id = p_send;
  if v_send.state = 'cancel_dispatching' then perform app.creator_mcf_schedule_settle(p_send, now() + interval '1 minute'); end if;
  return jsonb_build_object('decision', 'recorded', 'state', v_send.state);
end;
$$;

-- Replaces WP-338d's "Ask Amazon for this order id": also for a cancel_dispatching send, whose cancel is
-- settled only by reads (after the 7-day ladder the operator still has this).
create or replace function app.request_creator_mcf_settle_read(p_org uuid, p_send uuid) returns jsonb
  language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_member timestamptz; v_send public.creator_mcf_sends;
begin
  v_member := app.creator_mcf_manager(p_org);
  select * into v_send from public.creator_mcf_sends where id = p_send and org_id = p_org;
  if not found then return app.creator_mcf_refusal('send_not_found'); end if;
  perform 1 from public.creator_sample_shipments where org_id = p_org and creator_record_id = v_send.creator_record_id
    and asin = v_send.asin for update;
  select * into v_send from public.creator_mcf_sends where id = p_send for update;
  if v_send.state not in ('accepted', 'uncertain', 'conflict', 'cancel_dispatching') then
    return app.creator_mcf_refusal('send_not_settleable');
  end if;
  perform app.creator_mcf_schedule_settle(p_send, now());
  perform app.creator_mcf_event(v_send, 'settle_read_requested', 'user', auth.uid()::text, v_send.state, v_send.state,
    null, '{}', '{}', '{}', null, v_member);
  return jsonb_build_object('outcome', 'requested', 'sendId', p_send, 'state', v_send.state);
end;
$$;

-- Replaces WP-338d's alert summary: unchanged, except that uncertain_over_15m also counts a
-- cancel_dispatching send unsettled for 15 minutes (the MCP outcome classes both as uncertain), so a
-- cancel whose reads never settle it is not silent.
create or replace function app.creator_mcf_alert_summary() returns jsonb
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_residue jsonb;
begin
  perform app.assert_service_role('creator_mcf_alert_summary');
  v_residue := app.creator_mcf_residue(null);
  return jsonb_build_object('generatedAt', now(), 'conditions', jsonb_build_array(
    (select jsonb_build_object('code', 'uncertain_over_15m', 'count', count(*)::integer,
        'sendIds', coalesce(jsonb_agg(id order by state_changed_at) filter (where rn <= 50), '[]'::jsonb))
      from (select id, state_changed_at, row_number() over (order by state_changed_at) rn from public.creator_mcf_sends
        where state in ('uncertain', 'cancel_dispatching') and state_changed_at < now() - interval '15 minutes') x),
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

-- The recipient key ids of every active grant whose connection and marketplace are in p_scope, so the
-- MCF unit can refuse to start without a readable key file for each. Key ids only; nothing else.
create function app.creator_mcf_active_key_ids(p_scope text[]) returns text[]
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform app.assert_service_role('creator_mcf_active_key_ids');
  if not app.creator_mcf_scope_valid(p_scope) then
    raise exception 'Invalid creator MCF scope' using errcode = '22023';
  end if;
  return array(select distinct k from app.creator_mcf_grants g, unnest(g.recipient_key_ids) k
    where g.revoked_at is null and g.expires_at > now() and (g.spapi_connection_id::text || ':' || g.marketplace_id) = any(p_scope)
    order by k);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function app.creator_mcf_cancel_confirmation(integer), app.creator_mcf_cancel_guard(),
  app.creator_mcf_cancel_grant(uuid, uuid, text), app.creator_mcf_end_cancel(uuid, text, text, text, text, text, text[]),
  app.creator_mcf_cancel_sweep(uuid), app.creator_mcf_cancel_preview_problem(public.creator_mcf_sends, jsonb, jsonb),
  app.creator_mcf_lane_effect(public.creator_mcf_sends, text, text), app.creator_mcf_apply_cancel_read(uuid, text, timestamptz),
  app.creator_mcf_after_observation(), app.creator_mcf_ladder_mark(uuid), app.creator_mcf_cancel_not_sent(uuid, uuid, text),
  app.record_creator_mcf_cancel_unsent(uuid, uuid, text), app.request_creator_mcf_settle_read(uuid, uuid), app.creator_mcf_alert_summary(),
  app.request_creator_mcf_cancel_preview(uuid, uuid), app.approve_creator_mcf_cancel(uuid, uuid, uuid, text, text, uuid),
  app.read_creator_mcf_lane(uuid, text, text), app.claim_creator_mcf_outbox(text, text[], text[]),
  app.record_creator_mcf_cancel_preview(uuid, uuid, jsonb, text), app.reserve_creator_mcf_cancel(uuid, uuid, jsonb, text),
  app.record_creator_mcf_cancel_outcome(uuid, uuid, jsonb, jsonb), app.record_creator_mcf_settlement(uuid, jsonb, uuid),
  app.creator_mcf_active_key_ids(text[])
  from public, anon, authenticated, service_role;

grant execute on function app.request_creator_mcf_cancel_preview(uuid, uuid), app.approve_creator_mcf_cancel(uuid, uuid, uuid, text, text, uuid),
  app.read_creator_mcf_lane(uuid, text, text), app.request_creator_mcf_settle_read(uuid, uuid)
  to authenticated;
grant execute on function app.creator_mcf_cancel_confirmation(integer) to authenticated, service_role;
grant execute on function app.claim_creator_mcf_outbox(text, text[], text[]), app.record_creator_mcf_cancel_preview(uuid, uuid, jsonb, text),
  app.reserve_creator_mcf_cancel(uuid, uuid, jsonb, text), app.record_creator_mcf_cancel_outcome(uuid, uuid, jsonb, jsonb),
  app.record_creator_mcf_settlement(uuid, jsonb, uuid), app.creator_mcf_active_key_ids(text[]), app.record_creator_mcf_cancel_unsent(uuid, uuid, text),
  app.creator_mcf_alert_summary()
  to service_role;

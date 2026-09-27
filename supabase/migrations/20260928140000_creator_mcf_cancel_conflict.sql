-- Creator Connections round 3b (WP-338p): a cancel pressed on a send in conflict that Amazon does not honour
-- returns the send to conflict. Follows 20260928130000_creator_mcf_cancel, which is not edited.
--
-- Before this, the shared map's only way on from cancel_dispatching (other than cancelled) was placed, so a
-- conflicting order Amazon went on to fulfil after a cancel became placed and moved its lane to Confirmed
-- without anyone pressing "Record as sent". The map now also has cancel_dispatching -> conflict, and the
-- functions that settle a cancel use it for a cancel whose origin_state is 'conflict' (app.creator_mcf_cancels
-- already records the origin):
--
--   - not honoured (a read after the reservation shows Processing, Complete or CompletePartialled): the send
--     returns to conflict. Its write-once escalation stays, the lane stays where the conflict left it (Verified
--     for Submit), no placement milestone is written, and the MCP outcome class stays uncertain. The return
--     event carries the mismatch codes the conflict recorded, so "Record as sent" still names them.
--   - not honoured because the order failed (Invalid or Unfulfillable): conflict, then failed_by_amazon, as a
--     read of a conflicting send would have ended it. The send never passes through placed.
--   - not sent (withheld before it left, or answered 429 or 401/403): the send returns to conflict and the cancel
--     ends not_sent, as a cancel from placed returns to placed. Before this the send stayed cancel_dispatching
--     until a read showed a status Amazon could no longer cancel.
--
-- A cancel from placed is unchanged: not honoured returns it to placed (a failed order then fails after
-- placement), not sent returns it to placed.
--
-- Also: a cancel answer recorded after the cancel already ended answers late_recorded with that ending, so
-- the worker can tell an answer arriving after not_sent (Amazon may have acted on a request the ledger
-- recorded as never taking) from one arriving after a read settled the cancel.
--
-- Replaced: creator_mcf_next_states (the map, as data), creator_mcf_apply_cancel_read,
-- creator_mcf_cancel_not_sent and record_creator_mcf_cancel_outcome. New: creator_mcf_conflict_codes.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- The shared transition map (packages/shared/src/creators/mcf-send.ts), as data, with cancel_dispatching ->
-- conflict. The transition trigger and creator_mcf_move both read it.
create or replace function app.creator_mcf_next_states(p_state text) returns text[]
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
    when 'cancel_dispatching' then array['cancelled', 'placed', 'conflict']
    else array[]::text[]
  end
$$;

-- The mismatch codes of the send's newest entry into conflict, found the way resolve_creator_mcf_conflict finds
-- them. A send returning to conflict records them again on its return event, so "Record as sent" keeps naming them.
create function app.creator_mcf_conflict_codes(p_send uuid) returns text[]
  language sql stable set search_path = pg_catalog, pg_temp as $$
  select coalesce((select e.codes from public.creator_mcf_send_events e
    where e.send_id = p_send and e.after_state = 'conflict' and e.before_state is distinct from 'conflict'
      and e.event <> 'custody_destroyed' order by e.at desc limit 1), '{}'::text[])
$$;

-- Replaces WP-338i's version. One read of the order key, taken after the cancel's reservation, applied to a
-- cancel_dispatching send. Cancelled ends it cancelled. A status that can no longer be cancelled means the
-- cancel was not honoured: the send returns to the state the cancel was pressed from. From placed it is placed
-- again (and a failed order then fails after placement); from conflict it is in conflict again, with its
-- escalation, its lane and its mismatch codes, and a failed order then fails by Amazon. New, Received and
-- Planning leave it waiting. The caller holds the lane lock. Returns the send's state.
create or replace function app.creator_mcf_apply_cancel_read(p_send uuid, p_status text, p_read_at timestamptz) returns text
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
  if v_cancel.origin_state = 'conflict' then
    -- Back to conflict. creator_mcf_move keeps the write-once escalation; the lane is untouched (the reservation
    -- never moved it), so it stays Verified for Submit; nothing is recorded as a placement. Only "Record as sent"
    -- takes a conflict to placed.
    v_send := app.creator_mcf_move(p_send, 'conflict', 'cancel_not_honoured', lower(p_status), 'system', null, null,
      app.creator_mcf_conflict_codes(p_send));
    perform app.creator_mcf_end_cancel(v_cancel.id, 'not_honoured', lower(p_status), null, null, null);
    if p_status in ('Invalid', 'Unfulfillable') then
      -- What a read of a conflicting send in a failed status does (creator_mcf_apply_found).
      v_send := app.creator_mcf_move(p_send, 'failed_by_amazon', 'settlement_read', lower(p_status), 'system', null);
      perform app.creator_mcf_lane_effect(v_send, 'failed_by_amazon');
      perform app.creator_mcf_milestone(v_send, 'mcf_send_failed', 'failed_by_amazon', 'worker', null, 'failed');
      return 'failed_by_amazon';
    end if;
    return 'conflict';
  end if;
  -- From placed: placed again, its lane already Confirmed.
  v_send := app.creator_mcf_move(p_send, 'placed', 'cancel_not_honoured', lower(p_status), 'system', null);
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

-- Replaces WP-338i's version. A reserved cancel request that certainly did not take: the send returns to the
-- state the cancel was pressed from (placed, or conflict with its escalation and mismatch codes) and the cancel
-- ends not_sent, so a new press can follow while the order is still cancellable. The caller holds the lane and
-- send locks. Returns the send's state.
create or replace function app.creator_mcf_cancel_not_sent(p_send uuid, p_cancel uuid, p_reason text) returns text
  language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_send public.creator_mcf_sends; v_cancel app.creator_mcf_cancels;
begin
  select * into strict v_send from public.creator_mcf_sends where id = p_send;
  select * into strict v_cancel from app.creator_mcf_cancels where id = p_cancel;
  if v_send.state <> 'cancel_dispatching' or v_cancel.ended_at is not null then return v_send.state; end if;
  v_send := app.creator_mcf_move(p_send, v_cancel.origin_state, 'cancel_not_sent', p_reason, 'worker', null, null,
    case when v_cancel.origin_state = 'conflict' then app.creator_mcf_conflict_codes(p_send) else '{}'::text[] end);
  perform app.creator_mcf_end_cancel(v_cancel.id, 'not_sent', p_reason, null, null, null);
  return v_send.state;
end;
$$;

-- Replaces WP-338i's version, unchanged except that a late answer (the send no longer cancel_dispatching) also
-- returns the cancel's ending, so the worker can raise an answer that arrived after not_sent.
create or replace function app.record_creator_mcf_cancel_outcome(p_send uuid, p_lease uuid, p_outcome jsonb, p_lookup jsonb default null)
  returns jsonb
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
    return jsonb_build_object('decision', 'recorded', 'state', v_send.state);
  end if;
  return jsonb_build_object('decision', 'late_recorded', 'state', v_send.state, 'ending', v_cancel.ending);
end;
$$;

revoke all on function app.creator_mcf_conflict_codes(uuid) from public, anon, authenticated, service_role;

-- Creator Connections round 2 (WP-333): reply drafts, identity and score history on the
-- action log, and the `creator:write` MCP key class. A draft is text an operator sends by
-- hand; approving one records a decision and sends nothing. Nothing here is an Amazon write.
-- Fingerprints only: no column holds a name, address, email, phone or link. A draft body keeps its
-- template's name placeholders ({first name}, {recipient name}) unrendered; the operator fills them
-- in when sending by hand.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- A third key class. It cannot be used in this transaction, so every comparison below is on
-- `scope::text` and every body that names it is plpgsql or text-typed SQL.
alter type mcp.key_scope add value if not exists 'creator:write';
-- A creator:write key reaches no profile: it is org-bound and writes creator records only.
alter table mcp.api_keys add constraint api_keys_creator_write_no_profiles
  check (scope::text <> 'creator:write' or profile_ids = '{}'::uuid[]);

-- The tracker's typed score (column 36), as `creators.record_score` last reported it, so the
-- queue and the record page can show the score that disagrees with the computed one.
alter table public.creator_records
  add column tracker_score smallint check (tracker_score between 0 and 10),
  add column tracker_scored_on date,
  add constraint creator_records_tracker_score_dated check ((tracker_score is null) = (tracker_scored_on is null));

alter table public.creator_action_log drop constraint creator_action_log_action_check;
alter table public.creator_action_log
  add constraint creator_action_log_action_check check (action in ('identity_conflict_locked', 'mcf_reserved',
    'mcf_screen_verified', 'mcf_reconciliation_required', 'sample_confirmed', 'mcf_reservation_cancelled',
    'identity_resolved', 'score_recorded', 'message_sent_by_hand', 'status_moved', 'content_verified', 'escalated',
    'preflight_recorded', 'draft_submitted', 'draft_approved', 'draft_sent_by_hand', 'draft_withdrawn')),
  -- The other records an identity decision named: the candidates a conflict locked.
  add column related_record_ids text[] not null default '{}'::text[]
    check (array_to_string(related_record_ids, ',') ~ '^(CCR-[A-Z0-9]+-[0-9]{2}-[0-9]{4,}(,CCR-[A-Z0-9]+-[0-9]{2}-[0-9]{4,})*)?$'),
  add column draft_id uuid,
  -- The operator (or the issuer of the key) whose request wrote the entry; null for the file import.
  add column actor_user_id uuid;
create index creator_action_log_draft on public.creator_action_log(org_id, draft_id) where draft_id is not null;

create table public.creator_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  creator_record_id text not null,
  thread_fp text not null check (thread_fp ~ '^[0-9a-f]{64}$'),
  template_key text not null check (template_key in ('first_base_verification', 'asin_product_confirmation', 'proof_request',
    'product_switch_clarification', 'exact_asin_unavailable_for_mcf', 'recipient_mismatch_clarification', 'sample_confirmation',
    'awaiting_content_follow_up', 'content_posted_thank_you', 'performance_update_thank_you', 'paused_product')),
  -- Every approved template greets by {first name}; a body with the name rendered is refused.
  body text not null check (length(body) between 1 and 4000 and length(btrim(body)) > 0
    and position('{first name}' in body) > 0
    and (template_key <> 'recipient_mismatch_clarification' or position('{recipient name}' in body) > 0)),
  draft_date date not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent_by_hand', 'withdrawn')),
  -- Idempotency identity of a submission: the same record, thread, template, day and text is one draft.
  submission_digest text not null check (submission_digest ~ '^[0-9a-f]{64}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  closed_by uuid,
  closed_at timestamptz,
  source text not null check (source in ('control-runner', 'mcp', 'web')),
  -- Where the latest status change came from; the action-log entry carries it.
  status_source text not null check (status_source in ('control-runner', 'mcp', 'web')),
  foreign key (org_id, creator_record_id) references public.creator_records(org_id, creator_record_id) on delete cascade,
  unique (org_id, submission_digest),
  check ((approved_at is null) = (approved_by is null)),
  check (status <> 'draft' or (approved_at is null and closed_at is null)),
  check (status not in ('approved', 'sent_by_hand') or approved_at is not null),
  check ((status in ('sent_by_hand', 'withdrawn')) = (closed_at is not null))
);
-- One open draft per thread: a thread is approved one draft at a time.
create unique index creator_drafts_open_thread on public.creator_drafts(org_id, thread_fp) where status in ('draft', 'approved');
create index creator_drafts_day on public.creator_drafts(org_id, draft_date desc, created_at);

-- Status is the only thing that moves, along draft -> approved | withdrawn and
-- approved -> sent_by_hand | withdrawn, by a current owner or admin. The actor and
-- time come from the session, never from the caller. Nothing is sent.
create function app.creator_draft_transition() returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if (new.id, new.org_id, new.creator_record_id, new.thread_fp, new.template_key, new.body, new.draft_date, new.submission_digest,
      new.created_by, new.created_at, new.source)
     is distinct from (old.id, old.org_id, old.creator_record_id, old.thread_fp, old.template_key, old.body, old.draft_date,
      old.submission_digest, old.created_by, old.created_at, old.source) then
    raise exception 'a creator draft is immutable; submit a new one' using errcode = '55000';
  end if;
  if not ((old.status = 'draft' and new.status in ('approved', 'withdrawn'))
       or (old.status = 'approved' and new.status in ('sent_by_hand', 'withdrawn'))) then
    raise exception 'a creator draft cannot move from % to %', old.status, new.status using errcode = '23514';
  end if;
  if v_actor is null or not app.has_org_role(new.org_id, array['owner', 'admin']) then
    raise exception 'only a current owner or admin may change a creator draft' using errcode = '42501';
  end if;
  if new.status in ('approved', 'sent_by_hand') and exists (select 1 from public.creator_records r
      where r.org_id = new.org_id and r.creator_record_id = new.creator_record_id and r.lock_state = 'Conflict') then
    raise exception 'the record is locked in Conflict; nothing may act on it' using errcode = '23514';
  end if;
  new.approved_by := case when new.status = 'approved' then v_actor else old.approved_by end;
  new.approved_at := case when new.status = 'approved' then clock_timestamp() else old.approved_at end;
  new.closed_by := case when new.status in ('sent_by_hand', 'withdrawn') then v_actor else old.closed_by end;
  new.closed_at := case when new.status in ('sent_by_hand', 'withdrawn') then clock_timestamp() else old.closed_at end;
  return new;
end;
$$;
revoke all on function app.creator_draft_transition() from public, anon, authenticated;
create trigger creator_drafts_transition before update on public.creator_drafts
  for each row execute function app.creator_draft_transition();
create trigger creator_drafts_no_delete before delete on public.creator_drafts
  for each row execute function app.creator_refuse_rewrite();

-- Every submission and every status change lands in the append-only action log, in the
-- same transaction, keyed so a replay collides instead of repeating.
-- A submission names its author from the session, and a record locked in Conflict takes none.
create function app.creator_draft_submit() returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from public.creator_records r
      where r.org_id = new.org_id and r.creator_record_id = new.creator_record_id and r.lock_state = 'Conflict') then
    raise exception 'the record is locked in Conflict; nothing may act on it' using errcode = '23514';
  end if;
  new.created_by := auth.uid();
  return new;
end;
$$;
revoke all on function app.creator_draft_submit() from public, anon, authenticated;
create trigger creator_drafts_submit before insert on public.creator_drafts
  for each row execute function app.creator_draft_submit();

create function app.creator_draft_log() returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.approved_at is not null or new.closed_at is not null then
      raise exception 'a creator draft is submitted as a draft' using errcode = '23514';
    end if;
    insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reason_code, draft_id,
      actor_user_id, source)
    values (new.org_id, 'draft:' || new.id::text || ':submitted', new.creator_record_id, 'draft_submitted', new.created_at,
      new.template_key, new.id, new.created_by, new.source);
  else
    insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reason_code, draft_id,
      actor_user_id, source)
    values (new.org_id, 'draft:' || new.id::text || ':' || new.status, new.creator_record_id, 'draft_' || new.status,
      case when new.status = 'approved' then new.approved_at else new.closed_at end, new.template_key, new.id,
      case when new.status = 'approved' then new.approved_by else new.closed_by end, new.status_source);
  end if;
  return null;
end;
$$;
revoke all on function app.creator_draft_log() from public, anon, authenticated;
create trigger creator_drafts_log after insert or update of status on public.creator_drafts
  for each row execute function app.creator_draft_log();

-- Owners, admins and analysts read; owners and admins submit and decide. Drafts are never deleted.
alter table public.creator_drafts enable row level security;
create policy tenant_read on public.creator_drafts for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.creator_drafts for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_update on public.creator_drafts for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin'])) with check (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.creator_drafts from anon, authenticated;
grant select, insert, update on public.creator_drafts to authenticated;
grant all on public.creator_drafts to service_role;

-- The creator:write twin of app.authorize_mcp_read_key: every call rechecks the key, its
-- issuer's current owner/admin membership, expiry and revocation. A read key fails here and a
-- creator:write key fails the read check, so neither class can use the other's tools.
create function app.authorize_mcp_creator_write_key(p_key_id uuid, p_org_id uuid)
returns table(org_slug text)
language sql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select o.slug::text
    from mcp.api_keys k
    join public.orgs o on o.id = k.org_id
    join public.org_members m on m.org_id = k.org_id and m.user_id = k.created_by
   where k.id = p_key_id and k.org_id = p_org_id
     and k.created_by = auth.uid() and m.created_at <= k.created_at
     and m.role::text in ('owner', 'admin')
     and k.scope::text = 'creator:write' and k.revoked_at is null
     and k.expires_at > clock_timestamp()
     and k.expires_at <= k.created_at + interval '90 days';
$$;
revoke all on function app.authorize_mcp_creator_write_key(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.authorize_mcp_creator_write_key(uuid, uuid) to authenticated;

-- The web issuance command for the creator:write class, the twin of app.issue_mcp_read_key:
-- a current owner or admin, a label, an offered expiry, no profiles, and one audit row.
create function app.issue_mcp_creator_write_key(
  p_org_id uuid, p_label text, p_expires_in_days integer, p_key_prefix text, p_token_hash text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_id uuid; v_created_at timestamptz;
begin
  perform app.lock_org_manager(p_org_id);
  if p_label is null or char_length(btrim(p_label)) not between 1 and 200
     or p_expires_in_days is null or p_expires_in_days not in (7, 30, 90)
     or p_key_prefix is null or p_key_prefix !~ '^wza_[A-Za-z0-9_-]{8}$'
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception using errcode = '22023', message = 'Invalid key settings';
  end if;
  v_created_at := clock_timestamp();
  insert into mcp.api_keys
    (org_id, label, key_prefix, token_hash, scope, profile_ids, expires_at, created_by, created_at)
  values (p_org_id, btrim(p_label), p_key_prefix, p_token_hash, 'creator:write', '{}'::uuid[],
          v_created_at + make_interval(days => p_expires_in_days), auth.uid(), v_created_at)
  returning id into v_id;
  insert into public.audit_log
    (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
  values (p_org_id, 'user', auth.uid()::text, 'mcp_key.issued', 'mcp_key', v_id::text,
          jsonb_build_object('scope', 'creator:write', 'expires_in_days', p_expires_in_days), 'web');
  return v_id;
end;
$$;
revoke all on function app.issue_mcp_creator_write_key(uuid, text, integer, text, text) from public, anon, service_role;
grant execute on function app.issue_mcp_creator_write_key(uuid, text, integer, text, text) to authenticated;

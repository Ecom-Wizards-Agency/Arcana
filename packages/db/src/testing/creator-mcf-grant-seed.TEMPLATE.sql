-- Creator MCF send grant (WP-338d). Copy to a gitignored file and replace every placeholder
-- from the separately approved private scope; never commit the copy. Run as the migration owner.
-- This template deliberately ROLLS BACK. A reviewed execution copy may COMMIT.
--
-- A grant is immutable except its one revocation. To rotate a recipient key or change a cap,
-- name the current grant as the expected prior: it is revoked and the new grant inserted in the
-- same transaction. An approval names the grant it was pressed under, so a send approved under
-- the prior grant expires at reservation (custody destroyed; the operator seals again). Sealed
-- and previewed sends continue under the new grant only if their key id is in it.
begin;
set local lock_timeout = '5s';

do $grant$
declare
  v_org uuid := '__ORG_ID__';
  v_connection uuid := '__SPAPI_CONNECTION_ID__';
  v_marketplace text := '__MARKETPLACE_ID__';
  v_actions text[] := string_to_array('__ACTION_CLASSES__', ',');
  v_keys text[] := string_to_array('__RECIPIENT_KEY_IDS__', ',');
  v_units integer := '__MAX_UNITS_PER_DAY__';
  v_fee bigint := '__MAX_FEE_MINOR__';
  v_currency text := '__CURRENCY_CODE__';
  v_enabled_by text := '__OPERATOR_LABEL__';
  v_expires timestamptz := '__GRANT_EXPIRES_AT__';
  v_expected_prior uuid := nullif('__EXPECTED_PRIOR_GRANT_ID_OR_EMPTY__', '');
  v_window_end timestamptz := '__WINDOW_EXPIRES_AT__';
  v_prior uuid;
  v_grant uuid;
begin
  if clock_timestamp() >= v_window_end then
    raise exception 'Grant authorization window expired';
  end if;
  perform 1 from public.spapi_connections c
    where c.id = v_connection and c.org_id = v_org and c.status = 'active' and v_marketplace = any(c.marketplace_ids)
    for share;
  if not found then raise exception 'Grant connection or marketplace scope changed'; end if;
  select id into v_prior from app.creator_mcf_grants
    where org_id = v_org and spapi_connection_id = v_connection and marketplace_id = v_marketplace and revoked_at is null
    for update;
  if v_prior is distinct from v_expected_prior then
    raise exception 'Grant prior changed';
  end if;
  if v_prior is not null then
    update app.creator_mcf_grants set revoked_at = now() where id = v_prior;
  end if;
  insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids,
      max_units_per_day, max_fee_minor, currency, enabled_by, expires_at)
    values (v_org, v_connection, v_marketplace, v_actions, v_keys, v_units, v_fee, v_currency, v_enabled_by, v_expires)
    returning id into v_grant;
  if (select count(*) from app.creator_mcf_grants where org_id = v_org and spapi_connection_id = v_connection
        and marketplace_id = v_marketplace and revoked_at is null) <> 1
    or (select count(*) from app.creator_mcf_grants where id = v_grant) <> 1
    or clock_timestamp() >= v_window_end then
    raise exception 'Grant count or authorization window changed';
  end if;
end;
$grant$;

rollback;

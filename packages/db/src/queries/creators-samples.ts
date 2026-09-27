/**
 * Creator Connections round 3a (WP-334): recorded pre-flights and read-only MCF
 * observations for sample lanes.
 *
 * A pre-flight row is the control runner's result as `creators.preflight_result`
 * or the file import submitted it; the same mapping serves both. An observation
 * row is one SP-API read the worker made; a trigger moves the lane's settlement
 * in the same statement. Nothing here calls Amazon, and nothing here changes a
 * lane's state or releases a lock: the runner owns both.
 */
import {
  CreatorFulfillmentDetail, CreatorMcfObservationEvent, CreatorMcfObservationWrite, CreatorPreflightDetail, CreatorProductSwitchDetail,
  CreatorSampleOrderKey, CreatorSamplePreflight, CreatorSwitchPreflight, CreatorDailyQueueItem, creatorPreflightChecks, creatorPreflightOutcome,
  FulfillmentShipmentObservation, type CreatorInventoryRead, type CreatorPreviewRead, type CreatorLockState, type CreatorMcfSettlementState, type CreatorPreflightResultInput, type CreatorRunnerInventoryRead,
  type CreatorSource, type CreatorWriteCounts,
} from '@wizard-ads/shared';
import type { DbHandle, QueryHandle, QuerySql } from '../client.js';
import { creatorContentDigest, creatorShipmentFromRow, readLatestCreatorImport, type ShipmentRow } from './creators.js';
import { CreatorWriteRefusal } from './creators-records.js';

const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const blank = (value: string) => value.trim() === '' ? null : value.trim();

/** One pre-flight as it is written. `detail` is the camelCase remainder the screens read. */
export interface CreatorPreflightWrite {
  runId: string;
  command: 'preflight' | 'preflight-switch';
  creatorRecordId: string;
  asin: string;
  originalAsin: string | null;
  result: 'PASS' | 'HOLD';
  errors: string[];
  requiredNextState: string;
  recipientBindingFp: string | null;
  detail: Record<string, unknown>;
  /** The read times a stale-preview check compares; null when that read was not made or is not a sample pre-flight's. */
  previewReadAt: string | null;
  previewValidUntil: string | null;
  inventoryCheckedAt: string | null;
  startedAt: string;
  completedAt: string;
}

function inventory(read: CreatorRunnerInventoryRead | null): CreatorInventoryRead | null {
  return read === null ? null : {
    asin: read.asin, sku: read.sku, fulfillmentChannel: read.fulfillment_channel, mcfFulfillable: read.mcf_fulfillable,
    fulfillableQuantity: read.fulfillable_quantity, checkedAt: read.inventory_checked_at, evidenceReference: read.fulfillment_evidence_reference,
  };
}

/** A validated tool input or file entry to its row. Pure: no clock, no I/O. */
export function creatorPreflightRow(input: CreatorPreflightResultInput): CreatorPreflightWrite {
  const envelope = { runId: input.run_id, startedAt: input.started_at, completedAt: input.completed_at };
  if (input.command === 'preflight') {
    const r = input.result;
    const preview: CreatorPreviewRead | null = input.preview === null ? null : {
      operation: input.preview.operation, readAt: input.preview.read_at, validUntil: input.preview.valid_until,
      isFulfillable: input.preview.is_fulfillable, feeCents: input.preview.fee_cents, currency: input.preview.currency,
      constraints: input.preview.constraints,
    };
    return {
      ...envelope, command: 'preflight', creatorRecordId: r.creator_record_id, asin: r.selected_asin, originalAsin: null, result: r.result,
      errors: r.errors, requiredNextState: r.required_next_state, recipientBindingFp: r.recipient_binding === '' ? null : r.recipient_binding,
      detail: {
        computedScore: r.computed_score,
        checks: creatorPreflightChecks(r.errors, input.reads.map((read) => ({ check: read.check, readAt: read.read_at, evidenceReference: read.evidence_reference }))),
        sku: blank(r.selected_sku), campaignId: blank(r.campaign_id), productTitle: blank(r.product_title), trackerSourceRef: blank(r.tracker_source_ref),
        quantity: r.quantity, feeCents: r.visible_fee_cents, feeCapCents: r.approved_fee_cap_cents,
        inventory: inventory(input.inventory), preview,
      },
      previewReadAt: input.preview?.read_at ?? null, previewValidUntil: input.preview?.valid_until ?? null,
      inventoryCheckedAt: input.inventory?.inventory_checked_at ?? null,
    };
  }
  const r = input.result;
  return {
    ...envelope, command: 'preflight-switch', creatorRecordId: r.creator_record_id, asin: r.alternate_asin, originalAsin: r.original_asin,
    result: r.result, errors: r.errors, requiredNextState: r.required_next_state, recipientBindingFp: null,
    detail: {
      phase: r.phase, alternateSku: blank(r.alternate_sku), inventory: inventory(input.inventory),
      originalUnavailableReason: input.original_unavailable_reason, originalBlockerEvidenceReference: input.original_blocker_evidence_reference,
    },
    previewReadAt: null, previewValidUntil: null, inventoryCheckedAt: input.inventory?.inventory_checked_at ?? null,
  };
}

/**
 * Record pre-flights. A run id already held with the same content is unchanged;
 * with other content it is refused, and nothing of the call is written (the
 * caller's transaction rolls back). Each new run appends `preflight:{run id}` to
 * the record's action log in the same transaction.
 */
export async function writeCreatorPreflights(sql: QuerySql, orgId: string, source: CreatorSource, rows: readonly CreatorPreflightWrite[],
  actorUserId: string | null): Promise<CreatorWriteCounts & { derivedOrderKeys: string[] }> {
  const ids = [...new Set(rows.map((row) => row.creatorRecordId))];
  const known = ids.length === 0 ? [] : await sql<{ id: string }[]>`select creator_record_id as id from public.creator_records
    where org_id = ${orgId} and creator_record_id = any(${ids}::text[])`;
  if (known.length !== ids.length) {
    throw new CreatorWriteRefusal('record_not_found', 'A pre-flight names a creator record the organisation has not registered.');
  }
  let inserted = 0;
  const derivedOrderKeys: string[] = [];
  for (const row of rows) {
    const digest = creatorContentDigest(row);
    const result = await sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, original_asin, result,
        errors, required_next_state, recipient_binding_fp, detail, preview_read_at, preview_valid_until, inventory_checked_at, started_at,
        completed_at, source, source_digest, actor_user_id)
      values (${orgId}, ${row.runId}, ${row.command}, ${row.creatorRecordId}, ${row.asin}, ${row.originalAsin}, ${row.result},
        ${row.errors}::text[], ${row.requiredNextState}, ${row.recipientBindingFp}, ${JSON.stringify(row.detail)}::jsonb, ${row.previewReadAt},
        ${row.previewValidUntil}, ${row.inventoryCheckedAt}, ${row.startedAt}, ${row.completedAt}, ${source}, ${digest}, ${actorUserId})
      on conflict (org_id, run_id) do nothing returning derived_order_key`;
    if (result.length === 0) {
      const [held] = await sql<{ source_digest: string; derived_order_key: string }[]>`select source_digest, derived_order_key
        from public.creator_sample_preflights where org_id = ${orgId} and run_id = ${row.runId}`;
      if (held?.source_digest !== digest) {
        throw new CreatorWriteRefusal('run_id_reused', `Run ${row.runId} is already recorded with a different result.`);
      }
      derivedOrderKeys.push(held.derived_order_key);
      continue;
    }
    derivedOrderKeys.push(String(result[0]!['derived_order_key']));
    inserted++;
    await sql`insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, asin, reason_code, source,
        actor_user_id)
      values (${orgId}, ${`preflight:${row.runId}`}, ${row.creatorRecordId}, 'preflight_recorded', ${row.completedAt}, ${row.asin},
        ${`${row.command === 'preflight' ? 'preflight' : 'switch'}_${row.result.toLowerCase()}`}, ${source}, ${actorUserId})
      on conflict (org_id, event_key) do nothing`;
  }
  return { read: rows.length, inserted, updated: 0, unchanged: rows.length - inserted, derivedOrderKeys };
}

/**
 * The file import's pre-check, inside its transaction: a pre-flight whose
 * record is not registered, or whose run id is already held with another
 * result, is set aside and counted invalid instead of failing the whole
 * import. The MCP tool refuses both instead.
 */
export async function partitionCreatorPreflights(sql: QuerySql, orgId: string, rows: readonly CreatorPreflightWrite[]): Promise<{
  writable: CreatorPreflightWrite[]; refused: { index: number; code: 'record_not_found' | 'run_id_reused' }[];
}> {
  const ids = [...new Set(rows.map((row) => row.creatorRecordId))];
  const known = new Set(ids.length === 0 ? [] : (await sql<{ id: string }[]>`select creator_record_id as id from public.creator_records
    where org_id = ${orgId} and creator_record_id = any(${ids}::text[])`).map((row) => row.id));
  const runs = rows.map((row) => row.runId);
  const held = new Map(runs.length === 0 ? [] : (await sql<{ run_id: string; source_digest: string }[]>`select run_id, source_digest
    from public.creator_sample_preflights where org_id = ${orgId} and run_id = any(${runs}::text[])`).map((row) => [row.run_id, row.source_digest]));
  const writable: CreatorPreflightWrite[] = [];
  const refused: { index: number; code: 'record_not_found' | 'run_id_reused' }[] = [];
  rows.forEach((row, index) => {
    if (!known.has(row.creatorRecordId)) refused.push({ index, code: 'record_not_found' });
    else if (held.has(row.runId) && held.get(row.runId) !== creatorContentDigest(row)) refused.push({ index, code: 'run_id_reused' });
    else writable.push(row);
  });
  return { writable, refused };
}

// ---------------------------------------------------------------------------
// Reads for the screens
// ---------------------------------------------------------------------------

interface PreflightRow {
  id: string; run_id: string; command: string; creator_record_id: string; asin: string; original_asin: string | null; derived_order_key: string;
  result: string; errors: string[]; required_next_state: string; recipient_binding_fp: string | null; detail: Record<string, unknown>;
  started_at: Date; completed_at: Date; recorded_at: Date; source: string;
}
const PREFLIGHT_COLUMNS = `id, run_id, command, creator_record_id, asin, original_asin, derived_order_key, result, errors, required_next_state,
  recipient_binding_fp, detail, started_at, completed_at, recorded_at, source`;

function samplePreflight(row: PreflightRow): CreatorSamplePreflight {
  const d = row.detail;
  return CreatorSamplePreflight.parse({
    id: row.id, runId: row.run_id, creatorRecordId: row.creator_record_id, asin: row.asin, derivedOrderKey: row.derived_order_key, result: row.result,
    computedScore: d['computedScore'], errors: row.errors, requiredNextState: row.required_next_state, checks: d['checks'],
    sku: d['sku'] ?? null, campaignId: d['campaignId'] ?? null, productTitle: d['productTitle'] ?? null, trackerSourceRef: d['trackerSourceRef'] ?? null,
    quantity: d['quantity'] ?? null, feeCents: d['feeCents'] ?? null, feeCapCents: d['feeCapCents'] ?? null,
    recipientBound: row.recipient_binding_fp !== null, inventory: d['inventory'] ?? null, preview: d['preview'] ?? null,
    startedAt: iso(row.started_at), completedAt: iso(row.completed_at), recordedAt: iso(row.recorded_at), source: row.source,
  });
}

function switchPreflight(row: PreflightRow): CreatorSwitchPreflight {
  const d = row.detail;
  return CreatorSwitchPreflight.parse({
    id: row.id, runId: row.run_id, creatorRecordId: row.creator_record_id, phase: d['phase'], originalAsin: row.original_asin, alternateAsin: row.asin,
    alternateSku: d['alternateSku'] ?? null, result: row.result, outcome: creatorPreflightOutcome(row.errors), errors: row.errors,
    requiredNextState: row.required_next_state, inventory: d['inventory'] ?? null,
    originalUnavailableReason: d['originalUnavailableReason'] ?? null, originalBlockerEvidenceReference: d['originalBlockerEvidenceReference'] ?? null,
    startedAt: iso(row.started_at), completedAt: iso(row.completed_at), recordedAt: iso(row.recorded_at), source: row.source,
  });
}

const SHIPMENT_COLUMNS = `creator_record_id, asin, derived_order_key, sku, campaign_id, reservation_id, lane_state, runner_order_id, fee_cents,
  fee_cap_cents, reserved_at, verified_at, confirmed_at, cancelled_at, cancellation_reason, reconciliation_reason, mcf_status, mcf_operation,
  mcf_read_at, packages, source, imported_at`;
type LaneRow = ShipmentRow & { shipments: unknown; mcf_settlement: string | null; mcf_not_found_probes: number; mcf_probed_at: Date | null };

async function readLane(handle: QueryHandle, orgId: string, key: string): Promise<LaneRow | null> {
  const [row] = await handle.sql<LaneRow[]>`select ${handle.sql.unsafe(SHIPMENT_COLUMNS)}, shipments, mcf_settlement, mcf_not_found_probes,
      mcf_probed_at from public.creator_sample_shipments where org_id = ${orgId} and derived_order_key = ${key}`;
  return row ?? null;
}
async function lockOf(handle: QueryHandle, orgId: string, id: string | null): Promise<CreatorLockState | null> {
  if (id === null) return null;
  const [row] = await handle.sql<{ lock_state: CreatorLockState }[]>`select lock_state from public.creator_records
    where org_id = ${orgId} and creator_record_id = ${id}`;
  return row?.lock_state ?? null;
}

/** `/creators/samples/[key]/preflight`. Null when the key is not a derived order key. */
export async function readCreatorPreflightDetail(handle: QueryHandle, orgId: string, key: string): Promise<CreatorPreflightDetail | null> {
  if (!CreatorSampleOrderKey.safeParse(key).success) return null;
  const rows = await handle.sql<PreflightRow[]>`select ${handle.sql.unsafe(PREFLIGHT_COLUMNS)} from public.creator_sample_preflights
    where org_id = ${orgId} and derived_order_key = ${key} and command = 'preflight' order by completed_at desc, recorded_at desc limit 1`;
  const [{ total } = { total: 0 }] = await handle.sql<{ total: number }[]>`select count(*)::int as total from public.creator_sample_preflights
    where org_id = ${orgId} and derived_order_key = ${key} and command = 'preflight'`;
  const lane = await readLane(handle, orgId, key);
  const preflight = rows[0] === undefined ? null : samplePreflight(rows[0]);
  const recordId = preflight?.creatorRecordId ?? lane?.creator_record_id ?? null;
  return CreatorPreflightDetail.parse({
    lastImport: await readLatestCreatorImport(handle, orgId), derivedOrderKey: key, creatorRecordId: recordId,
    asin: preflight?.asin ?? lane?.asin ?? null, lockState: await lockOf(handle, orgId, recordId), preflight,
    earlierRuns: Math.max(0, total - (preflight === null ? 0 : 1)), lane: lane === null ? null : creatorShipmentFromRow(lane),
  });
}

interface ObservationRow {
  observation_key: string; creator_record_id: string; asin: string; derived_order_key: string; queried_order_id: string; operation: string;
  outcome: string; mcf_status: string | null; shipments: unknown; packages: unknown; read_at: Date; recorded_at: Date;
}
const observationEvent = (row: ObservationRow): CreatorMcfObservationEvent => CreatorMcfObservationEvent.parse({
  observationKey: row.observation_key, creatorRecordId: row.creator_record_id, asin: row.asin, derivedOrderKey: row.derived_order_key,
  queriedOrderId: row.queried_order_id, operation: row.operation, outcome: row.outcome, status: row.mcf_status, shipments: row.shipments,
  packages: row.packages, readAt: iso(row.read_at), recordedAt: iso(row.recorded_at),
});

/** `/creators/samples/fulfillment/[key]`. Null when the key is not a derived order key. */
export async function readCreatorFulfillmentDetail(handle: QueryHandle, orgId: string, key: string): Promise<CreatorFulfillmentDetail | null> {
  if (!CreatorSampleOrderKey.safeParse(key).success) return null;
  const lane = await readLane(handle, orgId, key);
  const rows = await handle.sql<ObservationRow[]>`select observation_key, creator_record_id, asin, derived_order_key, queried_order_id,
      operation, outcome, mcf_status, shipments, packages, read_at, recorded_at
    from public.creator_mcf_observations where org_id = ${orgId} and derived_order_key = ${key}
    order by read_at desc, recorded_at desc limit 20`;
  const [{ total } = { total: 0 }] = await handle.sql<{ total: number }[]>`select count(*)::int as total from public.creator_mcf_observations
    where org_id = ${orgId} and derived_order_key = ${key}`;
  const settlement: CreatorMcfSettlementState | null = lane?.mcf_settlement == null || lane.mcf_probed_at === null ? null
    : { settlement: lane.mcf_settlement as CreatorMcfSettlementState['settlement'], notFoundProbes: lane.mcf_not_found_probes,
      lastProbeAt: iso(lane.mcf_probed_at)! };
  return CreatorFulfillmentDetail.parse({
    lastImport: await readLatestCreatorImport(handle, orgId), derivedOrderKey: key,
    lane: lane === null ? null : creatorShipmentFromRow(lane), lockState: await lockOf(handle, orgId, lane?.creator_record_id ?? null),
    settlement, shipments: lane?.shipments ?? null, observations: rows.map(observationEvent), observationsTotal: total,
  });
}

/** `/creators/samples/[key]/product-switch`: the key is the original lane's. Null when it is not a derived order key. */
export async function readCreatorProductSwitch(handle: QueryHandle, orgId: string, key: string): Promise<CreatorProductSwitchDetail | null> {
  if (!CreatorSampleOrderKey.safeParse(key).success) return null;
  const switches = await handle.sql<PreflightRow[]>`select distinct on (asin) ${handle.sql.unsafe(PREFLIGHT_COLUMNS)}
    from public.creator_sample_preflights where org_id = ${orgId} and original_order_key = ${key} and command = 'preflight-switch'
    order by asin, completed_at desc, recorded_at desc`;
  const [original] = await handle.sql<PreflightRow[]>`select ${handle.sql.unsafe(PREFLIGHT_COLUMNS)} from public.creator_sample_preflights
    where org_id = ${orgId} and derived_order_key = ${key} and command = 'preflight' order by completed_at desc, recorded_at desc limit 1`;
  const lane = await readLane(handle, orgId, key);
  const alternates = switches.map(switchPreflight)
    .sort((left, right) => Number(right.result === 'PASS') - Number(left.result === 'PASS') || left.alternateAsin.localeCompare(right.alternateAsin));
  const recordId = alternates[0]?.creatorRecordId ?? original?.creator_record_id ?? lane?.creator_record_id ?? null;
  const originalAsin = alternates[0]?.originalAsin ?? original?.asin ?? lane?.asin ?? null;
  const [record] = recordId === null ? [] : await handle.sql<{ status: string | null; lock_state: CreatorLockState }[]>`
    select status, lock_state from public.creator_records where org_id = ${orgId} and creator_record_id = ${recordId}`;
  const [queue] = recordId === null ? [] : await handle.sql<Record<string, unknown>[]>`
    select q.run_date::text as "runDate", q.queue_id as "queueId", q.occurrence, q.creator_record_id as "creatorRecordId",
      q.brand, q.campaign_tab as "campaignTab", q.current_status as "currentStatus", q.computed_score as "computedScore",
      q.missing_checks as missing, q.due_date::text as "dueDate", q.action_type as "actionType", q.gate_result as "gateResult",
      q.queue_state as "queueState", q.reason, r.lock_state as "lockState", q.source
    from public.creator_daily_queue q
    left join public.creator_records r on r.org_id = q.org_id and r.creator_record_id = q.creator_record_id
    where q.org_id = ${orgId} and q.creator_record_id = ${recordId}
      and q.run_date = (select max(run_date) from public.creator_daily_queue where org_id = ${orgId})
    order by q.occurrence limit 1`;
  return CreatorProductSwitchDetail.parse({
    lastImport: await readLatestCreatorImport(handle, orgId), derivedOrderKey: key, creatorRecordId: recordId, originalAsin,
    lockState: record?.lock_state ?? null, status: record?.status ?? null,
    originalPreflight: original === undefined ? null : samplePreflight(original), alternates,
    queueItem: queue === undefined ? null : CreatorDailyQueueItem.parse(queue),
  });
}

/**
 * Every lane's settlement in one read, keyed by derived order key: the daily
 * report's view. A lane Amazon has not been asked about is absent, not "found".
 */
export async function readCreatorMcfSettlements(handle: QueryHandle, orgId: string): Promise<Record<string, CreatorMcfSettlementState>> {
  const rows = await handle.sql<{ derived_order_key: string; mcf_settlement: string; mcf_not_found_probes: number; mcf_probed_at: Date }[]>`
    select derived_order_key, mcf_settlement, mcf_not_found_probes, mcf_probed_at from public.creator_sample_shipments
    where org_id = ${orgId} and mcf_settlement is not null order by derived_order_key`;
  return Object.fromEntries(rows.map((row) => [row.derived_order_key, {
    settlement: row.mcf_settlement as CreatorMcfSettlementState['settlement'], notFoundProbes: row.mcf_not_found_probes,
    lastProbeAt: iso(row.mcf_probed_at)!,
  }]));
}

// ---------------------------------------------------------------------------
// The observe job (worker, service role)
// ---------------------------------------------------------------------------

/** The lane states the observe job asks Amazon about: submitted, ambiguous, confirmed. */
export const CREATOR_OBSERVABLE_LANE_STATES = ['Verified for Submit', 'Reconciliation Required', 'Confirmed'] as const;

/**
 * The one predicate for an SP-API connection the observe job may use: an
 * enabled binding on a syncing profile of an active connection with a stored
 * secret, as resolveActiveSpApiProfileBinding requires. Both the scope list and
 * the job's own connection count use it, so they cannot disagree.
 */
const USABLE_BINDINGS = `select b.org_id, b.connection_id, b.profile_id, b.marketplace_id, b.created_at, b.id
    from public.spapi_profile_bindings b
    join public.ad_profiles p on p.id = b.profile_id and p.org_id = b.org_id
    join public.spapi_connections c on c.id = b.connection_id and c.org_id = b.org_id
   where b.enabled and p.sync_enabled and c.status = 'active' and c.vault_secret_id is not null
     and nullif(btrim(c.selling_partner_id), '') is not null and b.marketplace_id = any(c.marketplace_ids)
     and p.region = app.spapi_region_for_marketplace(b.marketplace_id)`;

/**
 * One SP-API binding per organisation that has a lane to observe. An
 * organisation with more than one active SP-API connection is listed as
 * refused: a not-found from one seller account would not settle anything.
 */
export async function listCreatorMcfObserveScopes(handle: QueryHandle): Promise<{
  scopes: { orgId: string; profileId: string; marketplaceId: string }[]; refusedOrgs: number;
}> {
  const rows = await handle.sql<{ org_id: string; connections: number; profile_id: string | null; marketplace_id: string | null }[]>`
    with orgs as (
      select distinct s.org_id from public.creator_sample_shipments s
      where s.lane_state = any(${[...CREATOR_OBSERVABLE_LANE_STATES]}::text[])
    ), bindings as (${handle.sql.unsafe(USABLE_BINDINGS)})
    select o.org_id, (select count(distinct connection_id)::int from bindings x where x.org_id = o.org_id) as connections,
      first.profile_id, first.marketplace_id
      from orgs o
      left join lateral (select profile_id, marketplace_id from bindings x where x.org_id = o.org_id
        order by x.created_at, x.id limit 1) first on true
     order by o.org_id`;
  const scopes = rows.filter((row) => row.connections === 1 && row.profile_id !== null && row.marketplace_id !== null)
    .map((row) => ({ orgId: row.org_id, profileId: row.profile_id!, marketplaceId: row.marketplace_id! }));
  return { scopes, refusedOrgs: rows.length - scopes.length };
}

/** How many SP-API connections the organisation can observe through; the job refuses to settle anything unless it is one. */
export async function countActiveCreatorSpApiConnections(handle: QueryHandle, orgId: string): Promise<number> {
  const [row] = await handle.sql<{ count: number }[]>`select count(distinct connection_id)::int as count
    from (${handle.sql.unsafe(USABLE_BINDINGS)}) usable where org_id = ${orgId}`;
  return row?.count ?? 0;
}

export interface CreatorObservableLane {
  creatorRecordId: string;
  asin: string;
  derivedOrderKey: string;
  laneState: (typeof CREATOR_OBSERVABLE_LANE_STATES)[number];
  runnerOrderId: string | null;
  reservedAt: string | null;
  mcfStatus: string | null;
  /** Package numbers the newest found read listed, with the carrier status last read for each. */
  packages: { packageNumber: number; carrierStatus: string | null }[];
}

/**
 * Lanes to ask Amazon about, oldest probe first, at most `limit`. A lane stops
 * being observed once Amazon reports a terminal order status or every package
 * delivered.
 */
export async function readCreatorObservableLanes(handle: QueryHandle, orgId: string, limit: number): Promise<CreatorObservableLane[]> {
  const rows = await handle.sql<{ creator_record_id: string; asin: string; derived_order_key: string; lane_state: string; runner_order_id: string | null;
    reserved_at: Date | null; mcf_status: string | null; packages: unknown }[]>`
    select creator_record_id, asin, derived_order_key, lane_state, runner_order_id, reserved_at, mcf_status, packages
      from public.creator_sample_shipments
     where org_id = ${orgId} and lane_state = any(${[...CREATOR_OBSERVABLE_LANE_STATES]}::text[])
       and (mcf_status is null or mcf_status not in ('Cancelled', 'Unfulfillable', 'Invalid'))
       -- Fully delivered: every package of every live shipment reads DELIVERED. A cancelled shipment's
       -- package never moves, so it is not a stage (a replacement entry carries the parcel).
       and not (mcf_status in ('Complete', 'CompletePartialled') and jsonb_typeof(shipments) = 'array'
         and exists (select 1 from jsonb_array_elements(shipments) sh, jsonb_array_elements(sh->'packages') sp
           where sh->>'status' not in ('CANCELLED_BY_FULFILLER', 'CANCELLED_BY_SELLER'))
         and not exists (select 1 from jsonb_array_elements(shipments) sh, jsonb_array_elements(sh->'packages') sp
           where sh->>'status' not in ('CANCELLED_BY_FULFILLER', 'CANCELLED_BY_SELLER')
             and not exists (select 1 from jsonb_array_elements(coalesce(packages, '[]'::jsonb)) p
               where (p->>'packageNumber')::bigint = (sp->>'packageNumber')::bigint and p->>'carrierStatus' = 'DELIVERED')))
     order by mcf_probed_at nulls first, creator_record_id, asin
     limit ${limit}`;
  return rows.map((row) => ({
    creatorRecordId: row.creator_record_id, asin: row.asin, derivedOrderKey: row.derived_order_key,
    laneState: row.lane_state as CreatorObservableLane['laneState'], runnerOrderId: row.runner_order_id, reservedAt: iso(row.reserved_at),
    mcfStatus: row.mcf_status,
    packages: Array.isArray(row.packages) ? (row.packages as { packageNumber: number; carrierStatus: string | null }[])
      .map((item) => ({ packageNumber: item.packageNumber, carrierStatus: item.carrierStatus ?? null })) : [],
  }));
}

/** Observation keys this job already wrote, so a retried job does not read and record a lane twice. */
export async function readCreatorObservedKeys(handle: QueryHandle, orgId: string, jobId: string): Promise<Set<string>> {
  const rows = await handle.sql<{ derived_order_key: string }[]>`select derived_order_key from public.creator_mcf_observations
    where org_id = ${orgId} and job_id = ${jobId}`;
  return new Set(rows.map((row) => row.derived_order_key));
}

/**
 * Record one read of one lane. The lane is found by its derived key; a key the
 * organisation does not hold is refused. A replay of the same observation key
 * is unchanged. Returns what happened and the lane's settlement after it.
 */
export async function recordCreatorMcfObservation(handle: Pick<DbHandle, 'sql'>, orgId: string, raw: CreatorMcfObservationWrite):
  Promise<{ outcome: 'inserted' | 'unchanged'; settlement: CreatorMcfSettlementState | null }> {
  const write = CreatorMcfObservationWrite.parse(raw);
  const shipments = write.shipments === null ? null : write.shipments.map((item) => FulfillmentShipmentObservation.parse(item));
  return handle.sql.begin(async (sql) => {
    const [lane] = await sql<{ creator_record_id: string; asin: string }[]>`select creator_record_id, asin from public.creator_sample_shipments
      where org_id = ${orgId} and derived_order_key = ${write.derivedOrderKey} for update`;
    if (lane === undefined) throw new CreatorWriteRefusal('lane_not_found', 'No sample lane carries this derived order key.');
    const inserted = await sql`insert into public.creator_mcf_observations(org_id, observation_key, creator_record_id, asin, queried_order_id,
        operation, outcome, mcf_status, shipments, packages, read_at, job_id)
      values (${orgId}, ${write.observationKey}, ${lane.creator_record_id}, ${lane.asin}, ${write.queriedOrderId}, ${write.operation},
        ${write.outcome}, ${write.status}, ${shipments === null ? null : JSON.stringify(shipments)}::jsonb,
        ${write.packages === null ? null : JSON.stringify(write.packages)}::jsonb, ${write.readAt}, ${write.jobId})
      on conflict (org_id, observation_key) do nothing returning id`;
    const [state] = await sql<{ mcf_settlement: string | null; mcf_not_found_probes: number; mcf_probed_at: Date | null }[]>`
      select mcf_settlement, mcf_not_found_probes, mcf_probed_at from public.creator_sample_shipments
      where org_id = ${orgId} and derived_order_key = ${write.derivedOrderKey}`;
    return {
      outcome: inserted.length === 1 ? 'inserted' as const : 'unchanged' as const,
      settlement: state?.mcf_settlement == null || state.mcf_probed_at === null ? null : {
        settlement: state.mcf_settlement as CreatorMcfSettlementState['settlement'], notFoundProbes: state.mcf_not_found_probes,
        lastProbeAt: iso(state.mcf_probed_at)!,
      },
    };
  });
}

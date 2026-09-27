/**
 * Creator Connections round 3a against a migrated database: recorded
 * pre-flights and read-only MCF observations. Tenant RLS by role, append-only
 * rows, idempotent replays, one derivation of the sample order key, and the
 * settlement the observation trigger derives. Synthetic values only.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREATOR_MCF_NOT_FOUND_ESCALATION, type CreatorMcfObservationWrite, type CreatorPreflightResultInput } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asAnon, asServiceRole, asUser } from '../testing/rls.js';
import { creatorSampleOrderKey, persistCreatorImport, type CreatorImportBatch, type CreatorRecordWrite } from './creators.js';
import {
  countActiveCreatorSpApiConnections, creatorPreflightRow, listCreatorMcfObserveScopes, readCreatorFulfillmentDetail, readCreatorObservableLanes,
  readCreatorMcfSettlements, readCreatorObservedKeys, readCreatorPreflightDetail, readCreatorProductSwitch, recordCreatorMcfObservation, writeCreatorPreflights,
} from './creators-samples.js';

const available = await databaseAvailable();
const OWNER = '33400000-0000-4000-8000-000000000001';
const ADMIN = '33400000-0000-4000-8000-000000000002';
const ANALYST = '33400000-0000-4000-8000-000000000003';
const VIEWER = '33400000-0000-4000-8000-000000000004';
const FOREIGN = '33400000-0000-4000-8000-000000000005';
const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');
const ASIN = 'B0D9K3M2QP';
const FBM = 'B0D7Q1V8LM';

const record = (id: string): CreatorRecordWrite => ({
  creatorRecordId: id, brand: 'Synthetic brand', campaignId: 'campaign-synthetic-1',
  fingerprints: { storefront: fp(`${id}:storefront`), thread: fp(`${id}:thread`), fullName: null, email: null, phone: null, address: null },
  recordState: 'Active', lockState: 'Unlocked', escalationReason: null, runnerVersion: 1, createdOn: '2026-09-01', lastVerifiedOn: null,
});
const lane = (id: string, asin: string, laneState: 'Reconciliation Required' | 'Confirmed' | 'Reserved', change: Record<string, unknown> = {}) => ({
  creatorRecordId: id, asin, sku: 'SW-DERMA-05-FBA', campaignId: 'campaign-synthetic-1', reservationId: `MCFR-${id.slice(-4)}000000000000`,
  laneState, runnerOrderId: laneState === 'Confirmed' ? `synthetic-order-${id.slice(-4)}` : null, feeCents: 620, feeCapCents: 800,
  reservedAt: '2026-09-08T06:40:00.000Z', verifiedAt: '2026-09-08T06:43:00.000Z', confirmedAt: laneState === 'Confirmed' ? '2026-09-09T06:40:00.000Z' : null,
  cancelledAt: null, cancellationReason: null, reconciliationReason: laneState === 'Reconciliation Required' ? 'outcome_unknown' as const : null, ...change,
});
function seed(orgId: string): CreatorImportBatch {
  const ids = ['CCR-SW-26-0088', 'CCR-SW-26-0151', 'CCR-SW-26-0072', 'CCR-SW-26-0166'];
  return {
    orgId, startedAt: '2026-09-09T06:14:00.000Z', source: 'control-runner', files: ['registry'],
    records: { read: ids.length, invalid: 0, rows: ids.map(record) }, actions: null, queue: null, sweeps: null,
    shipments: { read: 2, invalid: 0, rows: [lane('CCR-SW-26-0072', ASIN, 'Reconciliation Required'), lane('CCR-SW-26-0088', ASIN, 'Confirmed')] },
  };
}
const preflight = (runId: string, change: Partial<CreatorPreflightResultInput & { command: 'preflight' }> = {},
  result: Record<string, unknown> = {}): CreatorPreflightResultInput => ({
  command: 'preflight', run_id: runId, started_at: '2026-09-09T06:33:04Z', completed_at: '2026-09-09T06:33:19Z',
  result: { result: 'PASS', creator_record_id: 'CCR-SW-26-0088', computed_score: 10, errors: [], required_next_state: 'Locked for MCF', quantity: 1,
    visible_fee_cents: 620, approved_fee_cap_cents: 800, selected_asin: ASIN, selected_sku: 'SW-DERMA-05-FBA', product_title: 'Synthetic roller',
    campaign_id: 'campaign-synthetic-1', tracker_source_ref: 'tracker:synthetic:row-87', recipient_binding: fp('recipient-0088'), ...result } as never,
  inventory: { asin: (result['selected_asin'] as string | undefined) ?? ASIN, sku: 'SW-DERMA-05-FBA', fulfillment_channel: 'AFN', mcf_fulfillable: true,
    fulfillable_quantity: 37, inventory_checked_at: '2026-09-09T06:33:17Z', fulfillment_evidence_reference: 'ev:mcf-inv-16' },
  preview: { operation: 'getFulfillmentPreview', read_at: '2026-09-09T06:33:17Z', valid_until: null, is_fulfillable: true, fee_cents: 620,
    currency: 'EUR', constraints: [] },
  reads: [{ check: 'fulfillable_stock', read_at: '2026-09-09T06:33:17Z', evidence_reference: 'ev:mcf-inv-16' }],
  ...change,
} as CreatorPreflightResultInput);
const held = preflight('preflight-0151-1', {}, { result: 'HOLD', creator_record_id: 'CCR-SW-26-0151', selected_asin: FBM, selected_sku: 'SW-DERMA-03-FBM',
  errors: ['selected_sku_not_mcf_fulfillable', 'insufficient_mcf_fulfillable_quantity'], required_next_state: 'Conflict or Held' });
const switchResult = (runId: string, alternate: string, errors: string[]): CreatorPreflightResultInput => ({
  command: 'preflight-switch', run_id: runId, started_at: '2026-09-09T06:36:00Z', completed_at: '2026-09-09T06:36:09Z',
  result: { result: errors.length === 0 ? 'PASS' : 'HOLD', phase: 'offer', creator_record_id: 'CCR-SW-26-0166', errors,
    required_next_state: errors.length === 0 ? 'Product Switch Pending' : 'Conflict or Held', original_asin: FBM, alternate_asin: alternate,
    alternate_sku: `SYN-${alternate.slice(-3)}` } as never,
  inventory: { asin: alternate, sku: `SYN-${alternate.slice(-3)}`, fulfillment_channel: errors.length === 0 ? 'AFN' : 'MFN',
    mcf_fulfillable: errors.length === 0, fulfillable_quantity: errors.length === 0 ? 37 : 0, inventory_checked_at: '2026-09-09T06:36:05Z',
    fulfillment_evidence_reference: 'ev:mcf-inv-17' },
  original_unavailable_reason: 'not_mcf_fulfillable', original_blocker_evidence_reference: 'ev:mcf-inv-17',
});
const observation = (key: string, observationKey: string, readAt: string, found: boolean): CreatorMcfObservationWrite => ({
  observationKey, derivedOrderKey: key, queriedOrderId: key, operation: found ? 'getFulfillmentOrder' : 'listAllFulfillmentOrders',
  outcome: found ? 'found' : 'not_found', status: found ? 'Processing' : null,
  shipments: found ? [{ amazonShipmentId: 'shipment-1', status: 'PENDING', shippedAt: null, estimatedArrivalAt: '2026-09-12T18:00:00.000Z',
    packages: [{ packageNumber: 12, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-1', estimatedArrivalAt: null }] }] : null,
  packages: found ? [{ packageNumber: 12, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-1', estimatedArrivalAt: null, carrierStatus: null,
    carrierStatusReadAt: readAt }] : null,
  readAt, jobId: observationKey.split(':')[0]!,
});

describe.skipIf(!available)('Creator Connections pre-flights and MCF observation', () => {
  let db: TestDatabase;
  let orgId: string;
  let foreignOrg: string;
  beforeAll(async () => {
    db = await createTestDatabase('wp334_creator_samples');
    const [a] = await db.sql`select app.seed_tenant_fixture('creator-samples', ${OWNER}, 'owner') as id`;
    orgId = String(a!['id']);
    const [b] = await db.sql`select app.seed_tenant_fixture('creator-samples-foreign', ${FOREIGN}, 'owner') as id`;
    foreignOrg = String(b!['id']);
    for (const [user, role] of [[ADMIN, 'admin'], [ANALYST, 'analyst'], [VIEWER, 'viewer']] as const) {
      await db.sql`select public.auth_user_stub(${user})`;
      await db.sql`insert into public.org_members(org_id, user_id, role) values (${orgId}, ${user}, ${role})`;
    }
    await persistCreatorImport(db, seed(orgId));
    await persistCreatorImport(db, seed(foreignOrg));
  }, 180_000);
  afterAll(async () => { await db?.drop(); });

  it('derives the sample order key in one place: the SQL function, every table\'s column and the TypeScript mirror agree', async () => {
    await writeCreatorPreflights(db.sql, orgId, 'mcp', [creatorPreflightRow(preflight('preflight-0088-key'))], OWNER);
    await recordCreatorMcfObservation(db, orgId, observation(creatorSampleOrderKey(orgId, 'CCR-SW-26-0088', ASIN), 'job-key:0088', '2026-09-09T06:50:00.000Z', true));
    const [keys] = await db.sql<{ fn: string; lane: string; preflight: string; observation: string }[]>`select
        app.creator_sample_order_key(${orgId}::uuid, 'CCR-SW-26-0088', ${ASIN}) as fn,
        (select derived_order_key from public.creator_sample_shipments where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0088') as lane,
        (select derived_order_key from public.creator_sample_preflights where org_id = ${orgId} and run_id = 'preflight-0088-key') as preflight,
        (select derived_order_key from public.creator_mcf_observations where org_id = ${orgId} and observation_key = 'job-key:0088') as observation`;
    const expected = creatorSampleOrderKey(orgId, 'CCR-SW-26-0088', ASIN);
    expect(keys).toEqual({ fn: expected, lane: expected, preflight: expected, observation: expected });
    expect(expected).toMatch(/^CCS-[0-9a-f]{32}$/);
    expect(creatorSampleOrderKey(foreignOrg, 'CCR-SW-26-0088', ASIN)).not.toBe(expected);
  });

  it('records pre-flights idempotently by run id, refuses a reused run id and an unregistered record, and logs each run once', async () => {
    const rows = [creatorPreflightRow(preflight('preflight-0088-1')), creatorPreflightRow(held)];
    expect(await writeCreatorPreflights(db.sql, orgId, 'mcp', rows, ADMIN)).toMatchObject({ read: 2, inserted: 2, updated: 0, unchanged: 0 });
    const replay = await writeCreatorPreflights(db.sql, orgId, 'mcp', rows, ADMIN);
    expect(replay).toEqual({ read: 2, inserted: 0, updated: 0, unchanged: 2, derivedOrderKeys: [creatorSampleOrderKey(orgId, 'CCR-SW-26-0088', ASIN),
      creatorSampleOrderKey(orgId, 'CCR-SW-26-0151', FBM)] });
    await expect(db.sql.begin((sql) => writeCreatorPreflights(sql, orgId, 'mcp', [creatorPreflightRow(preflight('preflight-0088-1', {},
      { visible_fee_cents: 790 }))], ADMIN))).rejects.toMatchObject({ code: 'run_id_reused' });
    await expect(db.sql.begin((sql) => writeCreatorPreflights(sql, orgId, 'mcp', [creatorPreflightRow(preflight('preflight-9999', {},
      { creator_record_id: 'CCR-SW-26-9999' }))], ADMIN))).rejects.toMatchObject({ code: 'record_not_found' });
    const logged = await db.sql<{ event_key: string; reason_code: string }[]>`select event_key, reason_code from public.creator_action_log
      where org_id = ${orgId} and action = 'preflight_recorded' and event_key in ('preflight:preflight-0088-1', 'preflight:preflight-0151-1') order by event_key`;
    expect(logged).toEqual([{ event_key: 'preflight:preflight-0088-1', reason_code: 'preflight_pass' },
      { event_key: 'preflight:preflight-0151-1', reason_code: 'preflight_hold' }]);
    const [stored] = await db.sql`select preview_read_at is not null as preview, inventory_checked_at is not null as stock, id is not null as id
      from public.creator_sample_preflights where org_id = ${orgId} and run_id = 'preflight-0088-1'`;
    expect(stored).toEqual({ preview: true, stock: true, id: true });
  });

  it('imports preflight-results through the same mapping, counts it, and replays it unchanged', async () => {
    const section = { read: 3, invalid: 1, rows: [creatorPreflightRow(switchResult('switch-0166-a', ASIN, [])),
      creatorPreflightRow(switchResult('switch-0166-b', 'B0D6H9YY41', ['selected_sku_not_mcf_fulfillable', 'insufficient_mcf_fulfillable_quantity']))] };
    const batch = { ...seed(orgId), records: null, shipments: null, files: ['preflight_results' as const], preflights: section };
    const first = await persistCreatorImport(db, batch);
    expect(first.counts.preflights).toEqual({ read: 3, valid: 2, invalid: 1, inserted: 2, updated: 0, unchanged: 0, removed: 0 });
    expect(first.counts.records).toBeNull();
    const again = await persistCreatorImport(db, batch);
    expect(again.counts.preflights).toEqual({ read: 3, valid: 2, invalid: 1, inserted: 0, updated: 0, unchanged: 2, removed: 0 });
    expect(again.files).toEqual(['preflight_results']);
  });

  it('counts a pre-flight for an unregistered record or a reused run id as invalid without failing the rest of the import', async () => {
    const good = creatorPreflightRow(preflight('preflight-0088-import'));
    const stranger = creatorPreflightRow(preflight('preflight-9997-import', {}, { creator_record_id: 'CCR-SW-26-9997' }));
    const reused = creatorPreflightRow(preflight('preflight-0088-1', {}, { visible_fee_cents: 700 }));
    const batch = { ...seed(orgId), files: ['registry' as const, 'preflight_results' as const],
      preflights: { read: 3, invalid: 0, rows: [stranger, good, reused] } };
    const run = await persistCreatorImport(db, batch);
    expect(run.status).toBe('succeeded');
    expect(run.counts.preflights).toEqual({ read: 3, valid: 1, invalid: 2, inserted: 1, updated: 0, unchanged: 0, removed: 0 });
    expect(run.counts.records).toMatchObject({ read: 4, valid: 4 });
    const [held] = await db.sql`select detail->>'feeCents' as fee from public.creator_sample_preflights where org_id = ${orgId} and run_id = 'preflight-0088-1'`;
    expect(held).toEqual({ fee: '620' });
  });

  it('reads the newest pre-flight for a lane with the eight checks, and the switch alternates offered first', async () => {
    const key = creatorSampleOrderKey(orgId, 'CCR-SW-26-0088', ASIN);
    const detail = await asUser(db, ANALYST, (sql) => readCreatorPreflightDetail({ sql }, orgId, key));
    expect(detail?.preflight?.runId).toBe('preflight-0088-import');
    expect(detail?.earlierRuns).toBe(2);
    expect(detail?.preflight?.checks.map((check) => check.outcome)).toEqual(Array(8).fill('pass'));
    expect(detail?.preflight?.checks[6]?.readAt).toBe('2026-09-09T06:33:17Z');
    expect(detail?.preflight?.checks.filter((check) => check.readAt === null)).toHaveLength(7);
    expect(detail).toMatchObject({ creatorRecordId: 'CCR-SW-26-0088', asin: ASIN, lockState: 'Unlocked', lane: { laneState: 'Confirmed' } });
    expect(detail?.preflight).toMatchObject({ recipientBound: true, feeCents: 620, feeCapCents: 800, inventory: { fulfillableQuantity: 37 } });
    const heldDetail = await readCreatorPreflightDetail(db, orgId, creatorSampleOrderKey(orgId, 'CCR-SW-26-0151', FBM));
    expect(heldDetail?.preflight?.checks.map((check) => check.outcome)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'hold', 'pass']);
    expect(heldDetail?.lane).toBeNull();
    expect(await readCreatorPreflightDetail(db, orgId, 'CCS-not-a-key')).toBeNull();
    const nothing = await readCreatorPreflightDetail(db, orgId, creatorSampleOrderKey(orgId, 'CCR-SW-26-0166', 'B0DB4X2NRT'));
    expect(nothing).toMatchObject({ preflight: null, lane: null, creatorRecordId: null, earlierRuns: 0 });

    const switchDetail = await readCreatorProductSwitch(db, orgId, creatorSampleOrderKey(orgId, 'CCR-SW-26-0166', FBM));
    expect(switchDetail?.alternates.map((alternate) => [alternate.alternateAsin, alternate.result, alternate.outcome]))
      .toEqual([[ASIN, 'PASS', 'pass'], ['B0D6H9YY41', 'HOLD', 'hold']]);
    expect(switchDetail).toMatchObject({ creatorRecordId: 'CCR-SW-26-0166', originalAsin: FBM, originalPreflight: null, lockState: 'Unlocked' });
  });

  it('settles an ambiguous submit from observation rows: not found three times running escalates, found resets, and nothing else moves', async () => {
    const key = creatorSampleOrderKey(orgId, 'CCR-SW-26-0072', ASIN);
    const before = await db.sql`select lane_state, reservation_id, reconciliation_reason from public.creator_sample_shipments
      where org_id = ${orgId} and derived_order_key = ${key}`;
    const settled = [];
    for (const [index, at] of ['2026-09-09T07:00:00.000Z', '2026-09-09T07:30:00.000Z', '2026-09-09T08:00:00.000Z'].entries()) {
      settled.push((await recordCreatorMcfObservation(db, orgId, observation(key, `job-${index}:0072`, at, false))).settlement);
    }
    expect(settled.map((state) => [state?.settlement, state?.notFoundProbes])).toEqual([['not_found', 1], ['not_found', 2], ['escalated', 3]]);
    expect(await recordCreatorMcfObservation(db, orgId, observation(key, 'job-2:0072', '2026-09-09T08:00:00.000Z', false)))
      .toMatchObject({ outcome: 'unchanged', settlement: { settlement: 'escalated', notFoundProbes: 3 } });
    // An older read arriving late is kept in the log and does not move the lane.
    expect(await recordCreatorMcfObservation(db, orgId, observation(key, 'job-late:0072', '2026-09-09T06:00:00.000Z', true)))
      .toMatchObject({ outcome: 'inserted', settlement: { settlement: 'escalated', notFoundProbes: 3 } });
    const found = await recordCreatorMcfObservation(db, orgId, observation(key, 'job-3:0072', '2026-09-09T09:00:00.000Z', true));
    expect(found.settlement).toEqual({ settlement: 'found', notFoundProbes: 0, lastProbeAt: '2026-09-09T09:00:00.000Z' });
    const after = await db.sql`select lane_state, reservation_id, reconciliation_reason from public.creator_sample_shipments
      where org_id = ${orgId} and derived_order_key = ${key}`;
    expect(after).toEqual(before);
    const detail = await asUser(db, ANALYST, (sql) => readCreatorFulfillmentDetail({ sql }, orgId, key));
    expect(detail?.observationsTotal).toBe(5);
    expect(detail?.observations.map((event) => event.outcome)).toEqual(['found', 'not_found', 'not_found', 'not_found', 'found']);
    expect(detail?.lane).toMatchObject({ laneState: 'Reconciliation Required', mcf: { status: 'Processing', operation: 'getFulfillmentOrder' } });
    expect(detail?.lane?.packages).toEqual([{ packageNumber: 12, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-1', estimatedArrivalAt: null,
      carrierStatus: null, carrierStatusReadAt: '2026-09-09T09:00:00.000Z' }]);
    expect(detail?.shipments?.[0]).toMatchObject({ amazonShipmentId: 'shipment-1', status: 'PENDING' });
    expect(await readCreatorObservedKeys(db, orgId, 'job-3')).toEqual(new Set([key]));
    const all = await asUser(db, ANALYST, (sql) => readCreatorMcfSettlements({ sql }, orgId));
    expect(all[key]).toEqual(found.settlement);
    expect(Object.keys(all).every((item) => item.startsWith('CCS-'))).toBe(true);
  });

  it('escalates at the same count in SQL as CREATOR_MCF_NOT_FOUND_ESCALATION says', async () => {
    const [source] = await db.sql<{ definition: string }[]>`select pg_get_functiondef('app.creator_mcf_observation_settle()'::regprocedure) as definition`;
    const thresholds = [...source!.definition.matchAll(/mcf_not_found_probes \+ 1 >= (\d+)/g)].map((match) => Number(match[1]));
    expect(thresholds).toEqual([CREATOR_MCF_NOT_FOUND_ESCALATION]);
  });

  it('counts only not-found reads taken while the submit is ambiguous: Verified for Submit, then Reconciliation Required', async () => {
    const id = 'CCR-SW-26-0151';
    await persistCreatorImport(db, { ...seed(orgId), records: null, shipments: { read: 1, invalid: 0,
      rows: [lane(id, FBM, 'Reserved', { laneState: 'Verified for Submit', reconciliationReason: null })] } });
    const key = creatorSampleOrderKey(orgId, id, FBM);
    for (const hour of ['01', '02']) {
      expect((await recordCreatorMcfObservation(db, orgId, observation(key, `job-v${hour}:0151`, `2026-09-12T${hour}:00:00.000Z`, false))).settlement)
        .toMatchObject({ settlement: 'not_found', notFoundProbes: 0 });
    }
    // The runner's uncertain cancel moves the lane to Reconciliation Required; the episode starts at zero.
    await persistCreatorImport(db, { ...seed(orgId), records: null, shipments: { read: 1, invalid: 0,
      rows: [lane(id, FBM, 'Reconciliation Required')] } });
    const episode = [];
    for (const hour of ['03', '04', '05']) {
      episode.push((await recordCreatorMcfObservation(db, orgId, observation(key, `job-r${hour}:0151`, `2026-09-12T${hour}:00:00.000Z`, false))).settlement);
    }
    expect(episode.map((state) => [state?.settlement, state?.notFoundProbes])).toEqual([['not_found', 1], ['not_found', 2], ['escalated', 3]]);
  });

  it('never escalates a confirmed lane on not-found reads, and refuses a key no lane carries', async () => {
    const key = creatorSampleOrderKey(orgId, 'CCR-SW-26-0088', ASIN);
    let last;
    for (const index of [1, 2, 3, 4]) last = await recordCreatorMcfObservation(db, orgId, observation(key, `job-c${index}:0088`, `2026-09-10T0${index}:00:00.000Z`, false));
    // Not-found reads outside an ambiguous submit start no episode.
    expect(last?.settlement).toMatchObject({ settlement: 'not_found', notFoundProbes: 0 });
    await expect(recordCreatorMcfObservation(db, orgId, observation(creatorSampleOrderKey(orgId, 'CCR-SW-26-0166', FBM), 'job-x:0166',
      '2026-09-10T05:00:00.000Z', false))).rejects.toMatchObject({ code: 'lane_not_found' });
    await expect(recordCreatorMcfObservation(db, orgId, { ...observation(key, 'job-y:0088', '2026-09-10T06:00:00.000Z', false), status: 'Processing' }))
      .rejects.toThrow();
  });

  it('lists observable lanes, stops at a terminal or fully delivered order, and scopes the job to one SP-API connection', async () => {
    const lanes = await readCreatorObservableLanes(db, orgId, 10);
    expect(lanes.map((item) => [item.creatorRecordId, item.laneState]).sort()).toEqual([['CCR-SW-26-0072', 'Reconciliation Required'],
      ['CCR-SW-26-0088', 'Confirmed'], ['CCR-SW-26-0151', 'Reconciliation Required']]);
    const delivered = observation(creatorSampleOrderKey(orgId, 'CCR-SW-26-0072', ASIN), 'job-d:0072', '2026-09-11T00:00:00.000Z', true);
    // A cancelled shipment's package never moves: only the live shipment's packages decide "delivered".
    await recordCreatorMcfObservation(db, orgId, { ...delivered, status: 'Complete',
      shipments: [{ amazonShipmentId: 'shipment-0', status: 'CANCELLED_BY_FULFILLER', shippedAt: null, estimatedArrivalAt: null,
        packages: [{ packageNumber: 11, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-0', estimatedArrivalAt: null }] }, ...delivered.shipments!],
      packages: [{ packageNumber: 11, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-0', estimatedArrivalAt: null, carrierStatus: null,
        carrierStatusReadAt: null }, ...delivered.packages!.map((item) => ({ ...item, carrierStatus: 'DELIVERED' }))] });
    // The least recently read first; the delivered lane is no longer observed.
    expect((await readCreatorObservableLanes(db, orgId, 10)).map((item) => item.creatorRecordId)).toEqual(['CCR-SW-26-0088', 'CCR-SW-26-0151']);
    expect(await countActiveCreatorSpApiConnections(db, orgId)).toBe(0);
    const pending = await listCreatorMcfObserveScopes(db);
    expect(pending.scopes.filter((scope) => scope.orgId === orgId)).toEqual([]);
    expect(pending.refusedOrgs).toBeGreaterThanOrEqual(2);
    await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'active', vault_secret_id = gen_random_uuid() where org_id = ${orgId}`);
    // The job resolves its binding as every SP-API workflow does: an enabled binding on a syncing profile.
    await db.sql`update public.spapi_profile_bindings set enabled = true where org_id = ${orgId}`;
    expect(await countActiveCreatorSpApiConnections(db, orgId)).toBe(1);
    // A second active connection with no usable binding counts for neither the scope nor the job.
    await asServiceRole(db, (sql) => sql`insert into public.spapi_connections(org_id, label, selling_partner_id, marketplace_ids, status, vault_secret_id)
      values (${orgId}, 'creator-samples-unbound', 'creator-samples-seller-2', array['ATVPDKIKX0DER'], 'active', gen_random_uuid())`);
    expect(await countActiveCreatorSpApiConnections(db, orgId)).toBe(1);
    const active = await listCreatorMcfObserveScopes(db);
    const [scope] = active.scopes.filter((item) => item.orgId === orgId);
    expect(scope).toMatchObject({ orgId, marketplaceId: 'ATVPDKIKX0DER' });
    expect(active.scopes.some((item) => item.orgId === foreignOrg)).toBe(false);
  });

  describe('tenant RLS and append-only rows', () => {
    const TABLES = ['creator_sample_preflights', 'creator_mcf_observations'] as const;
    it('lets owners, admins and analysts read their own organisation only; viewers and anonymous callers read nothing', async () => {
      for (const user of [OWNER, ADMIN, ANALYST]) {
        await asUser(db, user, async (sql) => {
          for (const table of TABLES) {
            const [counts] = await sql<{ own: number; foreign: number }[]>`select count(*) filter (where org_id = ${orgId})::int as own,
              count(*) filter (where org_id <> ${orgId})::int as foreign from ${sql(table)}`;
            expect(counts!.own, `${user} ${table}`).toBeGreaterThan(0);
            expect(counts!.foreign, `${user} ${table}`).toBe(0);
          }
        });
      }
      await asUser(db, VIEWER, async (sql) => { for (const table of TABLES) expect((await sql`select 1 from ${sql(table)}`).length, table).toBe(0); });
      await asAnon(db, async (sql) => { for (const table of TABLES) await expect(sql`select 1 from ${sql(table)}`, table).rejects.toThrow(/permission denied/); });
    });

    it('lets owners and admins record a pre-flight, refuses analysts and other organisations, and lets no member write an observation', async () => {
      const write = (user: string, org: string, runId: string) => asUser(db, user, (sql) => writeCreatorPreflights(sql, org, 'web',
        [creatorPreflightRow(preflight(runId))], user));
      expect(await write(OWNER, orgId, 'rls-owner')).toMatchObject({ inserted: 1 });
      expect(await write(ADMIN, orgId, 'rls-admin')).toMatchObject({ inserted: 1 });
      for (const user of [ANALYST, VIEWER]) await expect(write(user, orgId, `rls-${user.slice(-1)}`)).rejects.toThrow(/row-level security|not registered/);
      await expect(write(ADMIN, foreignOrg, 'rls-foreign')).rejects.toThrow(/row-level security|not registered/);
      for (const user of [OWNER, ADMIN]) {
        await expect(asUser(db, user, (sql) => sql`insert into public.creator_mcf_observations(org_id, observation_key, creator_record_id, asin,
          queried_order_id, operation, outcome, read_at) values (${orgId}, 'member-write', 'CCR-SW-26-0072', ${ASIN}, 'x', 'getFulfillmentOrder',
          'not_found', now())`)).rejects.toThrow(/permission denied/);
      }
    });

    it('refuses every update and delete, for the service role too', async () => {
      for (const table of TABLES) {
        await expect(asServiceRole(db, (sql) => sql`update ${sql(table)} set org_id = org_id where org_id = ${orgId}`)).rejects.toThrow(/append-only/);
        await expect(asServiceRole(db, (sql) => sql`delete from ${sql(table)} where org_id = ${orgId}`)).rejects.toThrow(/append-only/);
        await expect(asUser(db, OWNER, (sql) => sql`delete from ${sql(table)} where org_id = ${orgId}`)).rejects.toThrow(/permission denied/);
      }
    });

    it('has no column for raw contact data', async () => {
      const columns = await db.sql<{ column_name: string }[]>`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = any(${[...TABLES, 'creator_sample_shipments']}::text[])`;
      expect(columns.map((row) => row.column_name).filter((name) => /(^|_)(email|phone|address|full_name|name|storefront|url|link|recipient)$/.test(name))).toEqual([]);
      expect(columns.length).toBeGreaterThan(50);
    });
  });
});

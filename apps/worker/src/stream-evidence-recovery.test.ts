import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { deriveStreamConsumerEvidence, reconcileProviderGraph } from '@wizard-ads/core';
import { StreamExtensionBinding, StreamExtensionEvent } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { projectStreamExtensionEvent, readStreamConsumerSource, readStreamExtensionEvidence,
  reconcileAssetSearchWork, reconcileStreamExtensionWork, retainStreamExtensionDelivery } from '@wizard-ads/db';

let db: TestDatabase;
let orgId: string, profileId: string;
const at = new Date().toISOString();
const earlier = (hours: number) => new Date(Date.parse(at) - hours * 3_600_000).toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const datasetId = 'ads-campaign-management-campaigns' as const;
const destinationArn = 'arn:aws:sqs:eu-west-1:000000000000:synthetic';

beforeAll(async () => { db = await createTestDatabase('wp313_recovery_review', { applyFixture: false }); }, 120000);
beforeEach(async () => {
  orgId = randomUUID(); profileId = randomUUID();
  await db.sql`insert into public.orgs(id,slug,name) values(${orgId},${'recovery-' + orgId},'Synthetic recovery review')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone)
    values(${profileId},${orgId},'313','EU','DE','EUR','UTC')`;
});
afterEach(async () => { await db.sql`delete from public.orgs where id=${orgId}`; });
afterAll(async () => { await db?.drop(); });

function event(entityId: string, revision = 1, eventTime = at, subscriptionId = 'confirmed') {
  const record = { contractVersion: 'fixture.v1', datasetId, subscriptionId, destinationArn,
    advertiserId: 'advertiser', marketplaceId: 'market', region: 'EU', eventId: `${entityId}-${revision}-${eventTime.replaceAll(':', '')}`,
    revision, eventTime, window: null, observation: { entityId, adProduct: 'SB', operation: 'patch', state: 'enabled' } };
  return StreamExtensionEvent.parse({ orgId, profileId, identity: hash(record), payloadFingerprint: hash(record), receivedAt: at, record });
}
async function retain(value: StreamExtensionEvent) {
  const receipt = await retainStreamExtensionDelivery(db, { deliveryId: hash([orgId, value.identity]),
    bodyFingerprint: value.payloadFingerprint, receivedAt: value.receivedAt, decoded: 1, event: value, reason: null });
  expect(receipt.counts).toMatchObject({ decoded: 1, accepted: 1, stored: 1, verifiedStored: 1 });
}
async function project(value: StreamExtensionEvent) {
  await retain(value);
  expect(await projectStreamExtensionEvent(db, { orgId, profileId, datasetId, eventIdentity: value.identity }))
    .toMatchObject({ sourceRows: 1, parsedRows: 1, loadedRows: 1, verifiedLoadedRows: 1 });
}
async function binding(subscriptionId: string, enabled: boolean) {
  const value = StreamExtensionBinding.parse({ orgId, profileId, datasetId, subscriptionId, destinationArn,
    advertiserId: 'advertiser', marketplaceId: 'market', region: 'EU', contractVersion: 'fixture.v1',
    enabled, confirmed: true, capabilityVerified: true });
  await db.sql`insert into public.marketing_stream_extension_bindings
    (org_id,profile_id,dataset_id,subscription_id,destination_arn,binding,enabled,confirmed,capability_verified)
    values(${orgId},${profileId},${datasetId},${subscriptionId},${destinationArn},${JSON.stringify(value)}::jsonb,${enabled},true,true)`;
}

it('selects the graph-authoritative higher revision even when its source time is earlier', async () => {
  const lower = event('campaign', 1, earlier(1)), higher = event('campaign', 2, earlier(2));
  await project(lower); await project(higher);
  const input = { orgId, profileId, datasetId, datasets: [datasetId], asOf: at, maxAgeMs: 90 * 60_000 };
  const source = await readStreamConsumerSource(db, input);
  expect(source.events.map(row => row.identity)).toEqual([higher.identity]);
  expect(source.graph.persistedObservations).toBe(2);
  expect(reconcileProviderGraph({ scope: source.scope, ...source.graph }).nodes[0]?.revision).toBe('2');
  expect(deriveStreamConsumerEvidence(source, input)).toMatchObject({ measured: 1, unresolved: 0,
    completeness: 'stale', staleEventIds: [higher.identity] });
  expect((await readStreamExtensionEvidence(db, input)).events[0]?.record.eventTime).toBe(higher.record.eventTime);
  const replay = await projectStreamExtensionEvent(db, { orgId, profileId, datasetId, eventIdentity: higher.identity });
  expect(replay.graphReceipt?.observations).toMatchObject({ stored: 0, existing: 1, verified: 1 });
  expect(await db.sql`select identity from public.marketing_stream_extension_events where org_id=${orgId}`).toHaveLength(2);
  expect((await readStreamConsumerSource(db, { ...input, history: true })).events).toHaveLength(2);
});

it('refuses equal-revision conflicts at different times until a higher revision resolves them', async () => {
  await project(event('campaign', 2, earlier(1)));
  await project(event('campaign', 2, earlier(2)));
  const input = { orgId, profileId, datasetId, datasets: [datasetId], asOf: at, maxAgeMs: 86_400_000 };
  const conflicting = await readStreamConsumerSource(db, input);
  expect(conflicting.events).toHaveLength(0);
  expect(reconcileProviderGraph({ scope: conflicting.scope, ...conflicting.graph })).toMatchObject({ nodes: [], conflicts: 1 });
  expect(deriveStreamConsumerEvidence(conflicting, input)).toMatchObject({ measured: 0, completeness: 'missing' });
  const resolved = event('campaign', 3, earlier(3)); await project(resolved);
  const source = await readStreamConsumerSource(db, input);
  expect(source.events.map(row => row.identity)).toEqual([resolved.identity]);
  expect(deriveStreamConsumerEvidence(source, input)).toMatchObject({ measured: 1, unresolved: 0 });
  expect(await db.sql`select identity from public.marketing_stream_extension_events where org_id=${orgId}`).toHaveLength(3);
});

it('drains past a full exhausted Stream batch and later reconsiders disabled bindings', async () => {
  await binding('confirmed', true); await binding('disabled', false);
  const exhausted = Array.from({ length: 100 }, (_, i) => ({ ...event(`exhausted-${i}`, 1, earlier(4)), receivedAt: earlier(3) }));
  const disabled = Array.from({ length: 100 }, (_, i) => ({ ...event(`disabled-${i}`, 1, earlier(4), 'disabled'), receivedAt: earlier(2) }));
  const recoverable = Array.from({ length: 101 }, (_, i) => ({ ...event(`recoverable-${i}`, 1, earlier(4)), receivedAt: earlier(1) }));
  for (const value of [...exhausted, ...disabled, ...recoverable]) await retain(value);
  await db.sql`update public.sync_jobs set status='dead',attempts=1 where org_id=${orgId}`;
  await db.sql`update public.sync_jobs set attempts=8 where org_id=${orgId} and payload->>'eventIdentity'=any(${exhausted.map(row => row.identity)})`;
  // Keep already projected evidence readable even if only its coverage retry exhausted the queue.
  await db.sql`update public.marketing_stream_extension_projections set status='projected' where org_id=${orgId}
    and identity=any(${exhausted.map(row => row.identity)})`;
  await db.sql`update public.marketing_stream_extension_projections set status='blocked',reason='binding_refused'
    where org_id=${orgId} and identity=any(${disabled.map(row => row.identity)})`;
  // Intake times are immutable; queue-independent ordering is made explicit by distinct source receipts.
  const totals = { requested: 0, succeeded: 0, refused: 0 };
  for (let pass = 0; pass < 3; pass++) {
    const counts = await reconcileStreamExtensionWork(db, true);
    if (pass === 0) expect(counts).toEqual({ requested: 100, attempted: 0, succeeded: 0, failed: 0, refused: 100 });
    expect(counts.requested).toBeLessThanOrEqual(100);
    expect(counts.requested).toBe(counts.succeeded + counts.failed + counts.refused);
    totals.requested += counts.requested; totals.succeeded += counts.succeeded; totals.refused += counts.refused;
  }
  expect(totals).toEqual({ requested: 201, succeeded: 101, refused: 100 });
  expect(await db.sql`select id from public.sync_jobs where org_id=${orgId} and status='queued'`).toHaveLength(101);
  expect(await reconcileStreamExtensionWork(db, true)).toEqual({ requested: 0, attempted: 0, succeeded: 0, failed: 0, refused: 0 });
  expect(await db.sql`select identity from public.marketing_stream_extension_projections
    where org_id=${orgId} and status='projected' and reason='recovery_exhausted'`).toHaveLength(100);
  expect((await readStreamExtensionEvidence(db, { orgId, profileId, datasetId, asOf: at, maxAgeMs: 86_400_000 })).count).toBe(100);
  await db.sql`update public.marketing_stream_extension_bindings set enabled=true where org_id=${orgId} and subscription_id='disabled'`;
  expect(await reconcileStreamExtensionWork(db, true)).toEqual({ requested: 100, attempted: 100, succeeded: 100, failed: 0, refused: 0 });
  expect(await reconcileStreamExtensionWork(db, true)).toMatchObject({ requested: 0 });
  expect(await db.sql`select id from public.sync_jobs where org_id=${orgId} and status='queued'`).toHaveLength(201);
  expect(await db.sql`select identity from public.marketing_stream_extension_events where org_id=${orgId}`).toHaveLength(301);
}, 30000);

it('recovers more than one asset batch behind exhausted reads while retaining snapshot custody', async () => {
  const terminal = Array.from({ length: 100 }, () => randomUUID());
  const recoverable = Array.from({ length: 101 }, () => randomUUID());
  const awaitingSnapshot = randomUUID();
  for (const [index, id] of [...terminal, awaitingSnapshot, ...recoverable].entries()) {
    const attempts = terminal.includes(id) ? 8 : id === awaitingSnapshot ? 5 : 1;
    await db.sql`insert into public.sync_jobs(id,org_id,profile_id,job_type,payload,status,attempts,max_attempts,created_at)
      values(${id},${orgId},${profileId},'asset-library.search',${JSON.stringify({ type: 'asset-library.search', orgId, profileId })}::jsonb,
        'dead',${attempts},5,${earlier(1)}::timestamptz+${index}*interval '1 second')`;
  }
  expect(await reconcileAssetSearchWork(db, true)).toEqual({ requested: 100, attempted: 100, succeeded: 100, failed: 0, refused: 0 });
  expect(await reconcileAssetSearchWork(db, true)).toEqual({ requested: 1, attempted: 1, succeeded: 1, failed: 0, refused: 0 });
  expect(await reconcileAssetSearchWork(db, true)).toMatchObject({ requested: 0 });
  expect(await db.sql`select id from public.sync_jobs where org_id=${orgId} and status='queued'`).toHaveLength(101);
  await db.sql`insert into public.asset_library_snapshots(id,org_id,profile_id,observed_at,source_rows,persisted_rows)
    values(${awaitingSnapshot},${orgId},${profileId},${at},0,0)`;
  expect(await reconcileAssetSearchWork(db, true)).toEqual({ requested: 1, attempted: 1, succeeded: 1, failed: 0, refused: 0 });
  expect(await db.sql`select id from public.sync_jobs where id=${awaitingSnapshot} and status='queued' and attempts=5 and max_attempts=6`).toHaveLength(1);
  expect(await db.sql`select id from public.asset_library_snapshots where id=${awaitingSnapshot} and observed_at=${at}`).toHaveLength(1);
  expect(await db.sql`select id from public.sync_jobs where org_id=${orgId} and status='dead' and attempts=8`).toHaveLength(100);
  expect(await db.sql`select id from public.sync_jobs where org_id=${orgId}`).toHaveLength(202);
});

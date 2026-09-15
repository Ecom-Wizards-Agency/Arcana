import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { StreamExtensionEvent, StreamExtensionDataset } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { retainStreamExtensionDelivery, projectStreamExtensionEvent, readStreamExtensionEvidence, markStreamExtensionDeadLetter, readStreamExtensionHealth } from './marketing-stream-extensions.js';

let db: TestDatabase;
const org = '00000000-0000-4000-8000-000000000101';
const profile = '00000000-0000-4000-8000-000000000102';
const user = '00000000-0000-4000-8000-000000000103';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const at = '2026-09-01T12:00:00.000Z';
const observations = [
  { campaignId: 'campaign', recommendationId: 'diagnostic', diagnosticCode: 'budget', severity: 'info' },
  { campaignId: 'campaign', recommendationId: 'budget', currency: 'USD', recommendedBudget: 10 },
  { entityId: 'campaign', adProduct: 'SB', operation: 'patch', state: 'enabled' },
  { entityId: 'group', adProduct: 'SB', operation: 'patch', campaignId: 'campaign' },
  { entityId: 'ad', adProduct: 'SB', operation: 'patch', campaignId: 'campaign', adGroupId: 'group' },
  { entityId: 'target', adProduct: 'SB', operation: 'patch', campaignId: 'campaign', adGroupId: 'group' },
  { campaignId: 'campaign', creativeId: 'creative', clicks: 1 },
  { campaignId: 'campaign', creativeId: 'creative', engagements: 1 },
];
function event(i: number, revision = 1, eventTime = at) {
  const record = { contractVersion: 'fixture.v1', datasetId: StreamExtensionDataset.options[i], subscriptionId: 'sub',
    advertiserId: 'advertiser', marketplaceId: 'market', region: 'EU', destinationArn: 'arn:aws:sqs:eu-west-1:000000000000:synthetic',
    eventId: `event-${i}`, revision, eventTime, window: { start: '2026-09-01T11:00:00.000Z', end: at }, observation: observations[i] };
  return StreamExtensionEvent.parse({ orgId: org, profileId: profile, identity: hash(`${i}-${revision}`),
    payloadFingerprint: hash(JSON.stringify(record)), receivedAt: at, record });
}
async function retain(e: StreamExtensionEvent, delivery: string) {
  return retainStreamExtensionDelivery(db, { deliveryId: hash(delivery), bodyFingerprint: hash(JSON.stringify(e.record)),
    receivedAt: at, decoded: 1, event: e, reason: null });
}
beforeAll(async () => {
  db = await createTestDatabase('wp313_stream');
  await db.sql`insert into auth.users(id) values(${user})`;
  await db.sql`insert into public.orgs(id,slug,name) values(${org},'stream-fixture','Synthetic stream tenant')`;
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${org},${user},'owner')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone)
    values(${profile},${org},'synthetic-stream','EU','DE','EUR','UTC')`;
}, 60000);
afterAll(async () => { await db?.drop(); });

it('stores eight deliveries with exact readback and queues eight projections; budget awaits WP-312', async () => {
  for (let i = 0; i < 8; i++) {
    const e = event(i);
    const receipt = await retain(e, `initial-${i}`);
    expect(receipt.counts).toEqual({ received: 1, undecodable: 0, decoded: 1, accepted: 1, deduplicated: 0, stored: 1, rejected: 0, deadLettered: 0, verifiedStored: 1 });
    const result = await projectStreamExtensionEvent(db, { orgId: org, profileId: profile, datasetId: e.record.datasetId, eventIdentity: e.identity });
    expect(result.verifiedLoadedRows).toBe(1);
    const evidence = await readStreamExtensionEvidence(db, { orgId: org, profileId: profile, datasetId: e.record.datasetId, asOf: at, maxAgeMs: 60000 });
    expect(evidence.count).toBe(i === 1 ? 0 : 1);
    expect(evidence.selectionAuthority).toBe(false);
  }
  expect(await db.sql`select identity from public.marketing_stream_extension_events where org_id=${org}`).toHaveLength(8);
  expect(await db.sql`select id from public.sync_jobs where org_id=${org} and job_type='marketing_stream.extensions.project'`).toHaveLength(8);
  expect(await db.sql`select id from public.recommendation_preview_batches where org_id=${org}`).toHaveLength(0);
});
it('replays the original receipt, deduplicates another delivery, rejects revised payload under one identity', async () => {
  const e = event(0);
  expect((await retain(e, 'initial-0')).counts.stored).toBe(1);
  expect((await retain(e, 'duplicate-0')).counts.deduplicated).toBe(1);
  const conflict = { ...e, payloadFingerprint: hash('changed') };
  expect((await retain(conflict, 'conflict')).reason).toBe('revision_conflict');
  expect(await db.sql`select identity from public.marketing_stream_extension_events where org_id=${org}`).toHaveLength(8);
});
it('keeps newer source evidence over late older delivery; replay cannot renew freshness', async () => {
  const latest = event(2, 2, '2026-09-02T12:00:00.000Z');
  await retain(latest, 'newer');
  await projectStreamExtensionEvent(db, { orgId: org, profileId: profile, datasetId: latest.record.datasetId, eventIdentity: latest.identity });
  await retain(event(2), 'late-old');
  const evidence = await readStreamExtensionEvidence(db, { orgId: org, profileId: profile, datasetId: latest.record.datasetId,
    asOf: '2026-09-10T12:00:00.000Z', maxAgeMs: 60000 });
  expect(evidence.completeness).toBe('stale');
  expect(evidence.events[0]?.record.revision).toBe(2);
});
it('rolls back event and job when receipt persistence fails; crash retry produces exactly one event', async () => {
  const e = event(3, 3);
  await db.sql`create function public.fail_stream_receipt() returns trigger language plpgsql as $$begin raise exception 'fixture disk failure'; end$$`;
  await db.sql`create trigger fail_stream_receipt before insert on public.marketing_stream_extension_receipts for each row execute function public.fail_stream_receipt()`;
  await expect(retain(e, 'crash')).rejects.toThrow('fixture disk failure');
  expect(await db.sql`select identity from public.marketing_stream_extension_events where identity=${e.identity}`).toHaveLength(0);
  await db.sql`drop trigger fail_stream_receipt on public.marketing_stream_extension_receipts`;
  expect((await retain(e, 'crash')).counts.stored).toBe(1);
});
it('retains sanitized refusals and counts an observed DLQ transfer once', async () => {
  const receipt = await retainStreamExtensionDelivery(db, { deliveryId: hash('invalid'), bodyFingerprint: hash('invalid-body'),
    receivedAt: at, decoded: 0, event: null, reason: 'invalid_json' });
  expect(receipt.counts).toMatchObject({ decoded: 0, stored: 0, rejected: 0 });
  expect(await markStreamExtensionDeadLetter(db, receipt.deliveryId, at)).toEqual({ observed: 1, written: 1, existing: 0, verified: 1 });
  expect(await markStreamExtensionDeadLetter(db, receipt.deliveryId, at)).toEqual({ observed: 1, written: 0, existing: 1, verified: 1 });
});
it('denies cross-tenant reads, browser receipt access and modification of immutable events', async () => {
  const other = '00000000-0000-4000-8000-000000000104';
  await db.sql`insert into auth.users(id) values(${other})`;
  expect(await asUser(db, other, (sql) => sql`select * from public.marketing_stream_extension_events`)).toHaveLength(0);
  expect(await asUser(db, user, (sql) => sql`select * from public.marketing_stream_extension_events`)).toHaveLength(10);
  await expect(asUser(db, user, (sql) => sql`select * from public.marketing_stream_extension_receipts`)).rejects.toMatchObject({ code: '42501' });
  await expect(db.sql`update public.marketing_stream_extension_events set revision=9 where org_id=${org}`).rejects.toMatchObject({ code: '23514' });
});

it('reads eight authenticated health rows with normalized persisted timestamps and unchanged source age', async () => {
  const health = await asUser(db, user, (sql) => readStreamExtensionHealth({ sql }, org, profile));
  expect(health).toHaveLength(8);
  expect(health.reduce((sum, row) => sum + row.stored, 0)).toBe(10);
  expect(health.every((row) => !row.enabled && !row.confirmed)).toBe(true);
  expect(health.find((row) => row.datasetId === 'ads-campaign-management-campaigns')).toMatchObject({
    stored: 2, latestEventAt: '2026-09-02T12:00:00.000Z', duplicates: null, rejected: null, deadLettered: null,
  });
});

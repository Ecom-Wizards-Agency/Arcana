import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderGraphObservation, ProviderGraphReadResult, ProviderGraphScope } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { appendProviderGraphEvidence, readProviderGraphEvidence, recordProviderGraphResolution } from './provider-graph.js';

describe('provider graph durable intake and tenant evidence', () => {
  let db: TestDatabase; let scope: ProviderGraphScope;
  const owner = randomUUID(); const outsider = randomUUID();
  const when = '2026-09-15T00:00:00Z';
  const observation = (kind: 'ad' | 'ad_group', id: string): ProviderGraphObservation => ({ scope,
    identity: { adProduct: 'SD', kind, providerId: id, version: null }, source: 'marketing_stream',
    contractVersion: 'synthetic-v1', sourceEventAt: when, observedAt: when, revision: '1',
    payloadFingerprint: 'a'.repeat(64), operation: 'upsert', state: 'enabled' });
  const batch = (parent = false): ProviderGraphReadResult => {
    const ad = observation('ad','ad-one'); const group = observation('ad_group','group-one');
    return { observations: parent ? [ad,group] : [ad], associations: [{ scope, from: ad.identity, to: group.identity,
      relation: 'parent', sourceEventAt: when, revision: '1', payloadFingerprint: 'a'.repeat(64), operation: 'upsert' }],
    sourceRows: parent ? 2 : 1, parsed: parent ? 2 : 1, refusals: [], pages: 1, completeness: 'complete' };
  };
  beforeAll(async () => {
    db = await createTestDatabase('wp313_provider_graph');
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('graph-evidence',${owner},'owner','2026-09-15') as id`;
    const [profile] = await db.sql<{ id: string }[]>`insert into public.ad_profiles(org_id,amazon_profile_id,region,country_code,currency_code,timezone)
      values(${org!.id},'synthetic','NA','US','USD','UTC') returning id`;
    scope = { orgId: org!.id, profileId: profile!.id, amazonProfileId: 'synthetic', region: 'NA' };
    await db.sql`insert into auth.users(id) values(${outsider}) on conflict do nothing`;
  },120000);
  afterAll(async () => { if (db) await db.drop(); });
  it('persists exactly one node and one unresolved edge and reads both independently', async () => {
    const result = await appendProviderGraphEvidence(db,scope,batch());
    expect(result.observations).toMatchObject({ source: 1, stored: 1, verified: 1 });
    expect(result.associations).toMatchObject({ source: 1, stored: 1, verified: 1 });
    expect(await readProviderGraphEvidence(db,scope,when)).toMatchObject({ persistedObservations: 1,persistedAssociations: 1 });
    await expect(recordProviderGraphResolution(db,scope,batch().associations,await readProviderGraphEvidence(db,scope,when),when)).rejects.toThrow('verified active endpoint');
  });
  it('replay preserves original observation and expiry, later parent permits resolution', async () => {
    const replay = batch(); replay.observations[0]!.observedAt = '2026-09-16T00:00:00Z';
    const result = await appendProviderGraphEvidence(db,scope,replay);
    expect(result.observations).toMatchObject({ stored: 0, existing: 1, verified: 1 });
    expect((await readProviderGraphEvidence(db,scope,when)).observations[0]?.observedAt).toBe(when);
    await appendProviderGraphEvidence(db,scope,batch(true));
    expect(await recordProviderGraphResolution(db,scope,batch().associations,await readProviderGraphEvidence(db,scope,when),when)).toEqual({ offered: 1,verified: 1 });
    expect(await readProviderGraphEvidence(db,scope,'2027-01-01T00:00:00Z')).toMatchObject({ persistedObservations: 0,persistedAssociations: 0 });
  });
  it('denies another user reads and immutable observation changes', async () => {
    await asUser(db,outsider,async (sql) => {
      expect(await readProviderGraphEvidence({sql},scope,when)).toMatchObject({ persistedObservations: 0,persistedAssociations: 0 });
    });
    await expect(db.sql`update public.provider_graph_observations set observed_at='2026-09-16' where org_id=${scope.orgId}`).rejects.toThrow();
    const wrong = batch(); wrong.observations[0]!.scope = {...scope,profileId: randomUUID()};
    await expect(appendProviderGraphEvidence(db,scope,wrong)).rejects.toThrow('scope mismatch');
  });
  it('refuses a projection calculated before a new observation arrived', async () => {
    const previous=await readProviderGraphEvidence(db,scope,when);
    const changed=batch(); changed.observations[0]!.revision='2';
    changed.observations[0]!.state='paused'; changed.observations[0]!.payloadFingerprint='b'.repeat(64);
    await appendProviderGraphEvidence(db,scope,changed);
    await expect(recordProviderGraphResolution(db,scope,changed.associations,previous,when)).rejects.toThrow('snapshot changed');
  });
  it('excludes future source and receipt observations from an as-of reader', async () => {
    const before=await readProviderGraphEvidence(db,scope,when);
    const future=batch(); future.observations[0]!.identity.providerId='future-ad';
    future.observations[0]!.sourceEventAt='2026-09-16T00:00:00Z';
    future.observations[0]!.observedAt='2026-09-17T00:00:00Z'; future.associations=[];
    await appendProviderGraphEvidence(db,scope,future);
    expect((await readProviderGraphEvidence(db,scope,when)).persistedObservations).toBe(before.persistedObservations);
    expect((await readProviderGraphEvidence(db,scope,'2026-09-16T00:00:00Z')).persistedObservations).toBe(before.persistedObservations);
    expect((await readProviderGraphEvidence(db,scope,'2026-09-17T00:00:00Z')).persistedObservations).toBe(before.persistedObservations+1);
  });
});

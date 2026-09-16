import { randomUUID } from 'node:crypto';
import { createDb } from '@wizard-ads/db';
import { PROVIDER_FAMILY_CONSUMERS, ProviderCollectionConfig, ProviderRecommendation } from '@wizard-ads/shared';

/** Synthetic imported evidence for authenticated reader screenshots; no collector activation. */
export async function seedProviderReaderStates(connectionString: string, profileId: string): Promise<{ fixtureRows: number; totalRows: number }> {
  const target = new URL(connectionString);
  if (target.hostname !== '127.0.0.1' || !target.pathname.startsWith('/wizard_ads_test_')) throw new Error('Provider screenshots require a disposable loopback test database');
  const db = createDb({ connectionString, max: 1 });
  try {
    const [profile] = await db.sql<{ org_id: string; amazon_profile_id: string }[]>`select org_id,amazon_profile_id from public.ad_profiles where id=${profileId}`;
    if (!profile) throw new Error('Provider screenshot profile missing');
    const existing = await db.sql`select id from public.provider_recommendations where org_id=${profile.org_id} and profile_id=${profileId} and namespace='tactical.ListRecommendations' and provider_id in ('synthetic-reader-measured','synthetic-reader-stale','synthetic-reader-expired')`;
    const families = Object.entries(PROVIDER_FAMILY_CONSUMERS).filter(([,consumers]) => consumers.includes('recommendations')).map(([family]) => family);
    const countDisplayedRows = async () => {
      const [count] = await db.sql<{ total: number }[]>`select count(*)::int as total from public.provider_recommendations where org_id=${profile.org_id} and profile_id=${profileId} and family=any(${families})`;
      return count!.total;
    };
    if (existing.length === 3) return { fixtureRows: 3, totalRows: await countDisplayedRows() };
    if (existing.length !== 0) throw new Error('Incomplete provider screenshot fixture');
    const now = new Date(); const stamp = now.toISOString(); const runId = randomUUID();
    const config = ProviderCollectionConfig.parse({ id: randomUUID(), scope: { orgId: profile.org_id, profileId, amazonProfileId: profile.amazon_profile_id, marketplaceId: 'synthetic-market' }, family: 'tactical', operation: 'tactical.ListRecommendations', request: {}, enabled: false, maxPages: 1, maxRows: 3 });
    await db.sql`insert into public.provider_evidence_configs(id,org_id,profile_id,config) values(${config.id},${profile.org_id},${profileId},${JSON.stringify(config)}::jsonb)`;
    const counts = { source: 3, parsed: 3, refused: 0, duplicates: 0, conflicts: 0, canonical: 3, written: 3, existing: 0, readback: 3 };
    const observedAt = new Date(now.valueOf() - 10 * 86400000).toISOString();
    await db.sql`insert into public.provider_recommendation_runs(id,org_id,profile_id,config_id,run) values(${runId},${profile.org_id},${profileId},${config.id},${JSON.stringify({ id: runId, config, status: 'complete', page: 1, nextToken: null, startedAt: stamp, observedAt, counts, incomplete: false })}::jsonb)`;
    for (const [index,state] of ['measured','stale','expired'].entries()) {
      const generatedAt = state === 'stale' ? observedAt : state === 'expired' ? new Date(now.valueOf()-3600000).toISOString() : stamp;
      const evidence = ProviderRecommendation.parse({ family: 'tactical', namespace: config.operation, providerId: `synthetic-reader-${state}`, identityMethod: 'provider', version: String(index).repeat(64), apiVersion: 'synthetic-v1', contractHash: 'b'.repeat(64), transport: 'http', scope: config.scope,
        entity: { adProduct: 'SP', entityType: 'unknown', entityId: null, campaignId: null, adGroupId: null, mapping: 'unresolved' }, kind: `Synthetic ${state} budget advice`, action: 'budget', current: { value: 10, units: 'daily-budget', currency: 'USD' }, proposed: { value: 12, units: 'daily-budget', currency: 'USD' }, estimates: [{ label: 'Amazon estimate', metric: 'clicks', value: null, low: 0, high: 2, units: 'clicks', currency: null, horizon: 'weekly', attribution: null }], objective: null, horizon: null, attribution: null, eligibility: 'unknown', generatedAt, observedAt: generatedAt, retrievedAt: stamp, expiresAt: state === 'expired' ? new Date(now.valueOf()-60000).toISOString() : null, payload: { fixture: state } });
      const [row] = await db.sql<{ id: string }[]>`insert into public.provider_recommendations(org_id,profile_id,family,namespace,provider_id,version,evidence) values(${profile.org_id},${profileId},${evidence.family},${evidence.namespace},${evidence.providerId},${evidence.version},${JSON.stringify(evidence)}::jsonb) returning id`;
      if (!row) throw new Error('Provider fixture insert missing');
      await db.sql`insert into public.provider_recommendation_run_rows(org_id,profile_id,run_id,evidence_id) values(${profile.org_id},${profileId},${runId},${row.id})`;
    }
    const rows = await db.sql`select evidence_id from public.provider_recommendation_run_rows where run_id=${runId} and org_id=${profile.org_id} and profile_id=${profileId}`;
    if (rows.length !== 3) throw new Error('Provider screenshot readback mismatch');
    return { fixtureRows: rows.length, totalRows: await countDisplayedRows() };
  } finally { await db.close(); }
}

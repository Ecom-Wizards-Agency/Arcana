import { isDeepStrictEqual } from 'node:util';
import { ProviderCollectionConfig, ProviderEvidenceCounts, ProviderEvidencePage, ProviderEvidenceReadResult, ProviderEvidenceRun, ProviderRecommendation, PROVIDER_FAMILY_CONSUMERS, type ProviderEvidenceConsumer } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';
import type postgres from 'postgres';

const zero = () => ({ source: 0, parsed: 0, refused: 0, duplicates: 0, conflicts: 0, canonical: 0, written: 0, existing: 0, readback: 0 });
const transaction = <T>(handle: QueryHandle, fn: (sql: postgres.TransactionSql) => Promise<T>) => 'savepoint' in handle.sql ? handle.sql.savepoint(fn) : handle.sql.begin(fn);
export async function prepareProviderEvidenceRun(handle: QueryHandle, scope: { orgId: string; profileId: string; configId: string; runId: string }): Promise<ProviderEvidenceRun> {
  return transaction(handle, async (sql) => {
    const [stored] = await sql<{ config: unknown }[]>`select config from public.provider_evidence_configs where org_id=${scope.orgId} and profile_id=${scope.profileId} and id=${scope.configId} and enabled=true for share`;
    if (!stored) throw new Error('Provider evidence source is disabled or unavailable');
    const config = ProviderCollectionConfig.parse(stored.config);
    if (!config.enabled) throw new Error('Provider evidence source is disabled');
    const profile = await sql`select id from public.ad_profiles where org_id=${scope.orgId} and id=${scope.profileId} and amazon_profile_id=${config.scope.amazonProfileId}`;
    if (profile.length !== 1) throw new Error('Provider evidence account scope mismatch');
    const now = new Date().toISOString();
    const proposed = ProviderEvidenceRun.parse({ id: scope.runId, config, status: 'running', page: 0, nextToken: null, startedAt: now, observedAt: now, counts: zero() });
    await sql`insert into public.provider_recommendation_runs(id,org_id,profile_id,config_id,run) values(${scope.runId},${scope.orgId},${scope.profileId},${scope.configId},${JSON.stringify(proposed)}::jsonb) on conflict(id) do nothing`;
    const [row] = await sql<{ run: unknown }[]>`select run from public.provider_recommendation_runs where id=${scope.runId} and org_id=${scope.orgId} and profile_id=${scope.profileId} and config_id=${scope.configId}`;
    if (!row) throw new Error('Provider evidence run scope mismatch');
    let run = ProviderEvidenceRun.parse(row.run);
    // A retry may not silently adopt changed source parameters.
    if (JSON.stringify(run.config) !== JSON.stringify(config)) throw new Error('Provider evidence configuration changed; start a new run');
    if (run.status === 'failed') {
      run = { ...run, status: 'running' };
      await sql`update public.provider_recommendation_runs set run=${JSON.stringify(run)}::jsonb where id=${run.id} and org_id=${scope.orgId} and profile_id=${scope.profileId}`;
    }
    return run;
  });
}

export async function authorizeProviderEvidencePage(handle: QueryHandle, run: ProviderEvidenceRun): Promise<void> {
  const { scope } = run.config;
  const rows = await handle.sql`select id from public.provider_evidence_configs where org_id=${scope.orgId} and profile_id=${scope.profileId} and id=${run.config.id} and enabled=true and config=${JSON.stringify(run.config)}::jsonb`;
  if (rows.length !== 1 || !run.config.enabled) throw new Error('Provider evidence source is disabled or changed');
}

/** Versions, run membership, accounting and the next-page checkpoint commit together. */
export async function persistProviderEvidencePage(handle: QueryHandle, previous: ProviderEvidenceRun, raw: ProviderEvidencePage): Promise<ProviderEvidenceRun> {
  const page = ProviderEvidencePage.parse(raw);
  const { scope } = previous.config;
  return transaction(handle, async (sql) => {
    const [stored] = await sql<{ run: unknown }[]>`select run from public.provider_recommendation_runs where id=${previous.id} and org_id=${scope.orgId} and profile_id=${scope.profileId} for update`;
    if (!stored) throw new Error('Provider run unavailable');
    const run = ProviderEvidenceRun.parse(stored.run);
    if (run.page !== previous.page || run.status !== 'running' || !isDeepStrictEqual(run.config, previous.config)) throw new Error('Provider checkpoint conflict');
    if (page.nextToken !== null && page.nextToken === run.nextToken) throw new Error('Provider repeated pagination checkpoint');
    const c = { ...run.counts, source: run.counts.source + page.source, parsed: run.counts.parsed + page.rows.length, refused: run.counts.refused + page.refused };
    let observedAt = run.observedAt;
    let earliestExpiry = run.earliestExpiry ?? null;
    for (const rawEvidence of page.rows) {
      const evidence = ProviderRecommendation.parse(rawEvidence);
      if (JSON.stringify(evidence.scope) !== JSON.stringify(scope) || evidence.family !== run.config.family || evidence.namespace !== run.config.operation) throw new Error('Provider row scope mismatch');
      if (evidence.entity.entityId !== null) {
        const e = evidence.entity;
        const table = e.entityType === 'campaign' ? 'campaigns' : e.entityType === 'ad-group' ? 'ad_groups' : e.entityType === 'keyword' ? 'keywords' : e.entityType === 'target' ? 'targets' : null;
        if (table) {
          const entities = await sql<{ campaign_id?: string; ad_group_id?: string }[]>`select * from ${sql(`public.${table}`)} where org_id=${scope.orgId} and profile_id=${scope.profileId} and amazon_id=${e.entityId} and ad_product::text=${e.adProduct} and deleted_at is null`;
          evidence.entity.mapping = entities.length === 1 ? (e.campaignId !== null && entities[0]?.campaign_id !== undefined && e.campaignId !== entities[0].campaign_id || e.adGroupId !== null && entities[0]?.ad_group_id !== undefined && e.adGroupId !== entities[0].ad_group_id ? 'scope-mismatch' : 'mapped') : entities.length === 0 ? 'missing' : 'ambiguous';
        }
      }
      await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scope.orgId, scope.profileId, evidence.family, evidence.namespace, evidence.providerId])},0))`;
      const conflict = await sql`select id from public.provider_recommendations where org_id=${scope.orgId} and profile_id=${scope.profileId} and family=${evidence.family} and namespace=${evidence.namespace} and provider_id=${evidence.providerId} and version<>${evidence.version} limit 1`;
      const inserted = await sql<{ id: string }[]>`insert into public.provider_recommendations(org_id,profile_id,family,namespace,provider_id,version,evidence) values(${scope.orgId},${scope.profileId},${evidence.family},${evidence.namespace},${evidence.providerId},${evidence.version},${JSON.stringify(evidence)}::jsonb) on conflict(org_id,profile_id,family,namespace,provider_id,version) do nothing returning id`;
      const [readback] = await sql<{ id: string; evidence: unknown }[]>`select id,evidence from public.provider_recommendations where org_id=${scope.orgId} and profile_id=${scope.profileId} and family=${evidence.family} and namespace=${evidence.namespace} and provider_id=${evidence.providerId} and version=${evidence.version}`;
      if (!readback) throw new Error('Provider version readback missing');
      const verified = ProviderRecommendation.parse(readback.evidence);
      // Retrieval and mapping may differ on replay; immutable original evidence wins.
      const immutable = (v: ProviderRecommendation) => ({ ...v, retrievedAt: null, observedAt: v.generatedAt, entity: { ...v.entity, mapping: null } });
      if (!isDeepStrictEqual(immutable(verified), immutable(evidence))) throw new Error('Provider version readback mismatch');
      if (verified.expiresAt !== null && (earliestExpiry === null || Date.parse(verified.expiresAt) < Date.parse(earliestExpiry))) earliestExpiry = verified.expiresAt;
      observedAt = new Date(Math.min(Date.parse(observedAt), Date.parse(verified.observedAt))).toISOString();
      const members = await sql`insert into public.provider_recommendation_run_rows(org_id,profile_id,run_id,evidence_id) values(${scope.orgId},${scope.profileId},${run.id},${readback.id}) on conflict(run_id,evidence_id) do nothing returning evidence_id`;
      if (members.length === 0) c.duplicates++;
      else { c.canonical++; c.written += inserted.length; c.existing += 1 - inserted.length; c.conflicts += conflict.length; }
    }
    const readback = await sql<{ id: string }[]>`select e.id from public.provider_recommendation_run_rows m join public.provider_recommendations e on e.org_id=m.org_id and e.profile_id=m.profile_id and e.id=m.evidence_id where m.org_id=${scope.orgId} and m.profile_id=${scope.profileId} and m.run_id=${run.id}`;
    c.readback = readback.length;
    ProviderEvidenceCounts.parse(c);
    if (c.source > run.config.maxRows) throw new Error('Provider source row bound exceeded');
    const expectedTotal = run.expectedTotal ?? page.expectedTotal ?? null;
    const incomplete = run.incomplete || page.status === 'partial' || c.refused > 0 || page.expectedTotal != null && expectedTotal !== page.expectedTotal || page.nextToken === null && expectedTotal !== null && expectedTotal !== c.source;
    const status = page.nextToken !== null ? 'running' : page.status === 'unsupported' ? 'unsupported' : incomplete ? 'partial' : 'complete';
    const result = ProviderEvidenceRun.parse({ ...run, expectedTotal, incomplete, status, page: run.page + 1, nextToken: page.nextToken, observedAt, earliestExpiry, counts: c });
    await sql`update public.provider_recommendation_runs set run=${JSON.stringify(result)}::jsonb where id=${run.id} and org_id=${scope.orgId} and profile_id=${scope.profileId}`;
    return result;
  });
}

/** Safe failure state retains the last durable page; retries resume that checkpoint. */
export async function failProviderEvidenceRun(handle: QueryHandle, run: ProviderEvidenceRun): Promise<void> {
  await handle.sql`update public.provider_recommendation_runs set run=jsonb_set(jsonb_set(run,'{status}','"failed"'::jsonb),'{incomplete}','true'::jsonb) where id=${run.id} and org_id=${run.config.scope.orgId} and profile_id=${run.config.scope.profileId} and run->>'status'='running'`;
}

/** Caller supplies the authenticated transaction; all predicates retain agency/profile scope. */
export async function readProviderEvidence(handle: QueryHandle, scope: { orgId: string; profileId: string; consumer: ProviderEvidenceConsumer; entityId?: string; adProduct?: 'SP' | 'SB' | 'SD'; entityType?: 'keyword' | 'target'; limit?: number }): Promise<ProviderEvidenceReadResult> {
  const families = Object.entries(PROVIDER_FAMILY_CONSUMERS).filter(([, consumers]) => scope.consumer === 'sync-status' || consumers.includes(scope.consumer)).map(([family]) => family);
  if (scope.limit !== undefined && (!Number.isSafeInteger(scope.limit) || scope.limit < 1)) throw new Error('Invalid provider reader limit');
  const limit = Math.min(500, Math.max(1, scope.limit ?? 100));
  const rows = await handle.sql<{ evidence: unknown; total: string }[]>`select evidence,count(*) over()::text as total from public.provider_recommendations where org_id=${scope.orgId} and profile_id=${scope.profileId} and family=any(${families}) and (${scope.adProduct ?? null}::text is null or evidence#>>'{entity,adProduct}'=${scope.adProduct ?? null}) and (${scope.entityId ?? null}::text is null or (evidence#>>'{entity,entityId}'=${scope.entityId ?? null} and (${scope.entityType ?? null}::text is null or evidence#>>'{entity,entityType}'=${scope.entityType ?? null})) or (${scope.consumer === 'targets'} and evidence#>>'{entity,entityType}'='ad-group' and evidence#>>'{entity,adProduct}' in (select ad_product::text from public.targets where org_id=${scope.orgId} and profile_id=${scope.profileId} and amazon_id=${scope.entityId ?? null} union select ad_product::text from public.keywords where org_id=${scope.orgId} and profile_id=${scope.profileId} and amazon_id=${scope.entityId ?? null}) and evidence#>>'{entity,adGroupId}' in (select ad_group_id from public.targets where org_id=${scope.orgId} and profile_id=${scope.profileId} and amazon_id=${scope.entityId ?? null} union select ad_group_id from public.keywords where org_id=${scope.orgId} and profile_id=${scope.profileId} and amazon_id=${scope.entityId ?? null}))) order by evidence->>'observedAt' desc,id limit ${limit}`;
  const runs = await handle.sql<{ config_id: string; expires_at: string | null; family: string; status: string; observed_at: string; started_at: string; counts: unknown }[]>`select config_id,expires_at,family,status,observed_at,started_at,counts from public.read_provider_run_summaries(${scope.orgId},${scope.profileId}) where family=any(${families})`;
  const entityIds = rows.map((r) => ProviderRecommendation.parse(r.evidence).entity.entityId).filter((id): id is string => id !== null);
  const candidates = entityIds.length ? await handle.sql<{ entity_type: string; entity_id: string; ad_product: string | null; campaign_id: string | null; ad_group_id: string | null; field: string; current_value: unknown; proposed_value: unknown; created_at: Date }[]>`select distinct on(entity_type,entity_id,ad_product,field) entity_type,entity_id,ad_product,campaign_id,ad_group_id,field,current_value,proposed_value,created_at from public.recommendations where org_id=${scope.orgId} and profile_id=${scope.profileId} and entity_id=any(${entityIds}) order by entity_type,entity_id,ad_product,field,created_at desc,id desc` : [];
  const arcana = candidates.flatMap((c) => {
    const provider = rows.map((r) => ProviderRecommendation.parse(r.evidence)).find((r) => r.entity.entityId === c.entity_id && r.entity.entityType === (c.entity_type === 'ad_group' ? 'ad-group' : c.entity_type) && r.entity.adProduct === c.ad_product);
    if (!provider) return [];
    const value = (v: unknown) => ({ value: typeof v === 'number' || typeof v === 'string' ? v : null, units: null, currency: null });
    return [{ scope: provider.scope, entity: { ...provider.entity, campaignId: c.campaign_id, adGroupId: c.ad_group_id }, action: c.field === 'bid' ? 'bid' : ['budget', 'budgetAmount'].includes(c.field) ? 'budget' : c.field === 'headline' ? 'headline' : 'unknown', current: value(c.current_value), proposed: value(c.proposed_value), objective: null, horizon: null, attribution: null, observedAt: c.created_at.toISOString() }];
  });
  return ProviderEvidenceReadResult.parse({ arcana, rows: rows.map((r) => r.evidence), totalCount: Number(rows[0]?.total ?? 0), runs: runs.map((r) => ({ configId: r.config_id, expiresAt: r.expires_at, family: r.family, status: r.status, observedAt: r.observed_at, startedAt: r.started_at, counts: r.counts })) });
}

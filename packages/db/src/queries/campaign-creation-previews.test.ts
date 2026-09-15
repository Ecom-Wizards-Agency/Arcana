import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampaignCreationNodeKind, CampaignCreationNodeV2, CampaignCreationPlanV2,
  orderCampaignCreationNodes, serializeCampaignCreationNodeFingerprint,
  serializeCampaignCreationPlanFingerprint } from '@wizard-ads/shared';
import { createDb, type DbHandle } from '../client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asActor, asUser } from '../testing/rls.js';
import { readRecordedCampaignCreationPreview, recordCampaignCreationPreview } from './campaign-creation-previews.js';

const available = await databaseAvailable();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const zero = '0'.repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ref = (kind: string, n: number) => ({ source: 'plan_node', kind, nodeId: id(n) });
const identity = (plan: CampaignCreationPlanV2) => ({ profileId: plan.profileId, planId: plan.id });
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fingerprint(plan: CampaignCreationPlanV2) {
  const nodes = plan.nodes.map((node) => ({ ...node, fingerprint: sha(serializeCampaignCreationNodeFingerprint(node)) }));
  const value = CampaignCreationPlanV2.parse({ ...plan, nodes });
  return CampaignCreationPlanV2.parse({ ...value, fingerprint: sha(serializeCampaignCreationPlanFingerprint(value)) });
}

describe.skipIf(!available)('persisted campaign previews', () => {
  let database: TestDatabase;
  let pool: DbHandle;
  beforeAll(async () => {
    database = await createTestDatabase('campaign_preview');
    pool = createDb({ connectionString: database.connectionString, max: 1 });
  }, 60_000);
  afterAll(async () => { await pool?.close(); await database?.drop(); });

  async function fixture(product: 'SP' | 'SB' | 'SD' = 'SP') {
    const orgId = randomUUID(); const userId = randomUUID(); const profileId = randomUUID(); const connectionId = randomUUID();
    await database.sql`select public.auth_user_stub(${userId})`;
    await database.sql`insert into public.orgs (id, slug, name) values (${orgId}, ${orgId}, 'Synthetic preview tenant')`;
    await database.sql`insert into public.org_members (org_id,user_id,role) values (${orgId},${userId},'owner')`;
    await database.sql`insert into public.ads_connections (id,org_id,label,status)
      values (${connectionId},${orgId},'Synthetic connection','active')`;
    await database.sql`insert into public.ad_profiles
      (id,org_id,connection_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,account_name,sync_enabled)
      values (${profileId},${orgId},${connectionId},'900000000001','NA','US','USD','UTC','seller','Synthetic profile',true)`;
    const dialect = product === 'SP' ? 'sp_legacy_v3' : product === 'SB' ? 'unified_ads_v1' : 'sd_legacy';
    const base = { schemaVersion: 'openspell.campaign-creation-node.v2', adProduct: product, apiDialect: dialect, fingerprint: zero };
    const read = { ...base, effect: 'read_check', rollback: 'not_applicable', dependsOn: [] };
    const create = { ...base, effect: 'irreversible_create', rollback: 'none' };
    const raw: unknown[] = [{ ...read, nodeId: id(10), kind: 'eligibility.require_product',
      payload: { asin: 'B000000001', sku: 'SYNTHETIC-SKU' } }];
    if (product !== 'SP') raw.push({ ...read, nodeId: id(11), kind: 'asset.require_existing',
      payload: { assetId: 'SYNTHETIC-VIDEO', version: '3', purpose: 'video' } });
    if (product === 'SB') raw.push({ ...read, nodeId: id(16), kind: 'eligibility.require_brand',
      payload: { brandId: 'SYNTHETIC-BRAND', brandEntityId: null, brandName: 'Synthetic brand' } });
    raw.push({ ...create, nodeId: id(12), kind: 'campaign.create', dependsOn: [id(product === 'SB' ? 16 : 10)], payload: {
      name: 'Synthetic campaign', state: 'paused', budget: { amount: 20, type: 'daily', currencyCode: 'USD' }, portfolioId: null,
      schedule: product === 'SB' ? { type: 'instants', startDateTime: '2026-09-07T07:00:00.000Z', endDateTime: null }
        : { type: 'calendar_dates', startDate: '2026-09-07', endDate: null },
      settings: product === 'SP' ? { product, targetingType: 'auto', biddingStrategy: 'manual',
        placementBidding: { topOfSearch: 0, productPages: 0, restOfSearch: 0 } }
        : product === 'SB' ? { product, targetingType: 'manual', format: 'product_video', brand: ref('brand', 16),
          costType: 'CPC', marketplaceScope: 'SINGLE_MARKETPLACE', marketplace: 'US',
          optimizations: { goalSettings: { kpi: 'CLICKS' }, bidSettings: { bidStrategy: 'MANUAL' } }, purchasing: { type: 'auction' } }
          : { product, tactic: 'contextual', costType: 'cpc' },
    } }, { ...create, nodeId: id(13), kind: 'ad_group.create', dependsOn: [id(12)], payload: {
      campaign: ref('campaign', 12), name: 'Synthetic group', state: 'paused', defaultBid: product === 'SB' ? null : 1,
      settings: product === 'SD' ? { product, creativeType: 'VIDEO', bidOptimization: 'clicks' } : { product },
    } });
    raw.push({ ...create, nodeId: id(14), kind: 'ad.create', dependsOn: [10, 13, ...(product === 'SB' ? [11, 16] : [])].map(id).sort(),
      payload: product === 'SB' ? { format: 'sb_product_video', name: 'Synthetic ad', adGroup: ref('ad_group', 13),
        brand: ref('brand', 16), logoAsset: null, headline: null, enableCreativeAutoTranslation: false,
        products: [ref('product', 10)], landingPage: { type: 'detail_page', product: ref('product', 10) },
        videoAsset: ref('asset', 11), state: 'paused' }
        : { format: product === 'SP' ? 'sp_product_ad' : 'sd_product_ad', adGroup: ref('ad_group', 13), product: ref('product', 10), state: 'paused' } });
    if (product === 'SD') raw.push({ ...create, nodeId: id(15), kind: 'creative.create', dependsOn: [11, 13, 14].map(id),
      payload: { format: 'sd_video', adGroup: ref('ad_group', 13), headline: null, brandLogo: null,
        consentToTranslate: false, videos: { representation: 'single_video', video: ref('asset', 11) } } });
    const nodes = orderCampaignCreationNodes(raw.map((node) => CampaignCreationNodeV2.parse(node)));
    const reads = nodes.filter((node) => node.effect === 'read_check').length;
    const now = Date.now();
    const plan = fingerprint(CampaignCreationPlanV2.parse({ schemaVersion: 'openspell.campaign-creation-plan.v2',
      id: randomUUID(), orgId, profileId, marketplaceId: 'ATVPDKIKX0DER', adProduct: product, apiDialect: dialect,
      providerScope: { amazonProfileId: '900000000001', connectionId, region: 'NA', marketplaceId: 'ATVPDKIKX0DER', currencyCode: 'USD', accountType: 'seller' },
      generatedAt: new Date(now - 2_000).toISOString(), frozenAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), nodes, fingerprint: zero,
      counts: { totalNodes: nodes.length, readChecks: reads, irreversibleCreates: nodes.length - reads,
        byKind: Object.fromEntries(CampaignCreationNodeKind.options.map((kind) => [kind, nodes.filter((node) => node.kind === kind).length])) },
      noRollbackAcknowledgement: { required: true, rollback: 'none', compensatingAction: 'separate_reviewed_pause_or_archive' },
    }));
    return { actor: { orgId, userId }, plan, connectionId };
  }

  async function counts() {
    return (await database.sql`select
      (select count(*)::int from public.campaign_creation_previews) as plans,
      (select count(*)::int from public.sp_write_approval_requests) as approvals,
      (select count(*)::int from public.sp_write_execution_requests) as executions,
      (select count(*)::int from public.sp_write_outbox) as outbox,
      (select count(*)::int from public.sync_jobs) as jobs`)[0];
  }

  it.each(['SP', 'SB', 'SD'] as const)('round-trips exact %s plans with counted unknown evidence and read-only history', async (product) => {
    const { actor, plan } = await fixture(product);
    expect(await recordCampaignCreationPreview(database, actor, plan)).toEqual(identity(plan));
    const before = await counts();
    for (let i = 0; i < 2; i++) {
      const source = await readRecordedCampaignCreationPreview(database, actor, identity(plan));
      expect(source.plan).toEqual(plan);
      expect(source.current.checks.map((check) => check.nodeId)).toEqual(plan.nodes.map((node) => node.nodeId));
      expect(source.current.checks.every((check) => check.result === 'unknown' && check.checkedAt === null)).toBe(true);
      expect(source.current.assets).toHaveLength(plan.counts.byKind['asset.require_existing']);
      expect(source.current.assets.every((asset) => asset.observation === null && asset.moderation === 'unknown')).toBe(true);
      expect(source.current.providerScope).toBeNull();
      expect(source.admission).toEqual({ kind: 'unavailable' });
    }
    expect(await counts()).toEqual(before);
  });

  it('serializes identical concurrent saves and retains the original recorder/time on recovery', async () => {
    const { actor, plan } = await fixture();
    const before = await counts();
    const results = await Promise.all([recordCampaignCreationPreview(database, actor, plan), recordCampaignCreationPreview(database, actor, plan)]);
    expect(results).toEqual([identity(plan), identity(plan)]);
    expect((await counts())!.plans).toBe(before!.plans + 1);
    const [original] = await database.sql`select * from public.campaign_creation_previews where org_id = ${actor.orgId}`;
    const admin = randomUUID();
    await database.sql`select public.auth_user_stub(${admin})`;
    await database.sql`insert into public.org_members (org_id,user_id,role) values (${actor.orgId},${admin},'admin')`;
    await recordCampaignCreationPreview(database, { ...actor, userId: admin }, plan);
    expect((await readRecordedCampaignCreationPreview(database, { ...actor, userId: admin }, identity(plan))).plan).toEqual(plan);
    const [recovered] = await database.sql`select * from public.campaign_creation_previews where org_id = ${actor.orgId}`;
    expect(recovered).toEqual(original);
  });

  it('preserves the winning artifact when two valid but conflicting plans use the same identity', async () => {
    const { actor, plan } = await fixture();
    const different = structuredClone(plan);
    different.nodes.find((node) => node.kind === 'campaign.create')!.payload.name = 'Different synthetic campaign';
    const changed = fingerprint(different);
    const results = await Promise.allSettled([recordCampaignCreationPreview(database, actor, plan), recordCampaignCreationPreview(database, actor, changed)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'identity_conflict' } });
    const source = await readRecordedCampaignCreationPreview(database, actor, identity(plan));
    expect([plan.fingerprint, changed.fingerprint]).toContain(source.plan.fingerprint);
    const rows = await database.sql`select * from public.campaign_creation_previews where org_id = ${actor.orgId}`;
    expect(rows).toHaveLength(1);
  });

  it('refuses changed fingerprints before recording and refuses deep-invalid direct RPC artifacts on read', async () => {
    const { actor, plan } = await fixture();
    plan.nodes.find((node) => node.kind === 'campaign.create')!.payload.name = 'Tampered synthetic name';
    await expect(recordCampaignCreationPreview(database, actor, plan)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await database.sql`select * from public.campaign_creation_previews where org_id = ${actor.orgId}`).toHaveLength(0);
    await asUser(database, actor.userId, (sql) => sql`select app.record_campaign_creation_preview(${JSON.stringify(plan)})`);
    await expect(readRecordedCampaignCreationPreview(database, actor, identity(plan))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each(['viewer', 'analyst'] as const)('denies %s record/read access including direct RLS reads', async (role) => {
    const { actor, plan } = await fixture();
    await recordCampaignCreationPreview(database, actor, plan);
    await database.sql`update public.org_members set role = ${role} where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
    await expect(recordCampaignCreationPreview(database, actor, plan)).rejects.toMatchObject({ code: 'authorization_refused' });
    await expect(readRecordedCampaignCreationPreview(database, actor, identity(plan))).rejects.toMatchObject({ code: 'not_found' });
    expect(await asUser(database, actor.userId, (sql) => sql`select * from public.campaign_creation_previews`)).toHaveLength(0);
  });

  it('isolates tenants even when both use the same plan ID and the application pool is privileged', async () => {
    const first = await fixture(); const second = await fixture();
    second.plan = fingerprint({ ...second.plan, id: first.plan.id });
    await recordCampaignCreationPreview(database, first.actor, first.plan);
    await recordCampaignCreationPreview(database, second.actor, second.plan);
    for (const [owner, foreign] of [[first, second], [second, first]]) {
      await expect(readRecordedCampaignCreationPreview(database, owner!.actor, identity(foreign!.plan))).rejects.toMatchObject({ code: 'not_found' });
      await expect(readRecordedCampaignCreationPreview(database, { ...owner!.actor, orgId: foreign!.actor.orgId }, identity(foreign!.plan)))
        .rejects.toMatchObject({ code: 'not_found' });
      const rows = await asUser(database, owner!.actor.userId, (sql) => sql`select org_id::text from public.campaign_creation_previews`);
      expect(rows.map((row) => row.org_id)).toEqual([owner!.actor.orgId]);
    }
  });

  it('preserves saved values after profile drift and denies a subsequently revoked member', async () => {
    const { actor, plan, connectionId } = await fixture();
    await recordCampaignCreationPreview(database, actor, plan);
    await database.sql`update public.ad_profiles set account_name = 'Changed synthetic label', currency_code = 'EUR', sync_enabled = false where id = ${plan.profileId}`;
    await database.sql`delete from public.ads_connections where id = ${connectionId}`;
    const source = await readRecordedCampaignCreationPreview(database, actor, identity(plan));
    expect(source.plan).toEqual(plan);
    expect(source.profile.label).toBe('Changed synthetic label');
    expect(source.current.providerScope).toBeNull();
    await recordCampaignCreationPreview(database, actor, plan);
    await database.sql`delete from public.org_members where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
    await expect(readRecordedCampaignCreationPreview(database, actor, identity(plan))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects standalone evidence/profile deletion but permits the actual owning-org cascade', async () => {
    const { actor, plan } = await fixture();
    await recordCampaignCreationPreview(database, actor, plan);
    await expect(database.sql`delete from public.campaign_creation_previews where org_id = ${actor.orgId}`).rejects.toMatchObject({ code: '55000' });
    await expect(database.sql`update public.campaign_creation_previews set recorded_by = ${randomUUID()} where org_id = ${actor.orgId}`).rejects.toMatchObject({ code: '55000' });
    await expect(database.sql`truncate public.campaign_creation_previews`).rejects.toMatchObject({ code: '55000' });
    await expect(database.sql`delete from public.ad_profiles where id = ${plan.profileId}`).rejects.toMatchObject({ code: '55000' });
    await database.sql`delete from public.orgs where id = ${actor.orgId}`;
    expect(await database.sql`select * from public.campaign_creation_previews where org_id = ${actor.orgId}`).toHaveLength(0);
    expect(await database.sql`select * from public.ad_profiles where id = ${plan.profileId}`).toHaveLength(0);
  });

  it('limits table mutations and recorder execution to their explicit boundaries', async () => {
    for (const role of ['anon', 'authenticated', 'service_role'] as const) {
      const [grants] = await database.sql`select
        has_table_privilege(${role}, 'public.campaign_creation_previews', 'INSERT,UPDATE,DELETE,TRUNCATE') as mutation,
        has_function_privilege(${role}, 'app.record_campaign_creation_preview(text)', 'EXECUTE') as record`;
      expect(grants).toEqual({ mutation: false, record: role === 'authenticated' });
      await asActor(database, { role }, async (sql) => {
        await expect(sql`delete from public.campaign_creation_previews`).rejects.toMatchObject({ code: '42501' });
        if (role !== 'authenticated') await expect(sql`select app.record_campaign_creation_preview('{}')`).rejects.toMatchObject({ code: '42501' });
      });
    }
  });

  it('restores pooled role and claims after successful and failed reads', async () => {
    const { actor, plan } = await fixture();
    const before = await pool.sql`select current_user as role, auth.uid()::text as subject`;
    await recordCampaignCreationPreview(pool, actor, plan);
    await readRecordedCampaignCreationPreview(pool, actor, identity(plan));
    await expect(readRecordedCampaignCreationPreview(pool, actor, { ...identity(plan), planId: randomUUID() }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await pool.sql`select current_user as role, auth.uid()::text as subject`).toEqual(before);
  });

  it('reads using a database-enforced read-only repeatable snapshot', async () => {
    const { actor, plan } = await fixture();
    await recordCampaignCreationPreview(database, actor, plan);
    // The policy makes a writable or non-repeatable reader unable to see its own row.
    await database.sql`alter policy campaign_creation_previews_read on public.campaign_creation_previews
      using (app.has_org_role(org_id, array['owner','admin'])
        and current_setting('transaction_read_only') = 'on'
        and current_setting('transaction_isolation') = 'repeatable read')`;
    try {
      expect(await asUser(database, actor.userId, (sql) => sql`select * from public.campaign_creation_previews`)).toHaveLength(0);
      expect((await readRecordedCampaignCreationPreview(database, actor, identity(plan))).plan).toEqual(plan);
    } finally {
      await database.sql`alter policy campaign_creation_previews_read on public.campaign_creation_previews
        using (app.has_org_role(org_id, array['owner','admin']))`;
    }
  });

  it('recovers a historical expired plan without authorizing it or allowing a new expired record', async () => {
    const { actor, plan } = await fixture();
    const now = Date.now();
    const expired = fingerprint({ ...plan, generatedAt: new Date(now - 60_000).toISOString(),
      frozenAt: new Date(now - 50_000).toISOString(), expiresAt: new Date(now - 40_000).toISOString() });
    const artifact = JSON.stringify(expired);
    await database.sql`insert into public.campaign_creation_previews
      (org_id, profile_id, plan_id, artifact_text, artifact, artifact_sha256, recorded_by, recorded_at)
      values (${actor.orgId},${plan.profileId},${plan.id},${artifact},${artifact}::jsonb,${sha(artifact)},${actor.userId},${expired.frozenAt})`;
    const before = await counts();
    expect((await readRecordedCampaignCreationPreview(database, actor, identity(plan))).plan).toEqual(expired);
    expect(await recordCampaignCreationPreview(database, actor, expired)).toEqual(identity(plan));
    await expect(recordCampaignCreationPreview(database, actor, fingerprint({ ...expired, id: randomUUID() })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(await counts()).toEqual(before);
  });

  it('rejects fresh saves with changed profile scope, future timestamps or changed caller data', async () => {
    const { actor, plan } = await fixture();
    const wrong = fingerprint({ ...plan, providerScope: { ...plan.providerScope, amazonProfileId: '900000000002' } });
    await expect(recordCampaignCreationPreview(database, actor, wrong)).rejects.toMatchObject({ code: 'authorization_refused' });
    const now = Date.now();
    const future = fingerprint({ ...plan, generatedAt: new Date(now + 10_000).toISOString(),
      frozenAt: new Date(now + 20_000).toISOString(), expiresAt: new Date(now + 30_000).toISOString() });
    await expect(recordCampaignCreationPreview(database, actor, future)).rejects.toMatchObject({ code: 'invalid_request' });
    const original = structuredClone(plan);
    const recording = recordCampaignCreationPreview(database, actor, plan);
    plan.nodes.find((node) => node.kind === 'campaign.create')!.payload.name = 'Changed after call';
    await recording;
    expect((await readRecordedCampaignCreationPreview(database, actor, identity(plan))).plan).toEqual(original);
  });

  it('enforces byte and tenant identity integrity even for privileged fixture inserts', async () => {
    const { actor, plan } = await fixture();
    const artifact = JSON.stringify(plan);
    for (const [orgId, hash] of [[actor.orgId, zero], [randomUUID(), sha(artifact)]]) {
      await expect(database.sql`insert into public.campaign_creation_previews
        (org_id, profile_id, plan_id, artifact_text, artifact, artifact_sha256, recorded_by)
        values (${orgId!},${plan.profileId},${plan.id},${artifact},${artifact}::jsonb,${hash!},${actor.userId})`)
        .rejects.toMatchObject({ code: '23514' });
    }
  });

  it('refuses recording after a concurrent membership revocation wins the lock', async () => {
    const { actor, plan } = await fixture();
    const locked = barrier(); const release = barrier();
    const [connection] = await pool.sql`select pg_backend_pid() as pid`;
    const revoke = database.sql.begin(async (sql) => {
      await sql`update public.org_members set role = 'viewer' where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    const recording = recordCampaignCreationPreview(pool, actor, plan).then(
      (value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await expect.poll(async () => (await database.sql`select wait_event_type from pg_stat_activity where pid = ${connection!.pid}`)[0]?.wait_event_type)
        .toBe('Lock');
    } finally { release.resolve(); await revoke; }
    expect(await recording).toMatchObject({ error: { code: 'authorization_refused' } });
    expect(await database.sql`select * from public.campaign_creation_previews where org_id = ${actor.orgId}`).toHaveLength(0);
  });

  it('retains a committed record when recording wins a concurrent revocation, but denies subsequent reads', async () => {
    const { actor, plan } = await fixture();
    const recorded = barrier(); const release = barrier();
    const [connection] = await pool.sql`select pg_backend_pid() as pid`;
    const recording = database.sql.begin(async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor.userId, role: 'authenticated' })}, true)`;
      await sql`set local role authenticated`;
      await sql`select app.record_campaign_creation_preview(${JSON.stringify(plan)})`;
      recorded.resolve(); await release.promise;
    });
    await recorded.promise;
    const revoke = pool.sql`delete from public.org_members where org_id = ${actor.orgId} and user_id = ${actor.userId}`.execute();
    try {
      await expect.poll(async () => (await database.sql`select wait_event_type from pg_stat_activity where pid = ${connection!.pid}`)[0]?.wait_event_type)
        .toBe('Lock');
    } finally { release.resolve(); await recording; await revoke; }
    expect(await database.sql`select * from public.campaign_creation_previews where org_id = ${actor.orgId}`).toHaveLength(1);
    await expect(readRecordedCampaignCreationPreview(database, actor, identity(plan))).rejects.toMatchObject({ code: 'not_found' });
  });
});

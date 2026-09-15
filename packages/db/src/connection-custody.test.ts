import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asUser } from './testing/rls.js';
import { getConnectionCredentialBinding, getProfileCredentialBinding } from './queries/connections.js';
import { getAdsRefreshTokenForGeneration, revokeAdsRefreshToken, storeAdsRefreshToken } from './queries/tokens.js';
import { getIntegrationSecret, storeIntegrationSecret } from './queries/integrations.js';

const available = await databaseAvailable();
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const ANALYST = '10000000-0000-4000-8000-000000000003';
type Scope = { org: string; connection: string; profile: string; amazon: string; region: 'NA' | 'EU' | 'FE' };

describe.skipIf(!available)('Amazon connection custody', () => {
  let db: TestDatabase;
  let a: Scope;
  let b: Scope;
  beforeAll(async () => {
    db = await createTestDatabase('connection_custody');
    async function seed(label: string, user: string): Promise<Scope> {
      const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${label}, ${user}, 'owner') as id`;
      const [row] = await db.sql<Scope[]>`select org_id as org, connection_id as connection,
        id as profile, amazon_profile_id as amazon, region::text as region
        from public.ad_profiles where org_id = ${org!.id} order by id limit 1`;
      if (!row) throw new Error('Synthetic scope missing');
      await storeAdsRefreshToken(db, row.connection, ['synthetic', label, 'grant'].join('-'));
      return row;
    }
    a = await seed('custody-a', A); b = await seed('custody-b', B);
    await db.sql`insert into auth.users (id) values (${ANALYST})`;
    await db.sql`insert into public.org_members (org_id,user_id,role) values (${a.org},${ANALYST},'analyst')`;
  }, 60_000);
  afterAll(async () => { await db?.drop(); });

  it('denies guessed foreign credential pointers despite ownership of the edited row', async () => {
    const [foreign] = await db.sql<{ vault_secret_id: string }[]>`
      select vault_secret_id from public.ads_connections where id=${b.connection}`;
    await asUser(db, A, async (sql) => {
      expect(await sql`select id from public.ads_connections where org_id=${b.org}`).toHaveLength(0);
      await expect(sql`update public.ads_connections set vault_secret_id=${foreign!.vault_secret_id}
        where id=${a.connection}`).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('denies direct provider identity and connection attachment edits', async () => {
    await asUser(db, A, async (sql) => {
      await expect(sql`update public.ad_profiles set connection_id=${b.connection}, amazon_profile_id=${b.amazon}
        where id=${a.profile}`).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('prevents generic integrations from aliasing foreign Ads credentials', async () => {
    const [foreign] = await db.sql<{ vault_secret_id: string }[]>`select vault_secret_id
      from public.ads_connections where id=${b.connection}`;
    const [integration] = await db.sql<{ id: string }[]>`insert into public.integration_connections
      (org_id,provider,label) values (${a.org},'mrp','Synthetic integration') returning id`;
    for (const operation of ['insert', 'update']) {
      await asUser(db, A, async (sql) => {
        const query = operation === 'insert'
          ? sql`insert into public.integration_connections (org_id,provider,label,vault_secret_id)
              values (${a.org},'mrp','Synthetic alias',${foreign!.vault_secret_id})`
          : sql`update public.integration_connections set vault_secret_id=${foreign!.vault_secret_id}
              where id=${integration!.id}`;
        await expect(query).rejects.toMatchObject({ code: '42501' });
      });
    }
    expect(await getIntegrationSecret(db, integration!.id)).toBeNull();
    await storeIntegrationSecret(db, integration!.id, ['synthetic', 'integration', 'grant'].join('-'));
    await asUser(db, A, async (sql) => {
      expect(await sql`update public.integration_connections set label='Synthetic renamed'
        where id=${integration!.id} returning id`).toHaveLength(1);
    });
    expect(await getIntegrationSecret(db, integration!.id)).toBe('synthetic-integration-grant');
  });

  it('rejects a cross-agency attachment even under privileged database authority', async () => {
    await expect(db.sql`update public.ad_profiles set connection_id=${b.connection}
      where id=${a.profile}`).rejects.toMatchObject({ code: '23503' });
    const [counts] = await db.sql<{ count: number }[]>`select count(*)::int as count
      from public.ad_profiles p join public.ads_connections c on c.id=p.connection_id where p.org_id<>c.org_id`;
    expect(counts!.count).toBe(0);
  });

  it('preserves permitted target edits but refuses analyst synchronization changes', async () => {
    await asUser(db, ANALYST, async (sql) => {
      const rows = await sql`update public.ad_profiles set goal_lens='synthetic-review' where id=${a.profile} returning id`;
      expect(rows).toHaveLength(1);
    });
    await asUser(db, ANALYST, async (sql) => {
      await expect(sql`update public.ad_profiles set sync_enabled=not sync_enabled where id=${a.profile}`)
        .rejects.toMatchObject({ code: '42501' });
    });
    await asUser(db, A, async (sql) => {
      expect(await sql`update public.ad_profiles set sync_enabled=false where id=${a.profile} returning id`).toHaveLength(1);
    });
  });

  it('resolves only the complete current profile and organization identity', async () => {
    const binding = await getProfileCredentialBinding(db, a.org, a.profile, a.amazon, a.region);
    expect(binding).toMatchObject({ orgId: a.org, connectionId: a.connection, generation: '1' });
    expect(await getProfileCredentialBinding(db, b.org, a.profile, a.amazon, a.region)).toBeNull();
    expect(await getProfileCredentialBinding(db, a.org, a.profile, b.amazon + '-different', a.region)).toBeNull();
    expect(await getProfileCredentialBinding(db, a.org, a.profile, a.amazon, a.region === 'EU' ? 'NA' : 'EU')).toBeNull();
  });

  it('increments the generation for an in-place rotation and refuses stale or foreign reads', async () => {
    const before = (await getConnectionCredentialBinding(db, a.connection))!;
    const [original] = await db.sql<{ vault_secret_id: string }[]>`select vault_secret_id from public.ads_connections where id=${a.connection}`;
    const value = ['synthetic', 'rotated', 'grant'].join('-');
    await storeAdsRefreshToken(db, a.connection, value);
    const after = (await getConnectionCredentialBinding(db, a.connection))!;
    expect(BigInt(after.generation)).toBe(BigInt(before.generation) + 1n);
    const [current] = await db.sql<{ vault_secret_id: string }[]>`select vault_secret_id from public.ads_connections where id=${a.connection}`;
    expect(current!.vault_secret_id).toBe(original!.vault_secret_id);
    expect(await getAdsRefreshTokenForGeneration(db, before)).toBeNull();
    expect(await getAdsRefreshTokenForGeneration(db, { ...after, orgId: b.org })).toBeNull();
    expect(await getAdsRefreshTokenForGeneration(db, after)).toBe(value);
    await asUser(db, A, async (sql) => {
      await expect(sql`select public.get_ads_refresh_token_for_generation(${a.org},${a.connection},${after.generation}::bigint)`)
        .rejects.toMatchObject({ code: '42501' });
    });
  });

  it('revocation invalidates the binding and removes its stored credential', async () => {
    const binding = (await getConnectionCredentialBinding(db, b.connection))!;
    expect(await revokeAdsRefreshToken(db, b.connection)).toBe(true);
    expect(await getConnectionCredentialBinding(db, b.connection)).toBeNull();
    expect(await getAdsRefreshTokenForGeneration(db, binding)).toBeNull();
  });
});

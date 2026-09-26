import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSpApiConnection, storeSpApiRefreshToken, withAuthenticatedActor } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { loadSpApiConnections } from './connections';

const available = await databaseAvailable();

describe.skipIf(!available)('SP-API connection usability on Connections', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase('wp327_spapi_connection_usable'); }, 180_000);
  afterAll(async () => { await db?.drop(); });

  it('marks a connection usable only when active, stored and seller-identified, as the reporting RPC requires', async () => {
    const userId = randomUUID();
    await db.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name) values (${randomUUID()},'Synthetic usable agency') returning id`;
    const actor = { orgId: org!.id, userId };
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${userId},'owner')`;
    const cases = [
      { label: 'Synthetic identified', seller: 'synthetic-seller', store: true, usable: true },
      { label: 'Synthetic unidentified', seller: null, store: true, usable: false },
      { label: 'Synthetic blank seller', seller: 'synthetic-blank', store: true, usable: false },
      { label: 'Synthetic unstored', seller: 'synthetic-seller', store: false, usable: false },
    ];
    for (const row of cases) {
      const connection = await createSpApiConnection(db, { orgId: actor.orgId, label: row.label,
        sellingPartnerId: row.seller, marketplaceIds: ['ATVPDKIKX0DER'] });
      if (row.store) {
        await storeSpApiRefreshToken(db, { orgId: actor.orgId, connectionId: connection.id,
          refreshToken: ['synthetic', 'usable', 'refresh'].join('-') });
      }
    }
    // A seller id of only whitespace is not an identity; the producer trims it the same way.
    await db.sql`update public.spapi_connections set selling_partner_id='  ' where org_id=${actor.orgId} and label='Synthetic blank seller'`;
    const { connections } = await withAuthenticatedActor(db, actor, (sql) => loadSpApiConnections({ sql }, actor.orgId));
    expect(connections).toHaveLength(cases.length);
    let checked = 0;
    for (const row of cases) {
      const loaded = connections.find((connection) => connection.label === row.label);
      expect(loaded?.hasCredential).toBe(row.usable);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
    expect(connections.filter((connection) => connection.status === 'active')).toHaveLength(3);
  });
});

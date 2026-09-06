import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { connectAuthority, executeAuthority, type AuthorityConnection } from './database.js';
import { parseAuthorityCommand } from './command.js';

const available = await databaseAvailable();
describe.skipIf(!available)('actual managed authority adapter', () => {
  let database: TestDatabase; let connection: AuthorityConnection;
  const role = `broker_${randomUUID().replaceAll('-', '')}`;
  const a = 'a'.repeat(40); const b = 'b'.repeat(40);
  beforeAll(async () => {
    database = await createTestDatabase('authority_broker', { applyFixture: false });
    const loginValue = randomBytes(24).toString('hex');
    await database.sql.unsafe(`create role ${role} login noinherit nosuperuser nobypassrls password '${loginValue}'`);
    await database.sql.unsafe(`grant service_role to ${role} with inherit false, set true`);
    const url = new URL(database.connectionString); url.username = role; url.password = loginValue;
    connection = connectAuthority(url.toString());
  }, 60_000);
  afterAll(async () => {
    await connection?.end({ timeout: 1 });
    if (database) {
      await database.sql.unsafe(`drop role if exists ${role}`);
      await database.drop();
    }
  });

  it('uses the actual NOINHERIT login and executes all four transitions with refusal readback', async () => {
    expect((await connection`select session_user,current_user`)[0]).toEqual({ session_user: role, current_user: role });
    const run = (args: string[]) => executeAuthority(connection, parseAuthorityCommand(args));
    expect(await run(['block','0','-',a])).toMatchObject({ decision: 'blocked', epoch: 1 });
    expect(await run(['activate','1','-',a])).toMatchObject({ decision: 'activated', epoch: 2, authorizedRevision: a });
    expect(await run(['authorize','2',a,a])).toMatchObject({ decision: 'authorized', epoch: 3, admission: 'scoped' });
    expect(await run(['block','3',a,b])).toMatchObject({ decision: 'blocked', epoch: 4 });
    const before = await database.sql`select * from app.recommendation_claim_authority`;
    expect(await run(['rebind','3',a,b])).toMatchObject({ decision: 'stale_epoch', epoch: 4 });
    expect(await run(['rebind','4',b,a])).toMatchObject({ decision: 'authority_mismatch', epoch: 4 });
    expect(await database.sql`select * from app.recommendation_claim_authority`).toEqual(before);
    expect(await run(['rebind','4',a,b])).toMatchObject({ decision: 'rebound', epoch: 5, authorizedRevision: b });
    expect((await database.sql`select count(*)::int as count from app.recommendation_claim_authority`)[0]).toEqual({ count: 1 });
    expect((await connection`select current_user`)[0]).toEqual({ current_user: role });
  });

  it('denies direct authority-table writes and worker/browser CAS privilege', async () => {
    await expect(connection`update app.recommendation_claim_authority set epoch=100`).rejects.toMatchObject({ code: '42501' });
    for (const deniedRole of ['authenticated', 'anon', 'openspell_recommendation_worker']) {
      await expect(database.sql.begin(async (sql) => {
        await sql.unsafe(`set local role ${deniedRole}`);
        return sql`select * from public.block_recommendation_admission(5)`;
      })).rejects.toMatchObject({ code: '42501' });
    }
    // The credential is broad infrastructure authority once SET ROLE is used;
    // do not describe its service-role membership as a narrow DB principal.
    expect((await connection.begin(async (sql) => {
      await sql`set local role service_role`;
      return sql`select current_user`;
    }))[0]).toEqual({ current_user: 'service_role' });
  });

  it('retains fixed server timeouts and refuses credential startup-option overrides', async () => {
    expect((await connection`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`)[0])
      .toEqual({ statement: '5s', lock: '3s' });
    for (const query of ['statement_timeout=0', 'lock_timeout=0', 'options=-c%20statement_timeout%3D0', 'sslmode=disable&sslmode=require']) {
      expect(() => connectAuthority(`${database.connectionString}?${query}`)).toThrow('Authority credential unavailable');
    }
  });
});

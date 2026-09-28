/**
 * The MCF unit's entry (WP-338e; the WP-338i start-up key check). Runs
 * src/mcf-main.ts as its own process, as wizard-ads-mcf.service does, against a
 * migrated test database:
 *
 *  - with a flag on, it refuses to start when an active grant in its scope
 *    names a recipient key id that no readable key file carries, and the
 *    refusal names the variable and the count only;
 *  - with a key file for every such id (grants outside the scope, revoked or
 *    expired do not count), it starts, and a SIGTERM stops it with exit 0;
 *  - with both flags off it reads no keys and starts whatever the grants say;
 *  - with a flag on and the grants unreadable, it refuses.
 *
 * Synthetic keys, ids and credentials only, made at run time.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asServiceRole, createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { creatorMcfRecipientKeyId } from '@wizard-ads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcfRecipientCredentialName } from './mcf-send/custody.js';
import { mcfMissingRecipientKeys } from './mcf-send/policy.js';

const available = await databaseAvailable();
const entry = fileURLToPath(new URL('./mcf-main.ts', import.meta.url));
const OWNER = randomUUID();
const CLIENT_SECRET = ['synthetic', 'lwa', 'mcf', 'key'].join('-');

interface KeyPair { der: Buffer; keyId: string }
async function keyPair(): Promise<KeyPair> {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = pair.publicKey.export({ format: 'jwk' });
  const keyId = await creatorMcfRecipientKeyId({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y });
  return { der: pair.privateKey.export({ format: 'der', type: 'pkcs8' }), keyId };
}

/** The unit's environment: nothing from the test runner's WORKER_ or OPENSPELL_ variables leaks in. */
function unitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(merged)) if (name.startsWith('WORKER_') || name.startsWith('OPENSPELL_') || name === 'CREDENTIALS_DIRECTORY') delete merged[name];
  return { ...merged, SP_API_LWA_CLIENT_ID: 'synthetic-client', SP_API_LWA_CLIENT_SECRET: CLIENT_SECRET, OPENSPELL_MCF_POLL_INTERVAL_MS: '1000', ...env };
}

/** Runs the entry until it exits, or until `ready` appears on stdout and a SIGTERM stops it. */
async function runUnit(env: NodeJS.ProcessEnv, ready: string | null, timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { env: unitEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += String(data); });
  child.stderr.on('data', (data) => { stderr += String(data); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  if (ready !== null) {
    const deadline = Date.now() + timeoutMs;
    while (!stdout.includes(ready) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  const code = await exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

const refusal = (stderr: string): string | null => {
  const line = stderr.split('\n').find((text) => text.includes('"mcf_start_refused"'));
  return line === undefined ? null : String((JSON.parse(line) as { reason: unknown }).reason);
};

describe('the start-up key rule', () => {
  it('names every active key id without a readable key file, once, sorted', () => {
    const [a, b, c] = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    expect(mcfMissingRecipientKeys([b, a, b, c], [a])).toEqual([b, c]);
    expect(mcfMissingRecipientKeys([a], [a, b])).toEqual([]);
    expect(mcfMissingRecipientKeys([], [])).toEqual([]);
  });
});

describe.skipIf(!available)('the MCF unit refuses to start without a key file for every active grant key id in its scope', () => {
  let db: TestDatabase;
  let dir: string;
  let held: KeyPair;
  let missing: KeyPair;

  beforeAll(async () => {
    db = await createTestDatabase('wp338i_mcf_main');
    dir = await mkdtemp(join(tmpdir(), 'wp338i-main-keys-'));
    held = await keyPair();
    missing = await keyPair();
    await writeFile(join(dir, mcfRecipientCredentialName(held.keyId)), held.der);
  }, 240_000);
  afterAll(async () => {
    await db?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function newOrg(): Promise<{ id: string; connection: string; marketplace: string; scope: string }> {
    const [row] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${`mcf-main-${randomBytes(3).toString('hex')}`}, ${OWNER}, 'owner') as id`;
    const id = row!.id;
    await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'active', vault_secret_id = gen_random_uuid() where org_id = ${id}`);
    const [binding] = await db.sql<{ connection_id: string; marketplace_id: string }[]>`select connection_id, marketplace_id
      from public.spapi_profile_bindings where org_id = ${id}`;
    return { id, connection: binding!.connection_id, marketplace: binding!.marketplace_id, scope: `${binding!.connection_id}:${binding!.marketplace_id}` };
  }
  async function grant(org: { id: string; connection: string; marketplace: string }, keys: string[], state: 'active' | 'revoked' | 'expired' = 'active') {
    const enabled = state === 'expired' ? new Date(Date.now() - 10 * 86_400_000) : new Date();
    const expires = state === 'expired' ? new Date(Date.now() - 86_400_000) : new Date(Date.now() + 30 * 86_400_000);
    await db.sql`insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids, max_units_per_day,
        max_fee_minor, currency, enabled_by, enabled_at, expires_at, revoked_at)
      values (${org.id}, ${org.connection}, ${org.marketplace}, '{send,cancel}', ${keys}::text[], 1, 1500, 'USD', 'synthetic operator',
        ${enabled.toISOString()}::timestamptz, ${expires.toISOString()}::timestamptz, ${state === 'revoked' ? new Date().toISOString() : null}::timestamptz)`;
  }

  it('refuses with a flag on when an active grant in scope names a key id it cannot read, naming the variable and the count only', async () => {
    const org = await newOrg();
    await grant(org, [held.keyId, missing.keyId]);
    for (const flag of ['OPENSPELL_MCF_DISPATCH_ENABLED', 'OPENSPELL_MCF_PREVIEW_ENABLED']) {
      const result = await runUnit({ DATABASE_URL: db.connectionString, [flag]: '1', OPENSPELL_MCF_SCOPE: org.scope, CREDENTIALS_DIRECTORY: dir }, null);
      expect(result.code).toBe(1);
      expect(refusal(result.stderr)).toBe('CREDENTIALS_DIRECTORY: no readable key file for 1 active grant key id');
      const output = result.stdout + result.stderr;
      for (const secret of [missing.keyId, held.keyId, db.connectionString, CLIENT_SECRET]) expect(output).not.toContain(secret);
      expect(output).not.toContain('"mcf_start"');
    }
    // No heartbeat: the loop never ran.
    const [beats] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_worker_heartbeats`;
    expect(beats!.n).toBe(0);
  }, 180_000);

  it('starts when every active key id in scope is readable (outside the scope, revoked and expired grants do not count), and stops on SIGTERM', async () => {
    const org = await newOrg();
    await grant(org, [held.keyId, missing.keyId], 'revoked');
    await grant(org, [held.keyId]);
    const expiredOrg = await newOrg();
    await grant(expiredOrg, [missing.keyId], 'expired');
    const outside = await newOrg();
    await grant(outside, [missing.keyId]);
    const result = await runUnit({ DATABASE_URL: db.connectionString, OPENSPELL_MCF_DISPATCH_ENABLED: '1', OPENSPELL_MCF_PREVIEW_ENABLED: '1',
      OPENSPELL_MCF_SCOPE: `${org.scope},${expiredOrg.scope}`, CREDENTIALS_DIRECTORY: dir }, '"mcf_start"');
    expect(refusal(result.stderr)).toBeNull();
    expect(result.stdout).toContain('"mcf_start"');
    expect(result.stdout).toContain('"mcf_stop"');
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(CLIENT_SECRET);
  }, 120_000);

  it('with both flags off reads no key and starts whatever the grants say', async () => {
    const org = await newOrg();
    await grant(org, [missing.keyId]);
    const result = await runUnit({ DATABASE_URL: db.connectionString, OPENSPELL_MCF_SCOPE: org.scope, CREDENTIALS_DIRECTORY: join(dir, 'absent') },
      '"mcf_start"');
    expect(refusal(result.stderr)).toBeNull();
    expect(result.stdout).toContain('"mcf_start"');
    expect(result.code).toBe(0);
  }, 120_000);

  it('with a flag on and the grants unreadable, refuses rather than start unchecked', async () => {
    const org = await newOrg();
    await grant(org, [held.keyId]);
    const unreachable = 'postgres://synthetic:synthetic@127.0.0.1:1/absent';
    const result = await runUnit({ DATABASE_URL: unreachable, OPENSPELL_MCF_DISPATCH_ENABLED: '1', OPENSPELL_MCF_SCOPE: org.scope, CREDENTIALS_DIRECTORY: dir },
      null);
    expect(result.code).toBe(1);
    expect(refusal(result.stderr)).toBe('DATABASE_URL: the active grant key ids could not be read');
    expect(result.stdout + result.stderr).not.toContain(unreachable);
  }, 120_000);
});

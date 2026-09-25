/**
 * The connection-only SP-API command (WP-326) against a real, migrated
 * Postgres.
 *
 * Isolation: the database holds exactly what the general worker would act on
 * at startup (due queued jobs, a stale claim the reaper would requeue, and
 * profiles the schedule provisioner would provision), and the command must
 * leave every one of them untouched.
 *
 * Exchange: a pending consent is exchanged, interrupted, and interrupted by
 * repeated signals, and custody always settles.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDb, createSpApiConnectionLifecycle } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import type { FetchLike } from '@wizard-ads/sp-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSpApiConnectionsCli } from './spapi-connections-cli.js';
import { PostgresWorkerStore } from './store.js';

const available = await databaseAvailable();
const USER = '77777777-7777-4777-8777-777777777777';
const SECRET = ['synthetic', 'lwa', 'application', 'key'].join('-');
const CALLBACK = 'https://example.test/callback';
const QUEUED_JOBS = 3;
const cliPath = fileURLToPath(new URL('./spapi-connections-cli.ts', import.meta.url));

function commandEnv(database: TestDatabase): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: database.connectionString,
    OPENSPELL_SPAPI_CONNECTIONS_ENABLED: '1',
    SP_API_LWA_CLIENT_ID: 'synthetic-client',
    SP_API_LWA_CLIENT_SECRET: SECRET,
    SP_API_APPLICATION_ID: 'synthetic-application',
    SP_API_OAUTH_REGION: 'NA',
    SP_API_OAUTH_ALLOWED_REDIRECT_URIS: CALLBACK,
  };
}

/** The command as a separate process; no WORKER_ variable leaks in from the test runner. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of Object.keys(merged)) if (name.startsWith('WORKER_')) delete merged[name];
  return merged;
}

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!available)('SP-API connection command isolation (real Postgres)', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileIds: string[];
  let seededIds: { queued: string[]; stale: string };
  let env: NodeJS.ProcessEnv;
  let baseline: Record<string, unknown>[];

  const jobs = async (): Promise<Record<string, unknown>[]> =>
    [...await database.sql<Record<string, unknown>[]>`select * from public.sync_jobs order by id`];
  const count = async (table: 'public.sync_schedules' | 'app.spapi_connection_operations'): Promise<number> => {
    const [row] = await database.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
    return row?.n ?? -1;
  };
  const unscheduled = async (): Promise<string[]> =>
    (await new PostgresWorkerStore(database).unscheduledProfiles())
      .filter((profile) => profile.orgId === orgId).map((profile) => profile.profileId).sort();

  async function expectUntouched(): Promise<void> {
    expect(await jobs()).toEqual(baseline);
    expect(await count('public.sync_schedules')).toBe(0);
    expect(await count('app.spapi_connection_operations')).toBe(0);
    expect(await unscheduled()).toEqual(profileIds);
  }

  beforeAll(async () => {
    database = await createTestDatabase('spapi_cli');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('spapi-cli', ${USER}, 'owner')`;
    orgId = org?.seed_tenant_fixture ?? '';
    // Unprovisioned: no schedule of any kind, so ScheduleProvisioner would write rows.
    await database.sql`delete from public.sync_schedules`;
    await database.sql`update public.ad_profiles set sync_enabled = true where org_id = ${orgId}`;
    profileIds = (await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} order by id`).map((row) => row.id);
    const profileId = profileIds[0]!;
    const payload = JSON.stringify({ type: 'entity.sync', orgId, profileId, full: false });
    const queued: string[] = [];
    for (let index = 0; index < QUEUED_JOBS; index += 1) {
      const [row] = await database.sql<{ id: string }[]>`
        insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key, run_after)
        values (${orgId}, ${profileId}, 'entity.sync', ${payload}::jsonb,
          ${`spapi-cli-queued-${index}`}, now() - interval '1 hour')
        returning id`;
      queued.push(row!.id);
    }
    // A stale claim: StaleClaimReaper would requeue it on its first pass.
    const [stale] = await database.sql<{ id: string }[]>`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key, status,
        attempts, claimed_by, claimed_at, started_at, run_after)
      values (${orgId}, ${profileId}, 'entity.sync', ${payload}::jsonb,
        'spapi-cli-stale', 'running', 1, 'departed-worker', now() - interval '2 hours',
        now() - interval '2 hours', now() - interval '3 hours')
      returning id`;
    seededIds = { queued: queued.sort(), stale: stale!.id };
    baseline = await jobs();
    env = commandEnv(database);
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  it('seeds work the general worker would act on', async () => {
    expect.assertions(7);
    expect(profileIds.length).toBeGreaterThan(0);
    const seeded = baseline.filter((job) => String(job['dedupe_key']).startsWith('spapi-cli-'));
    expect(seeded).toHaveLength(QUEUED_JOBS + 1);
    expect(seeded.filter((job) => job['status'] === 'queued')).toHaveLength(QUEUED_JOBS);
    expect(seeded.filter((job) => job['status'] === 'running')).toHaveLength(1);
    // The snapshot compares whole rows, every column of sync_jobs.
    expect(Object.keys(baseline[0]!).length).toBeGreaterThanOrEqual(19);
    expect(await count('public.sync_schedules')).toBe(0);
    expect(await unscheduled()).toEqual(profileIds);
  });

  it('--once runs one idle pass and changes nothing', async () => {
    expect.assertions(8);
    const out: string[] = []; const err: string[] = [];
    const code = await runSpApiConnectionsCli(['--once'], { env, log: (line) => out.push(line), error: (line) => err.push(line) });
    expect(code).toBe(0);
    expect(err).toHaveLength(0);
    expect(out.map((line) => JSON.parse(line) as Record<string, string>).map(({ event, outcome }) => ({ event, outcome })))
      .toEqual([{ event: 'spapi_connection_command_started', outcome: undefined },
        { event: 'spapi_connection_pass', outcome: 'idle' }]);
    expect(out.join('\n')).not.toContain(database.connectionString);
    await expectUntouched();
  });

  it('a bounded loop run heartbeats, stops on the stop signal and changes nothing', async () => {
    expect.assertions(9);
    const out: string[] = []; const err: string[] = [];
    const stop = new AbortController();
    // Every clock read advances five minutes, so each pass also emits a heartbeat.
    let reads = 0;
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + (reads++) * 300_000);
    const heartbeats = () => out.filter((line) => line.includes('"spapi_connection_heartbeat"')).length;
    const done = runSpApiConnectionsCli([], { env, stop: stop.signal, now,
      log: (line) => out.push(line), error: (line) => err.push(line) });
    await until(() => heartbeats() >= 2, 'two passes');
    stop.abort();
    expect(await done).toBe(0);
    expect(err).toHaveLength(0);
    const events = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    // Idle passes after the first are not logged individually.
    expect(events.filter(({ event }) => event === 'spapi_connection_pass')).toEqual([expect.objectContaining({ outcome: 'idle' })]);
    expect(events.filter(({ event }) => event === 'spapi_connection_heartbeat').every(({ passes }) => passes === 1)).toBe(true);
    expect([events[0]?.['event'], events.at(-1)?.['event']])
      .toEqual(['spapi_connection_command_started', 'spapi_connection_command_stopped']);
    await expectUntouched();
  }, 20_000);

  it('the command process exits 0 on SIGTERM and never logs a secret or the database URL', async () => {
    expect.assertions(9);
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath], { env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += String(data); });
    child.stderr.on('data', (data) => { stderr += String(data); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    await until(() => stdout.includes('"spapi_connection_pass"'), 'a pass outcome');
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(stdout).toContain('"stop_requested"');
    expect(stdout).toContain('"spapi_connection_command_stopped"');
    expect(stdout + stderr).not.toContain(database.connectionString);
    expect(stdout + stderr).not.toContain(SECRET);
    await expectUntouched();
  }, 30_000);

  // Positive control, last because it mutates the seed: the general worker's
  // queue claim, reaper and provisioner do act on exactly this state.
  it('the seeded state is live work for the general worker', async () => {
    expect.assertions(4);
    const store = new PostgresWorkerStore(database);
    const claimed = await store.claim('spapi-cli-control', 50);
    expect(claimed.map((job) => job.id).filter((id) => seededIds.queued.includes(id)).sort()).toEqual(seededIds.queued);
    expect(await store.requeueStale('30 minutes')).toBe(1);
    expect(await store.provisionSchedules(orgId, profileIds[0]!)).toBeGreaterThan(0);
    expect(await count('public.sync_schedules')).toBeGreaterThan(0);
  });
});

describe.skipIf(!available)('SP-API connection command exchange (real Postgres)', () => {
  let database: TestDatabase;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    database = await createTestDatabase('spapi_cli_exchange');
    env = commandEnv(database);
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  /** One submitted consent for one seller profile, as the web callback leaves it. */
  async function pendingConsent(): Promise<{ operationId: string; code: string; read: () => Promise<{ state: string; reason: string | null; attachedBindings: number }> }> {
    const userId = randomUUID();
    await database.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await database.sql<{ id: string }[]>`
      insert into public.orgs(slug,name) values (${randomUUID()},'Synthetic seller agency') returning id`;
    const actor = { orgId: org!.id, userId };
    await database.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${userId},'owner')`;
    const seller = 'synthetic-seller';
    const [profile] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,amazon_account_id)
      values (${actor.orgId},${randomUUID()},'NA','US','USD','UTC','seller',${seller}) returning id`;
    const lifecycle = createSpApiConnectionLifecycle(database, () => true);
    const nonceHash = 'b'.repeat(64);
    const operation = await lifecycle.begin(actor, { requestId: randomUUID(), nonceHash, clientId: 'synthetic-client',
      applicationId: 'synthetic-application', redirectUri: CALLBACK, region: 'NA', label: 'Synthetic seller',
      bindings: [{ profileId: profile!.id, marketplaceId: 'ATVPDKIKX0DER' }] });
    const code = `synthetic-consent-${randomUUID()}`;
    await lifecycle.submit(actor, { operationId: operation.operationId, nonceHash, code, sellingPartnerId: seller });
    return { operationId: operation.operationId, code, read: () => lifecycle.custody.read(operation.operationId) };
  }

  it('--once exchanges a pending consent through an injected transport and attaches it', async () => {
    expect.assertions(8);
    const consent = await pendingConsent();
    expect((await consent.read()).state).not.toBe('exchanging');
    const refresh = `synthetic-refresh-${randomUUID()}`;
    let requests = 0;
    const fetch: FetchLike = async () => {
      requests += 1;
      return new Response(JSON.stringify({ refresh_token: refresh }), { status: 200 });
    };
    const out: string[] = []; const err: string[] = [];
    const code = await runSpApiConnectionsCli(['--once'], { env, fetch, log: (line) => out.push(line), error: (line) => err.push(line) });
    expect(code).toBe(0);
    expect(requests).toBe(1);
    expect(await consent.read()).toMatchObject({ state: 'completed', reason: null, attachedBindings: 1 });
    const pass = out.map((line) => JSON.parse(line) as Record<string, unknown>).find(({ event }) => event === 'spapi_connection_pass');
    expect(pass).toMatchObject({ outcome: 'observed', state: 'completed', reason: null });
    expect(err).toHaveLength(0);
    for (const value of [refresh, consent.code]) expect([...out, ...err].join('\n')).not.toContain(value);
  });

  it('--once stopped during a pending exchange settles custody as exchange_uncertain and exits 0', async () => {
    expect.assertions(6);
    const consent = await pendingConsent();
    const stop = new AbortController();
    let requested: () => void = () => {};
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const fetch: FetchLike = () => { requested(); return new Promise<Response>(() => {}); };
    const out: string[] = []; const err: string[] = [];
    const done = runSpApiConnectionsCli(['--once'], { env, fetch, stop: stop.signal,
      log: (line) => out.push(line), error: (line) => err.push(line) });
    await started;
    stop.abort();
    expect(await done).toBe(0);
    expect(await consent.read()).toMatchObject({ state: 'reconnect_required', reason: 'exchange_uncertain', attachedBindings: 0 });
    const pass = out.map((line) => JSON.parse(line) as Record<string, unknown>).find(({ event }) => event === 'spapi_connection_pass');
    expect(pass).toMatchObject({ outcome: 'observed', state: 'reconnect_required', reason: 'exchange_uncertain' });
    expect(err).toHaveLength(0);
    for (const value of [consent.code, SECRET]) expect([...out, ...err].join('\n')).not.toContain(value);
  });

  it('a repeated SIGTERM while a pass is blocked is logged and ignored; custody settles and the process exits 0', async () => {
    expect.assertions(9);
    const consent = await pendingConsent();
    // Block the command's first claim behind an exclusive lock on the consent table.
    const gate = createDb({ connectionString: database.connectionString, max: 1 });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked: () => void = () => {};
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const lock = gate.sql.begin(async (sql) => {
      await sql`lock table app.spapi_connection_operations in access exclusive mode`;
      locked();
      await released;
    });
    await holding;
    // The package script runs the command through the tsx CLI, which relays signals.
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const child = spawn(process.execPath, [tsxCli, cliPath], { env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += String(data); });
    child.stderr.on('data', (data) => { stderr += String(data); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      await until(async () => {
        const [row] = await database.sql<{ waiting: number }[]>`
          select count(*)::int as waiting from pg_catalog.pg_locks
           where not granted and relation = 'app.spapi_connection_operations'::regclass`;
        return (row?.waiting ?? 0) > 0;
      }, 'the command to block on the consent table');
      child.kill('SIGTERM');
      await until(() => stdout.includes('"stop_requested"'), 'the first signal');
      child.kill('SIGTERM');
      await until(() => stdout.includes('"signal_repeated"'), 'the repeated signal');
    } finally {
      release();
      await lock;
      await gate.close();
    }
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stdout).toContain('"stop_requested"');
    expect(stdout).toContain('"signal_repeated"');
    expect(stdout).toContain('"spapi_connection_command_stopped"');
    const settled = await consent.read();
    expect(settled.state).not.toBe('exchanging');
    // Either the claim timed out on the lock (consent untouched) or it took
    // custody after the stop and settled it without calling the provider.
    expect(['reconnect_required', 'queued'].includes(settled.state)).toBe(true);
    for (const value of [consent.code, SECRET, database.connectionString]) expect(stdout + stderr).not.toContain(value);
  }, 45_000);
});

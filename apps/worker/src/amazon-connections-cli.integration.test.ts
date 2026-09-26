/**
 * The connection-only Amazon Ads command (WP-330) against a real, migrated
 * Postgres.
 *
 * Isolation: the database holds exactly what the general worker would act on
 * at startup (due queued jobs, a stale claim the reaper would requeue, and
 * profiles the schedule provisioner would provision), and the command must
 * leave every one of them untouched.
 *
 * Exchange: a pending consent is exchanged and discovered through an injected
 * transport, interrupted, and interrupted by repeated signals, and custody
 * always settles.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beginAmazonConnection, createAdsConnectionLifecycle, createDb, submitAmazonConnection } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAmazonConnectionsCli } from './amazon-connections-cli.js';
import { PostgresWorkerStore } from './store.js';

const available = await databaseAvailable();
const USER = '66666666-6666-4666-8666-666666666666';
const SECRET = ['synthetic', 'lwa', 'application', 'key'].join('-');
const CLIENT_ID = 'synthetic-ads-client';
const CALLBACK = 'https://example.test/api/amazon/oauth/callback';
const SCOPE = 'advertising::campaign_management';
const QUEUED_JOBS = 3;
const cliPath = fileURLToPath(new URL('./amazon-connections-cli.ts', import.meta.url));

function commandEnv(database: TestDatabase): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: database.connectionString,
    OPENSPELL_AMAZON_CONNECTIONS_ENABLED: '1',
    LWA_CLIENT_ID: CLIENT_ID,
    LWA_CLIENT_SECRET: SECRET,
    AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: CALLBACK,
  };
}

/** The command as a separate process; no WORKER_ variable or Ads alias leaks in from the test runner. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of Object.keys(merged)) {
    if (name.startsWith('WORKER_') || ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_OAUTH_REDIRECT_URI'].includes(name)) {
      delete merged[name];
    }
  }
  return merged;
}

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!available)('Amazon Ads connection command isolation (real Postgres)', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileIds: string[];
  let seededIds: { queued: string[]; stale: string };
  let env: NodeJS.ProcessEnv;
  let baseline: Record<string, unknown>[];
  let connections: number;

  const jobs = async (): Promise<Record<string, unknown>[]> =>
    [...await database.sql<Record<string, unknown>[]>`select * from public.sync_jobs order by id`];
  const count = async (table: 'public.sync_schedules' | 'app.amazon_connection_operations' | 'public.ads_connections'): Promise<number> => {
    const [row] = await database.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
    return row?.n ?? -1;
  };
  const unscheduled = async (): Promise<string[]> =>
    (await new PostgresWorkerStore(database).unscheduledProfiles())
      .filter((profile) => profile.orgId === orgId).map((profile) => profile.profileId).sort();

  async function expectUntouched(): Promise<void> {
    expect(await jobs()).toEqual(baseline);
    expect(await count('public.sync_schedules')).toBe(0);
    expect(await count('app.amazon_connection_operations')).toBe(0);
    expect(await count('public.ads_connections')).toBe(connections);
    expect(await unscheduled()).toEqual(profileIds);
  }

  beforeAll(async () => {
    database = await createTestDatabase('amazon_cli');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('amazon-cli', ${USER}, 'owner')`;
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
          ${`amazon-cli-queued-${index}`}, now() - interval '1 hour')
        returning id`;
      queued.push(row!.id);
    }
    // A stale claim: StaleClaimReaper would requeue it on its first pass.
    const [stale] = await database.sql<{ id: string }[]>`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key, status,
        attempts, claimed_by, claimed_at, started_at, run_after)
      values (${orgId}, ${profileId}, 'entity.sync', ${payload}::jsonb,
        'amazon-cli-stale', 'running', 1, 'departed-worker', now() - interval '2 hours',
        now() - interval '2 hours', now() - interval '3 hours')
      returning id`;
    seededIds = { queued: queued.sort(), stale: stale!.id };
    baseline = await jobs();
    connections = await count('public.ads_connections');
    env = commandEnv(database);
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  it('seeds work the general worker would act on', async () => {
    expect.assertions(7);
    expect(profileIds.length).toBeGreaterThan(0);
    const seeded = baseline.filter((job) => String(job['dedupe_key']).startsWith('amazon-cli-'));
    expect(seeded).toHaveLength(QUEUED_JOBS + 1);
    expect(seeded.filter((job) => job['status'] === 'queued')).toHaveLength(QUEUED_JOBS);
    expect(seeded.filter((job) => job['status'] === 'running')).toHaveLength(1);
    // The snapshot compares whole rows, every column of sync_jobs.
    expect(Object.keys(baseline[0]!).length).toBeGreaterThanOrEqual(19);
    expect(await count('public.sync_schedules')).toBe(0);
    expect(await unscheduled()).toEqual(profileIds);
  });

  it('--once runs one idle pass and changes nothing', async () => {
    expect.assertions(9);
    const out: string[] = []; const err: string[] = [];
    const code = await runAmazonConnectionsCli(['--once'], { env, log: (line) => out.push(line), error: (line) => err.push(line) });
    expect(code).toBe(0);
    expect(err).toHaveLength(0);
    expect(out.map((line) => JSON.parse(line) as Record<string, string>).map(({ event, outcome }) => ({ event, outcome })))
      .toEqual([{ event: 'amazon_connection_command_started', outcome: undefined },
        { event: 'amazon_connection_pass', outcome: 'idle' }]);
    expect(out.join('\n')).not.toContain(database.connectionString);
    await expectUntouched();
  });

  it('a bounded loop run heartbeats, stops on the stop signal and changes nothing', async () => {
    expect.assertions(10);
    const out: string[] = []; const err: string[] = [];
    const stop = new AbortController();
    // Every clock read advances five minutes, so each pass also emits a heartbeat.
    let reads = 0;
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + (reads++) * 300_000);
    const heartbeats = () => out.filter((line) => line.includes('"amazon_connection_heartbeat"')).length;
    const done = runAmazonConnectionsCli([], { env, stop: stop.signal, now,
      log: (line) => out.push(line), error: (line) => err.push(line) });
    await until(() => heartbeats() >= 2, 'two passes');
    stop.abort();
    expect(await done).toBe(0);
    expect(err).toHaveLength(0);
    const events = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    // Idle passes after the first are not logged individually.
    expect(events.filter(({ event }) => event === 'amazon_connection_pass')).toEqual([expect.objectContaining({ outcome: 'idle' })]);
    expect(events.filter(({ event }) => event === 'amazon_connection_heartbeat').every(({ passes }) => passes === 1)).toBe(true);
    expect([events[0]?.['event'], events.at(-1)?.['event']])
      .toEqual(['amazon_connection_command_started', 'amazon_connection_command_stopped']);
    await expectUntouched();
  }, 20_000);

  it('the command process exits 0 on SIGTERM and never logs a secret or the database URL', async () => {
    expect.assertions(10);
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath], { env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += String(data); });
    child.stderr.on('data', (data) => { stderr += String(data); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    await until(() => stdout.includes('"amazon_connection_pass"'), 'a pass outcome');
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(stdout).toContain('"stop_requested"');
    expect(stdout).toContain('"amazon_connection_command_stopped"');
    expect(stdout + stderr).not.toContain(database.connectionString);
    expect(stdout + stderr).not.toContain(SECRET);
    await expectUntouched();
  }, 30_000);

  // Positive control, last because it mutates the seed: the general worker's
  // queue claim, reaper and provisioner do act on exactly this state.
  it('the seeded state is live work for the general worker', async () => {
    expect.assertions(4);
    const store = new PostgresWorkerStore(database);
    const claimed = await store.claim('amazon-cli-control', 50);
    expect(claimed.map((job) => job.id).filter((id) => seededIds.queued.includes(id)).sort()).toEqual(seededIds.queued);
    expect(await store.requeueStale('30 minutes')).toBe(1);
    expect(await store.provisionSchedules(orgId, profileIds[0]!)).toBeGreaterThan(0);
    expect(await count('public.sync_schedules')).toBeGreaterThan(0);
  });
});

describe.skipIf(!available)('Amazon Ads connection command exchange (real Postgres)', () => {
  let database: TestDatabase;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    database = await createTestDatabase('amazon_cli_exchange');
    env = commandEnv(database);
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  /** One submitted consent for a new agency, as the web callback leaves it. */
  async function pendingConsent() {
    const userId = randomUUID();
    await database.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await database.sql<{ id: string }[]>`
      insert into public.orgs(slug,name) values (${randomUUID()},'Synthetic ads agency') returning id`;
    const actor = { orgId: org!.id, userId };
    await database.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${userId},'owner')`;
    const nonceHash = 'c'.repeat(64);
    const started = await beginAmazonConnection(database, actor,
      { requestId: randomUUID(), nonceHash, clientId: CLIENT_ID, redirectUri: CALLBACK, scope: SCOPE });
    const code = ['synthetic', randomUUID(), 'consent'].join('-');
    await submitAmazonConnection(database, actor, { operationId: started.operationId, nonceHash, code });
    const read = () => createAdsConnectionLifecycle(database).custody.read(started.operationId);
    return { orgId: actor.orgId, operationId: started.operationId, code, read };
  }

  async function runOnce(fetch: typeof globalThis.fetch, stop?: AbortSignal) {
    const out: string[] = []; const err: string[] = [];
    const code = await runAmazonConnectionsCli(['--once'], { env, fetch, log: (line) => out.push(line), error: (line) => err.push(line),
      ...(stop === undefined ? {} : { stop }) });
    const pass = out.map((line) => JSON.parse(line) as Record<string, unknown>).find(({ event }) => event === 'amazon_connection_pass');
    return { code, out, err, pass, all: [...out, ...err].join('\n') };
  }

  it('--once exchanges a pending consent through an injected transport, and the next --once discovers every region', async () => {
    expect.assertions(22);
    const consent = await pendingConsent();
    expect((await consent.read()).state).toBe('queued');
    const refresh = ['synthetic', randomUUID(), 'grant'].join('-');
    const access = ['synthetic', randomUUID(), 'access'].join('-');
    const grants: string[] = [];
    const profileHosts: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.href === 'https://api.amazon.com/auth/o2/token') {
        const grant = new URLSearchParams(String(init?.body)).get('grant_type') ?? 'none';
        grants.push(grant);
        return Response.json(grant === 'authorization_code'
          ? { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'bearer' }
          : { access_token: access, expires_in: 3600, token_type: 'bearer' });
      }
      if (url.pathname === '/v2/profiles') {
        profileHosts.push(url.hostname);
        const region = url.hostname.includes('-eu') ? 'EU' : url.hostname.includes('-fe') ? 'FE' : 'NA';
        return Response.json([{ profileId: `9${profileHosts.length}000`, countryCode: region === 'EU' ? 'DE' : region === 'FE' ? 'JP' : 'US',
          currencyCode: region === 'EU' ? 'EUR' : region === 'FE' ? 'JPY' : 'USD', timezone: 'UTC',
          accountInfo: { type: 'seller', name: 'Synthetic advertiser', id: `SYNTHETIC${profileHosts.length}` } }]);
      }
      throw new Error('Unmapped synthetic provider request');
    };

    const exchanged = await runOnce(fetch);
    expect(exchanged.code).toBe(0);
    expect(exchanged.err).toHaveLength(0);
    expect(grants).toEqual(['authorization_code']);
    expect(profileHosts).toHaveLength(0);
    expect(exchanged.pass).toMatchObject({ outcome: 'observed', state: 'discovering', reason: null });
    expect(await consent.read()).toMatchObject({ state: 'discovering' });

    const discovered = await runOnce(fetch);
    expect(discovered.code).toBe(0);
    expect(discovered.err).toHaveLength(0);
    // The authorization code is exchanged exactly once; discovery only refreshes.
    expect(grants.filter((grant) => grant === 'authorization_code')).toHaveLength(1);
    expect(profileHosts.sort()).toEqual(['advertising-api-eu.amazon.com', 'advertising-api-fe.amazon.com', 'advertising-api.amazon.com']);
    expect(discovered.pass).toMatchObject({ outcome: 'observed', state: 'completed' });
    const settled = await consent.read();
    expect(settled).toMatchObject({ state: 'completed' });
    expect(settled.regions.map((region) => [region.region, region.state, region.received, region.upserted]))
      .toEqual([['NA', 'completed', 1, 1], ['EU', 'completed', 1, 1], ['FE', 'completed', 1, 1]]);
    expect(await database.sql`select id from public.ad_profiles where org_id = ${consent.orgId}`).toHaveLength(3);
    expect(await database.sql`select id from public.ads_connections where org_id = ${consent.orgId}`).toHaveLength(1);
    // The command enqueues and provisions nothing: the first entity sync belongs to the cron tick.
    expect(await database.sql`select id from public.sync_jobs where org_id = ${consent.orgId}`).toHaveLength(0);
    expect(await database.sql`select id from public.sync_schedules where org_id = ${consent.orgId}`).toHaveLength(0);
    for (const value of [refresh, access, consent.code, SECRET]) {
      expect([exchanged.all, discovered.all].join('\n')).not.toContain(value);
    }
  });

  it('--once stopped during a pending exchange settles custody as exchange_uncertain and exits 0', async () => {
    expect.assertions(7);
    const consent = await pendingConsent();
    const stop = new AbortController();
    let requested: () => void = () => {};
    const started = new Promise<void>((resolve) => { requested = resolve; });
    let requests = 0;
    const fetch: typeof globalThis.fetch = (_input, init) => {
      requests += 1;
      requested();
      // Honour the abort, as the platform fetch does.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    const done = runOnce(fetch, stop.signal);
    await started;
    stop.abort();
    const result = await done;
    expect(result.code).toBe(0);
    expect(requests).toBe(1);
    expect(await consent.read()).toMatchObject({ state: 'reconnect_required', reason: 'exchange_uncertain' });
    expect(result.pass).toMatchObject({ outcome: 'observed', state: 'reconnect_required', reason: 'exchange_uncertain' });
    expect(result.err).toHaveLength(0);
    for (const value of [consent.code, SECRET]) expect(result.all).not.toContain(value);
  });

  it('a repeated SIGTERM while a pass is blocked is logged and ignored; custody settles and the process exits 0', async () => {
    expect.assertions(9);
    const consent = await pendingConsent();
    // Block the command's first claim behind an exclusive lock on the operation table.
    const gate = createDb({ connectionString: database.connectionString, max: 1 });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked: () => void = () => {};
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const lock = gate.sql.begin(async (sql) => {
      await sql`lock table app.amazon_connection_operations in access exclusive mode`;
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
           where not granted and relation = 'app.amazon_connection_operations'::regclass`;
        return (row?.waiting ?? 0) > 0;
      }, 'the command to block on the operation table');
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
    expect(stdout).toContain('"amazon_connection_command_stopped"');
    const settled = await consent.read();
    expect(settled.state).not.toBe('exchanging');
    // The claim was already waiting on the lock when the stop arrived: it takes
    // custody after the stop and settles it without a provider response.
    expect(settled).toMatchObject({ state: 'reconnect_required', reason: 'exchange_uncertain' });
    for (const value of [consent.code, SECRET, database.connectionString]) expect(stdout + stderr).not.toContain(value);
  }, 45_000);
});

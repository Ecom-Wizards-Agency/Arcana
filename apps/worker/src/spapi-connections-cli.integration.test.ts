/**
 * Isolation proof for the connection-only SP-API command (WP-326) against a
 * real, migrated Postgres. The database holds exactly what the general worker
 * would act on at startup: due queued jobs, a stale claim the reaper would
 * requeue, and profiles the schedule provisioner would provision. The command
 * must leave every one of them untouched.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSpApiConnectionsCli } from './spapi-connections-cli.js';
import { PostgresWorkerStore } from './store.js';

const available = await databaseAvailable();
const USER = '77777777-7777-4777-8777-777777777777';
const SECRET = ['synthetic', 'lwa', 'application', 'key'].join('-');
const QUEUED_JOBS = 3;

interface JobSnapshot {
  id: string; dedupe_key: string | null; status: string; attempts: number; claimed_by: string | null;
  claimed_at: string | null; run_after: string; updated_at: string;
}

describe.skipIf(!available)('SP-API connection command isolation (real Postgres)', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileIds: string[];
  let env: NodeJS.ProcessEnv;
  let baseline: JobSnapshot[];

  const jobs = () => database.sql<JobSnapshot[]>`
    select id, dedupe_key, status::text, attempts, claimed_by, claimed_at::text, run_after::text, updated_at::text
      from public.sync_jobs order by id`;
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
    for (let index = 0; index < QUEUED_JOBS; index += 1) {
      await database.sql`
        insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key, run_after)
        values (${orgId}, ${profileId}, 'entity.sync',
          ${JSON.stringify({ type: 'entity.sync', orgId, profileId, full: false })}::jsonb,
          ${`spapi-cli-queued-${index}`}, now() - interval '1 hour')`;
    }
    // A stale claim: StaleClaimReaper would requeue it on its first pass.
    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key, status,
        attempts, claimed_by, claimed_at, started_at, run_after)
      values (${orgId}, ${profileId}, 'entity.sync',
        ${JSON.stringify({ type: 'entity.sync', orgId, profileId, full: false })}::jsonb,
        'spapi-cli-stale', 'running', 1, 'departed-worker', now() - interval '2 hours',
        now() - interval '2 hours', now() - interval '3 hours')`;
    baseline = await jobs();
    env = {
      DATABASE_URL: database.connectionString,
      OPENSPELL_SPAPI_CONNECTIONS_ENABLED: '1',
      SP_API_LWA_CLIENT_ID: 'synthetic-client',
      SP_API_LWA_CLIENT_SECRET: SECRET,
      SP_API_APPLICATION_ID: 'synthetic-application',
      SP_API_OAUTH_REGION: 'NA',
      SP_API_OAUTH_ALLOWED_REDIRECT_URIS: 'https://app.example.test/api/amazon/spapi/oauth/callback',
    };
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  it('seeds work the general worker would act on', async () => {
    expect.assertions(6);
    expect(profileIds.length).toBeGreaterThan(0);
    const seeded = baseline.filter((job) => job.dedupe_key?.startsWith('spapi-cli-'));
    expect(seeded).toHaveLength(QUEUED_JOBS + 1);
    expect(seeded.filter((job) => job.status === 'queued')).toHaveLength(QUEUED_JOBS);
    expect(seeded.filter((job) => job.status === 'running')).toHaveLength(1);
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
      .toEqual([{ event: 'spapi_connection_pass', outcome: 'idle' }]);
    expect(out.join('\n')).not.toContain(database.connectionString);
    await expectUntouched();
  });

  it('a bounded loop run stops on the stop signal and changes nothing', async () => {
    expect.assertions(8);
    const out: string[] = []; const err: string[] = [];
    const stop = new AbortController();
    const passes = () => out.filter((line) => line.includes('"spapi_connection_pass"')).length;
    const done = runSpApiConnectionsCli([], { env, stop: stop.signal, log: (line) => out.push(line), error: (line) => err.push(line) });
    const deadline = Date.now() + 10_000;
    while (passes() < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    expect(await done).toBe(0);
    expect(err).toHaveLength(0);
    const events = out.map((line) => JSON.parse(line) as Record<string, string>);
    expect(events.filter(({ event, outcome }) => event === 'spapi_connection_pass' && outcome === 'idle').length)
      .toBeGreaterThanOrEqual(2);
    expect([events[0]?.event, events.at(-1)?.event])
      .toEqual(['spapi_connection_command_started', 'spapi_connection_command_stopped']);
    await expectUntouched();
  }, 20_000);

  it('the command process exits 0 on SIGTERM and never logs a secret or the database URL', async () => {
    expect.assertions(8);
    const cli = fileURLToPath(new URL('./spapi-connections-cli.ts', import.meta.url));
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv['WORKER_JOB_TYPES'];
    delete childEnv['WORKER_DEPLOYMENT_ROLE'];
    const child = spawn(process.execPath, ['--import', 'tsx', cli], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stderr.on('data', (data) => { stderr += String(data); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('command produced no pass outcome')), 15_000);
      child.stdout.on('data', (data) => {
        stdout += String(data);
        if (stdout.includes('"spapi_connection_pass"')) { clearTimeout(timer); resolve(); }
      });
      child.once('error', reject);
    });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(stdout).toContain('"spapi_connection_command_stopped"');
    expect(stdout + stderr).not.toContain(database.connectionString);
    expect(stdout + stderr).not.toContain(SECRET);
    await expectUntouched();
  }, 30_000);

  // Positive control, last because it mutates the seed: the general worker's
  // reaper and provisioner do act on exactly this state.
  it('the seeded state is live work for the general worker passes', async () => {
    expect.assertions(3);
    const store = new PostgresWorkerStore(database);
    expect(await store.requeueStale('30 minutes')).toBe(1);
    expect(await store.provisionSchedules(orgId, profileIds[0]!)).toBeGreaterThan(0);
    expect(await count('public.sync_schedules')).toBeGreaterThan(0);
  });
});

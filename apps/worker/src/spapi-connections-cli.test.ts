import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SPAPI_CONNECTIONS_HEARTBEAT_MS,
  SPAPI_CONNECTIONS_REQUIRED_ENV,
  SpApiConnectionPassReporter,
  parseSpApiConnectionsArgs,
  runSpApiConnectionsCli,
  spApiConnectionsConfigFromEnv,
} from './spapi-connections-cli.js';

const SECRET = ['synthetic', 'lwa', 'application', 'key'].join('-');
const CALLBACK = 'https://app.example.test/api/amazon/spapi/oauth/callback';
// Loopback port 1 refuses connections, so no test here reaches a database.
const UNREACHABLE_DATABASE = 'postgres://synthetic-user:synthetic-password@127.0.0.1:1/synthetic';
const valid: NodeJS.ProcessEnv = {
  DATABASE_URL: UNREACHABLE_DATABASE,
  OPENSPELL_SPAPI_CONNECTIONS_ENABLED: '1',
  SP_API_LWA_CLIENT_ID: 'synthetic-client-7f3a',
  SP_API_LWA_CLIENT_SECRET: SECRET,
  SP_API_APPLICATION_ID: 'synthetic-application',
  SP_API_OAUTH_REGION: 'NA',
  SP_API_OAUTH_ALLOWED_REDIRECT_URIS: `${CALLBACK},https://app.example.test/second/callback`,
};

async function run(args: readonly string[], env: NodeJS.ProcessEnv, stop?: AbortSignal) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSpApiConnectionsCli(args, { env, log: (line) => out.push(line), error: (line) => err.push(line),
    ...(stop === undefined ? {} : { stop }) });
  const events = out.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, out, err, events, all: [...out, ...err].join('\n') };
}

describe('SP-API connection command environment', () => {
  it('accepts the documented environment without any ADS_* variable or job type', () => {
    const config = spApiConnectionsConfigFromEnv(valid);
    expect(config.databaseUrl).toBe(UNREACHABLE_DATABASE);
    expect(config.settings).toMatchObject({ spApiClientId: 'synthetic-client-7f3a', spApiApplicationId: 'synthetic-application',
      spApiConsentRegion: 'NA', spApiConnectionRedirects: [CALLBACK, 'https://app.example.test/second/callback'] });
    expect(Object.keys(valid).filter((name) => name.startsWith('ADS_') || name.startsWith('WORKER_'))).toHaveLength(0);
  });

  it('names each missing variable, exits non-zero and never contacts the database', async () => {
    expect(SPAPI_CONNECTIONS_REQUIRED_ENV).toHaveLength(7);
    for (const name of SPAPI_CONNECTIONS_REQUIRED_ENV) {
      for (const absent of [undefined, '  ']) {
        const result = await run([], { ...valid, [name]: absent });
        expect(result.code).toBe(1);
        expect(result.err).toEqual([`Missing required environment: ${name}`]);
        expect(result.out).toHaveLength(0);
        expect(result.all).not.toContain(SECRET);
      }
    }
  });

  it('refuses a job-runtime selector because it runs no jobs', async () => {
    const cases = [
      [{ WORKER_JOB_TYPES: 'entity.sync' }, 'WORKER_JOB_TYPES must be unset: this command runs no jobs'],
      [{ WORKER_DEPLOYMENT_ROLE: 'general' }, 'WORKER_DEPLOYMENT_ROLE must be unset: this command runs no jobs'],
      [{ WORKER_JOB_TYPES: '', WORKER_DEPLOYMENT_ROLE: 'evo-report-lane' },
        'WORKER_DEPLOYMENT_ROLE, WORKER_JOB_TYPES must be unset: this command runs no jobs'],
    ] as const;
    for (const [extra, message] of cases) {
      const result = await run(['--once'], { ...valid, ...extra });
      expect(result).toMatchObject({ code: 1, err: [message], out: [] });
    }
  });

  it('refuses every WORKER_ variable copied from a worker environment, valid or not, without echoing it', async () => {
    const copied = ['WORKER_ID', 'WORKER_HEALTH_HOST', 'WORKER_POLL_INTERVAL_MS', 'WORKER_CLAIM_BATCH_SIZE',
      'WORKER_MAX_CONCURRENT_JOBS', 'WORKER_AUTH_HEALTHCHECK_MINUTES', 'WORKER_STALE_CLAIM_AFTER', 'WORKER_REPORT_STALE_HOURS'];
    expect(copied).toHaveLength(8);
    for (const name of copied) {
      for (const value of ['1', 'synthetic-copied-value']) {
        const result = await run([], { ...valid, [name]: value });
        expect(result).toMatchObject({ code: 1, err: [`${name} must be unset: this command runs no jobs`], out: [] });
        expect(result.all).not.toContain('synthetic-copied-value');
      }
    }
  });

  it('names a malformed field without echoing its value', async () => {
    const cases = [
      [{ OPENSPELL_SPAPI_CONNECTIONS_ENABLED: 'true' }, /^OPENSPELL_SPAPI_CONNECTIONS_ENABLED must be exactly 1$/, 'true'],
      [{ SP_API_OAUTH_REGION: 'synthetic-region' }, /^SP_API_OAUTH_REGION must be NA, EU or FE$/, 'synthetic-region'],
      [{ SP_API_OAUTH_ALLOWED_REDIRECT_URIS: ' , ' }, /^SP_API_OAUTH_ALLOWED_REDIRECT_URIS must list/, null],
      [{ SP_API_OAUTH_ALLOWED_REDIRECT_URIS: 'https://synthetic-user:synthetic-pass@app.example.test/callback' },
        /^Invalid environment: SP-API connection callback policy is invalid$/, 'synthetic-pass'],
      // The worker parser reports a bad application id as the callback policy, not by name.
      [{ SP_API_APPLICATION_ID: 'synthetic-application-'.repeat(20) },
        /^Invalid environment: SP-API connection callback policy is invalid$/, 'synthetic-application-synthetic'],
      [{ PORT: 'synthetic-port' }, /^Invalid environment: PORT must be a positive integer$/, 'synthetic-port'],
    ] as const;
    for (const [extra, message, value] of cases) {
      const result = await run([], { ...valid, ...extra });
      expect(result.code).toBe(1);
      expect(result.err).toHaveLength(1);
      expect(result.err[0]).toMatch(message);
      if (value !== null) expect(result.all).not.toContain(value);
      expect(result.all).not.toContain(SECRET);
    }
  });

  it('accepts only --once as an argument', () => {
    expect(parseSpApiConnectionsArgs([])).toEqual({ once: false });
    expect(parseSpApiConnectionsArgs(['--once'])).toEqual({ once: true });
    expect(() => parseSpApiConnectionsArgs(['--once', '--once'])).toThrow(/usage/);
    expect(() => parseSpApiConnectionsArgs(['--loop'])).toThrow(/usage/);
  });
});

describe('SP-API connection command runtime without a database', () => {
  it('logs a startup line with the deployment identity and never the secret or database URL', async () => {
    const result = await run(['--once'], valid);
    expect(result.events).toHaveLength(2);
    const [started] = result.events;
    expect(Object.keys(started!).sort()).toEqual(['applicationId', 'at', 'clientIdSuffix', 'event', 'mode', 'redirectUris', 'region']);
    expect(started).toMatchObject({ event: 'spapi_connection_command_started', mode: 'once',
      applicationId: 'synthetic-application', region: 'NA', redirectUris: 2, clientIdSuffix: '7f3a' });
    for (const value of [SECRET, 'synthetic-password', '127.0.0.1', UNREACHABLE_DATABASE, 'synthetic-client-']) {
      expect(result.all).not.toContain(value);
    }
  });

  it('--once reports an unreachable database as an uncertain pass and exits 1', async () => {
    const result = await run(['--once'], valid);
    expect(result.code).toBe(1);
    const pass = result.events[1]!;
    expect(Object.keys(pass).sort()).toEqual(['at', 'event', 'outcome']);
    expect(pass).toMatchObject({ event: 'spapi_connection_pass', outcome: 'uncertain' });
    expect(Number.isNaN(Date.parse(String(pass['at'])))).toBe(false);
  });

  it('loop mode exits 1 when its first pass is uncertain, so a supervisor restarts it', async () => {
    const never = new AbortController();
    const result = await run([], valid, never.signal);
    expect(result.code).toBe(1);
    expect(result.err).toHaveLength(0);
    expect(result.events.map(({ event, outcome, reason }) => ({ event, outcome, reason }))).toEqual([
      { event: 'spapi_connection_command_started', outcome: undefined, reason: undefined },
      { event: 'spapi_connection_pass', outcome: 'uncertain', reason: undefined },
      { event: 'spapi_connection_command_failed', outcome: undefined, reason: 'first_pass_uncertain' },
    ]);
    expect(result.all).not.toContain('synthetic-password');
  });
});

describe('SP-API connection pass reporting', () => {
  const idle = { outcome: 'idle' as const, operation: null };
  const uncertain = { outcome: 'uncertain' as const, operation: null };

  it('logs changes and every non-idle pass, and a heartbeat with the pass count at most every five minutes', () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const reporter = new SpApiConnectionPassReporter((event, fields = {}) => lines.push({ event, fields }), () => new Date(clock));
    expect(SPAPI_CONNECTIONS_HEARTBEAT_MS).toBe(300_000);
    // 299 idle passes one second apart: only the first is a change.
    for (let pass = 0; pass < 299; pass += 1) { clock += 1_000; reporter.report(idle); }
    expect(lines).toEqual([{ event: 'spapi_connection_pass', fields: { outcome: 'idle' } }]);
    clock += 1_000; reporter.report(idle);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ event: 'spapi_connection_heartbeat', fields: { passes: 300 } });
    clock += 1_000; reporter.report(uncertain);
    clock += 1_000; reporter.report(uncertain);
    clock += 1_000; reporter.report(idle);
    clock += 1_000; reporter.report(idle);
    expect(lines.slice(2).map(({ fields }) => fields['outcome'])).toEqual(['uncertain', 'uncertain', 'idle']);
    // The next heartbeat counts passes since the previous one, not since start.
    for (let pass = 0; pass < 296; pass += 1) { clock += 1_000; reporter.report(idle); }
    expect(lines.at(-1)).toEqual({ event: 'spapi_connection_heartbeat', fields: { passes: 300 } });
    expect(lines).toHaveLength(6);
  });

  it('logs the settled state and reason of an observed pass', () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const reporter = new SpApiConnectionPassReporter((event, fields = {}) => lines.push({ event, fields }), () => new Date(0));
    reporter.report({ outcome: 'observed', operation: { operationId: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222', connectionId: null, state: 'reconnect_required',
      reason: 'exchange_uncertain', requestedBindings: 1, attachedBindings: 0,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } });
    reporter.report(idle, true);
    reporter.report(idle, true);
    expect(lines).toEqual([
      { event: 'spapi_connection_pass', fields: { outcome: 'observed', state: 'reconnect_required', reason: 'exchange_uncertain' } },
      { event: 'spapi_connection_pass', fields: { outcome: 'idle' } },
      { event: 'spapi_connection_pass', fields: { outcome: 'idle' } },
    ]);
  });
});

describe('SP-API connection command composition', () => {
  it('shares the general worker wiring and starts nothing else', () => {
    const cli = readFileSync(new URL('./spapi-connections-cli.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toContain('new ProviderConnectionLoop(spApiConnectionPass(handle, config))');
    expect(cli).toContain('spApiConnectionPass(handle, config.settings, env, options.fetch)');
    expect(cli).toContain('new ProviderConnectionLoop(async (signal) => {');
    // The entry point never injects a transport and never uses one-shot signal handlers.
    expect(cli).toContain('runSpApiConnectionsCli(process.argv.slice(2), { stop: controller.signal })');
    expect(cli).not.toContain('process.once');
    const forbidden = ['SyncWorker', 'startHealthServer', 'StaleClaimReaper', 'ScheduleProvisioner',
      'RecommendationObservationPass', 'BidSeriesSyncPass', 'AuthHealthMonitor', 'createCreativeSyncProducer',
      'createMarketingStreamSqsConsumer', 'AmazonConnectionLoop', 'startSpWritePolling', 'WorkerUnifiedDualRun',
      'PostgresWorkerStore', "from './worker.js'"];
    expect(forbidden).toHaveLength(14);
    for (const name of forbidden) expect(cli).not.toContain(name);
  });
});

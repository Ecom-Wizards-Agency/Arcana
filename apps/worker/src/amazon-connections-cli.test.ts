import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AMAZON_CONNECTIONS_HEARTBEAT_MS,
  AMAZON_CONNECTIONS_REFUSED_ALIASES,
  AMAZON_CONNECTIONS_REQUIRED_ENV,
  AmazonConnectionPassReporter,
  amazonConnectionsConfigFromEnv,
  parseAmazonConnectionsArgs,
  runAmazonConnectionsCli,
} from './amazon-connections-cli.js';
import { amazonConnectionPass } from './amazon-connections.js';

const SECRET = ['synthetic', 'lwa', 'application', 'key'].join('-');
const CALLBACK = 'https://app.example.test/api/amazon/oauth/callback';
// Loopback port 1 refuses connections, so no test here reaches a database.
const UNREACHABLE_DATABASE = 'postgres://synthetic-user:synthetic-password@127.0.0.1:1/synthetic';
const valid: NodeJS.ProcessEnv = {
  DATABASE_URL: UNREACHABLE_DATABASE,
  OPENSPELL_AMAZON_CONNECTIONS_ENABLED: '1',
  LWA_CLIENT_ID: 'synthetic-client-7f3a',
  LWA_CLIENT_SECRET: SECRET,
  AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: `${CALLBACK},https://app.example.test/second/callback`,
};

async function run(args: readonly string[], env: NodeJS.ProcessEnv, stop?: AbortSignal) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAmazonConnectionsCli(args, { env, log: (line) => out.push(line), error: (line) => err.push(line),
    ...(stop === undefined ? {} : { stop }) });
  const events = out.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, out, err, events, all: [...out, ...err].join('\n') };
}

describe('Amazon Ads connection command environment', () => {
  it('accepts the documented environment without any ADS_*, SP_API_* or WORKER_* variable', () => {
    const config = amazonConnectionsConfigFromEnv(valid);
    expect(config).toEqual({ databaseUrl: UNREACHABLE_DATABASE, settings: { amazonConnectionsEnabled: true },
      identity: { redirectUris: 2, clientIdSuffix: '7f3a' } });
    expect(Object.keys(valid).filter((name) => ['ADS_', 'SP_API_', 'WORKER_'].some((prefix) => name.startsWith(prefix))))
      .toHaveLength(0);
  });

  it('names each missing variable, exits non-zero and never contacts the database', async () => {
    expect(AMAZON_CONNECTIONS_REQUIRED_ENV).toHaveLength(5);
    let checked = 0;
    for (const name of AMAZON_CONNECTIONS_REQUIRED_ENV) {
      for (const absent of [undefined, '  ']) {
        const result = await run([], { ...valid, [name]: absent });
        expect(result.code).toBe(1);
        expect(result.err).toEqual([`Missing required environment: ${name}`]);
        expect(result.out).toHaveLength(0);
        expect(result.all).not.toContain(SECRET);
        checked += 1;
      }
    }
    expect(checked).toBe(10);
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

  it('refuses the fallback names of its settings, set alone or beside the canonical ones, without echoing them', async () => {
    expect(AMAZON_CONNECTIONS_REFUSED_ALIASES).toHaveLength(3);
    const reads = 'this command reads only LWA_CLIENT_ID, LWA_CLIENT_SECRET, AMAZON_OAUTH_ALLOWED_REDIRECT_URIS';
    let checked = 0;
    for (const name of AMAZON_CONNECTIONS_REFUSED_ALIASES) {
      for (const base of [valid, { DATABASE_URL: UNREACHABLE_DATABASE, OPENSPELL_AMAZON_CONNECTIONS_ENABLED: '1' }]) {
        const result = await run(['--once'], { ...base, [name]: 'synthetic-alias-value' });
        expect(result).toMatchObject({ code: 1, err: [`${name} must be unset: ${reads}`], out: [] });
        expect(result.all).not.toContain('synthetic-alias-value');
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });

  it('names a malformed field without echoing its value', async () => {
    const cases = [
      [{ OPENSPELL_AMAZON_CONNECTIONS_ENABLED: 'true' }, /^OPENSPELL_AMAZON_CONNECTIONS_ENABLED must be exactly 1$/, 'true'],
      [{ AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: ' , ' }, /^AMAZON_OAUTH_ALLOWED_REDIRECT_URIS must list at least one callback URI$/, null],
      [{ AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: 'https://synthetic-user:synthetic-pass@app.example.test/callback' },
        /^Invalid environment: Amazon connection callback configuration is invalid$/, 'synthetic-pass'],
      [{ AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: 'http://synthetic-foreign.test/callback' },
        /^Invalid environment: Amazon connection callback configuration is invalid$/, 'synthetic-foreign'],
      [{ AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: `${CALLBACK},` },
        /^AMAZON_OAUTH_ALLOWED_REDIRECT_URIS must not contain an empty entry$/, 'app.example.test'],
      [{ AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: Array.from({ length: 11 }, (_, index) => `${CALLBACK}/synthetic-${index}`).join(',') },
        /^Invalid environment: Amazon connection callback configuration is invalid$/, 'synthetic-10'],
      [{ LWA_CLIENT_ID: 'synthetic-client-'.repeat(20) },
        /^Invalid environment: Amazon connection callback configuration is invalid$/, 'synthetic-client-synthetic'],
      [{ PORT: 'synthetic-port' }, /^Invalid environment: PORT must be a positive integer$/, 'synthetic-port'],
      [{ LWA_CLIENT_ID: 'synthetic-client-7f3a\n' }, /^LWA_CLIENT_ID must not have leading or trailing whitespace$/, 'synthetic-client'],
      [{ LWA_CLIENT_SECRET: ` ${SECRET}` }, /^LWA_CLIENT_SECRET must not have leading or trailing whitespace$/, null],
      [{ LWA_CLIENT_ID: ' synthetic-client-7f3a', LWA_CLIENT_SECRET: `${SECRET} ` },
        /^LWA_CLIENT_ID, LWA_CLIENT_SECRET must not have leading or trailing whitespace$/, 'synthetic-client'],
    ] as const;
    expect(cases).toHaveLength(11);
    for (const [extra, message, value] of cases) {
      const result = await run([], { ...valid, ...extra });
      expect(result.code).toBe(1);
      expect(result.err).toHaveLength(1);
      expect(result.err[0]).toMatch(message);
      expect(result.out).toHaveLength(0);
      if (value !== null) expect(result.all).not.toContain(value);
      expect(result.all).not.toContain(SECRET);
    }
  });

  it('accepts only --once as an argument', () => {
    expect(parseAmazonConnectionsArgs([])).toEqual({ once: false });
    expect(parseAmazonConnectionsArgs(['--once'])).toEqual({ once: true });
    expect(() => parseAmazonConnectionsArgs(['--once', '--once'])).toThrow(/usage/);
    expect(() => parseAmazonConnectionsArgs(['--loop'])).toThrow(/usage/);
  });
});

describe('Amazon Ads connection command runtime without a database', () => {
  it('logs a startup line with the deployment identity and never the secret or database URL', async () => {
    const result = await run(['--once'], valid);
    expect(result.events).toHaveLength(2);
    const [started] = result.events;
    expect(Object.keys(started!).sort()).toEqual(['at', 'clientIdSuffix', 'event', 'mode', 'redirectUris']);
    expect(started).toMatchObject({ event: 'amazon_connection_command_started', mode: 'once',
      redirectUris: 2, clientIdSuffix: '7f3a' });
    for (const value of [SECRET, 'synthetic-password', '127.0.0.1', UNREACHABLE_DATABASE, 'synthetic-client-', CALLBACK]) {
      expect(result.all).not.toContain(value);
    }
  });

  it('--once reports an unreachable database as an unavailable pass and exits 1', async () => {
    const result = await run(['--once'], valid);
    expect(result.code).toBe(1);
    expect(result.err).toHaveLength(0);
    const pass = result.events[1]!;
    expect(Object.keys(pass).sort()).toEqual(['at', 'event', 'outcome']);
    expect(pass).toMatchObject({ event: 'amazon_connection_pass', outcome: 'unavailable' });
    expect(Number.isNaN(Date.parse(String(pass['at'])))).toBe(false);
  });

  it('loop mode exits 1 when its first pass cannot reach custody, so a supervisor restarts it', async () => {
    const never = new AbortController();
    const result = await run([], valid, never.signal);
    expect(result.code).toBe(1);
    expect(result.err).toHaveLength(0);
    expect(result.events.map(({ event, outcome, reason }) => ({ event, outcome, reason }))).toEqual([
      { event: 'amazon_connection_command_started', outcome: undefined, reason: undefined },
      { event: 'amazon_connection_pass', outcome: 'unavailable', reason: undefined },
      { event: 'amazon_connection_command_failed', outcome: undefined, reason: 'first_pass_unavailable' },
    ]);
    expect(result.all).not.toContain('synthetic-password');
  });
});

describe('Amazon Ads connection pass reporting', () => {
  const idle = { outcome: 'idle' as const, operation: null };
  const uncertain = { outcome: 'uncertain' as const, operation: null };
  const unavailable = { outcome: 'unavailable' as const, operation: null };

  it('logs changes and every non-idle pass, and a heartbeat with the pass count at most every five minutes', () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const reporter = new AmazonConnectionPassReporter((event, fields = {}) => lines.push({ event, fields }), () => new Date(clock));
    expect(AMAZON_CONNECTIONS_HEARTBEAT_MS).toBe(300_000);
    // 299 idle passes one second apart: only the first is a change.
    for (let pass = 0; pass < 299; pass += 1) { clock += 1_000; reporter.report(idle); }
    expect(lines).toEqual([{ event: 'amazon_connection_pass', fields: { outcome: 'idle' } }]);
    clock += 1_000; reporter.report(idle);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ event: 'amazon_connection_heartbeat', fields: { passes: 300 } });
    clock += 1_000; reporter.report(uncertain);
    clock += 1_000; reporter.report(unavailable);
    clock += 1_000; reporter.report(idle);
    clock += 1_000; reporter.report(idle);
    expect(lines.slice(2).map(({ fields }) => fields['outcome'])).toEqual(['uncertain', 'unavailable', 'idle']);
    // The next heartbeat counts passes since the previous one, not since start.
    for (let pass = 0; pass < 296; pass += 1) { clock += 1_000; reporter.report(idle); }
    expect(lines.at(-1)).toEqual({ event: 'amazon_connection_heartbeat', fields: { passes: 300 } });
    expect(lines).toHaveLength(6);
  });

  it('logs the settled state and reason of an observed pass', () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const reporter = new AmazonConnectionPassReporter((event, fields = {}) => lines.push({ event, fields }), () => new Date(0));
    const operation = { state: 'reconnect_required', reason: 'exchange_uncertain' } as unknown as
      Extract<Parameters<AmazonConnectionPassReporter['report']>[0], { outcome: 'observed' }>['operation'];
    reporter.report({ outcome: 'observed', operation });
    reporter.report(idle, true);
    reporter.report(idle, true);
    expect(lines).toEqual([
      { event: 'amazon_connection_pass', fields: { outcome: 'observed', state: 'reconnect_required', reason: 'exchange_uncertain' } },
      { event: 'amazon_connection_pass', fields: { outcome: 'idle' } },
      { event: 'amazon_connection_pass', fields: { outcome: 'idle' } },
    ]);
  });
});

describe('Amazon Ads connection pass wiring', () => {
  it('builds the provider eagerly and claims nothing while the gate is off', async () => {
    // A handle without a query function: any claim would throw and report "unavailable".
    const handle = {} as Parameters<typeof amazonConnectionPass>[0];
    const pass = amazonConnectionPass(handle, { amazonConnectionsEnabled: false }, valid);
    expect(await pass(new AbortController().signal)).toEqual({ outcome: 'idle', operation: null });
    const open = amazonConnectionPass(handle, { amazonConnectionsEnabled: true }, valid);
    expect(await open(new AbortController().signal)).toEqual({ outcome: 'unavailable', operation: null });
    expect(() => amazonConnectionPass(handle, { amazonConnectionsEnabled: true }, { ...valid, LWA_CLIENT_SECRET: undefined }))
      .toThrow('Amazon connection application is not configured');
  });
});

describe('Amazon Ads connection command composition', () => {
  it('shares the general worker wiring and starts nothing else', () => {
    const cli = readFileSync(new URL('./amazon-connections-cli.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toContain('new ProviderConnectionLoop(amazonConnectionPass(handle, config))');
    expect(main).not.toContain('createAmazonConnectionProvider');
    expect(cli).toContain('pass = amazonConnectionPass(handle, config.settings, env,');
    expect(cli).toContain('new ProviderConnectionLoop(async (signal) => {');
    // The entry point never injects a transport and never uses one-shot signal handlers.
    expect(cli).toContain('runAmazonConnectionsCli(process.argv.slice(2), { stop: controller.signal })');
    expect(cli).not.toContain('process.once');
    const forbidden = ['SyncWorker', 'startHealthServer', 'StaleClaimReaper', 'ScheduleProvisioner',
      'RecommendationObservationPass', 'BidSeriesSyncPass', 'AuthHealthMonitor', 'createCreativeSyncProducer',
      'createMarketingStreamSqsConsumer', 'spApiConnectionPass', 'startSpWritePolling', 'WorkerUnifiedDualRun',
      'PostgresWorkerStore', "from './worker.js'", 'createAdsApiClientFromEnv', 'createMarketSignalsImportPass'];
    expect(forbidden).toHaveLength(16);
    for (const name of forbidden) expect(cli).not.toContain(name);
  });
});

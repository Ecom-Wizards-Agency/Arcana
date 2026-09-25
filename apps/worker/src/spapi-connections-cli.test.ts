import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SPAPI_CONNECTIONS_REQUIRED_ENV,
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
  SP_API_LWA_CLIENT_ID: 'synthetic-client',
  SP_API_LWA_CLIENT_SECRET: SECRET,
  SP_API_APPLICATION_ID: 'synthetic-application',
  SP_API_OAUTH_REGION: 'NA',
  SP_API_OAUTH_ALLOWED_REDIRECT_URIS: CALLBACK,
};

async function run(args: readonly string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSpApiConnectionsCli(args, { env, log: (line) => out.push(line), error: (line) => err.push(line) });
  return { code, out, err, all: [...out, ...err].join('\n') };
}

describe('SP-API connection command environment', () => {
  it('accepts the documented environment without any ADS_* variable or job type', () => {
    const config = spApiConnectionsConfigFromEnv(valid);
    expect(config.databaseUrl).toBe(UNREACHABLE_DATABASE);
    expect(config.settings).toMatchObject({ spApiClientId: 'synthetic-client', spApiApplicationId: 'synthetic-application',
      spApiConsentRegion: 'NA', spApiConnectionRedirects: [CALLBACK] });
    expect(Object.keys(valid).filter((name) => name.startsWith('ADS_'))).toHaveLength(0);
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
        'WORKER_JOB_TYPES and WORKER_DEPLOYMENT_ROLE must be unset: this command runs no jobs'],
    ] as const;
    for (const [extra, message] of cases) {
      const result = await run(['--once'], { ...valid, ...extra });
      expect(result).toMatchObject({ code: 1, err: [message], out: [] });
    }
  });

  it('names a malformed field without echoing its value', async () => {
    const cases = [
      [{ OPENSPELL_SPAPI_CONNECTIONS_ENABLED: 'true' }, /^OPENSPELL_SPAPI_CONNECTIONS_ENABLED must be exactly 1$/, 'true'],
      [{ SP_API_OAUTH_REGION: 'synthetic-region' }, /^SP_API_OAUTH_REGION must be NA, EU or FE$/, 'synthetic-region'],
      [{ SP_API_OAUTH_ALLOWED_REDIRECT_URIS: ' , ' }, /^SP_API_OAUTH_ALLOWED_REDIRECT_URIS must list/, null],
      [{ SP_API_OAUTH_ALLOWED_REDIRECT_URIS: 'https://synthetic-user:synthetic-pass@app.example.test/callback' },
        /^Invalid environment: SP-API connection callback policy is invalid$/, 'synthetic-pass'],
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

  it('reports an unreachable database as an uncertain pass without rendering the database URL', async () => {
    const result = await run(['--once'], valid);
    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    const line = JSON.parse(result.out[0]!) as Record<string, string>;
    expect(Object.keys(line).sort()).toEqual(['at', 'event', 'outcome']);
    expect(line).toMatchObject({ event: 'spapi_connection_pass', outcome: 'uncertain' });
    expect(Number.isNaN(Date.parse(line['at']!))).toBe(false);
    for (const value of ['synthetic-password', '127.0.0.1', SECRET]) expect(result.all).not.toContain(value);
  });

  it('shares the general worker wiring and starts nothing else', () => {
    const cli = readFileSync(new URL('./spapi-connections-cli.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toContain('new ProviderConnectionLoop(spApiConnectionPass(handle, config))');
    expect(cli).toContain('new ProviderConnectionLoop(loggedPass)');
    expect(cli).toContain('spApiConnectionPass(handle, config.settings, env)');
    const forbidden = ['SyncWorker', 'startHealthServer', 'StaleClaimReaper', 'ScheduleProvisioner',
      'RecommendationObservationPass', 'BidSeriesSyncPass', 'AuthHealthMonitor', 'createCreativeSyncProducer',
      'createMarketingStreamSqsConsumer', 'AmazonConnectionLoop', 'startSpWritePolling', 'WorkerUnifiedDualRun',
      'PostgresWorkerStore', "from './worker.js'"];
    expect(forbidden).toHaveLength(14);
    for (const name of forbidden) expect(cli).not.toContain(name);
  });
});

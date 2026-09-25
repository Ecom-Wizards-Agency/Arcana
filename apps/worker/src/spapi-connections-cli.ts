/**
 * Connection-only SP-API entry point (WP-326).
 *
 * Runs the seller-authorization exchange and nothing else: no queue worker,
 * health server, background pass, stream consumer, Ads connection loop, SP
 * write polling or unified reporting. The general worker starts those
 * regardless of its claim policy, so this is the supported way to run the
 * exchange outside it.
 */
import { pathToFileURL } from 'node:url';
import { createDb } from '@wizard-ads/db';
import type { FetchLike } from '@wizard-ads/sp-api';
import { configFromEnv } from './config.js';
import { ProviderConnectionLoop } from './provider-connection-loop.js';
import { spApiConnectionPass, type SpApiConnectionSettings } from './spapi-connections.js';

export const SPAPI_CONNECTIONS_REQUIRED_ENV = [
  'DATABASE_URL',
  'OPENSPELL_SPAPI_CONNECTIONS_ENABLED',
  'SP_API_LWA_CLIENT_ID',
  'SP_API_LWA_CLIENT_SECRET',
  'SP_API_APPLICATION_ID',
  'SP_API_OAUTH_REGION',
  'SP_API_OAUTH_ALLOWED_REDIRECT_URIS',
] as const;

/** Job-runtime settings; their presence means a worker environment was copied over. */
export const SPAPI_CONNECTIONS_REFUSED_PREFIX = 'WORKER_';

/** At a one-second poll an idle day would otherwise log 86,400 lines. */
export const SPAPI_CONNECTIONS_HEARTBEAT_MS = 5 * 60_000;

const USAGE = 'usage: spapi-connections:start [--once]';

/** Every message names variables only; no configured value is ever rendered. */
export class SpApiConnectionsCliError extends Error {}

export interface SpApiConnectionsCliConfig {
  databaseUrl: string;
  settings: SpApiConnectionSettings;
}

type LogFields = Record<string, string | number | null>;
type PassResult = Awaited<ReturnType<ReturnType<typeof spApiConnectionPass>>>;

function configMessage(error: unknown): string {
  // Worker configuration errors name variables; anything else (a schema
  // library error, for instance) is summarized rather than rendered.
  return error instanceof Error && error.constructor === Error
    ? error.message : 'worker configuration is invalid';
}

/**
 * Validate the command's environment through the worker config parser. The
 * first parse runs with the gate closed so a malformed field can be named;
 * the second applies the parser's full connection policy.
 */
export function spApiConnectionsConfigFromEnv(env: NodeJS.ProcessEnv): SpApiConnectionsCliConfig {
  const refused = Object.keys(env)
    .filter((name) => name.startsWith(SPAPI_CONNECTIONS_REFUSED_PREFIX) && env[name] !== undefined).sort();
  if (refused.length > 0) {
    throw new SpApiConnectionsCliError(`${refused.join(', ')} must be unset: this command runs no jobs`);
  }
  const missing = SPAPI_CONNECTIONS_REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new SpApiConnectionsCliError(`Missing required environment: ${missing.join(', ')}`);
  }
  if (env['OPENSPELL_SPAPI_CONNECTIONS_ENABLED'] !== '1') {
    throw new SpApiConnectionsCliError('OPENSPELL_SPAPI_CONNECTIONS_ENABLED must be exactly 1');
  }
  let fields;
  try {
    fields = configFromEnv({ ...env, OPENSPELL_SPAPI_CONNECTIONS_ENABLED: '0' });
  } catch (error) {
    throw new SpApiConnectionsCliError(`Invalid environment: ${configMessage(error)}`);
  }
  if (fields.spApiConsentRegion === undefined) {
    throw new SpApiConnectionsCliError('SP_API_OAUTH_REGION must be NA, EU or FE');
  }
  if (fields.spApiConnectionRedirects.length === 0) {
    throw new SpApiConnectionsCliError('SP_API_OAUTH_ALLOWED_REDIRECT_URIS must list at least one callback URI');
  }
  let config;
  try {
    config = configFromEnv(env);
  } catch (error) {
    throw new SpApiConnectionsCliError(`Invalid environment: ${configMessage(error)}`);
  }
  return { databaseUrl: config.databaseUrl, settings: config };
}

export function parseSpApiConnectionsArgs(args: readonly string[]): { once: boolean } {
  if (args.length === 0) return { once: false };
  if (args.length === 1 && args[0] === '--once') return { once: true };
  throw new SpApiConnectionsCliError(USAGE);
}

/** Non-secret deployment identity for the startup line. */
export function startupFields(settings: SpApiConnectionSettings): LogFields {
  return {
    applicationId: settings.spApiApplicationId ?? null,
    region: settings.spApiConsentRegion ?? null,
    redirectUris: settings.spApiConnectionRedirects.length,
    clientIdSuffix: settings.spApiClientId?.slice(-4) ?? null,
  };
}

function passFields(result: PassResult): LogFields {
  return {
    outcome: result.outcome,
    ...(result.operation === null ? {} : { state: result.operation.state, reason: result.operation.reason }),
  };
}

/**
 * Chooses which passes reach the log: every non-idle pass, any change of
 * outcome, and a heartbeat with the pass count at most every five minutes.
 */
export class SpApiConnectionPassReporter {
  private previous: PassResult['outcome'] | null = null;
  private passes = 0;
  private lastHeartbeat: number;

  constructor(
    private readonly record: (event: string, fields?: LogFields) => void,
    private readonly now: () => Date,
  ) {
    this.lastHeartbeat = now().getTime();
  }

  report(result: PassResult, always = false): void {
    this.passes += 1;
    if (always || result.outcome !== 'idle' || result.outcome !== this.previous) {
      this.record('spapi_connection_pass', passFields(result));
    }
    this.previous = result.outcome;
    const at = this.now().getTime();
    if (at - this.lastHeartbeat >= SPAPI_CONNECTIONS_HEARTBEAT_MS) {
      this.record('spapi_connection_heartbeat', { passes: this.passes });
      this.passes = 0;
      this.lastHeartbeat = at;
    }
  }
}

export interface SpApiConnectionsCliOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Aborted on SIGINT or SIGTERM; the loop stops and waits for custody. */
  stop?: AbortSignal;
  now?: () => Date;
  /** Test transport for the token exchange. The command's entry point never sets it. */
  fetch?: FetchLike;
}

/** Returns the process exit code. */
export async function runSpApiConnectionsCli(
  args: readonly string[], options: SpApiConnectionsCliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.info(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const stop = options.stop ?? new AbortController().signal;
  let mode: { once: boolean };
  let config: SpApiConnectionsCliConfig;
  try {
    mode = parseSpApiConnectionsArgs(args);
    config = spApiConnectionsConfigFromEnv(env);
  } catch (failure) {
    error(failure instanceof SpApiConnectionsCliError ? failure.message : 'SP-API connection command failed to start');
    return 1;
  }

  const record = (event: string, fields: LogFields = {}): void =>
    log(JSON.stringify({ at: now().toISOString(), event, ...fields }));
  const reporter = new SpApiConnectionPassReporter(record, now);
  const handle = createDb({ connectionString: config.databaseUrl, max: 2 });
  const pass = spApiConnectionPass(handle, config.settings, env, options.fetch);

  try {
    record('spapi_connection_command_started', { mode: mode.once ? 'once' : 'loop', ...startupFields(config.settings) });
    if (mode.once) {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      stop.addEventListener('abort', abort, { once: true });
      if (stop.aborted) abort();
      try {
        const result = await pass(controller.signal);
        reporter.report(result, true);
        return result.outcome === 'idle' || result.outcome === 'observed' ? 0 : 1;
      } finally {
        stop.removeEventListener('abort', abort);
      }
    }

    // A first pass that cannot reach custody means the command cannot work;
    // exiting lets a supervisor restart it. Later uncertain passes only log.
    let firstPass = true;
    let firstPassUncertain = false;
    let failed: () => void = () => {};
    const failure = new Promise<void>((resolve) => { failed = resolve; });
    const loop = new ProviderConnectionLoop(async (signal) => {
      const result = await pass(signal);
      reporter.report(result);
      if (firstPass) {
        firstPass = false;
        if (result.outcome === 'uncertain') { firstPassUncertain = true; failed(); }
      }
      return result;
    });
    // The loop's timer is unreferenced; this keeps the process alive between passes.
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      loop.start();
      await Promise.race([failure, new Promise<void>((resolve) => {
        if (stop.aborted) resolve();
        else stop.addEventListener('abort', () => resolve(), { once: true });
      })]);
      await loop.stop();
    } finally {
      clearInterval(keepAlive);
    }
    if (firstPassUncertain && !stop.aborted) {
      record('spapi_connection_command_failed', { reason: 'first_pass_uncertain' });
      return 1;
    }
    record('spapi_connection_command_stopped');
    return 0;
  } catch {
    error('SP-API connection command failed');
    return 1;
  } finally {
    await handle.close();
  }
}

/**
 * Persistent handlers: the first SIGINT or SIGTERM starts the stop, and later
 * ones are logged and ignored so they cannot kill a pass holding custody.
 */
export function installSpApiConnectionsSignalHandlers(
  controller: AbortController, log: (line: string) => void = (line) => console.info(line),
): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      const event = controller.signal.aborted ? 'signal_repeated' : 'stop_requested';
      log(JSON.stringify({ at: new Date().toISOString(), event, signal }));
      controller.abort();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  installSpApiConnectionsSignalHandlers(controller);
  runSpApiConnectionsCli(process.argv.slice(2), { stop: controller.signal })
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      console.error('SP-API connection command failed');
      process.exitCode = 1;
    });
}

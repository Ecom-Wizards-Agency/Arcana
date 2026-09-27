/**
 * Connection-only Amazon Ads entry point (WP-330).
 *
 * Runs the Ads consent exchange and profile discovery and nothing else: no
 * queue worker, health server, background pass, stream consumer, SP-API
 * connection loop, SP write polling or unified reporting. The general worker
 * starts those regardless of its claim policy, and its configuration refuses
 * the Ads loop unless it also claims `entity.sync`, so this is the supported
 * way to run the exchange on a host whose worker does not claim entity jobs.
 * The first entity sync of a new connection's profiles is then left to the
 * runtime that claims `entity.sync` (the Vercel cron tick).
 */
import { pathToFileURL } from 'node:url';
import { createDb } from '@wizard-ads/db';
import { configFromEnv } from './config.js';
import { amazonConnectionPass, type AmazonConnectionSettings } from './amazon-connections.js';
import { ProviderConnectionLoop } from './provider-connection-loop.js';
import { installStopSignalHandlers } from './stop-signals.js';

export const AMAZON_CONNECTIONS_REQUIRED_ENV = [
  'DATABASE_URL',
  'OPENSPELL_AMAZON_CONNECTIONS_ENABLED',
  'LWA_CLIENT_ID',
  'LWA_CLIENT_SECRET',
  'AMAZON_OAUTH_ALLOWED_REDIRECT_URIS',
] as const;

/** Job-runtime settings; their presence means a worker environment was copied over. */
export const AMAZON_CONNECTIONS_REFUSED_PREFIX = 'WORKER_';

/**
 * Fallback names the shared provider wiring also reads. The command takes one
 * name per setting, so a second, possibly different value cannot be ignored
 * silently.
 */
export const AMAZON_CONNECTIONS_REFUSED_ALIASES = [
  'AMAZON_LWA_CLIENT_ID',
  'AMAZON_LWA_CLIENT_SECRET',
  'AMAZON_OAUTH_REDIRECT_URI',
] as const;

/** At a one-second poll an idle day would otherwise log 86,400 lines. */
export const AMAZON_CONNECTIONS_HEARTBEAT_MS = 5 * 60_000;

const USAGE = 'usage: amazon-connections:start [--once]';

/** Every message names variables only; no configured value is ever rendered. */
export class AmazonConnectionsCliError extends Error {}

export interface AmazonConnectionsCliConfig {
  databaseUrl: string;
  settings: AmazonConnectionSettings;
  /** Non-secret deployment identity for the startup line. */
  identity: { redirectUris: number; clientIdSuffix: string };
}

type LogFields = Record<string, string | number | null>;
type PassResult = Awaited<ReturnType<ReturnType<typeof amazonConnectionPass>>>;

function configMessage(error: unknown, fallback = 'worker configuration is invalid'): string {
  // Worker configuration and provider wiring errors name variables or state a
  // fixed refusal; anything else (a schema library error, for instance) is
  // summarized rather than rendered.
  return error instanceof Error && error.constructor === Error ? error.message : fallback;
}

/**
 * Validate the command's environment. The worker config parser supplies the
 * database URL and the gate; no job selector can reach it, so its
 * `entity.sync` rule for the general worker does not apply to this command.
 * The application credentials and callbacks are checked when the pass is built.
 */
export function amazonConnectionsConfigFromEnv(env: NodeJS.ProcessEnv): AmazonConnectionsCliConfig {
  const refused = Object.keys(env)
    .filter((name) => name.startsWith(AMAZON_CONNECTIONS_REFUSED_PREFIX) && env[name] !== undefined).sort();
  if (refused.length > 0) {
    throw new AmazonConnectionsCliError(`${refused.join(', ')} must be unset: this command runs no jobs`);
  }
  const aliases = AMAZON_CONNECTIONS_REFUSED_ALIASES.filter((name) => env[name] !== undefined);
  if (aliases.length > 0) {
    throw new AmazonConnectionsCliError(
      `${aliases.join(', ')} must be unset: this command reads only ${AMAZON_CONNECTIONS_REQUIRED_ENV.slice(2).join(', ')}`);
  }
  const missing = AMAZON_CONNECTIONS_REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new AmazonConnectionsCliError(`Missing required environment: ${missing.join(', ')}`);
  }
  // The provider compares the client id byte for byte with each consent's
  // installation, so a padded value would refuse every consent.
  const padded = (['LWA_CLIENT_ID', 'LWA_CLIENT_SECRET'] as const).filter((name) => env[name] !== env[name]?.trim());
  if (padded.length > 0) {
    throw new AmazonConnectionsCliError(`${padded.join(', ')} must not have leading or trailing whitespace`);
  }
  if (env['OPENSPELL_AMAZON_CONNECTIONS_ENABLED'] !== '1') {
    throw new AmazonConnectionsCliError('OPENSPELL_AMAZON_CONNECTIONS_ENABLED must be exactly 1');
  }
  const redirects = (env['AMAZON_OAUTH_ALLOWED_REDIRECT_URIS'] ?? '').split(',').map((value) => value.trim());
  if (redirects.every((value) => value === '')) {
    throw new AmazonConnectionsCliError('AMAZON_OAUTH_ALLOWED_REDIRECT_URIS must list at least one callback URI');
  }
  if (redirects.includes('')) {
    throw new AmazonConnectionsCliError('AMAZON_OAUTH_ALLOWED_REDIRECT_URIS must not contain an empty entry');
  }
  let config;
  try {
    config = configFromEnv(env);
  } catch (error) {
    throw new AmazonConnectionsCliError(`Invalid environment: ${configMessage(error)}`);
  }
  return {
    databaseUrl: config.databaseUrl,
    settings: { amazonConnectionsEnabled: config.amazonConnectionsEnabled },
    identity: { redirectUris: redirects.length, clientIdSuffix: (env['LWA_CLIENT_ID'] ?? '').slice(-4) },
  };
}

export function parseAmazonConnectionsArgs(args: readonly string[]): { once: boolean } {
  if (args.length === 0) return { once: false };
  if (args.length === 1 && args[0] === '--once') return { once: true };
  throw new AmazonConnectionsCliError(USAGE);
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
export class AmazonConnectionPassReporter {
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
      this.record('amazon_connection_pass', passFields(result));
    }
    this.previous = result.outcome;
    const at = this.now().getTime();
    if (at - this.lastHeartbeat >= AMAZON_CONNECTIONS_HEARTBEAT_MS) {
      this.record('amazon_connection_heartbeat', { passes: this.passes });
      this.passes = 0;
      this.lastHeartbeat = at;
    }
  }
}

export interface AmazonConnectionsCliOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Aborted on SIGINT or SIGTERM; the loop stops and waits for custody. */
  stop?: AbortSignal;
  now?: () => Date;
  /** Test transport for the token exchange and discovery. The command's entry point never sets it. */
  fetch?: typeof fetch;
}

function settled(result: PassResult): boolean {
  return result.outcome === 'idle' || result.outcome === 'observed';
}

/** Returns the process exit code. */
export async function runAmazonConnectionsCli(
  args: readonly string[], options: AmazonConnectionsCliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.info(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const stop = options.stop ?? new AbortController().signal;
  let mode: { once: boolean };
  let config: AmazonConnectionsCliConfig;
  try {
    mode = parseAmazonConnectionsArgs(args);
    config = amazonConnectionsConfigFromEnv(env);
  } catch (failure) {
    error(failure instanceof AmazonConnectionsCliError ? failure.message : 'Amazon Ads connection command failed to start');
    return 1;
  }

  const record = (event: string, fields: LogFields = {}): void =>
    log(JSON.stringify({ at: now().toISOString(), event, ...fields }));
  const reporter = new AmazonConnectionPassReporter(record, now);
  // The handle connects on its first query, so a refused setting below never reaches the database.
  const handle = createDb({ connectionString: config.databaseUrl, max: 2 });

  try {
    let pass: ReturnType<typeof amazonConnectionPass>;
    try {
      pass = amazonConnectionPass(handle, config.settings, env,
        options.fetch === undefined ? {} : { fetch: options.fetch });
    } catch (failure) {
      error(`Invalid environment: ${configMessage(failure, 'Amazon connection application configuration is invalid')}`);
      return 1;
    }
    record('amazon_connection_command_started', { mode: mode.once ? 'once' : 'loop', ...config.identity });
    if (mode.once) {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      stop.addEventListener('abort', abort, { once: true });
      if (stop.aborted) abort();
      try {
        const result = await pass(controller.signal);
        reporter.report(result, true);
        return settled(result) ? 0 : 1;
      } finally {
        stop.removeEventListener('abort', abort);
      }
    }

    // A first pass that cannot reach custody means the command cannot work;
    // exiting lets a supervisor restart it. Later unsettled passes only log.
    let firstPass = true;
    let firstPassFailure: PassResult['outcome'] | null = null;
    let failed: () => void = () => {};
    const failure = new Promise<void>((resolve) => { failed = resolve; });
    const loop = new ProviderConnectionLoop(async (signal) => {
      const result = await pass(signal);
      reporter.report(result);
      if (firstPass) {
        firstPass = false;
        if (!settled(result)) { firstPassFailure = result.outcome; failed(); }
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
    if (firstPassFailure !== null && !stop.aborted) {
      record('amazon_connection_command_failed', { reason: `first_pass_${firstPassFailure}` });
      return 1;
    }
    record('amazon_connection_command_stopped');
    return 0;
  } catch {
    error('Amazon Ads connection command failed');
    return 1;
  } finally {
    await handle.close();
  }
}

/**
 * Persistent handlers: the first SIGINT or SIGTERM starts the stop, and later
 * ones are logged and ignored so they cannot kill a pass holding custody.
 */
export function installAmazonConnectionsSignalHandlers(
  controller: AbortController, log: (line: string) => void = (line) => console.info(line),
): void {
  installStopSignalHandlers(() => controller.abort(), { log, stopping: () => controller.signal.aborted });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  installAmazonConnectionsSignalHandlers(controller);
  runAmazonConnectionsCli(process.argv.slice(2), { stop: controller.signal })
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      console.error('Amazon Ads connection command failed');
      process.exitCode = 1;
    });
}

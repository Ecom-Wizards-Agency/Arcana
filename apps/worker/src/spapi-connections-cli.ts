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

/** Job-runtime selectors; their presence means the operator expected a worker. */
export const SPAPI_CONNECTIONS_REFUSED_ENV = ['WORKER_JOB_TYPES', 'WORKER_DEPLOYMENT_ROLE'] as const;

const USAGE = 'usage: spapi-connections:start [--once]';

/** Every message names variables only; no configured value is ever rendered. */
export class SpApiConnectionsCliError extends Error {}

export interface SpApiConnectionsCliConfig {
  databaseUrl: string;
  settings: SpApiConnectionSettings;
}

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
  const refused = SPAPI_CONNECTIONS_REFUSED_ENV.filter((name) => env[name] !== undefined);
  if (refused.length > 0) {
    throw new SpApiConnectionsCliError(`${refused.join(' and ')} must be unset: this command runs no jobs`);
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

export interface SpApiConnectionsCliOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Aborted on SIGINT or SIGTERM; the loop stops and waits for custody. */
  stop?: AbortSignal;
  now?: () => Date;
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

  const record = (event: string, fields: Record<string, string> = {}): void =>
    log(JSON.stringify({ at: now().toISOString(), event, ...fields }));
  const handle = createDb({ connectionString: config.databaseUrl, max: 2 });
  const pass = spApiConnectionPass(handle, config.settings, env);
  const loggedPass = async (signal: AbortSignal) => {
    const result = await pass(signal);
    record('spapi_connection_pass', { outcome: result.outcome });
    return result;
  };

  try {
    if (mode.once) {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      stop.addEventListener('abort', abort, { once: true });
      if (stop.aborted) abort();
      try {
        const { outcome } = await loggedPass(controller.signal);
        return outcome === 'idle' || outcome === 'observed' ? 0 : 1;
      } finally {
        stop.removeEventListener('abort', abort);
      }
    }
    const loop = new ProviderConnectionLoop(loggedPass);
    // The loop's timer is unreferenced; this keeps the process alive between passes.
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      record('spapi_connection_command_started');
      loop.start();
      await new Promise<void>((resolve) => {
        if (stop.aborted) resolve();
        else stop.addEventListener('abort', () => resolve(), { once: true });
      });
      await loop.stop();
      record('spapi_connection_command_stopped');
      return 0;
    } finally {
      clearInterval(keepAlive);
    }
  } catch {
    error('SP-API connection command failed');
    return 1;
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runSpApiConnectionsCli(process.argv.slice(2), { stop: controller.signal })
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      console.error('SP-API connection command failed');
      process.exitCode = 1;
    });
}

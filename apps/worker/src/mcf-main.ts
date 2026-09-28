/**
 * Entry point of the dedicated MCF unit, `wizard-ads-mcf.service` (WP-338e;
 * DESIGN sections 4.3 and 8). The general worker (`src/main.ts`) never imports
 * this file or `src/mcf-send/`.
 *
 * It runs the MCF send loop: the heartbeat with scope, the expiry sweep, the
 * daily mask purge, previews, dispatches, guarded cancels (WP-338i) and
 * settlement reads. It opens no listener. The Evo runtime's `mcf` mode (WP-338f) execs it with:
 *
 *  - DATABASE_URL (the unit's database credential),
 *  - SP_API_LWA_CLIENT_ID and SP_API_LWA_CLIENT_SECRET (required whenever the
 *    scope is non-empty, because settlement reads run with both flags off),
 *  - OPENSPELL_MCF_PREVIEW_ENABLED, OPENSPELL_MCF_DISPATCH_ENABLED and
 *    OPENSPELL_MCF_SCOPE (see ./mcf-send/policy.ts),
 *  - CREDENTIALS_DIRECTORY holding `mcf-recipient-<keyId8>` files (PKCS#8 DER),
 *    required when either flag is on; the key itself never enters the
 *    environment,
 *  - optional WORKER_ID (default `wizard-ads-mcf`), OPENSPELL_WORKER_REVISION
 *    and OPENSPELL_MCF_POLL_INTERVAL_MS (1,000 to 60,000; default 5,000).
 *
 * It refuses to start, with a fixed message naming the variable and never its
 * value, when the policy is invalid, a flag is on without a readable key file
 * (every `mcf-recipient-*` file must import and match its name), a flag is on
 * and an active grant in the scope names a recipient key id that no readable
 * key file carries (read from the database with the service-role
 * app.creator_mcf_active_key_ids; only the count missing is printed), or a
 * scope is set without the LWA credentials. Flags off and restart is the kill
 * switch: settlement reads keep running for the scope.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import { readCreatorMcfActiveKeyIds } from '@wizard-ads/db/worker';
import { workerRevisionFromEnv } from './config.js';
import { postgresMcfCancelStore } from './mcf-send/cancel.js';
import { credentialDirectoryKeySource } from './mcf-send/custody.js';
import { consoleMcfLog, createMcfSendLoop, postgresMcfSendStore, spApiMcfAmazonFactory, startMcfSendPolling } from './mcf-send/loop.js';
import { McfPolicyError, mcfMissingRecipientKeys, mcfSendPolicyFromEnv } from './mcf-send/policy.js';
import { installStopSignalHandlers } from './stop-signals.js';

const log = consoleMcfLog();

function refuse(reason: string): never {
  console.error(JSON.stringify({ at: new Date().toISOString(), level: 'error', event: 'mcf_start_refused', reason }));
  process.exit(1);
}

function pollIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env['OPENSPELL_MCF_POLL_INTERVAL_MS'];
  if (raw === undefined || raw.trim() === '') return 5_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) refuse('OPENSPELL_MCF_POLL_INTERVAL_MS: invalid');
  return value;
}

async function main(): Promise<void> {
  const env = process.env;
  let policy;
  try {
    policy = mcfSendPolicyFromEnv(env);
  } catch (error) {
    refuse(error instanceof McfPolicyError ? error.message : 'policy: invalid');
  }
  let revision: string;
  try {
    revision = workerRevisionFromEnv(env);
  } catch {
    refuse('OPENSPELL_WORKER_REVISION: invalid');
  }
  const workerId = env['WORKER_ID']?.trim() || 'wizard-ads-mcf';
  if (!/^[A-Za-z0-9._:-]{1,70}$/.test(workerId)) refuse('WORKER_ID: invalid');
  const lwaClientId = env['SP_API_LWA_CLIENT_ID']?.trim() ?? '';
  const lwaKey = env['SP_API_LWA_CLIENT_SECRET']?.trim() ?? '';
  if (policy.scope.length > 0 && (lwaClientId === '' || lwaKey === '')) refuse('SP_API_LWA_CLIENT_ID and SP_API_LWA_CLIENT_SECRET: required with a scope');
  const keys = credentialDirectoryKeySource(env['CREDENTIALS_DIRECTORY']);
  const flagOn = policy.previewEnabled || policy.dispatchEnabled;
  let readable: string[] = [];
  if (flagOn) {
    try {
      readable = await keys.inventory();
    } catch {
      refuse('CREDENTIALS_DIRECTORY: no readable recipient key');
    }
    if (readable.length === 0) refuse('CREDENTIALS_DIRECTORY: no readable recipient key');
  }
  const interval = pollIntervalMs(env);
  let databaseUrl: string;
  try {
    databaseUrl = connectionStringFromEnv(env);
  } catch {
    refuse('DATABASE_URL: invalid');
  }
  const handle = createDb({ connectionString: databaseUrl, max: 2 });
  if (flagOn) {
    // Every recipient key id an active grant in this scope names must have a readable key file (DESIGN section 8).
    let missing: string[];
    try {
      missing = mcfMissingRecipientKeys(await readCreatorMcfActiveKeyIds(handle, policy.scope), readable);
    } catch {
      await handle.close().catch(() => undefined);
      refuse('DATABASE_URL: the active grant key ids could not be read');
    }
    if (missing.length > 0) {
      await handle.close().catch(() => undefined);
      refuse(`CREDENTIALS_DIRECTORY: no readable key file for ${missing.length} active grant key id${missing.length === 1 ? '' : 's'}`);
    }
  }
  const loop = createMcfSendLoop({
    store: postgresMcfSendStore(handle),
    cancelStore: postgresMcfCancelStore(handle),
    amazon: spApiMcfAmazonFactory({ handle, lwaClientId, lwaClientSecret: lwaKey }),
    keys,
    // Read again before every step, as the design asks; the process environment is fixed, so a restart applies a change.
    policy: () => mcfSendPolicyFromEnv(process.env),
    workerId,
    workerRevision: revision,
    log,
  });
  log('info', { event: 'mcf_start', counts: { previewEnabled: policy.previewEnabled ? 1 : 0, dispatchEnabled: policy.dispatchEnabled ? 1 : 0,
    scope: policy.scope.length } });
  const polling = startMcfSendPolling(loop, interval, log);
  let stopping: Promise<void> | null = null;
  installStopSignalHandlers(() => {
    stopping ??= (async () => {
      await polling.stop();
      await handle.close();
      log('info', { event: 'mcf_stop', counts: { pendingOutcomes: loop.pendingOutcomes() } });
      process.exit(0);
    })();
  });
}

main().catch(() => {
  log('error', { event: 'mcf_fault', codes: ['start'] });
  process.exit(1);
});

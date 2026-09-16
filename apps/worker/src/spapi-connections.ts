import { randomUUID } from 'node:crypto';
import { createSpApiConnectionLifecycle, settleSpApiConnection, type DbHandle } from '@wizard-ads/db';
import { NotConfigured, type SpApiConnectionInstallation, type SpApiConnectionOperation } from '@wizard-ads/shared';
import { exchangeLwaAuthorizationCode, SpApiCodeExchangeError, type FetchLike } from '@wizard-ads/sp-api';

/** Worker-owned credentials; the application tier never constructs this capability. */
export async function exchangeSpApiAuthorizationCode(
  installation: SpApiConnectionInstallation, code: string, signal: AbortSignal,
  credentials?: { clientId: string; clientSecret: string; fetch?: FetchLike },
): Promise<string> {
  if (!credentials?.clientSecret || installation.clientId !== credentials.clientId) throw new NotConfigured();
  return exchangeLwaAuthorizationCode({ ...credentials, redirectUri: installation.redirectUri, code, signal });
}

export interface SpApiConnectionRuntimeOptions {
  handle: Pick<DbHandle, 'sql'>;
  enabled: () => boolean;
  /** Deployment-owned installation check, never supplied by a callback. */
  accepts: (installation: SpApiConnectionInstallation) => boolean;
  exchange?: typeof exchangeSpApiAuthorizationCode;
}

/** One serial pass consumes one consent; no generic provider retry surrounds it. */
export async function runSpApiConnectionPass(
  options: SpApiConnectionRuntimeOptions, signal: AbortSignal, leaseId = randomUUID(),
): Promise<{ outcome: 'idle' | 'observed' | 'uncertain'; operation: SpApiConnectionOperation | null }> {
  if (signal.aborted || !options.enabled()) return { outcome: 'idle', operation: null };
  const lifecycle = createSpApiConnectionLifecycle(options.handle, options.enabled);
  try {
    const claim = await lifecycle.custody.claim(leaseId);
    if (claim === null) return { outcome: 'idle', operation: null };
    const id = claim.operation.operationId;
    let refresh: string;
    try {
      if (!options.enabled() || !options.accepts(claim.installation)) throw new NotConfigured();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      bounded.throwIfAborted();
      refresh = await (options.exchange ?? exchangeSpApiAuthorizationCode)(claim.installation, claim.code, bounded);
    } catch (error) {
      const operation = await settleSpApiConnection(options.handle, id, claim.leaseId, {
        reason: error instanceof NotConfigured ? 'not_configured'
          : error instanceof SpApiCodeExchangeError ? error.outcome : 'exchange_uncertain',
      });
      return { outcome: 'observed', operation };
    }
    try {
      // Revocation/membership/expiry are rechecked transactionally by attachment.
      if (!options.enabled() || signal.aborted) {
        return { outcome: 'observed', operation: await settleSpApiConnection(options.handle, id, claim.leaseId, { reason: 'exchange_uncertain' }) };
      }
      return { outcome: 'observed', operation: await lifecycle.custody.attach(id, claim.leaseId, refresh) };
    } catch {
      const observed = await lifecycle.custody.read(id);
      return { outcome: 'observed', operation: observed.state === 'exchanging'
        ? await settleSpApiConnection(options.handle, id, claim.leaseId, { reason: 'exchange_uncertain' }) : observed };
    }
  } catch {
    return { outcome: 'uncertain', operation: null };
  }
}

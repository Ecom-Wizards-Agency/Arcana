import { randomUUID } from 'node:crypto';
import {
  AdsProfileDiscoveryResult, AmazonConnectionClaim, AmazonConnectionRosterInput, AmazonConnectionRosterProfile,
  type AdsConnectionCredentialBinding, type AmazonConnectionInstallation,
  type AmazonConnectionOperation, type AmazonConnectionRegionProgress, type Region,
} from '@wizard-ads/shared';
import { AdsApiParseError, AdsAuthError, AdsAuthorizationCodeError } from '@wizard-ads/ads-api';

type RegionFailure = NonNullable<AmazonConnectionRegionProgress['reason']>;
type ExchangeFailure = 'exchange_refused' | 'exchange_uncertain' | 'installation_changed';

export interface AmazonConnectionStore {
  claim(leaseId: string): Promise<AmazonConnectionClaim | null>;
  attach(operationId: string, leaseId: string, refreshToken: string): Promise<AmazonConnectionOperation>;
  failExchange(operationId: string, leaseId: string, reason: ExchangeFailure): Promise<AmazonConnectionOperation>;
  failDiscovery(operationId: string, leaseId: string): Promise<AmazonConnectionOperation>;
  read(operationId: string): Promise<AmazonConnectionOperation>;
  startRegion(operationId: string, leaseId: string, region: Region): Promise<AmazonConnectionOperation>;
  recordRegion(operationId: string, leaseId: string, region: Region,
    input: AmazonConnectionRosterInput | null, failure: RegionFailure | null): Promise<AmazonConnectionOperation>;
}

export interface AmazonConnectionProvider {
  accepts(installation: AmazonConnectionInstallation): boolean;
  exchange(installation: AmazonConnectionInstallation, code: string, signal: AbortSignal): Promise<string>;
  discover(binding: AdsConnectionCredentialBinding, region: Region, signal: AbortSignal): Promise<AdsProfileDiscoveryResult>;
}

export type AmazonConnectionPassResult =
  | { outcome: 'idle' | 'unavailable' | 'uncertain'; operation: null }
  | { outcome: 'observed'; operation: AmazonConnectionOperation };

class InvalidDiscoveryResponse extends Error {
  constructor() { super('Profile discovery response could not be reconciled'); }
}

/** Required metadata refusals join parser refusals; no received row disappears. */
export function connectionRosterInput(raw: AdsProfileDiscoveryResult): AmazonConnectionRosterInput {
  try {
    const result = AdsProfileDiscoveryResult.parse(raw);
    const profiles: AmazonConnectionRosterProfile[] = [];
    let rejected = result.rejected.length;
    for (const row of result.profiles) {
      const parsed = AmazonConnectionRosterProfile.safeParse(row);
      if (!parsed.success) { rejected += 1; continue; }
      try { new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timezone }).format(0); }
      catch { rejected += 1; continue; }
      profiles.push(parsed.data);
    }
    return AmazonConnectionRosterInput.parse({ region: result.region, received: result.received, profiles, rejected });
  } catch {
    throw new InvalidDiscoveryResponse();
  }
}

function deadline(parent: AbortSignal, milliseconds: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => { controller.abort(new DOMException('Connection worker stopped', 'AbortError')); };
  if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Connection request timed out', 'TimeoutError')), milliseconds);
  timer.unref();
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
}

function regionFailure(error: unknown): RegionFailure {
  if (error instanceof AdsAuthError) return 'access_refused';
  if (error instanceof AdsApiParseError || error instanceof InvalidDiscoveryResponse) return 'invalid_response';
  return 'request_failed';
}

/** One pass has at most one exchange claim. No generic retry wraps this effect. */
export async function runAmazonConnectionPass(
  store: AmazonConnectionStore, provider: AmazonConnectionProvider, signal: AbortSignal,
  leaseId: string = randomUUID(),
): Promise<AmazonConnectionPassResult> {
  if (signal.aborted) return { outcome: 'idle', operation: null };
  let claim: AmazonConnectionClaim | null;
  try {
    const raw = await store.claim(leaseId);
    claim = raw === null ? null : AmazonConnectionClaim.parse(raw);
  } catch {
    // The claim may already have consumed a code. Do not request it again.
    return { outcome: 'unavailable', operation: null };
  }
  if (claim === null) return { outcome: 'idle', operation: null };
  const { operationId } = claim.operation;
  try {
    if (!provider.accepts(claim.installation)) {
      return { outcome: 'observed', operation: claim.kind === 'exchange'
        ? await store.failExchange(operationId, claim.leaseId, 'installation_changed')
        : await store.failDiscovery(operationId, claim.leaseId) };
    }
    if (claim.kind === 'exchange') {
      let refreshToken: string;
      const bounded = deadline(signal, 30_000);
      try { refreshToken = await provider.exchange(claim.installation, claim.code, bounded.signal); }
      catch (error) {
        const reason = error instanceof AdsAuthorizationCodeError ? error.reason : 'exchange_uncertain';
        return { outcome: 'observed', operation: await store.failExchange(operationId, claim.leaseId, reason) };
      } finally { bounded.dispose(); }
      try {
        return { outcome: 'observed', operation: await store.attach(operationId, claim.leaseId, refreshToken) };
      } catch {
        // A locked read waits behind any attaching transaction. A failure can
        // settle only the still-owned exchange; it cannot undo an attached grant.
        const observed = await store.read(operationId);
        return { outcome: 'observed', operation: observed.state === 'exchanging'
          ? await store.failExchange(operationId, claim.leaseId, 'exchange_uncertain') : observed };
      }
    }

    let observed = claim.operation;
    for (const region of ['NA', 'EU', 'FE'] as const) {
      if (signal.aborted) return { outcome: 'uncertain', operation: null };
      if (observed.regions.some((row) => row.region === region && ['completed', 'failed'].includes(row.state))) continue;
      observed = await store.startRegion(operationId, claim.leaseId, region);
      if (observed.state !== 'discovering') return { outcome: 'observed', operation: observed };
      let input: AmazonConnectionRosterInput | null = null;
      let failure: RegionFailure | null = null;
      const bounded = deadline(signal, 60_000);
      try {
        const discovered = await provider.discover(claim.binding, region, bounded.signal);
        if (discovered.region !== region) throw new InvalidDiscoveryResponse();
        input = connectionRosterInput(discovered);
      } catch (error) { failure = regionFailure(error); }
      finally { bounded.dispose(); }
      // Shutdown leaves unfinished regional custody resumable. It is not an
      // Amazon refusal and must not permanently settle an interrupted region.
      if (signal.aborted) return { outcome: 'uncertain', operation: null };
      try {
        observed = await store.recordRegion(operationId, claim.leaseId, region, input, failure);
      } catch {
        observed = await store.read(operationId);
        if (observed.state !== 'discovering') return { outcome: 'observed', operation: observed };
        const saved = observed.regions.find((row) => row.region === region);
        if (saved && ['completed', 'failed'].includes(saved.state)) continue;
        // An uncommitted roster write has no accepted rows. Preserve the known
        // provider/parser counts while recording the persistence refusal.
        observed = await store.recordRegion(operationId, claim.leaseId, region, input, failure ?? 'persistence_failed');
      }
      if (observed.state !== 'discovering') return { outcome: 'observed', operation: observed };
    }
    return { outcome: 'uncertain', operation: null };
  } catch {
    // No provider or postgres error (including non-enumerable parameters/cause)
    // escapes into worker logging. Durable custody is reconciled on a later pass.
    return { outcome: 'uncertain', operation: null };
  }
}

/** One serial consumer; stop aborts its provider request and waits for custody. */
export class AmazonConnectionLoop {
  private readonly controller = new AbortController();
  private task: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private active = false;
  private running = false;
  private failures = 0;
  private lastSuccessAt: string | null = null;

  constructor(
    private readonly store: AmazonConnectionStore,
    private readonly provider: AmazonConnectionProvider,
    private readonly pollIntervalMs = 1_000,
  ) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error('Invalid connection poll interval');
  }

  start(): void {
    if (this.task !== null || this.controller.signal.aborted) return;
    this.active = true;
    this.task = this.run().finally(() => { this.active = false; });
  }

  private async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      this.running = true;
      const result = await runAmazonConnectionPass(this.store, this.provider, this.controller.signal);
      this.running = false;
      if (result.outcome === 'idle' || result.outcome === 'observed') {
        this.failures = 0;
        this.lastSuccessAt = new Date().toISOString();
      } else this.failures += 1;
      if (this.controller.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); this.wake = null; resolve(); };
        const timer = setTimeout(done, this.pollIntervalMs);
        timer.unref();
        this.wake = done;
      });
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.wake?.();
    await this.task;
  }

  status(): { enabled: true; running: boolean; stopping: boolean; inFlight: 0 | 1;
    consecutiveFailures: number; lastSuccessAt: string | null } {
    return { enabled: true, running: this.active, stopping: this.controller.signal.aborted,
      inFlight: this.running ? 1 : 0, consecutiveFailures: this.failures, lastSuccessAt: this.lastSuccessAt };
  }
}

/**
 * `mcf.observe` (WP-334): read-only MCF observation for Creator Connections
 * sample lanes.
 *
 * For every lane the control runner reports as submitted (Verified for
 * Submit), ambiguous (Reconciliation Required) or confirmed, the job asks
 * Amazon whether an order exists under the lane's derived order key (and under
 * the id the runner recorded, when it recorded one), reads the whole shipments
 * array and each package's carrier status, and appends one observation row per
 * lane. The database moves the lane's settlement in the same statement: found,
 * not found, or, after three not-found reads of an ambiguous submit, escalated.
 *
 * It never creates, updates or cancels an order, never changes a lane's state
 * and never releases a lock: `FulfillmentOutboundReader` has no write method.
 * It is off unless `OPENSPELL_MCF_OBSERVE_ENABLED=1` and the SP-API client
 * credentials are configured; off, nothing registers and nothing is enqueued.
 *
 * Evo job type candidate: not in the Evo worker template or runtime allowlist
 * this round, and its ingestion source has no lane affinity. Adding it there is
 * a deployment decision for a later round.
 */
import { getSpApiRefreshToken, resolveActiveSpApiProfileBinding, type DbHandle } from '@wizard-ads/db';
import {
  countActiveCreatorSpApiConnections, listCreatorMcfObserveScopes, readCreatorObservableLanes, readCreatorObservedKeys,
  recordCreatorMcfObservation, type CreatorObservableLane,
} from '@wizard-ads/db/worker';
import {
  CREATOR_MCF_NOT_FOUND_ESCALATION, type CreatorMcfObservationWrite, type CreatorMcfSettlementState, type CreatorSamplePackage,
  type FulfillmentOrderList, type FulfillmentOrderLookup, type JobType, type McfObserveJob, type PackageTrackingObservation,
} from '@wizard-ads/shared';
import { FulfillmentOutboundReader, LwaRefreshTokenProvider, type FetchLike } from '@wizard-ads/sp-api';
import { IngestionRegistry } from './ingestion-registry.js';
import { PermanentJobError } from './permanent-job-error.js';
import { spApiEndpointForRegion } from './spapi-sqp.js';

export const MCF_OBSERVE_ENABLED_ENV = 'OPENSPELL_MCF_OBSERVE_ENABLED';
export const MCF_OBSERVE_INTERVAL_ENV = 'OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES';
/** Lanes read per job; the next job continues with the least recently read. */
export const MCF_OBSERVE_LANE_LIMIT = 25;
/** Packages tracked per lane. A sample is one unit; more than this is itself the signal. */
export const MCF_OBSERVE_PACKAGE_LIMIT = 5;
/** getFulfillmentOrder and getPackageTrackingDetails allow 2 requests a second. */
export const MCF_OBSERVE_SPACING_MS = 600;
/** How far before the reservation the order list is read when corroborating a not-found. */
const LIST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LIST_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** The read-only surface the job needs. The production reader has nothing else. */
export type McfObserveReader = Pick<FulfillmentOutboundReader, 'getOrder' | 'listOrders' | 'trackPackage'>;
export interface McfObserveStore {
  activeConnections(orgId: string): Promise<number>;
  lanes(orgId: string, limit: number): Promise<CreatorObservableLane[]>;
  observedKeys(orgId: string, jobId: string): Promise<Set<string>>;
  record(orgId: string, write: CreatorMcfObservationWrite): Promise<{ outcome: 'inserted' | 'unchanged'; settlement: CreatorMcfSettlementState | null }>;
}

/** What one job did, counted. lanes = alreadyObserved + found + notFound + inconsistent. */
export interface McfObserveResult extends Record<string, unknown> {
  lanes: number;
  alreadyObserved: number;
  found: number;
  notFound: number;
  /** getFulfillmentOrder said none while the order list named it: nothing is recorded, the next job reads again. */
  inconsistent: number;
  escalated: number;
  written: number;
  unchanged: number;
  packages: number;
  carrierRead: number;
  carrierNotYet: number;
  carrierFailed: number;
  amazonCalls: number;
}

export interface McfObserveDependencies {
  reader: McfObserveReader;
  store: McfObserveStore;
  now?: () => Date;
  pause?: (ms: number) => Promise<void>;
}

const idOk = (value: string | null): value is string => value !== null && value.length >= 1 && value.length <= 40;

/** Observe one organisation's lanes through one reader. Pure orchestration; every Amazon call is a read. */
export async function observeCreatorMcfLanes(deps: McfObserveDependencies, payload: McfObserveJob, jobId: string): Promise<McfObserveResult> {
  const now = deps.now ?? (() => new Date());
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const result: McfObserveResult = { lanes: 0, alreadyObserved: 0, found: 0, notFound: 0, inconsistent: 0, escalated: 0, written: 0, unchanged: 0,
    packages: 0, carrierRead: 0, carrierNotYet: 0, carrierFailed: 0, amazonCalls: 0 };
  const connections = await deps.store.activeConnections(payload.orgId);
  if (connections !== 1) {
    // A not-found from one of several seller accounts settles nothing, so nothing is read.
    throw new PermanentJobError(`mcf.observe needs exactly one active SP-API connection for the organisation; it has ${connections}`);
  }
  let calls = 0;
  const call = async <T>(read: () => Promise<T>): Promise<T> => {
    if (calls > 0) await pause(MCF_OBSERVE_SPACING_MS);
    calls++;
    return read();
  };
  const lanes = await deps.store.lanes(payload.orgId, MCF_OBSERVE_LANE_LIMIT);
  const done = await deps.store.observedKeys(payload.orgId, jobId);
  result.lanes = lanes.length;
  for (const lane of lanes) {
    if (done.has(lane.derivedOrderKey)) { result.alreadyObserved++; continue; }
    const ids = [lane.derivedOrderKey, ...(idOk(lane.runnerOrderId) && lane.runnerOrderId !== lane.derivedOrderKey ? [lane.runnerOrderId] : [])];
    let found: Extract<FulfillmentOrderLookup, { outcome: 'found' }> | null = null;
    for (const id of ids) {
      const lookup = await call(() => deps.reader.getOrder(id));
      if (lookup.outcome === 'found') { found = lookup; break; }
    }
    const readAt = now().toISOString();
    let write: CreatorMcfObservationWrite;
    if (found !== null) {
      const packages: CreatorSamplePackage[] = [];
      for (const pkg of found.order.shipments.flatMap((shipment) => shipment.packages).slice(0, MCF_OBSERVE_PACKAGE_LIMIT)) {
        let tracking: PackageTrackingObservation | null | 'failed';
        try { tracking = await call(() => deps.reader.trackPackage(pkg.packageNumber)); }
        catch { tracking = 'failed'; }
        const trackedAt = now().toISOString();
        if (tracking === 'failed') result.carrierFailed++;
        else if (tracking === null || tracking.currentStatus === null) result.carrierNotYet++;
        else result.carrierRead++;
        packages.push({
          packageNumber: pkg.packageNumber, carrierCode: pkg.carrierCode, trackingNumber: pkg.trackingNumber, estimatedArrivalAt: pkg.estimatedArrivalAt,
          // Null status: the carrier has no scan yet. Null read time: the carrier was not read (the read failed).
          carrierStatus: tracking === 'failed' || tracking === null ? null : tracking.currentStatus,
          carrierStatusReadAt: tracking === 'failed' ? null : trackedAt,
        });
      }
      result.packages += packages.length;
      write = { observationKey: `${jobId}:${lane.derivedOrderKey}`, derivedOrderKey: lane.derivedOrderKey,
        queriedOrderId: found.order.sellerFulfillmentOrderId, operation: 'getFulfillmentOrder', outcome: 'found', status: found.order.status,
        shipments: found.order.shipments, packages, readAt, jobId };
      result.found++;
    } else {
      let operation: CreatorMcfObservationWrite['operation'] = 'getFulfillmentOrder';
      if (lane.laneState === 'Reconciliation Required') {
        // An ambiguous submit is settled by the derived id; the bounded order list corroborates a not-found.
        const start = lane.reservedAt === null ? new Date(now().getTime() - LIST_FALLBACK_MS) : new Date(Date.parse(lane.reservedAt) - LIST_LOOKBACK_MS);
        const listed: FulfillmentOrderList = await call(() => deps.reader.listOrders(start.toISOString(), 5));
        if (listed.orders.some((order) => ids.includes(order.sellerFulfillmentOrderId))) { result.inconsistent++; continue; }
        if (listed.complete) operation = 'listAllFulfillmentOrders';
      }
      write = { observationKey: `${jobId}:${lane.derivedOrderKey}`, derivedOrderKey: lane.derivedOrderKey, queriedOrderId: lane.derivedOrderKey,
        operation, outcome: 'not_found', status: null, shipments: null, packages: null, readAt, jobId };
      result.notFound++;
    }
    const recorded = await deps.store.record(payload.orgId, write);
    if (recorded.outcome === 'inserted') result.written++; else result.unchanged++;
    // Only this read's transition into escalation counts: not a lane already escalated, and not a replay.
    if (recorded.outcome === 'inserted' && recorded.settlement?.settlement === 'escalated'
      && recorded.settlement.notFoundProbes === CREATOR_MCF_NOT_FOUND_ESCALATION) result.escalated++;
  }
  result.amazonCalls = calls;
  if (result.lanes !== result.alreadyObserved + result.found + result.notFound + result.inconsistent
    || result.written + result.unchanged !== result.found + result.notFound
    || result.packages !== result.carrierRead + result.carrierNotYet + result.carrierFailed) {
    throw new Error('mcf.observe counts do not reconcile');
  }
  return result;
}

/** The flag and the credentials; both are required, and the flag must be exactly "1". */
export function mcfObserveEnabled(env: NodeJS.ProcessEnv, lwaClientId: string | undefined, lwaKey: string | undefined): boolean {
  return env[MCF_OBSERVE_ENABLED_ENV] === '1' && Boolean(lwaClientId) && Boolean(lwaKey);
}

export interface McfObserveRuntime {
  handle: DbHandle;
  lwaClientId: string;
  lwaClientSecret: string;
  userAgent?: string;
  fetch?: FetchLike;
}

/** The production store over the worker's database handle. */
export function postgresMcfObserveStore(handle: DbHandle): McfObserveStore {
  return {
    activeConnections: (orgId) => countActiveCreatorSpApiConnections(handle, orgId),
    lanes: (orgId, limit) => readCreatorObservableLanes(handle, orgId, limit),
    observedKeys: (orgId, jobId) => readCreatorObservedKeys(handle, orgId, jobId),
    record: (orgId, write) => recordCreatorMcfObservation(handle, orgId, write),
  };
}

/** Resolve the job's SP-API binding on every attempt and build a read-only reader for it. */
export function createMcfObserveHandler(runtime: McfObserveRuntime, store: McfObserveStore = postgresMcfObserveStore(runtime.handle)):
  (payload: McfObserveJob, jobId: string) => Promise<McfObserveResult> {
  return async (payload, jobId) => {
    const binding = await resolveActiveSpApiProfileBinding(runtime.handle, { orgId: payload.orgId, profileId: payload.profileId, marketplaceId: payload.marketplaceId });
    if (binding === null) throw new PermanentJobError('mcf.observe has no active exact profile, marketplace and SP-API binding');
    const { lwaClientId, lwaClientSecret: lwaKey } = runtime;
    const reader = new FulfillmentOutboundReader({
      endpoint: spApiEndpointForRegion(binding.region),
      userAgent: runtime.userAgent ?? 'WizardAds/1.0 (Language=TypeScript)',
      accessTokenProvider: new LwaRefreshTokenProvider({
        clientId: lwaClientId, clientSecret: lwaKey,
        refreshTokenProvider: () => getSpApiRefreshToken(runtime.handle, { orgId: binding.orgId, connectionId: binding.connectionId }),
        ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
      }),
      fetch: runtime.fetch ?? globalThis.fetch,
    });
    return observeCreatorMcfLanes({ reader, store }, payload, jobId);
  };
}

/**
 * Register the `mcf.observe` handler, and only when enabled. Disabled, the
 * registry keeps no handler, so a queued `mcf.observe` job fails as
 * unimplemented instead of reaching Amazon.
 */
export function registerMcfObserve(registry: Pick<IngestionRegistry, 'register'>, options: { enabled: boolean; handler: () => (payload: McfObserveJob, jobId: string) => Promise<McfObserveResult> }): boolean {
  if (!options.enabled) return false;
  if (!(registry instanceof IngestionRegistry)) throw new Error('mcf.observe requires the worker task registry');
  const handler = options.handler();
  registry.installBuiltin('mcf.observe', ({ job, payload }) => handler(payload, job.id));
  return true;
}

export interface McfObserveEnqueuer {
  enqueue(payload: McfObserveJob, runAt: Date, dedupeKey: string): Promise<boolean>;
}

/**
 * Enqueues one `mcf.observe` job per organisation with a lane to observe, once
 * per interval slot: the dedupe key carries the slot, so two workers running
 * this pass in the same slot enqueue one job. Jobs from adjacent slots can still
 * each read a lane; every read is a real read at its own time, and three of them
 * are the escalation threshold at a 30-minute interval, not within one cycle.
 */
export class McfObservePass {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<{ enqueued: number; deduplicated: number; refusedOrgs: number } | null> | undefined;

  constructor(
    private readonly scopes: () => ReturnType<typeof listCreatorMcfObserveScopes>,
    private readonly queue: McfObserveEnqueuer,
    private readonly intervalMs: number,
    private readonly logger: Pick<Console, 'info' | 'error'> = console,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  runOnce(): Promise<{ enqueued: number; deduplicated: number; refusedOrgs: number } | null> {
    if (this.inFlight) return Promise.resolve(null);
    this.inFlight = this.execute().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async execute(): Promise<{ enqueued: number; deduplicated: number; refusedOrgs: number } | null> {
    try {
      const { scopes, refusedOrgs } = await this.scopes();
      const at = this.now();
      const slot = Math.floor(at.getTime() / this.intervalMs);
      let enqueued = 0;
      for (const scope of scopes) {
        if (await this.queue.enqueue({ type: 'mcf.observe', ...scope }, at, `mcf-observe:${scope.orgId}:${slot}`)) enqueued++;
      }
      const counts = { enqueued, deduplicated: scopes.length - enqueued, refusedOrgs };
      this.logger.info('mcf.observe enqueue pass', counts);
      return counts;
    } catch {
      this.logger.error('mcf.observe enqueue pass failed');
      return null;
    }
  }
}

/** Interval from the environment: 30 minutes by default, never under 5. */
export function mcfObserveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env[MCF_OBSERVE_INTERVAL_ENV];
  const minutes = raw === undefined || raw.trim() === '' ? 30 : Number(raw);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) throw new Error(`${MCF_OBSERVE_INTERVAL_ENV} must be a whole number of minutes from 5 to 1440`);
  return minutes * 60_000;
}

/** The producer, only when enabled, on a runtime that runs background passes and claims `mcf.observe`. */
export function createMcfObservePass(handle: DbHandle, queue: McfObserveEnqueuer, env: NodeJS.ProcessEnv,
  options: { enabled: boolean; startsBackgroundPasses: boolean; jobTypes: readonly JobType[] | undefined }): McfObservePass | undefined {
  if (!options.enabled || !options.startsBackgroundPasses) return undefined;
  if (options.jobTypes !== undefined && !options.jobTypes.includes('mcf.observe')) return undefined;
  return new McfObservePass(() => listCreatorMcfObserveScopes(handle), queue, mcfObserveIntervalMs(env));
}

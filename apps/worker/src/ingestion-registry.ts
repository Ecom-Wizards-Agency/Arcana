import {
  IngestionCounts, IngestionSource, ReportCoverageObservation,
  type JobPayload, type JobType,
} from '@wizard-ads/shared';
import type { ClaimedJob } from '@wizard-ads/db';
import type { AdsProfileContext } from './ads-api.js';
import type { WorkerStore } from './store.js';
import { PermanentJobError } from './permanent-job-error.js';

export interface IngestionContext<K extends JobType = JobType> {
  job: ClaimedJob;
  payload: Extract<JobPayload, { type: K }>;
  profile: AdsProfileContext;
}

export type CoverageTarget = Omit<ReportCoverageObservation,
  'orgId' | 'profileId' | 'source' | 'sourceRows' | 'parsedRows' | 'loadedRows' | 'refusedRows' | 'countsMatch'>;
export type CoverageProducer = (
  observation: ReportCoverageObservation, verifiedLoadedRows: number,
) => Promise<{ offered: number; written: number; unchanged: number }>;

export interface IngestionHandlers<K extends JobType, Plan, Result extends Record<string, unknown>> {
  source: IngestionSource & { jobType: K };
  plan(context: IngestionContext<K>): Plan | Promise<Plan>;
  execute(plan: Plan, context: IngestionContext<K>): Promise<Result>;
  counts(result: Result, plan: Plan): IngestionCounts;
  /** Data only: the registry invokes its producer and verifies the write receipt. */
  coverage: {
    target(result: Result, plan: Plan): CoverageTarget;
  };
}

export type TransactionalAccounting =
  | { kind: 'report'; counts: Parameters<WorkerStore['completeReport']>[1] }
  | { kind: 'attributed'; counts: Parameters<WorkerStore['finishAttributedReport']>[1] }
  | { kind: 'deferred'; reason: 'download-expired' };

export interface TransactionalIngestionHandlers<K extends JobType, Plan, Result extends Record<string, unknown>> {
  source: IngestionSource & { jobType: K };
  plan(context: IngestionContext<K>, completion: ReportCoverageCompletion): Plan | Promise<Plan>;
  execute(plan: Plan, context: IngestionContext<K>): Promise<Result>;
  counts(result: Result, plan: Plan): TransactionalAccounting;
  coverage: { kind: 'report-ledger' };
}

type RuntimeHandlers = IngestionHandlers<JobType, unknown, Record<string, unknown>>;
type RuntimeTransactionalHandlers = TransactionalIngestionHandlers<JobType, unknown, Record<string, unknown>>;
type RegistryEntry =
  | { kind: 'source'; handlers: RuntimeHandlers }
  | { kind: 'transactional-source'; handlers: RuntimeTransactionalHandlers }
  | { kind: 'task'; execute(context: IngestionContext): Promise<Record<string, unknown>> };

/** One map owns source planning, execution, accounting and coverage publication. */
export class IngestionRegistry {
  private readonly handlers = new Map<JobType, RegistryEntry>();

  constructor(
    private readonly producer: CoverageProducer,
    private readonly reportCompletion?: () => ReportCoverageCompletion,
  ) {}

  register<K extends JobType, Plan, Result extends Record<string, unknown>>(
    handlers: IngestionHandlers<K, Plan, Result>,
  ): void {
    const source = IngestionSource.parse(handlers.source);
    if (!handlers.coverage || typeof handlers.coverage.target !== 'function') {
      throw new Error('An ingestion source requires coverage at registration');
    }
    for (const handler of [handlers.plan, handlers.execute, handlers.counts]) {
      if (typeof handler !== 'function') throw new Error('Incomplete ingestion handlers');
    }
    const { plan, execute, counts, coverage: { target } } = handlers;
    // The map key binds the payload type; each entry retains its own plan/result
    // correlation. Erase generics at this single boundary, after validation.
    const runtime = { source, plan, execute, counts, coverage: { target } } as unknown as RuntimeHandlers;
    this.add(source.jobType, { kind: 'source', handlers: runtime });
  }

  /** Report sources retain the existing ledger/coverage transaction. */
  registerTransactionalSource<K extends JobType, Plan, Result extends Record<string, unknown>>(
    handlers: TransactionalIngestionHandlers<K, Plan, Result>,
  ): void {
    const source = IngestionSource.parse(handlers.source);
    if (handlers.coverage?.kind !== 'report-ledger' || typeof this.reportCompletion !== 'function') {
      throw new Error('A transactional source requires coverage at registration');
    }
    for (const handler of [handlers.plan, handlers.execute, handlers.counts]) {
      if (typeof handler !== 'function') throw new Error('Incomplete ingestion handlers');
    }
    const { plan, execute, counts } = handlers;
    const runtime = { source, plan, execute, counts, coverage: { kind: 'report-ledger' } } as unknown as RuntimeTransactionalHandlers;
    this.add(source.jobType, { kind: 'transactional-source', handlers: runtime });
  }

  /** Existing control/lifecycle adapters are installed only by worker composition. */
  installBuiltin<K extends JobType>(type: K, execute: (context: IngestionContext<K>) => Promise<Record<string, unknown>>): void {
    if (!this.handlers.has(type)) this.add(type, { kind: 'task', execute: (context) => execute(narrowContext(context, type)) });
  }

  private add(type: JobType, handler: RegistryEntry): void {
    if (this.handlers.has(type)) throw new Error(`Duplicate ingestion registration: ${type}`);
    this.handlers.set(type, handler);
  }

  async dispatch(context: IngestionContext): Promise<Record<string, unknown>> {
    const entry = this.handlers.get(context.payload.type);
    if (!entry) throw new PermanentJobError(`${context.payload.type} is declared but unimplemented`);
    if (entry.kind === 'task') return entry.execute(context);
    if (entry.kind === 'transactional-source') {
      const completion = this.reportCompletion!();
      const { plan, execute, counts } = entry.handlers;
      const planned = await plan(context, completion);
      const result = await execute(planned, context);
      completion.verify(counts(result, planned));
      return result;
    }
    const { source, plan, execute, counts, coverage } = entry.handlers;
    if (context.payload.type !== source.jobType) throw new PermanentJobError('Ingestion payload type mismatch');
    const planned = await plan(context);
    const result = await execute(planned, context);
    const counted = IngestionCounts.parse(counts(result, planned));
    const observation = ReportCoverageObservation.parse({
      ...coverage.target(result, planned), orgId: context.job.orgId, profileId: context.job.profileId,
      source: source.source, sourceRows: counted.sourceRows, parsedRows: counted.parsedRows,
      loadedRows: counted.loadedRows, refusedRows: counted.refusedRows, countsMatch: true,
    });
    if (source.reportType !== undefined && source.reportType !== observation.reportType) {
      throw new PermanentJobError('Ingestion coverage report type mismatch');
    }
    const receipt = await this.producer(observation, counted.verifiedLoadedRows);
    if (receipt.offered !== 1 || ![0, 1].includes(receipt.written) || ![0, 1].includes(receipt.unchanged)
      || receipt.offered !== receipt.written + receipt.unchanged) {
      throw new Error('Ingestion coverage write counts do not reconcile');
    }
    return result;
  }
}

/** Per-execution capability retains the existing ledger/coverage transaction. */
export class ReportCoverageCompletion {
  private receipt: TransactionalAccounting | undefined;
  constructor(private readonly store: Pick<WorkerStore, 'completeReport' | 'finishAttributedReport'>) {}

  async complete(...args: Parameters<WorkerStore['completeReport']>): Promise<void> {
    if (args[1].coverage === undefined) throw new Error('Registered report completion requires coverage');
    await this.store.completeReport(...args);
    this.receipt = { kind: 'report', counts: args[1] };
  }

  async attributed(...args: Parameters<WorkerStore['finishAttributedReport']>): Promise<void> {
    if (args[2].status === 'completed' && args[2].coverage === undefined) {
      throw new Error('Registered attributed completion requires coverage');
    }
    await this.store.finishAttributedReport(...args);
    if (args[2].status === 'completed') this.receipt = { kind: 'attributed', counts: args[1] };
  }

  /** Only after the worker has durably requested a replacement download URL. */
  deferDownload(): void { this.receipt = { kind: 'deferred', reason: 'download-expired' }; }

  accounting(): TransactionalAccounting {
    if (!this.receipt) throw new Error('Registered report source skipped coverage completion');
    return this.receipt;
  }

  verify(accounting: TransactionalAccounting): void {
    if (this.accounting() !== accounting) throw new Error('Report accounting does not match its completion receipt');
  }
}

function narrowContext<K extends JobType>(context: IngestionContext, type: K): IngestionContext<K> {
  const payload = context.payload;
  if (!isPayloadFor(payload, type)) throw new PermanentJobError('Ingestion payload type mismatch');
  return { ...context, payload };
}

function isPayloadFor<K extends JobType>(payload: JobPayload, type: K): payload is Extract<JobPayload, { type: K }> {
  return payload.type === type;
}

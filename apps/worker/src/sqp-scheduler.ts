/** Weekly, idempotent producer for durable `sqp.request` jobs. */
import {
  listSqpScheduleScopes,
  type DbHandle,
  type SqpScheduleScope,
} from '@wizard-ads/db';
import { SqpRequestJob, type SqpRequestJob as SqpRequestJobType } from '@wizard-ads/shared';
import { SQP_PARSER_VERSION } from '@wizard-ads/sp-api';

const DAY_MS = 86_400_000;

export interface SqpJobEnqueuer {
  enqueue(payload: SqpRequestJobType, runAt: Date, dedupeKey: string): Promise<boolean>;
}

export interface WeeklySqpScheduleResult {
  scopes: number;
  scopesWithAsins: number;
  scopesWithoutAsins: number;
  refusedScopes: number;
  sourceAsinRows: number;
  uniqueAsins: number;
  duplicateAsinRows: number;
  refusedAsinRows: number;
  offeredJobs: number;
  enqueuedJobs: number;
  alreadyPresentJobs: number;
  /** Subset of `enqueuedJobs`: weeks re-offered because a newer parser may accept them. */
  reofferedRefusedJobs: number;
}

export interface WeeklySqpScheduleProducer {
  enqueueDueSqpRequests(): Promise<WeeklySqpScheduleResult>;
}

function profileDate(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const year = read('year');
  const month = read('month');
  const day = read('day');
  if (!year || !month || !day) throw new Error('could not derive profile-local calendar date');
  return `${year}-${month}-${day}`;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Most recent fully completed Sunday-Saturday period in profile-local time. */
export function completedSqpWeek(
  timezone: string,
  now: Date,
): { weekStart: string; weekEnd: string } {
  const today = new Date(`${profileDate(timezone, now)}T00:00:00.000Z`);
  const daysBackToCompletedSaturday = ((today.getUTCDay() - 6 + 7) % 7) || 7;
  const end = new Date(today.valueOf() - daysBackToCompletedSaturday * DAY_MS);
  const start = new Date(end.valueOf() - 6 * DAY_MS);
  return { weekStart: isoDate(start), weekEnd: isoDate(end) };
}

function dedupeKey(payload: SqpRequestJobType): string {
  return ['sqp.request', payload.profileId, payload.marketplaceId, payload.weekStart].join(':');
}

/** Dedupe key of the single re-offer a parser version may make for one week. */
export function sqpParserRetryDedupeKey(baseKey: string, parserVersion: number): string {
  return `${baseKey}:parser-v${parserVersion}`;
}

/**
 * Advisory-lock text shared by the weekly producer's re-offer and
 * `sqp:requeue`. It covers every marketplace of one profile's week, so the two
 * writers serialize before either decides whether the week is already covered.
 */
export function sqpWeekLockKey(profileId: string, weekStart: string): string {
  return ['sqp.request', profileId, 'week', weekStart].join(':');
}

/** First words of the error every refused SQP job has carried since parser version 1. */
const REFUSED_ERROR = /^SQP report refused \d+ rows; canonical promotion is blocked/;
/** The version the refusal line names (WP-335 onward), even when its checkpoint write failed. */
const REFUSING_PARSER = /; parser v(\d+) refused \d+ of \d+ rows/;

/**
 * Parser version that refused a dead job's rows, or null when the job is not
 * dead or died for another reason. The checkpoint summary is read first, then
 * the version the error line names; jobs refused before WP-335 name none and
 * are attributed to version 1, the pass-through parser.
 */
export function refusedParserVersion(job: {
  status: string;
  lastError: string | null;
  result: unknown;
}): number | null {
  if (job.status !== 'dead') return null;
  const envelope = job.result;
  const checkpoint = typeof envelope === 'object' && envelope !== null
    ? (envelope as Record<string, unknown>)['checkpoint']
    : undefined;
  const summary = typeof checkpoint === 'object' && checkpoint !== null
    ? (checkpoint as Record<string, unknown>)['refusalSummary']
    : undefined;
  const version = typeof summary === 'object' && summary !== null
    ? (summary as Record<string, unknown>)['parserVersion']
    : undefined;
  if (typeof version === 'number' && Number.isInteger(version) && version >= 1) return version;
  if (job.lastError === null || !REFUSED_ERROR.test(job.lastError)) return null;
  const named = REFUSING_PARSER.exec(job.lastError)?.[1];
  return named === undefined ? 1 : Number(named);
}

/**
 * Enqueue one versioned re-offer of a week whose scheduled job is dead from a
 * refusal by an older parser. Under the week's advisory lock it re-reads every
 * `sqp.request` job for the week and inserts nothing while any of them is not
 * dead, so a concurrent `sqp:requeue` and this re-offer cannot both leave a
 * live job. The versioned key is itself deduplicated: one re-offer per week and
 * parser version.
 */
export async function reofferRefusedSqpWeek(
  handle: Pick<DbHandle, 'sql'>,
  payload: SqpRequestJobType,
  runAt: Date,
): Promise<boolean> {
  const baseKey = dedupeKey(payload);
  return handle.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtext(${sqpWeekLockKey(payload.profileId, payload.weekStart)}))`;
    const jobs = await sql<{ dedupe_key: string | null; status: string; last_error: string | null; result: unknown }[]>`
      select dedupe_key, status::text as status, last_error, result
        from public.sync_jobs
       where org_id = ${payload.orgId}
         and profile_id = ${payload.profileId}
         and job_type = 'sqp.request'::public.sync_job_type
         and payload->>'marketplaceId' = ${payload.marketplaceId}
         and payload->>'weekStart' = ${payload.weekStart}
    `;
    if (jobs.some((job) => job.status !== 'dead')) return false;
    const base = jobs.find((job) => job.dedupe_key === baseKey);
    if (base === undefined) return false;
    const version = refusedParserVersion({ status: base.status, lastError: base.last_error, result: base.result });
    if (version === null || version >= SQP_PARSER_VERSION) return false;
    const inserted = await sql<{ id: string }[]>`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, run_after, dedupe_key)
      values (${payload.orgId}, ${payload.profileId}, 'sqp.request'::public.sync_job_type,
              ${JSON.stringify(payload)}::jsonb, ${runAt.toISOString()}::timestamptz,
              ${sqpParserRetryDedupeKey(baseKey, SQP_PARSER_VERSION)})
      on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
      returning id
    `;
    return inserted.length === 1;
  }) as Promise<boolean>;
}

export class PostgresWeeklySqpScheduler implements WeeklySqpScheduleProducer {
  constructor(
    private readonly handle: Pick<DbHandle, 'sql'>,
    private readonly jobs: SqpJobEnqueuer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueueDueSqpRequests(): Promise<WeeklySqpScheduleResult> {
    const scopes = await listSqpScheduleScopes(this.handle);
    const observedAt = this.now();
    const totals: WeeklySqpScheduleResult = {
      scopes: scopes.length,
      scopesWithAsins: 0,
      scopesWithoutAsins: 0,
      refusedScopes: 0,
      sourceAsinRows: 0,
      uniqueAsins: 0,
      duplicateAsinRows: 0,
      refusedAsinRows: 0,
      offeredJobs: 0,
      enqueuedJobs: 0,
      alreadyPresentJobs: 0,
      reofferedRefusedJobs: 0,
    };

    for (const scope of scopes) {
      this.countAsins(totals, scope);
      if (scope.asins.length === 0) {
        totals.scopesWithoutAsins += 1;
        continue;
      }
      let week: { weekStart: string; weekEnd: string };
      try {
        week = completedSqpWeek(scope.timezone, observedAt);
      } catch {
        totals.refusedScopes += 1;
        continue;
      }
      totals.scopesWithAsins += 1;
      const payload = SqpRequestJob.parse({
        type: 'sqp.request',
        orgId: scope.orgId,
        profileId: scope.profileId,
        marketplaceId: scope.marketplaceId,
        asins: scope.asins,
        ...week,
      });
      totals.offeredJobs += 1;
      let inserted = await this.jobs.enqueue(payload, observedAt, dedupeKey(payload));
      if (!inserted && await reofferRefusedSqpWeek(this.handle, payload, observedAt)) {
        inserted = true;
        totals.reofferedRefusedJobs += 1;
      }
      if (inserted) totals.enqueuedJobs += 1;
      else totals.alreadyPresentJobs += 1;
    }

    if (
      totals.scopes !== totals.scopesWithAsins + totals.scopesWithoutAsins + totals.refusedScopes ||
      totals.sourceAsinRows !==
        totals.uniqueAsins + totals.duplicateAsinRows + totals.refusedAsinRows ||
      totals.offeredJobs !== totals.enqueuedJobs + totals.alreadyPresentJobs ||
      totals.reofferedRefusedJobs > totals.enqueuedJobs
    ) {
      throw new Error('weekly SQP schedule counts do not reconcile');
    }
    return totals;
  }

  private countAsins(totals: WeeklySqpScheduleResult, scope: SqpScheduleScope): void {
    totals.sourceAsinRows += scope.sourceRows;
    totals.uniqueAsins += scope.asins.length;
    totals.duplicateAsinRows += scope.duplicateRows;
    totals.refusedAsinRows += scope.refusedRows;
  }
}

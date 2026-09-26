/**
 * Attended requeue of one dead weekly SQP job (WP-335).
 *
 *   pnpm --filter @wizard-ads/worker run sqp:requeue -- \
 *     --org <slug> --profile <label> --week-start YYYY-MM-DD [--fresh-reports]
 *
 * Resets exactly one dead `sqp.request` job for that profile and week to
 * `queued` with its attempts cleared and `run_after` now. The durable
 * checkpoint is kept, so reports Amazon already produced are downloaded again
 * by document id instead of being re-requested; `--fresh-reports` drops the
 * checkpoint when those documents can no longer be fetched. The command refuses
 * when any other job already covers the week, and when this checkout's parser
 * version is the one that refused it: the same document would be refused again.
 *
 * The version check reads this checkout, not the running worker. Run the
 * command only after the release carrying the new parser is deployed, from a
 * checkout of that release. It takes the same per-week advisory lock as the
 * weekly producer's re-offer, so the two cannot both leave a live job.
 */
import { pathToFileURL } from 'node:url';
import { connectionStringFromEnv, createDb, type DbHandle } from '@wizard-ads/db';
import { SQP_PARSER_VERSION, type SqpRefusalSummary } from '@wizard-ads/sp-api';
import { refusedParserVersion, sqpWeekLockKey } from './sqp-scheduler.js';
import type { SqpRequeueRecord } from './sqp.js';

const USAGE =
  'usage: sqp:requeue --org <slug> --profile <label> --week-start YYYY-MM-DD [--fresh-reports] ' +
  '(run only after the release carrying the parser is deployed, from a checkout of that release)';
const FAILURE = 'sqp:requeue failed; no job was changed by a failed transaction';
const CHECKPOINT_KIND = 'sqp_workflow_checkpoint';
const LAST_ERROR_LIMIT = 4_000;

/** A refusal names the condition only; it never echoes a label or slug back. */
export class SqpRequeueRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqpRequeueRefused';
  }
}

export interface SqpRequeueArgs {
  orgSlug: string;
  profileLabel: string;
  weekStart: string;
  freshReports: boolean;
}

export function parseSqpRequeueArgs(args: readonly string[]): SqpRequeueArgs {
  const values = new Map<string, string>();
  let freshReports = false;
  const rest = args[0] === '--' ? args.slice(1) : [...args];
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (name === '--fresh-reports' && !freshReports) {
      freshReports = true;
      continue;
    }
    const value = rest[index + 1];
    if (!name || !['--org', '--profile', '--week-start'].includes(name) || values.has(name) ||
      value === undefined || value.startsWith('--') || value.trim().length === 0) {
      throw new SqpRequeueRefused(USAGE);
    }
    values.set(name, value.trim());
    index += 1;
  }
  const orgSlug = values.get('--org');
  const profileLabel = values.get('--profile');
  const weekStart = values.get('--week-start');
  if (!orgSlug || !profileLabel || !weekStart) throw new SqpRequeueRefused(USAGE);
  const parsed = new Date(`${weekStart}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== weekStart) {
    throw new SqpRequeueRefused('--week-start must be a calendar date YYYY-MM-DD');
  }
  if (parsed.getUTCDay() !== 0) throw new SqpRequeueRefused('--week-start must be a Sunday');
  return { orgSlug, profileLabel, weekStart, freshReports };
}

export interface SqpRequeueResult {
  event: 'sqp.requeue';
  jobId: string;
  orgId: string;
  profileId: string;
  marketplaceId: string;
  weekStart: string;
  weekEnd: string;
  previousStatus: 'dead';
  previousAttempts: number;
  refusedByParserVersion: number | null;
  currentParserVersion: number;
  checkpointKept: boolean;
  /** Batches whose Amazon report is reused (ready or confirmed empty). */
  reusedReports: number;
  /** Batches the job will request from Amazon; null when the checkpoint was dropped and all are re-planned. */
  reportsToRequest: number | null;
  requeuedAt: string;
}

interface JobRow {
  id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  result: unknown;
  marketplace_id: string | null;
  week_end: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep a stored summary only when it has the shape this release writes. */
function refusalSummaryOf(value: unknown): SqpRefusalSummary | null {
  if (!isRecord(value)) return null;
  const count = (field: unknown) => typeof field === 'number' && Number.isInteger(field) && field >= 0;
  const reasons = value['topReasons'];
  const sample = value['firstRefusedRow'];
  const valid = count(value['parserVersion']) && count(value['sourceRows']) && count(value['refusedRows']) &&
    count(value['distinctReasons']) && Array.isArray(reasons) &&
    reasons.every((entry) => isRecord(entry) && typeof entry['reason'] === 'string' && count(entry['count'])) &&
    (sample === null || (isRecord(sample) && count(sample['index']) && typeof sample['rowIsObject'] === 'boolean' &&
      Array.isArray(sample['presentFields']) && sample['presentFields'].every((field) => typeof field === 'string') &&
      Array.isArray(sample['missingFields']) && sample['missingFields'].every((field) => typeof field === 'string') &&
      count(sample['unrecognizedFieldCount'])));
  return valid ? value as unknown as SqpRefusalSummary : null;
}

function checkpointOf(result: unknown): Record<string, unknown> | null {
  if (result === null) return null;
  if (!isRecord(result) || result['kind'] !== CHECKPOINT_KIND || !isRecord(result['checkpoint'])) {
    throw new SqpRequeueRefused('the dead job result is not an SQP workflow checkpoint');
  }
  return result['checkpoint'];
}

/** Requeue the one dead `sqp.request` job for an org, profile label and week. */
export async function requeueDeadSqpWeek(
  handle: Pick<DbHandle, 'sql'>,
  input: SqpRequeueArgs & { now?: Date },
): Promise<SqpRequeueResult> {
  const requeuedAt = (input.now ?? new Date()).toISOString();
  return handle.sql.begin(async (sql) => {
    const orgs = await sql<{ id: string }[]>`
      select id from public.orgs where slug = ${input.orgSlug}
    `;
    if (orgs.length !== 1) throw new SqpRequeueRefused('no organization has that slug');
    const orgId = orgs[0]!.id;

    const profiles = await sql<{ id: string }[]>`
      select id from public.ad_profiles
       where org_id = ${orgId}
         and (account_name = ${input.profileLabel} or amazon_profile_id = ${input.profileLabel})
    `;
    if (profiles.length !== 1) {
      throw new SqpRequeueRefused(`the profile label matches ${profiles.length} profiles in that organization; expected 1`);
    }
    const profileId = profiles[0]!.id;
    await sql`select pg_advisory_xact_lock(hashtext(${sqpWeekLockKey(profileId, input.weekStart)}))`;

    const jobs = await sql<JobRow[]>`
      select id, status::text as status, attempts, last_error, result,
             payload->>'marketplaceId' as marketplace_id, payload->>'weekEnd' as week_end
        from public.sync_jobs
       where org_id = ${orgId}
         and profile_id = ${profileId}
         and job_type = 'sqp.request'::public.sync_job_type
         and payload->>'weekStart' = ${input.weekStart}
       order by created_at desc, id desc
       for update
    `;
    if (jobs.length === 0) throw new SqpRequeueRefused('no sqp.request job exists for that profile and week');
    if (new Set(jobs.map((job) => job.marketplace_id)).size !== 1) {
      throw new SqpRequeueRefused('sqp.request jobs for that week span more than one marketplace');
    }
    const live = jobs.find((job) => job.status !== 'dead');
    if (live !== undefined) {
      throw new SqpRequeueRefused(`a ${live.status} sqp.request job already covers that week`);
    }
    const target = jobs[0]!;
    if (target.marketplace_id === null || target.week_end === null) {
      throw new SqpRequeueRefused('the dead job payload lacks its marketplace or week end');
    }
    const marketplaceId = target.marketplace_id;
    const weekEnd = target.week_end;
    const refusedBy = refusedParserVersion({
      status: target.status,
      lastError: target.last_error,
      result: target.result,
    });
    if (refusedBy !== null && refusedBy >= SQP_PARSER_VERSION) {
      throw new SqpRequeueRefused(
        `parser v${refusedBy} already refused that week; this checkout's parser is v${SQP_PARSER_VERSION}, so a requeue would be refused again`,
      );
    }

    const checkpoint = input.freshReports ? null : checkpointOf(target.result);
    let nextResult: unknown = null;
    let reusedReports = 0;
    let batchCount = 0;
    if (checkpoint !== null) {
      const batches = Array.isArray(checkpoint['batches']) ? checkpoint['batches'] : [];
      batchCount = batches.length;
      reusedReports = batches.filter((batch) =>
        isRecord(batch) && (batch['status'] === 'ready' || batch['status'] === 'empty')).length;
      const previousRefusal = refusalSummaryOf(checkpoint['refusalSummary']);
      const record: SqpRequeueRecord = {
        requeuedAt,
        previousAttempts: target.attempts,
        refusedByParserVersion: refusedBy,
        previousRefusal,
      };
      const { refusalSummary: _dropped, ...kept } = checkpoint;
      const requeues = Array.isArray(checkpoint['requeues']) ? checkpoint['requeues'] : [];
      nextResult = {
        ...(target.result as Record<string, unknown>),
        checkpoint: { ...kept, requeues: [...requeues, record] },
      };
    }
    const audit = `requeued by sqp:requeue at ${requeuedAt}` +
      `${input.freshReports ? ' with fresh reports' : ''}; previous error: ${target.last_error ?? 'none'}`;

    const updated = await sql<{ id: string }[]>`
      update public.sync_jobs
         set status = 'queued'::public.sync_job_status,
             attempts = 0,
             run_after = now(),
             claimed_by = null,
             claimed_at = null,
             claim_token = null,
             started_at = null,
             finished_at = null,
             last_error = ${audit.slice(0, LAST_ERROR_LIMIT)},
             result = ${nextResult === null ? null : JSON.stringify(nextResult)}::jsonb
       where id = ${target.id}
         and status = 'dead'::public.sync_job_status
      returning id
    `;
    if (updated.length !== 1 || updated[0]?.id !== target.id) {
      throw new SqpRequeueRefused('the dead job changed before it could be requeued');
    }
    return {
      event: 'sqp.requeue',
      jobId: target.id,
      orgId,
      profileId,
      marketplaceId,
      weekStart: input.weekStart,
      weekEnd,
      previousStatus: 'dead',
      previousAttempts: target.attempts,
      refusedByParserVersion: refusedBy,
      currentParserVersion: SQP_PARSER_VERSION,
      checkpointKept: checkpoint !== null,
      reusedReports,
      reportsToRequest: checkpoint === null ? null : batchCount - reusedReports,
      requeuedAt,
    };
  }) as Promise<SqpRequeueResult>;
}

export async function runSqpRequeueCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = console.log,
): Promise<SqpRequeueResult> {
  const input = parseSqpRequeueArgs(args);
  const handle = createDb({ connectionString: connectionStringFromEnv(env), max: 1 });
  try {
    const result = await requeueDeadSqpWeek(handle, input);
    // One audit line of identifiers and counts; no label, slug or report value.
    write(JSON.stringify(result));
    return result;
  } finally {
    await handle.close();
  }
}

/** Only this command's own refusals are printed; a driver error can name a host or user. */
export function sqpRequeueFailureMessage(error: unknown): string {
  return error instanceof SqpRequeueRefused ? error.message : FAILURE;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSqpRequeueCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(sqpRequeueFailureMessage(error));
    process.exitCode = 1;
  });
}

/**
 * General-worker MCF housekeeping (WP-338n): the path that keeps custody expiry,
 * mask retention and alerting running when the dedicated mcf unit is stopped
 * or pg_cron is absent.
 *
 * Every 5 minutes one tick:
 *  1. calls app.expire_creator_mcf_custody() (the sweep's three rules);
 *  2. once per UTC day, calls app.purge_creator_mcf_masks();
 *  3. reads app.creator_mcf_alert_summary() and, when the set of active
 *     conditions changed (a code appeared or cleared, or a new send id appeared
 *     under an active code) or a day has passed while any persists, posts one
 *     message to OPENSPELL_MCF_ALERT_WEBHOOK_URL. Without a webhook the same
 *     message is logged and nothing is sent.
 *
 * A message is built only from known condition codes, integer counts, UUID send
 * ids and the samples URL: nothing from the summary is copied through as free
 * text, so a recipient's name, address or mask cannot reach it. Failures are
 * counted and logged by code, never by message, and never throw out of a tick.
 * Nothing here calls Amazon.
 */
import type { DbHandle } from '@wizard-ads/db';
import { expireCreatorMcfCustody, purgeCreatorMcfMasks, readCreatorMcfAlertSummary, type CreatorMcfAlertCode, type CreatorMcfAlertSummary } from '@wizard-ads/db/worker';

export const MCF_ALERT_WEBHOOK_ENV = 'OPENSPELL_MCF_ALERT_WEBHOOK_URL';
/** The web origin the samples link points at; optional, the path alone without it. */
export const MCF_ALERT_APP_URL_ENV = 'WIZARD_ADS_APP_URL';
export const MCF_HOUSEKEEPING_INTERVAL_MS = 5 * 60_000;
/** A condition set that persists is posted again this long after the last delivered message. */
export const MCF_ALERT_REMINDER_MS = 24 * 60 * 60_000;
export const MCF_ALERT_WEBHOOK_TIMEOUT_MS = 10_000;
export const MCF_SAMPLES_PATH = '/creators/samples';

/** Codes app.creator_mcf_alert_summary() returns, in message order. */
export const MCF_ALERT_CODES = ['uncertain_over_15m', 'lane_escalated', 'ladder_exhausted', 'conflict', 'heartbeat_stale', 'custody_residue',
  'authorization_failure'] as const satisfies readonly CreatorMcfAlertCode[];
/** Fails to compile when the ledger gains a code this list does not name. */
const everyAlertCodeListed: [Exclude<CreatorMcfAlertCode, (typeof MCF_ALERT_CODES)[number]>] extends [never] ? true : never = true;
void everyAlertCodeListed;
/** A code the summary returned that this worker does not know; kept as a condition so it is never silently dropped. */
export const MCF_ALERT_UNKNOWN_CODE = 'unknown_condition';
export type McfAlertConditionCode = CreatorMcfAlertCode | typeof MCF_ALERT_UNKNOWN_CODE;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_CODES: ReadonlySet<string> = new Set(MCF_ALERT_CODES);
const CODE_ORDER: readonly McfAlertConditionCode[] = [...MCF_ALERT_CODES, MCF_ALERT_UNKNOWN_CODE];

export interface McfHousekeepingStore {
  expire(): Promise<{ expiredTtl: number; expiredUnclaimed: number; uncertainCrash: number }>;
  purge(): Promise<{ scheduled: number; backstop: number; purged: number }>;
  alertSummary(): Promise<CreatorMcfAlertSummary>;
}

export type McfAlertFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'body'>>;
export type McfHousekeepingLogger = Pick<Console, 'info' | 'warn' | 'error'>;

export interface McfHousekeepingConfig {
  /** Absent: messages are logged, never posted. Never logged itself. */
  webhookUrl: string | null;
  /** Absolute when WIZARD_ADS_APP_URL is set, otherwise the path. */
  samplesUrl: string;
}

export class McfHousekeepingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McfHousekeepingConfigError';
  }
}

/**
 * The webhook and the samples link from the environment. An empty value is
 * absent. A value that is present but invalid throws at boot; the error names
 * the key, never the value, because the webhook URL is a secret.
 */
export function mcfHousekeepingConfigFromEnv(env: NodeJS.ProcessEnv): McfHousekeepingConfig {
  const webhookRaw = env[MCF_ALERT_WEBHOOK_ENV]?.trim() ?? '';
  let webhookUrl: string | null = null;
  if (webhookRaw !== '') {
    const url = URL.canParse(webhookRaw) ? new URL(webhookRaw) : null;
    if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
      throw new McfHousekeepingConfigError(`${MCF_ALERT_WEBHOOK_ENV} must be an https URL without credentials or fragment`);
    }
    webhookUrl = url.toString();
  }
  const appRaw = env[MCF_ALERT_APP_URL_ENV]?.trim() ?? '';
  let samplesUrl = MCF_SAMPLES_PATH;
  if (appRaw !== '') {
    const url = URL.canParse(appRaw) ? new URL(appRaw) : null;
    const local = url !== null && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url === null || (url.protocol !== 'https:' && !local) || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new McfHousekeepingConfigError(`${MCF_ALERT_APP_URL_ENV} must be an https origin without a path (http only for localhost)`);
    }
    samplesUrl = `${url.origin}${MCF_SAMPLES_PATH}`;
  }
  return { webhookUrl, samplesUrl };
}

/** One active condition, reduced to what a message may carry. */
export interface McfAlertCondition {
  code: McfAlertConditionCode;
  count: number;
  /** UUIDs only; anything else the summary returned is dropped and counted in `sendIdsWithheld`. */
  sendIds: string[];
  sendIdsWithheld: number;
}

/** Active conditions only (count above 0), in a fixed order, with every field checked. */
export function activeMcfAlertConditions(summary: CreatorMcfAlertSummary): McfAlertCondition[] {
  const byCode = new Map<McfAlertConditionCode, McfAlertCondition>();
  for (const condition of summary.conditions) {
    const count = Number.isSafeInteger(condition.count) && condition.count > 0 ? condition.count : 0;
    if (count === 0) continue;
    const code: McfAlertConditionCode = KNOWN_CODES.has(condition.code) ? condition.code : MCF_ALERT_UNKNOWN_CODE;
    const ids = Array.isArray(condition.sendIds) ? condition.sendIds : [];
    const sendIds = ids.filter((id): id is string => typeof id === 'string' && UUID.test(id));
    const entry = byCode.get(code) ?? { code, count: 0, sendIds: [], sendIdsWithheld: 0 };
    entry.count += count;
    entry.sendIds.push(...sendIds);
    entry.sendIdsWithheld += ids.length - sendIds.length;
    byCode.set(code, entry);
  }
  return CODE_ORDER.flatMap((code) => byCode.get(code) ?? []);
}

export type McfAlertReason = 'changed' | 'cleared' | 'reminder';

/**
 * A fixed gloss after a code whose name alone misleads. uncertain_over_15m counts uncertain sends and, since WP-338i,
 * cancel_dispatching sends (a cancel request Amazon has not settled): both are unsettled for over 15 minutes.
 */
export const MCF_ALERT_GLOSS: Partial<Record<McfAlertConditionCode, string>> = {
  uncertain_over_15m: 'uncertain sends or cancels unsettled for over 15 minutes',
};

/** The message text: codes, counts, send ids and the samples URL. */
export function formatMcfAlert(reason: McfAlertReason, conditions: readonly McfAlertCondition[], samplesUrl: string,
  previous: readonly McfAlertConditionCode[]): string {
  const heading = reason === 'cleared'
    ? `Arcana MCF alert: no conditions active (cleared: ${previous.join(', ')})`
    : `Arcana MCF alert: ${conditions.length} condition${conditions.length === 1 ? '' : 's'} active`
      + (reason === 'reminder' ? ' (daily reminder, unchanged)' : ' (changed)');
  const lines = conditions.map((condition) => {
    const listed = condition.sendIds.length === 0 ? '' : `; sends: ${condition.sendIds.join(', ')}`;
    const more = condition.count > condition.sendIds.length && condition.sendIds.length > 0
      ? ` (${condition.count - condition.sendIds.length} more not listed)` : '';
    const withheld = condition.sendIdsWithheld > 0 ? ` (${condition.sendIdsWithheld} malformed ids withheld)` : '';
    const gloss = MCF_ALERT_GLOSS[condition.code];
    return `- ${condition.code}${gloss === undefined ? '' : ` (${gloss})`}: ${condition.count}${listed}${more}${withheld}`;
  });
  return [heading, ...lines, `Samples: ${samplesUrl}`].join('\n');
}

export type McfWebhookFailure = 'webhook_http' | 'webhook_timeout' | 'webhook_network';
export type McfHousekeepingStep = 'expire' | 'purge' | 'summary';

/** What one tick did. Counts are the ledger's own answers; a step that failed says so rather than reading as zero. */
export interface McfHousekeepingTick {
  at: string;
  expire: { expiredTtl: number; expiredUnclaimed: number; uncertainCrash: number } | 'failed';
  purge: { scheduled: number; backstop: number; purged: number } | 'not_due' | 'failed';
  /** Active conditions, or 'failed' when the summary could not be read. */
  conditions: { code: McfAlertConditionCode; count: number }[] | 'failed';
  alert: McfAlertReason | 'none';
  delivery: 'not_due' | 'sent' | 'failed' | 'no_webhook';
  failures: (McfHousekeepingStep | McfWebhookFailure)[];
}

/** Totals since this process started. */
export interface McfHousekeepingTotals {
  ticks: number;
  expireFailures: number;
  purgeRuns: number;
  purgeFailures: number;
  summaryFailures: number;
  alertsSent: number;
  alertsLogged: number;
  webhookFailures: number;
}

export interface McfHousekeepingDependencies {
  store: McfHousekeepingStore;
  config: McfHousekeepingConfig;
  fetch?: McfAlertFetch;
  logger?: McfHousekeepingLogger;
  now?: () => Date;
  intervalMs?: number;
}

const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;
/** A Postgres SQLSTATE or an error class name, never a message. */
const errorCode = (error: unknown): string => {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
  return error instanceof Error && SAFE_CODE.test(error.name) ? error.name : 'unknown';
};

type NotifiedConditions = Map<McfAlertConditionCode, { count: number; sendIds: Set<string> }>;

/**
 * Whether `next` differs from what was last notified: a code appeared or cleared, a send id is new under a
 * code, or a code's count rose past its listed ids (items without a send id, such as a stale heartbeat
 * scope, or sends beyond the summary's 50-id list).
 */
function alertSetChanged(next: readonly McfAlertCondition[], previous: NotifiedConditions): boolean {
  if (next.length !== previous.size) return true;
  return next.some((condition) => {
    const seen = previous.get(condition.code);
    return seen === undefined || condition.sendIds.some((id) => !seen.sendIds.has(id))
      || (condition.count > seen.count && condition.count > condition.sendIds.length);
  });
}

export class McfHousekeepingPass {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<McfHousekeepingTick | null> | undefined;
  /** UTC day (YYYY-MM-DD) of the last successful purge. */
  private purgedDay: string | null = null;
  /**
   * The active conditions last delivered (or logged, without a webhook), their send ids, and when.
   * Null until the first summary.
   */
  private notified: { conditions: NotifiedConditions; at: number } | null = null;
  private readonly totalsSoFar: McfHousekeepingTotals = { ticks: 0, expireFailures: 0, purgeRuns: 0, purgeFailures: 0, summaryFailures: 0,
    alertsSent: 0, alertsLogged: 0, webhookFailures: 0 };
  private readonly fetch: McfAlertFetch;
  private readonly logger: McfHousekeepingLogger;
  private readonly now: () => Date;
  readonly intervalMs: number;

  constructor(private readonly deps: McfHousekeepingDependencies) {
    this.fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.logger = deps.logger ?? console;
    this.now = deps.now ?? (() => new Date());
    this.intervalMs = deps.intervalMs ?? MCF_HOUSEKEEPING_INTERVAL_MS;
  }

  start(): void {
    if (this.timer !== undefined) return;
    if (!this.deps.config.samplesUrl.startsWith('http')) {
      this.logger.warn('MCF alerts carry a relative samples link', { missing: MCF_ALERT_APP_URL_ENV });
    }
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  /** Stops the schedule and waits for a tick in progress. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  totals(): McfHousekeepingTotals {
    return { ...this.totalsSoFar };
  }

  /** One tick; null when a tick is already running. Never rejects. */
  runOnce(): Promise<McfHousekeepingTick | null> {
    if (this.inFlight) return Promise.resolve(null);
    this.inFlight = this.tick().catch(() => {
      this.logger.error('MCF housekeeping tick failed', { code: 'unexpected' });
      return null;
    }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async tick(): Promise<McfHousekeepingTick> {
    const at = this.now();
    const totals = this.totalsSoFar;
    totals.ticks++;
    const failures: McfHousekeepingTick['failures'] = [];
    const failed = (step: McfHousekeepingStep, error: unknown): void => {
      failures.push(step);
      this.logger.error('MCF housekeeping step failed', { step, code: errorCode(error) });
    };

    let expire: McfHousekeepingTick['expire'];
    try { expire = await this.deps.store.expire(); }
    catch (error) { expire = 'failed'; totals.expireFailures++; failed('expire', error); }

    let purge: McfHousekeepingTick['purge'] = 'not_due';
    const day = at.toISOString().slice(0, 10);
    if (this.purgedDay !== day) {
      try {
        purge = await this.deps.store.purge();
        this.purgedDay = day;
        totals.purgeRuns++;
      } catch (error) { purge = 'failed'; totals.purgeFailures++; failed('purge', error); }
    }

    let active: McfAlertCondition[] | null = null;
    try { active = activeMcfAlertConditions(await this.deps.store.alertSummary()); }
    catch (error) { totals.summaryFailures++; failed('summary', error); }

    let alert: McfHousekeepingTick['alert'] = 'none';
    let delivery: McfHousekeepingTick['delivery'] = 'not_due';
    if (active !== null) {
      const conditions: NotifiedConditions = new Map(active.map((condition) =>
        [condition.code, { count: condition.count, sendIds: new Set(condition.sendIds) }]));
      const previous = this.notified;
      if (previous === null) {
        // First reading after start: an empty set is the baseline; anything active is news.
        if (active.length === 0) this.notified = { conditions, at: at.getTime() };
        else alert = 'changed';
      } else if (alertSetChanged(active, previous.conditions)) {
        alert = active.length === 0 ? 'cleared' : 'changed';
      } else if (active.length > 0 && at.getTime() - previous.at >= MCF_ALERT_REMINDER_MS) {
        alert = 'reminder';
      }
      if (alert !== 'none') {
        const text = formatMcfAlert(alert, active, this.deps.config.samplesUrl, [...(previous?.conditions.keys() ?? [])]);
        delivery = await this.deliver(text, failures);
        if (delivery !== 'failed') this.notified = { conditions, at: at.getTime() };
      } else if (previous !== null) {
        // A send that resolved (or a count that fell) while its code stays active is folded in without a post;
        // the reminder clock keeps running.
        this.notified = { conditions, at: previous.at };
      }
    }

    const result: McfHousekeepingTick = {
      at: at.toISOString(), expire, purge,
      conditions: active === null ? 'failed' : active.map(({ code, count }) => ({ code, count })),
      alert, delivery, failures,
    };
    this.logger.info('MCF housekeeping', { ...result });
    return result;
  }

  private async deliver(text: string, failures: McfHousekeepingTick['failures']): Promise<'sent' | 'failed' | 'no_webhook'> {
    const url = this.deps.config.webhookUrl;
    if (url === null) {
      this.totalsSoFar.alertsLogged++;
      this.logger.warn('MCF alert (no webhook configured)', { text });
      return 'no_webhook';
    }
    let failure: McfWebhookFailure;
    let status: number | null = null;
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        redirect: 'error',
        signal: AbortSignal.timeout(MCF_ALERT_WEBHOOK_TIMEOUT_MS),
      });
      // The response body is never read: nothing a webhook answers belongs in a log.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) {
        this.totalsSoFar.alertsSent++;
        return 'sent';
      }
      failure = 'webhook_http';
      status = response.status;
    } catch (error) {
      failure = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'webhook_timeout' : 'webhook_network';
    }
    this.totalsSoFar.webhookFailures++;
    failures.push(failure);
    this.logger.error('MCF alert webhook failed', { code: failure, status, webhookFailures: this.totalsSoFar.webhookFailures });
    return 'failed';
  }
}

/** The production store over the worker's service-role database handle. */
export function postgresMcfHousekeepingStore(handle: DbHandle): McfHousekeepingStore {
  return {
    expire: () => expireCreatorMcfCustody(handle),
    purge: () => purgeCreatorMcfMasks(handle),
    alertSummary: () => readCreatorMcfAlertSummary(handle),
  };
}

/**
 * The general worker's pass, or undefined on a runtime that does not start
 * background passes. It has no enable flag: with no sends the sweep, purge and
 * summary are no-ops, and without a webhook nothing leaves the process.
 */
export function createMcfHousekeepingPass(handle: DbHandle, env: NodeJS.ProcessEnv, startsBackgroundPasses: boolean,
  overrides: Omit<McfHousekeepingDependencies, 'store' | 'config'> = {}): McfHousekeepingPass | undefined {
  if (!startsBackgroundPasses) return undefined;
  return new McfHousekeepingPass({ ...overrides, store: postgresMcfHousekeepingStore(handle), config: mcfHousekeepingConfigFromEnv(env) });
}

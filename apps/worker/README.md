# worker

The worker handles Amazon entity sync, asynchronous report ingestion, recommendation
runs and crosscheck ingestion. Web requests preview, approve and enqueue work;
provider execution belongs here. The root [installation guide](../../README.md)
describes agency onboarding and the supported runtime topology.

The worker uses a service-role connection with the job payload's `orgId`.
Job claims are intentionally org-blind so one worker can drain several agencies.
Before dispatching a job, [`SyncWorker.execute`](src/worker.ts) checks that the
payload's org, profile and job type match the claimed row, then verifies that the
profile belongs to the payload's org. This check precedes every dispatched
mutation; claiming a job alone does not establish its agency boundary.

## The shape of it

| Module | What it is |
|---|---|
| `worker.ts` | The claim loop, the job handlers, the retry policy, and the two periodic passes. |
| `store.ts` | Every database call the worker makes, behind `WorkerStore` so a handler can be tested without one. |
| `parsers.ts` | Gunzip + the typed per-report-type row parsers, and the grain each one lands on. |
| `region-token-buckets.ts` | Per-region concurrency caps. NA/EU/FE are separate hosts and separate limits. |
| `crosscheck.ts` | The seam WP-10's `runCrosscheckIngest` is called through, plus the retry classification. |
| `schedules.ts` | The default cadences, as rows rather than as a comment. |
| `ads-api.ts` | The narrow client interface the worker needs, plus `DbAdsApiClient` — the adapter that maps it onto the real `@wizard-ads/ads-api` client (per-connection/per-region, Vault-backed refresh token). |
| `amazon-connections.ts` | Serial single-use authorization exchange and resumable, counted regional discovery. |
| `amazon-connection-adapters.ts` | Worker-only provider credentials and protected database commands for connection operations. |
| `main.ts` | Process entry: config, health server, the two passes, graceful shutdown. |
| `marketing-stream-sqs.ts` | Optional SQS long-poll ingress. It acknowledges only after the raw ledger and hourly projection counts reconcile. |
| `spapi-sqp.ts` | Exact profile/marketplace binding, Vault-backed LWA token composition, and regional Reports API client pool. |
| `sqp-scheduler.ts` | Idempotent weekly producer using the last complete profile-local Sunday–Saturday week and counted advertised ASINs. |

## The job pipeline

Reporting v3 is asynchronous and slow — a report can take hours — so it is three jobs, not one long
one. A worker killed halfway through loses at most one short step:

```
report.request  create the report, write report_requests, enqueue a poll for +5min
report.poll     PENDING → reschedule 5→10→20→30min (capped), give up at 4h
                COMPLETED → enqueue report.fetch
report.fetch    stream, gunzip, parse, upsert into the fact partition, assert parsed == loaded
```

`entity.sync` diffs a listing against the entity mirror and writes `entity_changes` rows for the
fields that moved. **Only a `full` pass tombstones.** A delta pass has no way to tell "absent
because deleted" from "absent because this pass did not list that type", so sweeping on one would
tombstone every keyword the moment a campaign-only pass ran.

`crosscheck.ingest` calls `runCrosscheckIngest` from `@wizard-ads/crosscheck-cli` (WP-10). A
`mismatch` headline is a **success** — the verdict is the job's product. Only a throw fails it, and
two throws skip the retries entirely (see below).

## Counting, because exit codes lie

Every list-driven step counts its outputs against its inputs and fails when they disagree:

- `entity.sync` asserts entities listed against rows upserted.
- `report.fetch` asserts fact rows parsed against fact rows loaded, and `report_requests` carries
  both plus a generated `counts_match`.
- `crosscheck.ingest` logs rows parsed against rows kept, and verdicts written against findings.

`spCampaigns` is the one place these numbers legitimately differ: Amazon sends one row per campaign
per day and `fact_profile_daily` holds one row per profile per day, so the parser sums by date. The
job result reports `reportRows` (what Amazon sent) alongside `parsed`/`loaded` (fact rows).

## Retry policy

| Situation | What happens |
|---|---|
| Any handler throws | `attempts++`, requeued with exponential backoff, `dead` after `max_attempts` |
| `AdsApiRetryableError` with `Retry-After` | requeued with exactly that delay |
| `PermanentJobError` (including accounting mismatch), `ExportContractError`, `ProfileNotFound` | straight to `dead` on the current attempt; no further retries |
| Reporting v3 create may have reached Amazon without returning an id | fenced claim retained in `running` (exit 78); tokenless claim goes to `dead`; attended reconciliation only |
| General worker SIGKILLed mid-job | the tokenless job sits in `running` until a sweep requeues it |
| Evo report worker SIGKILLed mid-job | the fenced job remains `running`; elapsed time never authorizes replay |

The general worker still needs `StaleClaimReaper`: legacy `claim_sync_jobs` only sees `queued`, so
without a sweep a killed tokenless worker's job is lost. pg_cron runs
`requeue_stale_sync_jobs()` every 15 minutes on Supabase; the reaper runs the same function
in-process for plain Postgres. Both paths ignore token-bearing claims. The Evo role uses
`claim_sync_jobs_fenced`; every transition presents its fresh opaque token, and no timer requeues
it. Recovery is deliberately attended because a timeout cannot prove provider work stopped.

## The auth healthcheck is not a queue job — deliberately

New agency connections use a separate durable operation before profiles exist.
Install the matching connection migrations, configure the worker's application
credentials and exact comma-separated `AMAZON_OAUTH_ALLOWED_REDIRECT_URIS`, then
enable `OPENSPELL_AMAZON_CONNECTIONS_ENABLED=1` on a general worker that can claim
`entity.sync`. The singular `AMAZON_OAUTH_REDIRECT_URI` is accepted for an installation
with one callback. The report and recommendation lanes cannot own this consumer.
Verify `components.amazonConnections` on `/healthz` before enabling the web flag.

The worker consumes an authorization code once. An uncertain exchange requires new
consent; a lost attachment response is reconciled against the committed operation.
Discovery resumes without re-exchanging the code and records each region's received,
parsed, refused, upserted and newly created counts together. Shutdown aborts a regional
request and leaves it resumable after its lease expires. Membership removal or
credential rotation refuses stale custody. Three consecutive command failures degrade
health; no code, token, profile identifier or provider response appears in that health
payload. Connecting does not select profiles for sync or copy tenant strategy settings.

`AuthHealthMonitor` probes account access on an in-process timer. It does not depend
on the queue it monitors.

The reason is that a liveness probe which depends on the subsystem it monitors cannot report the
failure that matters most. If the queue stops draining — a stuck claim, a wedged pool, a worker
that is up but not working — a queued `auth.healthcheck` never runs, and the silence looks exactly
like health. Running it on its own timer means the probe still fires and still logs when the queue
itself is the broken thing.

The secondary reasons all point the same way: the probe is not scoped to a profile, so it does not
fit the `(org, profile)` shape every `sync_jobs` row has; it needs no dedupe slot, no backoff and
no ledger entry; and it is per-worker-process rather than per-account, so a second worker should
run its own rather than contend for one row.

`WORKER_AUTH_HEALTHCHECK_MINUTES` changes the interval. Failures are logged loudly; Slack alerting
is wired by the operator downstream of the logs.

## Schedules

`enqueue_due_schedules()` (WP-01) runs on pg_cron every five minutes and turns due `sync_schedules`
rows into jobs. `schedules.ts` holds the defaults per profile:

| Variant | Job | Cadence | Window |
|---|---|---|---|
| `default` | `entity.sync` (full) | daily | — |
| `default` | `report.request` | daily | trailing 3 days |
| `restatement` | `report.request` | weekly | trailing 35 days |

The restatement pass exists because Amazon restates sales for 14+ days after the fact. The window
is in the *profile's* timezone, which is the only calendar Amazon's report dates mean anything in.

`ScheduleProvisioner` installs these for any sync-enabled profile that has **no** schedule rows, so
a newly connected profile starts syncing without an onboarding step somebody forgets. It only ever
fills an empty set: a profile whose schedules an operator pruned stays pruned.

`variant` is a column added by the `sync_schedule_variant` migration (0017, in
`supabase/migrations/`). The
original uniqueness key was `(profile_id, job_type, report_type)`, which made the daily and weekly
schedules for one report type mutually exclusive — the restatement pass could not be scheduled at
all. `variant` joins the key; existing rows default to `default` and keep the uniqueness they had.

## Configuration

| Variable | Default | What it is |
|---|---|---|
| `DATABASE_URL` | — | Service-role connection string. Required. Only the service role may call `get_ads_refresh_token`. |
| `LWA_CLIENT_ID` | — | The LWA application's client id. Required. Same app for every connection. |
| `LWA_CLIENT_SECRET` | — | The LWA application's client secret. Required. Secret. |
| `AMAZON_ADS_USER_AGENT` | unset | Sent on every Amazon request. Amazon asks integrators to identify. |
| `WORKER_ID` | `worker-<pid>` | Identifies the claimer in `sync_jobs.claimed_by`. |
| `WORKER_JOB_TYPES` | all | Comma-separated queue allowlist. Unknown or empty values fail startup. `evo-report-lane` requires exactly `creative.sync,report.request,report.poll,report.fetch`. |
| `WORKER_DEPLOYMENT_ROLE` | `general` | `general` or `evo-report-lane`. The report lane is queue-only and refuses missing, partial, or foreign `WORKER_JOB_TYPES`. |
| `OPENSPELL_WORKER_REVISION` | `unknown` | Sanitized 7–64 character Git object id exposed in worker health. A Creative pilot preflight refuses `unknown` or a mismatch. |
| `PORT` | `3000` | `/healthz`. |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Idle sleep between empty claims. |
| `WORKER_CLAIM_BATCH_SIZE` | `10` | Jobs per `claim_sync_jobs` call. |
| `WORKER_MAX_CONCURRENT_JOBS` | `10` | In-flight cap for this process. |
| `WORKER_AUTH_HEALTHCHECK_MINUTES` | `60` | Auth probe interval. |
| `WORKER_STALE_CLAIM_AFTER` | `30 minutes` | How long a `running` claim may go quiet. |
| `CROSSCHECK_INBOX_DIR` | unset | Root of the AdLabs export inbox. Never a tracked default. |
| `MARKETING_STREAM_SQS_QUEUE_URL` | unset | Enables Marketing Stream SQS ingestion. Kept out of health and logs. AWS credentials and region use the standard SDK provider chain. |
| `SP_API_LWA_CLIENT_ID` | unset | Enables the SP-API SQP runtime when paired with `SP_API_LWA_CLIENT_SECRET`. Deployment environment only. |
| `SP_API_LWA_CLIENT_SECRET` | unset | SP-API LWA application secret. Deployment environment only; tenant refresh credentials remain in Vault. |
| `SP_API_REPORT_MIN_INTERVAL_MS` | `1000` | Serial floor between Reports API operations. Provider `Retry-After` still controls throttled retries. |

### Claim-loop health and retry

The always-on worker contains only a direct PostgreSQL `57014` cancellation from the atomic claim
RPC. It records the fixed `postgres_query_cancelled` category, waits with equal-jitter backoff from
half of the current window through the full window, caps that window at 30 seconds, and retries the
same worker id and job-type allowlist with freshly calculated capacity. The raw database error,
statement, parameters and connection details never enter this log or `/healthz` state. Every other
claim error remains fatal, and the one-shot `drainOnce()` path never retries.

`worker.claimLoop` in `/healthz` reports the phase, consecutive failure count, sanitized
timestamps/category and scheduled delay. The endpoint remains ready for the first two contained
failures and returns 503 on the third. It also returns 503 before the claim loop starts, while it is
stopping, after it stopped, or after a fatal loop exit. A real successful claim RPC resets the
failure evidence even when the queue is empty; a pass skipped because local capacity is full does
not.

Shutdown interrupts idle and backoff waits. If an atomic claim was already in progress, shutdown
waits for it and registers any returned jobs once. Tokenless work retains the timed release path.
Fenced Evo work never releases on elapsed shutdown time and remains quarantined if its handler does
not drain. A stopped worker instance cannot be started again. Any unprovable fenced settlement is a
fatal fixed-category queue error, so the process cannot continue claiming after custody is lost.

### Bounded Creative pilot preflight

The daily Creative producer remains off unless the Vercel deployment has all
three exact values: the report-lane handoff, the producer gate, and a non-empty
`OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST` containing unique comma-separated
profile UUIDs. When the producer gate is absent or `0`, the cohort is not parsed
and no Creative job is offered.

Before activating the producer, run the read-only preflight against the stopped
or running candidate configuration:

```bash
pnpm --filter @wizard-ads/worker creative:preflight \
  --health-url http://127.0.0.1:3000/healthz \
  --expected-revision "$APPROVED_REVISION"
```

The command reads the cohort from the deployment environment, inspects the
required Creative tables, columns, and enums, counts cohort and total pending
snapshots, and compares the worker's exact revision, role, and claim set. It
does not apply a migration, enqueue a job, or construct an Amazon client. Its
JSON output contains counts and catalog names only, never profile identifiers.

### Weekly SQP

| Job type | Runtime and prerequisites |
|---|---|
| `sqp.request` | Always-on `general` worker; `WORKER_JOB_TYPES` set to `keepa.sync,rank.sync,economics.sync,sqp.request` (or unset); both `SP_API_LWA_CLIENT_ID` and `SP_API_LWA_CLIENT_SECRET`; active credentialed SP-API connection and exact profile/marketplace binding. |
| `sqp.categorize`, `history.bootstrap`, `report.promote` | Declared but unimplemented; permanently rejected. No schedules are provisioned; reconciliation disables legacy `sqp.categorize` integration schedules. |

The weekly producer remains in `ScheduleProvisioner`, which runs only with
`startsBackgroundPasses=true` on the general worker. The configured allowlist
must include `sqp.request` (or be unset). Vercel cron and the Evo report lane do
not produce or consume this job. Keep the general worker online for weekly SQP.

`enqueue_due_schedules()` does not construct SQP's exact bound marketplace,
validated and counted ASIN set, or completed profile-local week. Moving the
producer there requires a SQL scheduler migration outside the schedule-removal
scope of WP-247. Keeping it beside the credential-gated consumer avoids producing
jobs on deployments without an SP-API handler. The Evo lane contract is unchanged.

When both SP-API LWA application variables are present, the schedule
provisioner also inspects active `spapi_profile_bindings`. Each eligible
binding must match one sync-enabled Ads profile, one active credentialed
SP-API connection, its seller id, and one marketplace explicitly listed on the
connection. The scheduler uses current, non-deleted `product_ads` rows as the
initial attributable ASIN source; it counts missing, invalid, duplicate, and
unique values before offering a job.

The queue identity is stable per profile, marketplace, and completed week, so
restarts and repeated 15-minute passes do not create another report. The
durable job reuses provider report ids across polling attempts. Active
advertised ASINs are not a claim of catalog-complete Brand Registry coverage;
the exact requested set remains on the promotion ledger.

This code does not activate itself. The additive SP-API binding migration,
tenant refresh credential, exact binding rows, application role approval, and
deployment environment must all be supplied separately. No production
migration or credential provisioning is performed by the worker.

### Marketing Stream

When `MARKETING_STREAM_SQS_QUEUE_URL` is set, the same always-on process starts
an independent 20-second SQS long poll. It accepts Amazon's documented
`sp-traffic`, `sp-conversion`, `sb-traffic`, `sb-conversion`, `sd-traffic`,
`sd-conversion`, and campaign-scoped `budget-usage` records directly or inside
an SNS notification. The legacy shared `MarketingStreamBatchEnvelope` remains
accepted during rollout.

Provider `advertiser_id`, `marketplace_id`, and `dataset_id` must resolve to one
active subscription binding. Runtime routing never guesses from profile aliases
or campaign ids. The adapter retains the complete provider record, qualifies
Amazon's `idempotency_id` with its binding and dataset identity, requires an
explicit timestamp offset, converts timestamps to UTC, and normalizes the
14-day click-attributed conversion window that is common to SP, SB, and SD.
View-attributed measures remain raw evidence and are not silently combined.
Portfolio budget notifications are refused because the current canonical fact
is campaign-grained. Timezone/currency come from the profile and settling/
budget-cap policy comes from tenant strategy data. No dayparting number is
defaulted in source.

One poll is grouped by internal profile. The SQS message is deleted only after
raw ledger counts reconcile and one durable normalization job is created or
already present. That job replays complete affected hours, validates canonical
read-back, and schedules settling transitions. Malformed, unbound, stale-race,
database, and acknowledgement failures are left for SQS retry and its required
DLQ/redrive policy. `/healthz` reports only sanitized counters and timestamps.

Unknown datasets and malformed provider fields are refused rather than guessed.
AWS queue/DLQ provisioning, subscription confirmation, hosted migration
application, and live source/ledger/fact count crosschecks remain
operator-gated prerequisites.

Region concurrency is capped in code at 2 concurrent report creates per region (NA/EU/FE
independently), which is the conservative starting point the plan asks for.

## The Amazon client

`createAdsApiClientFromEnv(handle)` builds `DbAdsApiClient`, the adapter that satisfies the worker's
`AdsApiClient` on top of the real `@wizard-ads/ads-api` client. Three things it does that a fake did
not:

- **One client per `(connection, region)`, built lazily and cached.** A profile's connection id is
  looked up from `ad_profiles`, the refresh token is read from Vault via `get_ads_refresh_token`
  (service role only — hence the service-role `DATABASE_URL`), and the LWA app identity is the same
  `LWA_CLIENT_ID` / `LWA_CLIENT_SECRET` for every connection. The token is passed to the client and
  never returned, logged, or held anywhere the adapter exposes. A 401/403 evicts the cached client
  so a rotated credential is picked up on the next attempt.
- **`listEntities` lists every ad product** (SP campaigns/ad groups/keywords/targets/product
  ads/negatives, SB and SD campaigns/ad groups), sequentially so one profile does not blow the
  region concurrency cap, and stamps our profile uuid back onto each mapped row.
- **Errors are narrowed to what the retry policy can act on.** Idempotent reads retry throttles,
  5xx and transport failures. A stale S3 download URL (403/410) becomes
  `DownloadUrlExpiredError` so `report.fetch` re-polls for a fresh one. Reporting v3 create adopts
  a 425 only when Amazon supplies the in-flight report id; transport loss, server failure,
  undecodable success, or a duplicate without an id is quarantined and never automatically sent
  again. Report downloads are bounded to 32 MiB compressed, 64 MiB inflated, 60 seconds idle and
  15 minutes total.

`recommendations.run` executes the implemented recommendation pipeline. The dedicated
recommendation lane has its own role, immutable release and database authority
requirements; follow its [deployment guide](../../docs/deploy/evo-recommendation-worker.md).
A running general worker does not prove that one-time preview admission is enabled.

## Running it

```
DATABASE_URL='postgres://…service-role…' \
LWA_CLIENT_ID='amzn1.application-oa2-client.…' \
LWA_CLIENT_SECRET='…' \
  pnpm --filter @wizard-ads/worker start
```

`start` runs `tsx src/main.ts`: config from env, the health server on `PORT`, the claim loop, the
auth healthcheck, the stale-claim reaper and the schedule provisioner, with graceful shutdown on
SIGTERM/SIGINT. Nothing syncs until a profile has `sync_enabled = true` **and** a schedule (the
provisioner installs defaults for enabled profiles that have none).

## Selecting profiles to synchronize

Choose profiles explicitly within the agency that owns their Amazon connection.
Enable synchronization through the application's profile settings after verifying
that connection and worker deployment. A scheduler provisions only the enabled
profiles for its configured lane. Keep the entity/report/recommendation ownership
handoff consistent with web cron; do not enable a second independent claimant.

Profile selection is never inferred from account size or copied from another
installation. Read-only synchronization does not authorize an Amazon mutation.

## Verifying facts landed

After a report cycle completes (a `report.request` → `report.poll` → `report.fetch` chain), the
per-profile daily facts prove data reached the database:

```sql
select p.amazon_profile_id,
       count(*)      as fact_rows,
       max(f.date)   as latest_day,
       sum(f.cost)   as total_cost,
       max(r.rows_loaded) filter (where r.status = 'completed') as last_report_rows
  from public.ad_profiles p
  join public.fact_profile_daily f on f.profile_id = p.id
  left join public.report_requests r on r.profile_id = p.id
 where p.sync_enabled
   and p.org_id = '<selected-org-uuid>'::uuid
   and p.id = '<selected-profile-uuid>'::uuid
 group by p.amazon_profile_id
 order by p.amazon_profile_id;
```

`report_requests.rows_parsed = rows_loaded` (its generated `counts_match`) is the Rule-4 receipt for
each report; a completed report with a positive `fact_rows` count is the sync working end to end.

## Deploying to Fly.io

`fly.toml` and `Dockerfile` provide an alternative worker deployment. Set your own
Fly application name and region in the configuration and verify the selected lane
before deploying from the repository root:

```
fly deploy --config apps/worker/fly.toml
```

Three secrets must be set before the first real sync (build-time env like `PORT` stays in
`fly.toml`; credentials never do):

```
fly secrets set \
  DATABASE_URL='postgres://…service-role…' \
  LWA_CLIENT_ID='amzn1.application-oa2-client.…' \
  LWA_CLIENT_SECRET='…' \
  --config apps/worker/fly.toml
```

Do **not** run the first live sync against the hosted database from a developer machine — enable the
explicitly selected profiles and let the deployed worker pick them up on its own cadence.

## Tests

```
WIZARD_ADS_TEST_DATABASE_URL=postgres://…  pnpm --filter @wizard-ads/worker test
```

Local DB-backed suites can skip when PostgreSQL is unavailable; that does not
validate the worker. CI requires its disposable database and fails on an outage.

Everything above the client is exercised against `AdsApiClient` fakes and a real database;
`DbAdsApiClient` itself is unit-tested against a mock underlying client and a mock Vault
(`ads-api.test.ts`, no network, no DB).

## Reconciling ambiguous report creates

A create that may have reached Amazon must never be blindly replayed. The fenced
worker retains the `running` job and exits 78. A tokenless worker dead-letters it.
New failures record the phase, HTTP status (when available), known Amazon report
id, and timestamp in `report_requests.reconciliation`. The client deliberately
retains no raw provider response. The request UUID is also the original queue job
UUID; its payload records the profile, type and date window.

Apply the additive report-reconciliation migration before deploying this worker.
The separate JSON column preserves evidence and the operator audit when ordinary
polling clears `error`. No existing column or enum changes.

1. Stop the owning worker and confirm its process is gone, including any restarted
   instance. Pause the producer for the affected scope during investigation. A
   stale timestamp alone does not prove an Amazon request stopped.
2. Use an authorized database runtime for the exact organisation. Keep IDs and
   command output in private operational records. List requests:

   ```bash
   pnpm --filter @wizard-ads/worker reconcile-reports list --org-id "$ORG_ID"
   ```

   The output includes a count, request identity, known Amazon id and stored
   evidence. Older unmarked fenced requests appear as **legacy candidates**.
   They are not proven ambiguous: confirm the stopped claimant's exit/log evidence
   before resolving one. The command cannot reconstruct a response that was lost.
3. Independently obtain Amazon's report id from existing provider evidence or
   support records. Verify the exact account/profile, report type, date window and
   create time. Do not submit a new create to discover whether one exists. Adopt
   only after a match:

   ```bash
   pnpm --filter @wizard-ads/worker reconcile-reports adopt \
     --org-id "$ORG_ID" --request-id "$REQUEST_ID" \
     --amazon-report-id "$AMAZON_REPORT_ID" \
     --actor "$OPERATOR" --reason "$EVIDENCE_REFERENCE_AND_REASON" --worker-stopped
   ```

   Adoption records actor/time/reason and the supplied id in the ledger, finishes
   the original create job, revokes its retained claim and enqueues exactly one
   `report.poll` atomically. Expected counts: `requests: 1, jobs: 1, polls: 1`.
   A conflicting known provider id, existing downstream job or repeated resolution
   is refused; inspect the evidence instead of changing identifiers to force it.
4. If the request cannot be safely adopted, leave it quarantined or explicitly
   abandon it with a reason:

   ```bash
   pnpm --filter @wizard-ads/worker reconcile-reports abandon \
     --org-id "$ORG_ID" --request-id "$REQUEST_ID" \
     --actor "$OPERATOR" --reason "$REASON" --worker-stopped
   ```

   Expected counts: `requests: 1, jobs: 1, polls: 0`. Abandonment fails the ledger
   row and dead-letters the original job without resetting attempts. It does not
   cancel or delete anything at Amazon and does not authorize a replacement.
5. Read back the ledger audit and queue outcome, then restart the worker. An
   adopted request must progress through polling and fetch to reconciled loaded
   counts. Restore the producer only after reviewing the affected scope.

These commands never construct an Amazon client, create an Amazon report, or
queue `report.request`. `--worker-stopped` is an explicit operator attestation,
not an automatic process check. The supplied actor is recorded as an operator
statement under the database runtime's authority.

`/healthz.reports` exposes `deadJobsByType`, `staleRequests`,
`quarantinedRequests`, and `newestCompletedReportDateByType` (the newest completed
report's end date, not its completion timestamp). `WORKER_REPORT_STALE_HOURS`
sets the pending/processing age threshold; default 6 hours. Quarantine counts
include recorded markers; older unmarked candidates require the list command.
These diagnostics do not change the existing 503 policy. A failed diagnostics
read, or one that takes more than a second, returns `reports: null, reportsAvailable: false`,
never fabricated zeroes. Concurrent probes share an outstanding diagnostics read.

The sync-status lifecycle table counts requests with evidence of each stage over
the whole scoped ledger. Stages overlap; `polled` counts requests with at least
one poll, and `promoted` counts requests with positive promoted/canonical rows.
A zero-row completion counts as parsed/loaded but not promoted. `refused` uses
stored refusal counts or parser-refusal errors. Multiple dead child jobs count
once per request. The separate dead-letter table shows the newest 100 jobs;
first/last seen are queue creation/update times. Errors retain the existing
operator-safe display labels; exact details remain in the private ledger.
### SB keyword sync (WP-246)

`OPENSPELL_SB_KEYWORD_SYNC_ENABLED=1` sets `sbKeywordSyncEnabled`; absent or other
values keep it off. Enable only after an operator records live evidence for the
candidate SB keyword path, media type and response key and updates the endpoint's
verification status. Use the [SB keyword smoke mode](../../packages/ads-api/README.md#sb-keyword-verification).

With the flag enabled, keywords list after SB campaigns and ad groups. Truncation,
refused mappings or listed/mapped count disagreement fail the SB product group.
Accepted keyword rows enter the existing mirror upsert, which asserts listed versus
upserted counts. SP keyword sync is unchanged. The creative read model independently
falls back to an unambiguous preset Keyword slot when no synchronized SB keyword
exists; conflicting keywords and malformed names remain unresolved.

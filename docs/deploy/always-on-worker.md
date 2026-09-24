# Always-on integration worker

This page describes the legacy integration-only worker. It does not authorize the
exclusive Amazon report lane. The Evo report worker has its own immutable systemd
package and runbook in [evo-report-worker.md](./evo-report-worker.md).

Run the four implemented integration queues on a Linux host that stays online. Amazon entity
and Advertising report jobs remain on their configured cron/report runtime; this process does not need any
Ads application variables when its allowlist contains only integration jobs.

## Install

The host needs Node 22 or newer, Corepack/pnpm, Git, and network access to the
Supabase Postgres endpoint. Put a clean checkout at `/opt/wizard-ads`, check out the
approved release commit, and install the locked workspace dependencies:

```bash
cd /opt/wizard-ads
corepack enable
pnpm install --frozen-lockfile
```

This repository consumes workspace TypeScript source directly, so the supported
systemd command is the package's pnpm start script. If a later deployment produces
compiled output, `node apps/worker/dist/main.js` can replace it without changing the
environment or claim policy below.

## Credential boundary

The former plaintext environment-file recipe is retired. Do not create or preserve
`worker.env`. Any refreshed integration deployment must use TPM-encrypted systemd
credentials and a versioned, strict public configuration, following the custody and
immutable-release pattern in [evo-report-worker.md](./evo-report-worker.md).

The database credential must authenticate as the service role because queue claims
and integration-secret reads are service-role-only. Use the direct or pooler connection
string appropriate for a long-running process. A browser Supabase key is not a worker
database credential.

## systemd refresh required

The mutable-checkout unit and its `EnvironmentFile=` boundary are no longer approved.
Keep an existing legacy integration service unchanged until a dedicated migration
package replaces it; do not use this retired recipe for a new host or reinstall.

The health endpoint must stay firewalled or be exposed only through the host's
monitoring network.

## Coexistence with Vercel cron

Both runtimes use the same atomic `FOR UPDATE SKIP LOCKED` claim operation, so a job
cannot be handed to both. Their allowlists also divide responsibility before a claim:

- the always-on service claims `keepa.sync`, `rank.sync`, `economics.sync`, and
  `sqp.request`;
- Vercel cron explicitly claims `entity.sync`, `report.request`, `report.poll`,
  `report.fetch`, and `recommendations.run`.

Configure the always-on service as `WORKER_DEPLOYMENT_ROLE=general` with
`WORKER_JOB_TYPES` set to `keepa.sync,rank.sync,economics.sync,sqp.request`.
`sqp.request` requires both `SP_API_LWA_CLIENT_ID` and `SP_API_LWA_CLIENT_SECRET`,
an active SP-API connection with a Vault-backed refresh credential, and an exact
profile/marketplace binding. These SP-API credentials are separate from Ads LWA
credentials. The Evo report lane's exclusive allowlist remains unchanged.

`history.bootstrap`, `report.promote`, and `sqp.categorize` are declared but
unimplemented. They fail permanently with `"<job type> is declared but
unimplemented"`. Reconciliation no longer creates `sqp.categorize` schedules
and disables existing integration schedules for it, even with active DataDive
connections. Neither of the other two types has a provisioned schedule.

The weekly SQP producer stays in the general worker's `ScheduleProvisioner`.
It requires background passes, an allowlist containing `sqp.request` (or unset),
and both SP-API application variables. It builds exact bound marketplace payloads,
counts and validates advertised ASINs, and selects the completed profile-local
week. `enqueue_due_schedules()` cannot build those payloads today; moving this
logic would require a SQL scheduler migration beyond schedule removal. Keeping
production gated with the configured consumer also avoids creating jobs when no
SP-API handler is available. The general worker must remain online: cron and the
Evo report lane alone neither produce nor consume weekly SQP jobs. See the
[weekly SQP prerequisites](../../apps/worker/README.md#weekly-sqp).

Schedule reconciliation runs in both runtimes and is idempotent. It creates schedules
only from active integration connections, selects the first sync-enabled profile per
org/country unless `config.profile_id` designates one, and disables the provider's
schedule after the last applicable connection is no longer active. Atomic schedule
upserts and queue dedupe make concurrent passes safe.

## Updating and rollback

Do not update this legacy service by mutating its checkout. Migrate it through a
separately reviewed immutable release package. `SIGTERM` gives the worker up to 25
seconds to finish in-flight jobs, then releases remaining claims to `queued`. A
worker rollback never rolls back a database migration by editing production data.

## Source registry

`apps/worker/src/ingestion-sources.ts` declares job ownership through shared
`IngestionSource` descriptors. `deployment-role.ts` derives its lane lists from
those descriptors. The explicit deployment allowlist must still match the complete
Evo report lane; registering a source does not enable its credentials or transfer
custody. Immutable artifact contracts retain their serialized sets, with a test
checking those sets against the descriptors.

New ingestions use `SyncWorkerOptions.sources` and register `plan`, `execute`,
`counts`, and a coverage target. Missing coverage is rejected at registration.
The registry checks source and load counts, invokes the WP-256 coverage producer,
and reconciles its write receipt before queue success. Ads report completion keeps
its existing ledger/coverage transaction; request, poll, superseded and control
steps do not manufacture a fresh observation.

SP-API onboarding uses the shared provider-connection lifecycle and dedicated
one-use consent custody. Its application gate defaults off. The worker exchange
stub throws `NotConfigured` until the provider-specific exchange is supplied;
this does not enable a connection consumer or a new data source.

The SP-API connection consumer starts only with
`OPENSPELL_SPAPI_CONNECTIONS_ENABLED=1`, a general worker, both SP-API application
variables, and `SP_API_OAUTH_ALLOWED_REDIRECT_URIS`. Submission installation values
must match that deployment allowlist. It uses the same serial connection loop as
Ads and participates in shutdown. Leave the gate off while the exchange is
unconfigured. Operator revocation closes credential reads immediately; service
custody then clears the exact revoked SP-API Vault pointer.

## Report fetch reliability (WP-323)

Until WP-323 every report fetch on the Vercel cron lane died with `report download
exceeded decompressed_bytes limit`, whatever its size. The parser ran in a worker
thread started from `new URL('./report-json-parser-worker.mjs', import.meta.url)`.
Inside the Next.js server bundle, webpack emits that thread as a chunk and addresses it
through the server `publicPath`, so Node tried to start `file:///_next/<chunk>.js`, got
`MODULE_NOT_FOUND`, and the parser mapped any thread error to the inflate limit. Reports
are now parsed in-process as a stream: the first two bytes decide gzip or an already
inflated body, each array element is parsed when its closing byte arrives, and the
document is never held whole. The inflate limit stays at 64 MiB; parser bounds
(`parsed_row_bytes`, `parsed_rows`, `parsed_bytes`) and payload failures (`empty`,
`not_gzip_or_json`, `corrupt_gzip`, `invalid_json`) have their own names.

**Claim priority is the tick budget rule.** `claim_sync_jobs` orders by priority first.
`report.fetch` jobs are enqueued at 300 and `report.poll` at 200; requests, entity and
integration jobs keep the default 100 and recommendation runs 50. When a backlog exists,
every due fetch and poll is claimed before any new request, so the budget finishes
reports already in flight. With nothing to fetch or poll, requests use the whole budget.

**Expiry-aware fetch.** A fetch reads its URL's expiry from the signature (`X-Amz-Date`
plus `X-Amz-Expires`) or from the ledger's recorded `download_expires_at`. If less than
two minutes remain, or storage answers 403/410 (S3's `Request has expired` XML is
classified `download_url_expired`), the fetch does not download. It enqueues a
`report.request` for the same window (dedupe `report.rerequest:<generation>:<ledger>`),
marks the old ledger `expired` and succeeds. One window may be re-requested three times;
after that the ledger fails and the weekly restatement re-pulls the dates. An sbAds report
bound to a Creative snapshot is the exception: an expired ledger would block its snapshot,
so it keeps its ledger and re-polls the same Amazon report for a fresh URL, as before,
within the 4-hour request horizon.

**Dead-fetch recovery.** Before its first claim, each cron tick examines up to 2,000 dead
`report.fetch` jobs of profiles that sync, whose report type has an enabled restatement
schedule and whose window overlaps that schedule's current window. A fetch whose recorded
error a fresh report repairs (expired or rejected URL, transport, timeout, corrupt gzip,
and the pre-WP-323 inflate-limit message) joins one re-request of the restatement window
per profile and report type (dedupe `report.recover:<generation>:...`), or joins a request
for that window already queued. Every examined job receives exactly one verdict in
`result.recovery` (`re-requested`, `joined`, `unrecoverable` or `exhausted`), so the pass
never repeats work. The recovery runs only in the runtime that claims `report.request`;
the Evo report lane does not compose it.

After this release the 762 dead fetches recover without operator action: the first tick
re-requests one restatement window per affected profile and report type, and each
examined dead fetch records that request in `result.recovery`. The replacement requests
queue like any request; their polls and fetches are then claimed ahead of new requests. Dead
fetches whose window ends before the restatement window, and load-stage failures such
as `Failed query: insert into fact_…`, are not re-requested.

**Attended bookkeeping.** `pnpm --filter @wizard-ads/worker reconcile-reports abandon-dead
--org-id <uuid> --before <YYYY-MM-DD> --actor <name> --reason <text> --worker-stopped`
abandons every unresolved legacy ambiguous-create candidate whose request job is dead,
was requested before the cut-off, and whose whole window lies inside the profile's
current restatement window. It refuses and counts candidates outside that window,
without an enabled restatement schedule, or with poll/fetch jobs, and never touches
running claims. It prints `candidates`, `abandoned`, each refusal count and `running`.
An abandoned candidate is no longer listed, so repeating the command resolves nothing
twice. `list`, `adopt` and `abandon` are unchanged.

`/sync-status` names the blocking stage (request, poll, fetch or load) with the bounded
class of its last error, shows per-profile retrying and dead counts, and labels the
organisation-wide dead count separately.

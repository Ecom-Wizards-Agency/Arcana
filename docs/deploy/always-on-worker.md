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

### Connection-only SP-API exchange (WP-326)

`pnpm --filter @wizard-ads/worker run spapi-connections:start` runs the SP-API
connection loop and nothing else. It builds the same pass as the general worker
(gate, installation check, exchange credentials and poll interval) from the shared
`spApiConnectionPass` wiring. It does not start the queue worker, the health
server, the stale-claim reaper, schedule provisioning, recommendation observation,
bid-series sync, the auth health monitor, creative sync, the marketing stream
consumer, the Amazon Ads connection loop, SP write polling or unified reporting.
This command is the only supported way to run the exchange outside the general
worker.

It requires `DATABASE_URL`, `OPENSPELL_SPAPI_CONNECTIONS_ENABLED=1`,
`SP_API_LWA_CLIENT_ID`, `SP_API_LWA_CLIENT_SECRET`, `SP_API_APPLICATION_ID`,
`SP_API_OAUTH_REGION` and `SP_API_OAUTH_ALLOWED_REDIRECT_URIS`. Give it a
purpose-built environment with only these: the command runs the whole worker config
parser, so other worker settings copied from a general-worker environment are
parsed too and a bad one stops it (for example `PORT`,
`OPENSPELL_WORKER_REVISION`, `SP_API_REPORT_MIN_INTERVAL_MS`, the unified-reporting
flag or the SP write flags). It refuses to start when any variable whose name
starts with `WORKER_` is set, because it runs no jobs.

Startup errors never print a value. A missing variable, a gate other than `1`, a
region other than `NA`, `EU` or `FE`, and an empty callback list are named. A bad
`SP_API_LWA_CLIENT_ID`, `SP_API_APPLICATION_ID` or callback URI is reported as
`Invalid environment: SP-API connection callback policy is invalid`, without the
variable name.

Output is one JSON line per event with a timestamp. The startup line carries the
application id, region, the number of allowed callback URIs and the last four
characters of the client id; never the secret, a token, a consent code or the
database URL. A pass line (`idle`, `observed` or `uncertain`, plus the operation's
settled state and reason when there is one) is written for every non-idle pass and
whenever the outcome changes; a heartbeat line with the pass count is written at
most every five minutes. In loop mode an `uncertain` first pass exits 1 so a
supervisor restarts the command; later `uncertain` passes are only logged. The
first SIGINT or SIGTERM stops the loop, waits for consent custody, closes the
database handle and exits 0; further signals are logged as `signal_repeated` and
ignored. Add `--once` for a runbook check: one pass, logged with its state and
reason, exit 0 when it is `idle` or `observed`, 1 otherwise.

## Evo general worker package (WP-326)

The Evo host's general worker (`wizard-ads-worker.service`) is the legacy
integration service described above. WP-326 replaces its hand-copied runtime with
a versioned release and adds the SP-API seller-authorization exchange.

A release is built without privileges from a clean checkout of the approved
revision with `docs/deploy/build-evo-general-worker-artifact.sh --revision <sha>
--output <new-directory>`. It contains `REVISION`, `ARTIFACT_SHA256`,
`credential_runtime.py` (from `wizard-ads-credential-runtime.py`), both unit files,
the configuration template, and `app/`, a `pnpm deploy` of `@wizard-ads/worker`
with the pinned `tsx` runtime, normalized by
`normalize-report-worker-evo-artifact.mjs`. Releases live in
`/usr/local/lib/wizard-ads-runtime/worker-releases/<sha>`, and the unit runs
`/usr/local/lib/wizard-ads-runtime/worker-current/credential_runtime.py worker`
through the `worker-current` link. The runtime resolves that link at start, runs
its own release's `app/` with `/usr/local/bin/node`, and sets
`OPENSPELL_WORKER_REVISION` from `REVISION`, so `/healthz` reports the revision.
`ARTIFACT_LINKS` records every symlink target and is itself checksummed.
It prints one start line with the mode, the revision and whether the SP-API
connection loop is enabled. The MCP bridge keeps its own unit and the earlier
runtime.

Each systemd credential populates exactly one variable:

| Credential | Variable |
|---|---|
| `database-url` | `DATABASE_URL` |
| `spapi-lwa-client-id` | `SP_API_LWA_CLIENT_ID` |
| `spapi-lwa-client-secret-value` | `SP_API_LWA_CLIENT_SECRET` |

The secret's ID ends in `-value` because `pnpm hygiene` reads a unit line whose
credential ID ends in `secret` followed by `:<path>` as a credential assignment.
The two LWA credentials are supplied together or not at all. The public
configuration `/etc/wizard-ads/worker.json` (template
`wizard-ads-worker.TEMPLATE.json`) accepts only the runtime's allowlisted keys and
can never name a credential variable or the revision. It adds
`OPENSPELL_SPAPI_CONNECTIONS_ENABLED`, `SP_API_APPLICATION_ID`,
`SP_API_OAUTH_REGION` and `SP_API_OAUTH_ALLOWED_REDIRECT_URIS`; the last must list
the web deployment's `SP_API_OAUTH_REDIRECT_URI`, and the client id and
application id must equal the web deployment's. The runtime refuses a gate other
than `0` or `1`, a region other than `NA`, `EU` or `FE`, a template placeholder,
and an enabled gate without every setting and both credentials.

`wizard-ads-spapi-connections.service` is a template for the connection-only
command. It is not installed by the WP-326 upgrade. Its runtime mode passes only
`DATABASE_URL`, the LWA credentials and the SP-API settings, and refuses to start
while `worker.json` gives the loop to the general worker.

Lanes after the upgrade:

- The Evo general worker keeps `keepa.sync`, `rank.sync`, `economics.sync`,
  `sqp.categorize` and `recommendations.run` and additionally runs the SP-API
  connection loop. None of its claimed job types is an Amazon Ads job, so it
  builds no Ads client and makes no Amazon Ads call. `sqp.categorize` remains
  declared but unimplemented.
- The Vercel cron tick keeps `entity.sync`, `creative.sync`, `report.request`,
  `report.poll` and `report.fetch`, and `recommendations.run` unless the
  recommendation lane is enabled. `OPENSPELL_EVO_REPORT_LANE_READY` stays unset.
- The Amazon Ads connection loop runs only in a general worker with
  `OPENSPELL_AMAZON_CONNECTIONS_ENABLED=1` whose allowlist contains `entity.sync`.
  The Evo general worker has neither, the Vercel cron route does not compose the
  loop, and the report and recommendation lanes cannot own it, so it does not run
  on Evo and this upgrade leaves it where it is.

Switch `worker-current` only after the production database has the release
revision's migrations; the worker exits at startup otherwise, and a rollback
restores the previous unit and `worker.json` rather than touching the database.

`bash docs/deploy/test-evo-general-worker-deployment.sh` is the static proof: the
credential mapping tests, the units' exact shape (only the command and
credentials may differ from the host unit) and credential names against the
runtime mapping, the configuration template, the build's revision pinning, and a
staged release whose checksums and link manifest verify, whose import graph
resolves inside `app/`, and whose runtime launches its own `app/` at its recorded
revision.

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

## Campaign creation batches

The existing Sponsored Products outbox poller also drives approved campaign-creation
batches after pending update work. Its existing enable switch remains off by default.
Creation uses the same environment gate, profile allowlist and dispatch/reconcile
switches. No new timer, cadence or automatic approval is installed. Open the
environment write gate only on a deployment where the worker's dispatch switch is
on; otherwise admitted batches wait unclaimed until their authority expires.

Queued creation authority expires with its five-minute review checks or the frozen
plan, whichever expires first. Reservation rechecks selected products and observed
parents against the mirror. Each creation node has one durable reservation before
its only create POST. Readback
uses a returned Amazon ID when available, otherwise the exact profile-scoped name or
parent-scoped product/keyword identity. A complete read with one match adopts that
resource; multiple matches refuse creation. Two complete empty reads at least 60
seconds apart stop the batch as needing attention. Every read is recorded.

Retry requires a separate operator approval. It reads each remaining identity before
reserving a new POST, reuses observed parents, and refuses ambiguous matches. The
approval warns that a delayed original resource could appear after an empty read.
Creation has no delete rollback. Terminal attention releases dispatch capacity but
retains the unresolved evidence.

A child batch of keywords only is a keyword retry; its control reads exactly "Yes, retry
N keyword(s) in Amazon". A child that includes a campaign, ad group or product ad is
resource recovery. Recovery is its own approval with its own control, "Yes, recover N
resource(s) in Amazon", and is never described as a keyword retry.

Admission binds the review evidence the operator saw: the persisted validation of the
approved draft revision. Evidence older than five minutes, or without a check time, is
refused with `freshness_not_current`; admission never replaces it with newer evidence.
Fresh evidence is recorded at a new draft revision only when the operator acts.
Continue to confirmation revalidates the draft. For a retry or recovery, the result
screen's Review keyword retry or Review resource recovery action records the evidence,
as does Refresh review evidence. Opening or reloading the retry screen does not refresh
it; the screen shows the recorded evidence and disables its Amazon control when that
evidence is stale. Every confirmation disables itself when its evidence window closes.

The builder reports stock, buy-box, suppression and moderation as unmeasured and
lists their missing evidence at confirmation. These checks do not block approval.
Every check must be present exactly once; measured blocking checks and stale evidence
still refuse admission. Opening the gates never creates a campaign automatically.

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

- the always-on service (the Evo general worker) claims `keepa.sync`, `rank.sync`,
  `economics.sync`, `sqp.categorize`, `sqp.request`, `recommendations.run`, and
  `mcf.observe`;
- Vercel cron explicitly claims `entity.sync`, `creative.sync`, `report.request`,
  `report.poll`, `report.fetch`, and `recommendations.run`. It never claims `sqp.request`
  or `mcf.observe`.

`recommendations.run` is in both allowlists until the recommendation lane is enabled;
the shared claim operation still hands each job to one runtime.

Configure the always-on service as `WORKER_DEPLOYMENT_ROLE=general` with
`WORKER_JOB_TYPES` set to
`keepa.sync,rank.sync,economics.sync,sqp.categorize,sqp.request,recommendations.run,mcf.observe`.
The Evo general worker's runtime refuses to start the worker mode with any other set;
the connection-only mode does not read it.
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

A weekly SQP job whose rows the parser refuses goes `dead`. Its `last_error`,
its checkpoint (`refusalSummary`) and one `SQP report rows refused` log line name
the parser version, the refused count, the five most frequent fixed reasons and
the field names of the first refused row, never a row value. After a release
that changes the parser version, the producer re-offers the current week once
under a versioned dedupe key. For any other dead week, run
`pnpm --filter @wizard-ads/worker run sqp:requeue -- --org <slug> --profile <label> --week-start YYYY-MM-DD`
with production `DATABASE_URL` in the operator shell, only after the release
carrying the new parser is deployed and from a checkout of that release: the
command compares the refusing version with its own checkout's parser. It resets
the one dead job to `queued` and keeps the checkpoint, so Amazon reports already
produced are downloaded again by document id; add `--fresh-reports` only if those
documents can no longer be fetched. It takes the same per-week lock as the
producer's re-offer, refuses when another job covers the week or when this
checkout's parser version already refused it, and prints one JSON audit line.

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

### Connection-only Amazon Ads exchange (WP-330)

The Settings, Connections screen starts a new Amazon Ads connection only when the web
deployment sets `OPENSPELL_AMAZON_CONNECTIONS_ENABLED=1`, and that flag must stay off
until a production process runs the Ads connection loop. The general worker runs the
loop only when it also claims `entity.sync`: a new connection's profiles need their
first entity sync, and the rule keeps the loop in a runtime that performs it. The Evo
general worker does not claim `entity.sync` (the Vercel cron tick does), so its
configuration refuses the loop.

`pnpm --filter @wizard-ads/worker run amazon-connections:start` runs the Ads
connection loop and nothing else: the one-use consent exchange and the regional
profile discovery (`/v2/profiles` reads in NA, EU and FE). It builds the same pass as
the general worker (the store, the installation check, the exchange credentials and
the poll interval) from the shared `amazonConnectionPass` wiring. It does not start
the queue worker, the health server, the stale-claim reaper, schedule provisioning,
recommendation observation, bid-series sync, the auth health monitor, creative sync,
the marketing stream consumer, the SP-API connection loop, SP write polling, unified
reporting or the market signals import. It claims no queue job, so the `entity.sync`
rule does not apply to it. It enqueues no job and provisions no schedule. Discovered
profiles start with sync off; once sync is enabled for a profile, the Vercel cron tick
provisions its schedules and runs its first entity sync. The exchange is not an
Amazon Ads write.

It requires `DATABASE_URL`, `OPENSPELL_AMAZON_CONNECTIONS_ENABLED=1`,
`LWA_CLIENT_ID`, `LWA_CLIENT_SECRET` and `AMAZON_OAUTH_ALLOWED_REDIRECT_URIS`. The
client id and secret must be those of the Amazon Ads LWA application that the web
deployment's `AMAZON_LWA_CLIENT_ID` and the cron tick's `LWA_CLIENT_ID` name. The
callback list must contain the web deployment's `AMAZON_OAUTH_REDIRECT_URI`; a
submitted consent whose client id or callback differs is settled as
`installation_changed` without a provider call. The OAuth state key
(`AMAZON_OAUTH_STATE_KEY`) is verified by the web callback and is not needed here. The
command refuses to start when any `WORKER_` variable is set, because it runs no jobs,
and when `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET` or
`AMAZON_OAUTH_REDIRECT_URI` is set, because the shared wiring would otherwise read one
of two names for the same setting. As with the SP-API command, give it a purpose-built
environment: the whole worker config parser runs, so another worker setting copied
over can stop it.

Startup errors never print a value. A missing variable, a gate other than `1`, an
LWA client id or secret with leading or trailing whitespace (the client id is compared
byte for byte with each consent's), an empty callback list and an empty callback entry
are named. A callback that is not
HTTPS (or a local development origin), carries credentials or a fragment, more than
ten callbacks, or an over-long client id is reported as `Invalid environment: Amazon
connection callback configuration is invalid`.

Output matches the SP-API command with `amazon_connection_` event names: a startup
line with the number of allowed callback URIs and the last four characters of the
client id, a pass line (`idle`, `observed`, `unavailable` or `uncertain`, with the
operation's state and reason when there is one) for every non-idle pass and every
change of outcome, and a heartbeat with the pass count at most every five minutes.
`unavailable` means the claim itself failed, for example an unreachable database.
In loop mode a first pass that is `unavailable` or `uncertain` exits 1 so a supervisor
restarts the command; later ones are only logged. The first SIGINT or SIGTERM stops
the loop, waits for custody, closes the database handle and exits 0; further signals
are logged as `signal_repeated` and ignored. A stop during an exchange settles the
consent as `reconnect_required` with `exchange_uncertain` (the code is never
exchanged twice); a stop during discovery leaves the region resumable. `--once` runs
one pass (an exchange, or one operation's discovery), exits 0 when it is `idle` or
`observed` and 1 otherwise.

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
| `ads-lwa-client-id` | `LWA_CLIENT_ID` (Amazon Ads unit only) |
| `ads-lwa-client-secret-value` | `LWA_CLIENT_SECRET` (Amazon Ads unit only) |

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
an enabled gate without every setting and both credentials. The worker mode also
refuses a `WORKER_JOB_TYPES` that is not exactly the seven general-worker job types,
each listed once.

`wizard-ads-spapi-connections.service` is a template for the connection-only
command. It is not installed by the WP-326 upgrade. Its runtime mode passes only
`DATABASE_URL`, the LWA credentials and the SP-API settings, and refuses to start
while `worker.json` gives the loop to the general worker.

`wizard-ads-amazon-connections.service` (WP-330) runs `credential_runtime.py
amazon-connections` through the same `worker-current` link, with the host unit's
hardening and its own credentials: `database-url`, `ads-lwa-client-id` and
`ads-lwa-client-secret-value`. The general worker's unit loads neither Ads
credential. `worker.json` gains two keys for it, `OPENSPELL_AMAZON_CONNECTIONS_ENABLED`
and `AMAZON_OAUTH_ALLOWED_REDIRECT_URIS`. The Ads mode refuses to start unless the
gate is `1` and the callback list is set, requires both Ads credentials, and passes
only `DATABASE_URL`, `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, the gate and the callback
list to `src/amazon-connections-cli.ts`. The worker mode never passes the two Ads keys
to the general worker, whose configuration would refuse the gate. The release built by
`build-evo-general-worker-artifact.sh` carries `app/src/amazon-connections-cli.ts` but
not this unit file: install the unit from the checkout of the release's revision. A
release older than WP-330 refuses a `worker.json` with the two Ads keys, so add them
only after `worker-current` points at a WP-330 release, and remove them before a
rollback to an older one.

Lanes after the upgrade:

- The Evo general worker claims seven job types: `keepa.sync`, `rank.sync`,
  `economics.sync`, `sqp.categorize`, `sqp.request`, `recommendations.run` and
  `mcf.observe` (WP-338b, below). It also runs the SP-API connection loop and, because it claims `sqp.request` and
  holds both LWA credentials, the weekly SQP producer. None of its claimed job
  types is an Amazon Ads job, so it builds no Ads client and makes no Amazon Ads
  call. `sqp.categorize` remains declared but unimplemented.
- The Vercel cron tick keeps `entity.sync`, `creative.sync`, `report.request`,
  `report.poll` and `report.fetch`, and `recommendations.run` unless the
  recommendation lane is enabled. It does not run `sqp.request`.
  `OPENSPELL_EVO_REPORT_LANE_READY` stays unset.
- The Amazon Ads connection loop runs in a general worker only with
  `OPENSPELL_AMAZON_CONNECTIONS_ENABLED=1` and `entity.sync` in its allowlist. The
  Evo general worker has neither, the Vercel cron route does not compose the loop,
  and the report and recommendation lanes cannot own it. On Evo it runs in the
  connection-only `wizard-ads-amazon-connections.service` (WP-330) once that unit is
  installed.

Switch `worker-current` only after the production database has the release
revision's migrations; the worker exits at startup otherwise, and a rollback
restores the previous unit and `worker.json` rather than touching the database.

`bash docs/deploy/test-evo-general-worker-deployment.sh` is the static proof: the
credential mapping tests, the three units' exact shape (only the command and
credentials may differ from the host unit, and the worker unit adds one
`ReadOnlyPaths=` line for the import directory) and credential names against the
runtime mappings (the worker mapping for the worker and SP-API units, the Amazon Ads
mapping for the Ads unit), the configuration template, the build's revision pinning, and a
staged release whose checksums and link manifest verify, whose import graph
resolves inside `app/` from all three entry points, and whose runtime launches its
own `app/` at its recorded revision in the worker and Amazon Ads modes.

## Market signals import (WP-331)

wizards-ai is the only process that calls Keepa; the general worker imports its
`market-signals/2` export. The import is off until `OPENSPELL_MARKET_SIGNALS_DIR`
names a directory the hardened worker can read (with `ProtectHome=yes`, not a home
directory), where wizards-ai's hourly pass writes `<UTC date>.ndjson` batches. With
it set, the pass runs in the general worker every 15 minutes, never in the report
or recommendation lanes. `OPENSPELL_MARKET_SIGNALS_ORG_KEYS=key=uuid[,key=uuid]`
maps each export `org_key` to an organisation id; without it, only the default key
`ecom-wizards` is imported, and only while the database holds exactly one
organisation. Both values are non-secret. Map each wizards-ai profile key once
with `pnpm --filter @wizard-ads/worker run market-signals:map -- --org <slug>
--profile-key <key> --profile <label>`; signals under an unmapped key import with
no profile and are counted. `pnpm --filter @wizard-ads/worker run
market-signals:import -- --once` runs one pass for a runbook (exit 0 clean, 3 with
findings, 2 usage, 1 failure). `/healthz` and `/sync-status` show the counters and
the export's "data as of". `keepa.sync` keeps running until a later step.

On the Evo (WP-336), `worker.json` may carry both keys; they are optional, and
without `OPENSPELL_MARKET_SIGNALS_DIR` the import is off. They are not in
`wizard-ads-worker.TEMPLATE.json`: JSON has no comments, so an optional
placeholder cannot be written there, and the template's key set stays exact. Only
the worker mode passes them on; the connection-only modes never do. The runtime
refuses, naming the key and never the value, a directory that is not a normalized
absolute path or lies under `/home`, `/root` or `/run/user` (all hidden by
`ProtectHome=yes`), an org-key map that is not `key=uuid[,key=uuid]` with unique
keys (a key is 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or
digit), and an org-key map without the directory. The export lives in
`/var/lib/wizard-ads-imports/market-signals`: `/var/lib/wizard-ads-imports` is
owned by root and the `wizard-ads-imports` group, whose members are the wizards-ai
user (which writes) and `wizard-ads-runtime` (which reads). The worker unit reads it
through `ReadOnlyPaths=-/var/lib/wizard-ads-imports`; the leading `-` lets the unit
start before the directory exists. `/var/lib/wizard-ads-imports/creators` is the
same shape for `creators:import --dir`. A release older than WP-336 refuses a
`worker.json` with either key, so add them only after `worker-current` points at a
WP-336 release, and remove them before a rollback to an older one.

Retiring `keepa.sync` is prepared but not applied. After a verified profile-day of
imported signals and the operator's Keepa key check, one change retires it:
drop `"keepa.sync"` from `GENERAL_WORKER_JOB_TYPES` in
`wizard-ads-credential-runtime.py` and from `WORKER_JOB_TYPES` in the template, so
both hold the six types `rank.sync,economics.sync,sqp.categorize,sqp.request,recommendations.run,mcf.observe`.
The static proof and the runtime tests pin the seven types today and refuse the set
without `keepa.sync`, so the same commit moves their expected set to the six types; the
live `worker.json` then drops `keepa.sync` in the same release switch.

## MCF observation on the Evo (WP-338b)

`mcf.observe` (WP-334) is a read-only job. For each Creator Connections sample lane
that the control runner reports as submitted, ambiguous or confirmed, it asks Amazon
whether a fulfillment order exists under the lane's derived order key, reads the
shipments and each package's carrier status, and appends one row to
`creator_mcf_observations`. It never creates, updates or cancels an order and never
changes a lane's state or lock. Nothing in this section places an order or turns on
any part of the send path.

The Evo general worker claims `mcf.observe` as its seventh job type. The Vercel cron
tick does not claim it. Two optional, non-secret `worker.json` keys control it:

| Key | Accepted values | Absent |
|---|---|---|
| `OPENSPELL_MCF_OBSERVE_ENABLED` | exactly `0` or `1` | off |
| `OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES` | a whole number from `5` to `1440`, no sign, leading zero or spaces | 30 minutes |

Like the import keys, they are not in `wizard-ads-worker.TEMPLATE.json`. Only the
worker mode passes them on; the connection-only modes never do. The runtime refuses a
flag other than `0` or `1`, an interval outside the range or not written as plain
digits, and a flag of `1` without both SP-API LWA credentials (the worker would
otherwise stay off without saying so). Each refusal names the key and never the
value. With the flag at `1`, an organisation is observed only when it has exactly one
active SP-API connection and a usable profile, marketplace and SP-API binding. The
enqueue pass skips any other organisation without creating a job; the only sign is
`refusedOrgs` in the worker's `mcf.observe enqueue pass` journal line. A job fails
permanently, naming the reason, only if the connections or the binding change
between enqueue and run. The general worker accepts no
other MCF key: the flags that let Arcana send an order belong to the separate MCF
unit only, and this runtime refuses them as unsupported keys.

With the flag on, the worker enqueues one `mcf.observe` job per organisation with a
lane to observe when it starts and then once per interval. The dedupe key carries
the interval slot, so a restart inside a slot does not enqueue twice. Each job reads
at most 25 lanes, least recently read first, spacing Amazon calls 600 ms apart.

### Lockstep order

A release older than WP-338b refuses `mcf.observe` in `WORKER_JOB_TYPES` and both
observe keys. A WP-338b release refuses the six-type list without `mcf.observe`. The
job-type list therefore changes in the same stop as the release switch, and the flag
comes after it.

1. Confirm the production database has WP-334's migration
   (`20260927120000_creator_sample_preflight_observation.sql`). The worker exits at
   startup without it.
2. Stop `wizard-ads-worker.service`. Point `worker-current` at the WP-338b release
   (or a later one). In the same stop, append `,mcf.observe` to `WORKER_JOB_TYPES`
   in `/etc/wizard-ads/worker.json`. Add no observe key yet.
3. Start the unit. Check the start line (`mode` `worker` and the new revision) and
   `/healthz`. The worker now claims `mcf.observe`, but with the flag absent it
   enqueues nothing and registers no handler.
4. Add `"OPENSPELL_MCF_OBSERVE_ENABLED": "1"` to `worker.json` (and the interval, if
   30 minutes is not wanted) and restart the unit. The first jobs are enqueued at
   start.

### Rollback order

1. To stop observing, set `OPENSPELL_MCF_OBSERVE_ENABLED` to `0` or remove the key,
   and restart. The worker enqueues nothing new. Jobs already queued are claimed and
   end `dead` with `mcf.observe is declared but unimplemented`, because no handler is
   registered; no Amazon call is made.
2. To roll the release back, first do step 1 and wait one interval so queued
   `mcf.observe` jobs are claimed. Then stop the unit, remove both observe keys, remove
   `mcf.observe` from `WORKER_JOB_TYPES` (back to the six types), point
   `worker-current` at the previous release, and start the unit. No runtime claims
   `mcf.observe` after the rollback, so any job still queued stays queued and runs on
   a later upgrade.

Neither step touches the database. Observation rows stay as recorded, and the lanes
keep the settlement the last read gave them.

### Reading the first results

Read the jobs and the observations after the first interval:

```sql
select status, attempts, last_error, result, finished_at
  from public.sync_jobs where job_type = 'mcf.observe'
 order by created_at desc limit 20;

select outcome, operation, count(*)
  from public.creator_mcf_observations
 group by outcome, operation;
```

A succeeded job's `result` counts `lanes`, `found`, `notFound`, `inconsistent`,
`escalated`, `written`, `packages` and the Amazon calls it made. What the first
reads show:

- **`found` rows** mean Amazon answered HTTP 200: the seller authorization carries
  the Amazon Fulfillment role, and the order exists under that id.
- **`not_found` rows** mean Amazon answered HTTP 404, which the reader records as
  not found. The role works, and Amazon does not know that id. The job reads the
  lane's derived order key first and, when the runner recorded an order id, that id
  next. Lanes whose orders were placed in the browser under `CC-…` ids have a derived
  key Amazon has never seen, so that first read is the 404-or-400 probe. Such a lane
  shows `not_found` when no runner id is recorded, and may show `found` with
  `queried_order_id` equal to the runner's id when one is.
- **Jobs with `last_error` `Fulfillment Outbound http (400)`** (status `queued`
  with that `last_error` while they retry, `dead` after the fifth attempt) mean
  Amazon refused a read. Two operations can raise it: getFulfillmentOrder for every
  lane, and, for lanes in Reconciliation Required, the listAllFulfillmentOrders read
  that corroborates a not-found. Check the lanes' states before concluding. If no
  lane is in Reconciliation Required, the 400 came from getFulfillmentOrder: either
  Amazon answers an unknown id with 400 rather than 404, in which case WP-334's
  reader needs a follow-up before the preview flag goes on, or the authorization
  lacks the role. No observation row is written for those lanes.
- **`Fulfillment Outbound http (403)`** means the seller authorization does not
  cover Fulfillment Outbound: re-authorize the SP-API connection with the Amazon
  Fulfillment role.
- **`Fulfillment Outbound http (5xx)`, `Fulfillment Outbound transport` or
  `Fulfillment Outbound authentication`** (the LWA token refresh failed) is a failed
  read, never a not-found. The job retries; nothing is settled.

After a 400 or 403, set the flag to `0` (rollback step 1) and report the error
before turning on anything that depends on MCF reads.

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

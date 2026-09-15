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

# OpenSpell

OpenSpell is an Amazon Advertising application for connecting advertising accounts,
syncing entities and reports, reviewing performance, and preparing campaign and
optimization changes. Preview is the default. Amazon writes require explicit operator
authority, immutable scope, worker execution, counted responses and resynchronization.
An available client method or page does not establish that a deployment has enabled
the complete workflow.

This public repository contains the application, shared contracts, tests, synthetic
fixtures, CI, deployment tools and installation documentation. It has no runtime or
installation dependency on a private companion repository. Package names retain the
`@wizard-ads/*` scope.

## Develop locally

Use Node 22 or newer and the pnpm version in [package.json](package.json).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs typecheck, lint, tests, public-repository hygiene and skill-lint.
Database-backed tests need a disposable database configured through
`WIZARD_ADS_TEST_DATABASE_URL`; skipped database suites are not database validation.
The historical migration-evidence suite additionally needs a fresh PostgreSQL 17
cluster for each run, configured through `WP197_EXACT_HISTORY_DATABASE_URL`; see
the [fixture instructions](tools/hosted-migration-bundle/fixtures/history-v1/README.md).
CI supplies both disposable services and fails when either is unavailable.
The local Supabase configuration is in [supabase/config.toml](supabase/config.toml).
Its Auth signup and automatic seeding are disabled. Use the committed synthetic
[fixtures](fixtures/) and [database test helpers](packages/db/src/) for local proof.

Inject local process configuration using the names in
[apps/web/env.TEMPLATE](apps/web/env.TEMPLATE), then start the web application:

```bash
pnpm --filter @wizard-ads/web dev
```

Real credentials belong in a secret manager and the approved runtime's secret
configuration. Keep them out of Git, command output and local `.env` files. Optional
operator files have public placeholder templates:

```bash
cp _local/hygiene-denylist.TEMPLATE.txt _local/hygiene-denylist.txt
cp _local/strategy.TEMPLATE.json _local/strategy.json
```

The first supplies local client-name hygiene rules. The second supplies tenant
configuration for a separately scoped import; copying it does not seed a database.

## Host your own instance

The deployment layout is a Next.js web application on Vercel, a Supabase project for
Postgres/Auth/Vault, and an always-on worker with network access to Supabase and
Amazon. An MCP server is a separate, optional deployment. Hosting on another platform
requires equivalent process, database, authentication and secret-injection behavior.

The installer supplies their own Amazon Advertising API application and approved LWA
application credentials. Agency owners connect their advertising accounts through that
application; they do not each need to register a developer application. SP-API is a
separate optional integration for retail/Brand Analytics data, not a prerequisite for
the Advertising API connection.

1. **Prepare a separate Supabase project.** Configure Auth email delivery, the web
   origin and exact allowed invitation/recovery redirects. Keep public signup disabled.
   Rehearse the repository's [migrations](supabase/migrations/) on a disposable database
   before applying the reviewed schema to the installation. Existing hosted ledgers
   require their own reconciliation; the fixed
   [hosted-history bundle tool](tools/hosted-migration-bundle/README.md) is not a fresh
   database initializer. Development seeds are synthetic test data, not a production
   first-owner installer.
   Keep the exposed API schemas as declared in [supabase/config.toml](supabase/config.toml).
   The `app`, `mcp` and `vault` schemas must remain unexposed: server-only manager
   commands rely on the web application's verified session and authenticator checks
   before their independent database membership checks.
2. **Configure Vercel.** Build the `@wizard-ads/web` workspace with its locked monorepo
   dependencies. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   server-only `DATABASE_URL` and the exact HTTPS `WIZARD_ADS_APP_URL` through deployment
   configuration. Use [env.TEMPLATE](apps/web/env.TEMPLATE) as the variable reference.
   Password login and recovery default on; hosted releases set
   `WIZARD_ADS_TOTP_POLICY` to `enforce-when-enrolled` so authenticator enrollment remains
   optional and enrolled factors are enforced. Passkeys are experimental and default
   off. Configure and test invitation and recovery delivery before admitting users.
3. **Register the Amazon callback.** The installer-owned LWA app's allowed return URL
   must exactly match `AMAZON_OAUTH_REDIRECT_URI`, normally the web origin plus
   `/api/amazon/oauth/callback`. Set the public application identity and signed-state
   configuration from the web template. The worker uses `LWA_CLIENT_ID` and
   `LWA_CLIENT_SECRET` for that same app; tenant refresh tokens belong in Vault.
   The web callback validates the session and signed state, then submits a protected
   connection operation. It has no client secret or token-exchange endpoint. Set
   `AMAZON_OAUTH_ALLOWED_REDIRECT_URIS` on the general worker to the exact allowed
   callbacks, comma-separated when production and protected review share that worker.
   New connections default off. Enable `OPENSPELL_AMAZON_CONNECTIONS_ENABLED=1` on
   the compatible general worker first, verify its connection-processing health, then
   enable that flag on the web deployments. Install the matching connection migrations
   before either activation. Existing consent links from an earlier protocol require
   a new authorization.
4. **Install and verify the worker.** Use the maintained
   [worker configuration](apps/worker/README.md),
   [report worker deployment](docs/deploy/evo-report-worker.md) and
   [recommendation worker deployment](docs/deploy/evo-recommendation-worker.md)
   contracts for the lane being installed. The supplied systemd packages have strict
   host, credential and immutable-release requirements. A general worker's development
   start command does not replace those requirements. Verify `/healthz`, revision,
   queue ownership and database authority before allowing claims. The
   [Vercel cron configuration](apps/web/vercel.json) must agree with the lane handoff;
   staging a worker does not transfer queue ownership.
5. **Provision an owner and prove the first connection.** Use the
   [agency operator command](tools/agency-operator/README.md) to issue an independent
   first-owner invitation. Install its matching Auth template and redirects, verify
   password setup and exact-organization access, and complete the worker-owned
   connection workflow before admitting unrelated agencies. Do not substitute a
   development seed or permanent operator membership. For each first sync, reconcile
   profiles discovered, profiles accepted, entities listed/upserted and report rows
   parsed/loaded; show missing or refused rows explicitly.
6. **Configure MCP if required.** Deploy [apps/mcp](apps/mcp/README.md) separately and
   explicitly set `WIZARD_ADS_MCP_URL` to that installation's HTTPS endpoint. Never
   inherit another installation's endpoint. Use the
   [MCP deployment guide](docs/deploy/mcp-evo.md) for its runtime and credentials.

A protected hosted review that shares production Auth or data needs its own explicit
web origin and allowed redirects, visible `WIZARD_ADS_REVIEW_LIVE_DATA=1` labeling and
disabled cron. Such a deployment is a review of live data, not a disposable test
database. Schema and Auth changes must remain compatible with both active releases.

Verify the complete password, invitation, connection and first-sync workflow in the
target installation; source tests do not establish its deployment or Amazon approval.

## Source guides

| Concern | Public source or guide |
| --- | --- |
| Contributor rules, authority and hygiene | [AGENTS.md](AGENTS.md) |
| Cross-package types and validation | [packages/shared](packages/shared/) |
| Amazon client behavior and capability limits | [Ads API guide](packages/ads-api/README.md) |
| Tenant strategy shape and resolution | [Strategy guide](packages/strategy/README.md) |
| Components, tokens and assets | [UI guide](packages/ui/README.md) |
| Campaign planning and validation | [packages/campaigns](packages/campaigns/) |
| Export inputs and backfill | [Export contract](docs/adlabs-export-contract.md), [backfill CLI](tools/adlabs-backfill/README.md) |
| Offline migration evidence | [Bundle tool](tools/hosted-migration-bundle/README.md), [root authority library](tools/hosted-migration-root-authority/README.md) |

Read [AGENTS.md](AGENTS.md) before contributing. Keep tenant values, account rosters,
credentials and real account fixtures out of this public repository.

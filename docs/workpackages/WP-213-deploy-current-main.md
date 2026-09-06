# WP-213 — Deploy web/MCP and verify worker compatibility

Owner: implementer. Execute a tested deployment window under scoped authorization;
operator attendance is optional.

Depends on: WP-207 postflight at 46 ledger versions; WP-216 merged; WP-208 merged if ready.
`docs/HANDOVER.md` and `docs/STATUS.md` are edited here only after WP-207 has finished with
them.

## Readiness check, 2026-09-06

The operator cannot use the loopback preview below. A clean `wp-213-web-release` checkout at
main `9672d93` now has a successful production-target prebuilt artifact. Main CI `34015967395`
passed; output checks verify the pinned brand SVG, Node 24 function runtime and 300-second
cron duration. Only public Supabase browser settings entered the local build. The existing
Pro/Fluid project supports that duration; the read-only settings check preserves the enabled
five-minute cron and deployment protection. The existing
production deployment is Ready as the exact rollback anchor. Private preparation evidence is
in `_local/wp213-web-candidate/`; [the runbook](../deploy/web-vercel.md) records the procedure.
Web-only candidate/promotion authorization has been requested. Nothing has been uploaded or
promoted. Browser control now works, but its OpenSpell session needs operator sign-in.
The existing verifier's cookie-extraction path cannot be used under current browser rules;
a permitted authenticated verification path remains part of the deployment gate.

Live web remains at `44da7ac`, independently confirmed through public health and Vercel's
latest production deployment. Main `9672d93` includes the sidebar, brand and table improvements,
but there is no up-to-date hosted preview. The next frontend review needs a tested candidate;
merged UI source is not an available operator release. Keep the release scope explicit:
a main-only candidate uses the completed WP-207 schema and WP-216 legacy fallback, whereas
PR #141's write source additionally depends on the separately reviewed ten-migration window.
Do not put the write branch on the hosted database before its schema prerequisites.

## Objective

End the deployment drift: production web at the current main revision through a verified
candidate and the MCP service on the same revision on the Evo host. Verify that the existing
integration worker and any pinned Creative worker remain compatible with the upgraded schema.
Write the missing web deployment runbook. A new integration-worker release is a separate
activation deliverable in WP-214, not an in-place update hidden inside this web release.

## Owned files

- `docs/deploy/web-vercel.md` (new runbook);
- `docs/HANDOVER.md` "Verified repository and deployment snapshot";
- `docs/STATUS.md` "Dated live and deployed evidence" and "Release gates";
- this brief.

## Read first

1. `docs/deploy/mcp-evo.md`, `docs/deploy/install-mcp-evo-systemd.sh`,
   `verify-mcp-evo-systemd.sh`, `rollback-mcp-evo-systemd.sh`.
2. `docs/deploy/always-on-worker.md`.
3. `apps/web/package.json` script `verify:release-candidate` and
   `apps/web/src/release/candidate-artifacts.ts`.
4. `docs/STATUS.md` entries describing earlier candidate deployments and promotions.

## Required behavior

### Web

1. Runbook: clean worktree at the exact main revision; `vercel build` and `vercel deploy
   --prebuilt` to an immutable candidate URL with `OPENSPELL_WEB_REVISION` set to that revision;
   `pnpm --filter @wizard-ads/web verify:release-candidate` against the candidate; authenticated
   click-through of all 35 pages in both themes covering loaded, empty, error and permission
   states; promote; confirm `/api/healthz` reports the revision; rollback is promoting the
   previous deployment.
2. Environment: keep `OPENSPELL_EVO_REPORT_LANE_READY` and the creative variables exactly as
   WP-210 left them; keep `OPENSPELL_RECOMMENDATION_LANE_READY` unset so WP-216 legacy mode
   applies; confirm the Vercel plan allows the cron route's 300-second `maxDuration`.
3. After promotion, confirm one cron tick succeeds and claimed jobs finish, which proves finding
   F1 is closed in production.

### MCP

4. Follow `docs/deploy/mcp-evo.md` in order: stage the two encrypted credentials, approve the
   cloudflared checksum, test, install, create the route-exclusivity record, stop the legacy
   service, activate, verify, and repeat the two-client discovery check with all 11 tools and an
   audit-log read. The MCP references no pending migration.

### Worker

5. Keep the legacy integration worker and any WP-210 report worker on their recorded releases.
   Verify service/artifact identity, exact job ownership, health and two counted claim cycles
   against the upgraded schema. Record the observed restart count and its change over the
   verification interval. Do not claim these workers share the web revision.
   `always-on-worker.md` requires a dedicated immutable release procedure for an integration
   refresh; do not update a mutable checkout or restore a retired plaintext credential path.
6. Do not stage or activate the fenced report worker or the recommendation worker; both remain
   later packages. Do not retire `wizard-ads-worker.service`.

### Freeze

7. Once web and its Vercel cron are on one revision, WP-216 is live and every claimant has a
   recorded compatible artifact and exclusive job set, prove one complete preview lifecycle.
   Only then record that the optimizer edit and job-creation freeze is lifted.

## Local operator preview, 2026-09-06

A separate `wp-213-marketer-preview` worktree at main `9672d93` now runs the existing E2E
development setup with mock Amazon hosts, synthetic users and disposable local PostgreSQL
on port 55439. Welcome: `http://127.0.0.1:3986`; app: `http://127.0.0.1:3987`. Both bind
127.0.0.1. Private launcher and evidence are under `_local/frontend-preview/` in Codex's
source checkout. The launcher PID is recorded there; SIGTERM runs the existing cleanup for
its Next server, mock and owned `wizard_ads_e2e` database. Do not run another E2E suite against
that same database name while the preview is in use.

There are 31 synthetic campaigns, 1,200 added daily SP/SB/SD facts and 41 aggregate dates
including the original fixture day. Optimizer, dashboard, grid, recommendations and Time
Machine pass authenticated HTTP checks. Visual/interaction verification remains pending due
to a browser-control timeout. This uncommitted local helper is not deployable authentication
code, a Vercel release candidate, or evidence of live Amazon execution. Production deployment
and the remaining approval/creation/upload client work retain their acceptance checks above.

## Authorization

Present one scoped deployment authorization after candidate and rollback preparation. Name
Vercel candidate/promotion, MCP credential staging/install/activation and the exact previous
artifacts used for rollback. Execute covered steps autonomously. No migration, provider write,
integration-worker replacement or queue-ownership transfer is authorized by this package.

## Acceptance

1. `/api/healthz` on production reports the main revision; the candidate verifier passed.
2. MCP health reports the same revision; discovery shows 11 tools; audit rows appear.
3. Both worker artifact identities and job ownership are recorded as applicable; two counted
   compatible claim cycles and no new restart during verification.
4. The click-through is recorded per page with no 5xx and no Amazon write.
5. `docs/HANDOVER.md` and `docs/STATUS.md` reflect the new snapshot; `pnpm hygiene` passes.

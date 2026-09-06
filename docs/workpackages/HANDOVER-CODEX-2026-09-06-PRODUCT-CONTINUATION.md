# Codex handover: continue the product work

Prepared September 6, 2026, after the main website frontend release. Start with this document,
`AGENTS.md`, [the replan](REPLAN-2026-09-05.md) and [the audit](REPLAN-2026-09-05-AUDIT.md).
Historical statements that publication awaits approval or that the frontend is only built
are superseded by this checkpoint.

## What is live

The main website now runs **`9672d93d946d09d6f49a89461432831ef23df0c9`**, the current main
revision independently checked against GitHub. Claude's sidebar, branding and table changes
are published. The operator can review them on the normal website with the existing login.
This deployment did not merge PR #141 or publish its backend write source.

Main CI `34015967395` passed. The release's production artifact passed the existing public
verifier for full Vercel revision identity and the official brand SVG. Independent reads then
confirmed the custom domain and cron target point to the same new deployment. The Vercel
five-minute cron is **enabled**; its cutover pause lasted **208.619 seconds**, ending at
15:49:47 UTC. One unique subsequent cron request at 15:50:27 UTC returned 200. The CLI log
repeated that request four times; do not count it as four cycles.

Browser checks used the permitted Chrome surface and the operator's actual session. They
observed the loaded dashboard, optimizer table and campaign grid, the Recommendations empty
result, Time Machine history, and Creative Performance's explicit inactive-sync state. The
optimizer was visually inspected in light and dark themes; fullscreen was entered and exited,
and light mode restored. No recommendation run, approval, provider mutation or export was
triggered. This is a bounded smoke check, not the complete 35-page, both-theme acceptance matrix.

Two product limitations are visible on the live account:

- Reporting freshness warns that the required completed report loads are missing and the
  displayed figures are older than the page. Diagnose ingestion and coverage before treating
  these figures as current marketing evidence. Do not hide or weaken the warning.
- Creative sync is not active for the reviewed profile. The page correctly refuses to replace
  observed asset mappings with names or ad-group totals. SB video and SD insights remain work.

Production deployment IDs, URLs, project identifiers, browser evidence and account context
stay in gitignored `_local/wp213-web-candidate/`. The exact original deployment is retained
there as rollback; do not delete it. No sudo operation is currently waiting on the operator.

## What happened during deployment

The first `--prod --skip-domain` attempt reassigned cron despite preserving the public custom
domain. Its unknown revision failed verification. Recovery then briefly served an old-code
clone before its unknown health result was evaluated, and an initial rollback raced promotion
completion. The exact original was restored before cron resumed; that earlier pause lasted
703.669 seconds. This incident is disclosed in the audit and must not be represented as a clean
first attempt. The earlier candidate received one cron request returning 200; a read-only job
census found no retained job started in the exposure interval, but neither fact proves complete
invocation accounting or excludes inline sync work.

A protected custom `release-review` environment was created to avoid cron reassignment. It
references production database/auth configuration on Vercel, excludes cron and Amazon
credentials, has no branch matcher, uses its own sign-in origin and disables weekly scheduling.
It is **not a separate database sandbox**. Its seven effective settings and their scope are
recorded privately. Production settings retained their values, types and production targets.
Two exact Supabase auth callback patterns were appended for that review alias; existing entries
and the site URL were preserved. Preview email still did not complete the operator's sign-in.

The operator then explicitly said to publish main and check the public website. That instruction
superseded pre-publication authenticated preview checks for this release. No further release
approval is pending. Promotion first created a separate Ready/STAGED production build with
production configuration. Its public identity/brand checks passed before a second promotion
assigned it. See [the corrected runbook](../deploy/web-vercel.md). Future releases must evaluate
each dependent read before mutation; CLI success and Ready do not prove domain assignment.

## Source state to preserve

- Active source checkout: `wp-214-sp-write-source`, draft **PR #141**. Its pre-handover head
  `bd23d7f` has green CI `34037799902` for both required jobs. This handover and release records
  land as a later documentation commit; check that exact head's CI separately.
- The seven findings from Claude's PR #142 handoff are fixed in source, including immutable
  proposal revisions, actual-store mirror capability, approval retry refusals, Time Machine
  filtering, MCP import restrictions and required-database CI. They are not live write proof.
- The newest source slice, `3340f73`, implements immutable persisted campaign previews, an
  authenticated reader/server loader and read-only `GET /api/campaign-creation/preview`.
  Its final serial tests pass: **641 DB tests, 761 web tests, 22 workspace typechecks**, full
  clean-checkout lint and hygiene. Private detailed evidence is in
  `_local/campaign-preview-store-design/`. There is no public campaign generator, approval or
  dispatch route yet. Opening a saved plan does not create or approve anything.
- Preserve the clean main release and synthetic local preview worktrees. The user cannot
  use the loopback preview, so do not ask them to review localhost again.
- WP-201–205 remain parked. Leave `wp-201-disposable-preparation` and its worktree untouched,
  including its pre-existing uncommitted files. Do not delete, rebase or resume it.

Inspect branches/worktrees before editing. Do not edit Claude's client components or reserved
`docs/HANDOVER.md`, `docs/STATUS.md` and `.github/workflows/trusted-kernel-proof.yml` without
coordinating ownership. This new handover is separate from those protected files.

## Database and activation boundaries

Claude's WP-207 five-migration window is complete at the 46-version baseline. The eight fenced
function ACLs were independently repaired, and the unexplained preview login was disabled,
its RLS bypass removed and its future default SELECT grant revoked. Its existing grants remain;
the two known grant-count differences are expected. Do not reopen or repeat these repairs.

The **ten-file write-path window is not applied**. It contains the five WP-214 migrations
`20260905000000`–`20260905040000` and the five WP-217 migrations
`20260906000000`–`20260906040000`. Follow their exact inventories and deployment order in
[WP-214](WP-214-first-live-sp-write.md) and [WP-217](WP-217-mcp-guarded-apply.md).
The local rehearsal used the resulting hosted baseline and operational repairs; production
lock/index duration, final bundle review, source merge and scoped window authorization remain.
Do not deploy the write branch's web code before its schema dependencies.

The source ACL correction `20260906050000_recommendation_fenced_function_acl.sql` is separately
scoped; its SQL repaired hosted permissions without adding a migration-ledger entry. The new
`20260906060000_campaign_creation_previews.sql` is also separate and local-test-only. Never run
an unrestricted `db push` that silently combines these with the authorized ten-file bundle.

Web publication does not authorize migration execution, a replacement worker, MCP activation,
Amazon writes or an optimizer cadence. Keep the recommendation-lane flag absent for the
merged fallback. The optimizer operational freeze retains its uncompleted preview-lifecycle,
claimant compatibility and counted-cycle checks. Check any gitignored live-write authorization
against its exact action, profile bounds and expiry; credential availability is not authority.

## Continue in this order

1. Finish WP-213 operational evidence: investigate reporting freshness, reconcile cron work
   with completed jobs/observations, record compatible worker identities and claim ownership,
   and finish the remaining browser matrix. The integration service was active with zero
   restarts; it was not replaced. HTTP 200 alone does not finish this acceptance check.
2. Finish WP-214/WP-217 product integration and review PR #141. Complete approval/status and
   guarded inverse screens with Claude, immutable confirmation, missing-observation handling
   and linked Time Machine history. MCP attribution must show the key and approving authority.
   Keep the operator's decision: no arbitrary global ceiling on a configured daily allowance.
   Add bid/budget and campaign state changes in separate slices beyond the keyword path.
3. Deliver direct SP, all supported SB and SD creation using the existing frozen plan contracts.
   Add approval, dependency-ordered worker execution, persistence and uncertain-response
   recovery without duplicate resources. Create paused and approve launch separately. Creation
   has no delete rollback; pause/archive is another reviewed operation.
4. Add the profile-scoped Amazon asset picker and private upload/worker registration workflow
   for the operator's videos. Keep processing, eligibility and moderation distinct and bind
   selected asset ID/version into the approved preview. Supply Claude's rendering/failure fixtures.
5. Finish SB video ingestion and the early SD inventory/identity/reporting-grain checks. Use
   the dated [Amazon capability matrix](WP-215-AMAZON-CAPABILITIES-2026-09-06.md), rechecking
   current provider contracts and profile eligibility. Missing creative-level reporting stays
   an explicit gap; campaign totals cannot stand in for it.

Keep Claude's frontend boundary stable: Codex owns `approval-loader.ts`, preview GET and existing
approve/status routes, the server `writes/[planId]/page.tsx`, approval fixtures and E2E support.
Claude owns `approval-screen.tsx` and presentation tests. Integrate the server page when the
component exists. Apply the same separation to campaigns, assets and insights; serialize shared
schema and browser registry edits. Update the replan, audit and affected briefs after meaningful
changes, distinguishing source, tests, deployment and live evidence.

The frontend release is available for design review. The full **frontend foundation ready** and
**marketer release ready** milestones remain unachieved. Resume WP-201–205 only after the usable
product and authorized live workflows are delivered, while Claude continues design work.

## Suggested new-chat instruction

> Read this handover and the current AGENTS.md, inspect the source branch and worktrees, and
> continue the remaining product work in goal mode. The frontend is already deployed; do not
> ask again for that release approval. Start with the reporting-freshness and operational
> evidence gap, then finish the guarded write, campaign, asset and creative work. Keep Claude's
> frontend ownership and WP-201–205's parked status. Prepare exact hosted/live scopes before
> requesting any authorization that is still actually required. Keep the replan and audit current.

The previous thread's older write-only goal record is still marked blocked. It was not marked
complete by this frontend deployment. A new chat can establish the current product goal afresh.

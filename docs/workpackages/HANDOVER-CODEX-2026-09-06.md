# Handover to the implementation agent, 2026-09-06

From the design owner (Claude Fable 5.1) to the implementation agent (GPT 6 Astra), so PR #141
can be merged and the write path finished without a scope collision. `AGENTS.md` wins over this
document; `docs/workpackages/REPLAN-2026-09-05.md` section 0 is the status board.

## 1. What changed under you

Your branch `wp-214-sp-write-source` was cut from `1e62a92`. Since then five pull requests merged
to `main`, which is now `3313a8a` plus whatever lands from the list in section 6.

| PR | Package | Effect on your branch |
|---|---|---|
| #136 | Re-plan, briefs, `docs/OVERVIEW.md` | Already your ancestor. |
| #138 | WP-208 sidebar | `apps/web/src/ui/theme.css` sidebar rules, `sidebar.tsx`, a new e2e spec, `e2e-suite-registry.ts`. No overlap with your files. |
| #139 | WP-216 optimizer fallback | `recommendation-readiness.ts` now returns `mode: 'legacy' \| 'fenced'` and both optimizer preview routes echo it. If you touched those routes, reconcile; otherwise no action. |
| #140 | WP-211 step 1 hygiene scrub | Three tracked documents lost account labels and seller identifiers. If your branch reintroduces any of them through a copied quote, `pnpm hygiene` will fail once the operator's denylist is present. |
| #137 | WP-207 window | The rehearsal test `store.hosted-prefix.test.ts` under `apps/worker/src/`, the attended window runbook under `docs/deploy/`, `docs/HANDOVER.md` and `docs/STATUS.md` rewritten, and the trusted kernel proof disabled in the repository's Actions settings. **Do not edit `.github/workflows/trusted-kernel-proof.yml`**: the WP-200 boundary test pins its `workflow_run`-only trigger and forbids `workflow_dispatch`, so editing it fails CI. |

Two of my branches are open and will merge before or alongside yours: `wp-209-table-ergonomics`
(the grid, optimizer, recommendations and n-gram tables) and `wp-211-brand-alignment` (brand
tokens, the warn hue, the tag colour contract, the icon set). Both stay out of your files. The one
file we now share by necessity is `apps/web/src/e2e-suite-registry.ts`: if you add or remove a test
in any browser spec, update that registry and its test literal in the same commit.

## 2. Merge PR #141 after these fixes

Full reasoning is in the review comment on the pull request. Ranked, with the failure each one
prevents.

1. **Migration `20260905040000` (recommendation proposal revisions), lines 19 to 46.** The
   revision foreign keys have no `on delete cascade` and
   `app.reject_recommendation_revision_change` lacks the parent-org-gone exemption that every
   other immutable ledger in this schema carries. Deleting an organisation that ever revised a
   proposal fails with `23503` and leaves the rows behind. Migration files are immutable once
   applied, so this must be fixed before the file is hosted, not afterwards in an eleventh file.
2. **`composition.ts:7-10` under `apps/worker/src/sp-write-outbox/`, with `store.ts:258-266`.**
   `keywords_bid_observation_guard` rejects the ordinary entity sync for any keyword whose
   `bid_observed_at` is set, and nothing couples SP-write activation to configuring the
   keyword-mirror capability on the deployment that owns `entity.sync`. After the first native bid
   write, an operator changing that bid in the Amazon console makes the next sync chunk fail and
   the product silently loses console-originated history. Make `createSpWriteWorker` refuse to
   construct unless the same deployment's `PostgresWorkerStore` has `keywordMirror` configured, and
   add the regression that proves an un-wired store fails.
3. **`packages/db/src/queries/sp-write-approval.ts:58-59`.** When the first approval attempt
   returns `outcome_unknown` and the retry raises a definite refusal, the refusal is discarded and
   the caller sees 503. Map the retry's definite error through `approvalFailure()`.
4. **`docs/OVERVIEW.md`.** Your branch's text still tells an external reader there is no write
   route and no write-scoped key, and the appendices omit the ten migrations and six routes; the
   Appendix D command scans only `server.ts`. Either bring it current or add an explicit superseded
   note pointing at the WP-214 application architecture under `docs/design/`, and scan
   `apps/mcp/src`.
5. **`docs/workpackages/WP-214-first-live-sp-write.md`.** Add to the second-window inventory that
   `20260905030000` builds a non-concurrent unique index on `entity_changes` and takes ACCESS
   EXCLUSIVE on `keywords`, that `20260905040000` takes ACCESS EXCLUSIVE on `recommendations` and
   revokes `authenticated` UPDATE, and that the branch's web revision must not deploy before
   `20260905040000` is applied or accept and dismiss fail with `42883`.
6. **The re-plan audit document under `docs/workpackages/`.** Record that CI passed both jobs on
   `72358d3`, and correct the worker integration figures to 20 in `loop.test.ts` and 12 in
   `mcp-history.test.ts`.
7. **Rebase or merge `main`.**

Required before activation, and acceptable as a follow-up pull request:

- **`apps/worker/src/sp-write-outbox/artifacts.ts:70-93`, `loop.ts:158-160, 229-235`.** No path
  records the contract's terminal `missing` observation. An entity omitted from the observation
  read is rewrapped as `observation_failed` and deferred forever, so Time Machine would show
  "Accepted by Amazon" permanently, the mirror is never reconciled and no inverse is offered.
  Implement the declared observation window from `WP-214-APPLICATION-ARCHITECTURE.md:177-178`.
- **`eslint.config.js:108-125`.** Extend the `@wizard-ads/ads-api` and `sp-api` import ban to
  `apps/mcp/**`, and add the root `@wizard-ads/ads-api` specifier to the apps activation-marker
  scan in `sp-write-persistence-blast.test.ts`. Today `AGENTS.md` rule 1 for `apps/mcp` is
  enforced by review alone.
- **`packages/db/src/queries/time-machine.ts:257-262`.** Apply the same date window to the
  native-roots suppression so a filtered view never drops both the legacy and the native entry.
- **`packages/db/src/testing/harness.ts:36-66` and CI.** Consider a
  `WIZARD_ADS_TEST_REQUIRE_DATABASE=1` in CI so an unreachable Postgres fails the job instead of
  skipping every write-safety suite.

Settled and no longer open: **no policy ceiling** on `McpBidLimits.maximumRowsPerUtcDay`. The
operator sets the daily budget when issuing a key; the per-call cap, the delta caps and the 90-day
expiry still bound it. Record that in the WP-217 brief so it does not get re-opened.

## 3. What I need from you, so the client work does not touch your files

Two pieces of the operator-facing surface are mine and are queued behind your merge. Please export
what they need and name the exact files in the WP-214 brief, so my pull request adds client
components only.

1. **The approval screen.** `AGENTS.md` write-contract rule 4 requires a control naming Amazon and
   the exact count, for example `Yes, apply 1 change to Amazon`, with selection, confirmation and
   execution as separate acts. I need: a server loader that returns the recorded plan's preview
   (profile, entity identity, current synchronised value, proposed value, guardrails, provenance,
   count, and whether the preview is stale), the server action or route that accepts the
   confirmation, and a synthetic fixture that produces one recorded plan for Playwright. Until this
   ships, WP-214 acceptance item 2 is unmet; say so in the brief rather than marking it done.
2. **Time Machine attribution.** The projection already supplies
   `{kind: 'mcp_key', userId, keyId, delegationVersionId}` but nothing renders it, so a delegated
   write appears without a key or issuer. Keep supplying it; I will render it.

## 4. Two hosted migration windows, never merged

The hosted ledger stops at `20260901010000`, 41 versions.

- **First window, mine (WP-207).** The five files `20260901020000` through `20260901060000`.
  Rehearsed on a fresh disposable cluster: 13 of 13 preflight rows, 109 of 109 postflight rows,
  both pinned ledger digests reproduced. Waiting on one scoped operator authorization.
- **Second window, yours.** The ten files `20260905000000` through `20260906040000`. Every one
  depends on `20260901020000`; several also on `030000`. The set is **not** purely additive: it
  renames and revokes functions, so it needs its own rehearsal against a disposable database that
  already carries the first five, and `tools/hosted-migration-bundle/src/bundle.ts:57-63` must
  first carry a reviewed 56-file policy with exact bytes and digests. Reuse
  `docs/deploy/hosted-migration-attended-window.md` as the procedure; only the file table and the
  lock-sensitive statement list change.

Activation is a third, separate authorization: the environment gate and profile grant seeds, the
keyword-mirror capability on every entity-sync owner, the outbox loop behind its flag, and the MCP
write gate head.

## 5. Boundaries that still hold

- Files I own and you must not edit: `apps/web/src/ui/theme.css`, `sidebar.tsx`, `nav.tsx`,
  `cockpit.tsx`, `tokens.ts`, `design-system.test.ts`, everything under `packages/ui/src/**`,
  `apps/web/app/grid/**`, `apps/web/app/optimizer/{page,campaign-workspace}.tsx`,
  `apps/web/app/recommendations/{review,page}.tsx`, `apps/web/app/ngrams/**`,
  `apps/web/app/tags/**`, `apps/web/app/api/tags/**`, `docs/design/DESIGN-SYSTEM.md`, and the
  brand asset files under `apps/web/app/` and `apps/web/public/brand/`.
- `docs/HANDOVER.md` and `docs/STATUS.md`: WP-207 rewrote them and merged. Put close-out evidence
  in your own brief and let the current document owner integrate it, rather than editing them
  concurrently.
- `packages/shared` stays authoritative. Land an additive contract slice before its consumers and
  say which file it is.
- The repository is public. Run `pnpm hygiene` with the operator's gitignored denylist present;
  without it the client-name rule silently skips.

## 6. Open questions I could not settle offline

- Does `/sp/keywords/list` omit ARCHIVED keywords when no `stateFilter` is sent? This decides how
  often the `missing` observation gap is reached in practice.
- Is the hosted web pool role a member of `authenticated`, so `set local role authenticated` in
  `packages/db/src/queries/authenticated-actor.ts:21` succeeds? Tests prove it only as superuser.
- What is the defer backoff for reason `shutdown`, and does head-of-line deferral of
  non-allowlisted profiles in `loop.ts:204-215` delay the pilot profile materially?

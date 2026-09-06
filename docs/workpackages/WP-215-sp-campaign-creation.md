# WP-215 — SP, SB and SD campaign creation via API

Owner: Codex for contracts, server and worker; Claude for client components. Source contracts,
provider research and synthetic verification may proceed alongside WP-214. Activation of
campaign creation follows WP-214's verified live write and inverse.

Operator decision, 2026-09-06: D7 now requires direct SP, all supported SB formats and SD
creation, Amazon Asset Library selection and uploading the operator's own video. The old
SP-only release boundary is superseded. SP remains the first vertical implementation;
SB/SD and asset preparation are required follow-up slices in this package's release.

## Required delivery slices

1. Verify the per-profile format, objective, targeting and destination capability matrix from
   pinned Amazon contracts and an authorized read-only probe. Cover SP automatic/manual,
   SB classic and manual/automatic collections, Store Spotlight, video and Brand Gallery
   with their supported product-page/Store
   destinations, and SD image/video. Unverified combinations stay explicit blockers.
2. Implement the SP frozen-plan ledger, adapter, executor and approval/status contract below.
3. Implement profile-scoped Asset Library search/read and own-video preparation. Stage uploads
   in private Supabase Storage with scoped upload authorization. Only the worker calls Amazon
   upload/register APIs. Expose processing, eligibility and moderation separately. A campaign
   preview binds the eligible Amazon asset ID and version, never a transient upload URL.
4. Implement each SB and SD adapter with matching eligibility, parent observation and response
   correlation tests. Add supported shared contract variants before consumers when the verified
   matrix requires them; the operator pre-approved this additive work. Do not infer full
   coverage from the current enum or treat the legacy media client as the Asset Library.
5. Expose campaign draft, recorded preview, approval and status contracts and synthetic fixtures
   to Claude before client integration. Creation starts paused. Launch/pause is another exact
   approved write through OpenSpell. Record creation and state changes in Time Machine;
   pause/archive does not delete created resources.

Each slice declares exact files before editing. Further migrations have their own reviewed
scope and rehearsal; they do not join either existing hosted window without authorization.
The final release requires creation and observation in Amazon for every supported format,
including library selection and own-video upload. A generated export is not acceptance evidence.

## Current Amazon contract corrections, 2026-09-06

The [verified capability matrix](WP-215-AMAZON-CAPABILITIES-2026-09-06.md) records exact primary
sources and raw-byte digests. It distinguishes documented APIs from profile eligibility and
live behavior. These corrections precede executor implementation:

- SP automatic targeting clauses are created by Amazon. Never POST `target.create` for those
  four predicates. Observe them after creating the parent ad group; any bid/state override is
  a separately approved mutation against the observed IDs. Initial creation uses the frozen
  ad-group default bid. Reject an unsupported override rather than dropping it from the plan.
- Classic product collection and Brand Gallery are distinct SB formats added in the v2
  schema. Brand Gallery requires the documented reserve-share-of-voice capability; its booking
  and spend commitment need an exact approved recipe. An enum does not establish eligibility.
- SD creatives bind to an ad group, with explicit image/video properties and versioned assets.
  SD advertised-product reports contain ad IDs, not asset IDs. Attribution needs temporally
  valid observed relationships; a multi-asset creative cannot award the same totals to every file.
- Asset upload, registration, processing and creative moderation are separate operations/states.
  Current OpenAPI spells the upload request field `fileName`; the differing guide example remains
  an activation check. A registration response alone does not make a video eligible for a campaign.

The first corrective contract slice owns `packages/shared/src/campaign-creation.ts` and its
test only. It rejects unsupported SP automatic create nodes without rewriting recorded plans.
Broader SB/SD variants and their consumers follow as separately verified slices.

The next Asset Library source slice owns `packages/shared/src/asset-library.ts` and test,
then `packages/ads-api/src/asset-library.ts` and test, with explicit `./asset-library`
package exports. It reuses the existing HTTP/auth transport through an inert factory.
Shared contracts are verified and committed before the client. Registration makes one
attempt and preserves uncertain outcomes; reads verify selected identity/version. This
slice supplies metadata preparation only. Private Storage authorization, binary transfer,
durable upload recovery and the picker/upload screens remain separate pending work.

Contracts are committed at `d3330f8`; the provider client and explicit subpath at `d3540b5`.
`createAssetLibraryClient(options, scope)` exposes `search`, `get`, `prepareUploadLocation`
and `register`. It performs no binary transfer and no runtime registration. Search requires
complete counts; reads require the exact requested ID/version; registration attempts once
and preserves uncertainty. ACTIVE processing does not imply creative eligibility/moderation.

The next campaign slice owns `packages/shared/src/campaign-creation.ts` and its test only.
It introduces explicit v2 plan/node schemas, preserves valid v1 fingerprint preimages and
historical reading, and refuses incomplete historical inputs at dispatch. V2 includes classic
collection and Gallery/RSOV, exact SB cost/optimization/marketplace/time inputs, and explicit
SD ad-group-bound image/video properties. All resource references, counts, dependency gates
and receipt checks remain shared. Profile eligibility and verified provider recipes stay
separate prerequisites; this contract slice does not claim working campaign execution.

The v2 slice is committed at `fa83ba5`: 181 shared tests, all 22 workspace typechecks and
focused lint pass. Tests preserve fixed v1 hash goldens, reject mixed versions and incomplete
historical dispatch inputs, require observed dependencies, and prevent redispatch after an
uncertain create. No historical plan is rewritten or given new authority by parsing it.

The next SP request compiler owns `packages/ads-api/src/sp-creation-codec.ts` and its test.
It compiles one selected SP create node into one provider request and a candidate write-ahead
intent using the shared plan/authority/evidence verification boundary. Parent IDs come only
from checked requirements or observed successful creates. Whole-request and per-node digests
cover the exact wire values. Unsupported recipes fail before any I/O. This initial compiler
has no persistence, credentials, transport or runtime export; the later adapter must use one
HTTP attempt per durably reserved intent rather than hide several requests behind a client call.
The same slice extracts the existing provider money rules, without changing their values or
behavior, into internal `packages/ads-api/src/sp-money.ts`; `sp-write-codec.ts` imports those
helpers. Creation and editing then use the same marketplace, precision and range checks.
Non-null portfolios remain unavailable until a scoped portfolio requirement is implemented.

`75c0512` closes a scope omission before compiler implementation: v2 freezes Amazon profile ID,
connection, region, marketplace, currency and account type into the plan hash. New dispatch
rejects every v1 plan because v1 lacks that binding; historical reading and observation remain
supported. All 186 shared tests pass, including scope tampering against the original receipt.
SP dispatch also rejects unsupported campaign-level negative targeting and refuses to guess
seller SKU versus vendor ASIN. Real admission/execution must still verify the currently owned
profile and connection against the frozen scope.

The compiler is committed at `dd64e2c` after the money extraction at `e3750df`:
`prepareSpCreationCall({ plan, currentEvidence, nodeId }, hasher)` returns one immutable POST
body, endpoint/media type, frozen provider scope, request digest and one exact position.
Forty focused tests and all 447 Ads API tests pass, including every SP create endpoint,
large string IDs, missing/failed/unobserved parents, existing/uncertain intents, scope changes,
money precision/range and the exact 1,000-predicate boundary. All 186 shared tests and 22
workspace typechecks pass. This is preparation only; it neither records nor executes an intent.
The future adapter must preserve authoritative rejections versus uncertain responses, use a
lossless ID parser and exact count assertions, and quarantine uncertain creates. Matching names
or an absent observation never authorize another create. Provider-created automatic clauses
are separate observed resources, not explicit POST-create nodes in these counts.

## SP transport implementation checkpoint

The [transport design](../design/WP-215-SP-TRANSPORT.md) declares the next exact scope and
preserves the mandatory reservation boundary. Shared verification now refuses reused call or
attempt IDs across different nodes; all 62 campaign-creation tests and shared typecheck pass.
The inert adapter, private response decoder and synthetic fixtures/tests follow that shared
commit. Durable reservation and runtime activation remain pending.

## Objective

Let the operator take a plan from the Campaign Builder, preview it as an immutable dependency
graph, confirm `Yes, create N campaigns in Amazon`, and have the worker create the campaign,
ad groups, product ads, keywords, targets and negatives in order through the Advertising API
with write-ahead evidence, exact counts and resynchronization. Creation has no delete rollback;
the preview says so and a pause proposal is a separate reviewed action.

## Owned files

- `packages/ads-api/src/sp-creation-codec.ts` and test (new; deterministic request compilation);
- `packages/ads-api/src/sp-money.ts` and the import-only extraction in `sp-write-codec.ts`;
- `packages/ads-api/src/sp-creation-adapter.ts` and test (new; maps plan nodes onto the
  existing deterministic compiler and `httpRequestOnce`; never the retrying/chunking bulk
  create clients);
- `supabase/migrations/<timestamp>_campaign_creation_ledger.sql` (new, additive, five-second
  lock timeout and the advisory DDL lock like every migration since WP-185);
- `packages/db/src/queries/campaign-creation-persistence.ts` and tests (new);
- `apps/worker/src/campaign-creation/**` (new executor, registered behind
  `OPENSPELL_CAMPAIGN_CREATION_READY` and a profile allowlist);
- `apps/web/app/campaigns/create/**` server loaders/actions and
  `apps/web/app/api/campaign-creation/**`; Claude Fable 5.1 owns the client components/design;
- `apps/worker/src/main.ts`, `config.ts` and the relevant activation/blast tests, in a separate
  activation PR after the inert adapter/persistence/executor source passes;
- the DB migration-order assertion in `packages/db/src/migrations.test.ts`;
- `docs/deploy/campaign-creation-activation.md` (new);
- this brief's close-out evidence for the current STATUS owner to integrate.

`packages/shared/src/campaign-creation.ts` remains authoritative; declare and verify any
additive change before dependent implementations. `packages/campaigns` remains pure and
export-capable; direct creation belongs to the application and worker, not the pure planner.

## Read first

1. `AGENTS.md` "Amazon write contract", especially rules 3, 4 and 8 on creation.
2. `docs/workpackages/WP-124-campaign-creation-architecture.md` and
   `WP-125-campaign-creation-contracts.md`; `docs/design/WP-125-ARCHITECTURE.md`.
3. `packages/shared/src/campaign-creation.ts`: plans, approvals, write-ahead evidence,
   accounting, observation-gated dependencies.
4. `packages/campaigns/src/**`: the planner whose output becomes the frozen plan.
5. WP-214's ledger, loop and approval transport; reuse the same patterns and the same
   authenticated-actor helper.

## Required behavior

1. Freeze: a route takes a Campaign Builder plan, validates it with the shared contract, and
   records an immutable plan with a fingerprint and the tenant and profile scope.
2. Preview: shows every node to be created with its parent, the count per entity type, the
   guardrails, and the statement that Amazon resources cannot be deleted by a rollback.
3. Approval: the literal `Yes, create N campaigns in Amazon` with the exact campaign count;
   approval runs as the signed-in owner or admin through the authenticated-actor helper.
4. Execution: worker-only, one plan at a time per profile. For each eligible node record the
   intent, call once, record the sanitized response and Amazon ID, observe that exact resource
   and persist the observation. Release dependants only after the authoritative contract accepts
   the parent as observed. Pending, missing, conflicting and ambiguous parents stay blocked.
   Reconcile ambiguous calls without issuing a second create. Preserve partial and pending states.
5. Counts: requested, attempted, created, failed and refused per entity type reconcile against
   the plan; an HTTP success without an entity-level id is not creation evidence.
6. Resync: observe parents between stages and perform final scoped entity synchronization.
   Show created and observed separately; end-only synchronization cannot satisfy dependency gates.
7. Campaigns are created paused. Launch requires a separate approved state change.
8. Tests: fake provider proving ordering, write-ahead evidence, delayed parent observation,
   ambiguous create recovery without redispatch, partial failure, closed gates and count
   reconciliation; Playwright for freeze, preview and confirmation.

## Authorization

The migration is hosted through the scoped procedure of WP-207's runbook with its own exact
authorization. Prepare the immutable worker deployment and exact live preview for authorization;
covered operations may run autonomously. Creation has no inverse-delete authorization.

## Acceptance

1. One plan with one campaign, one ad group, one product ad and two keywords is created on the
   allowlisted profile with counts reconciled and the entities visible after resync.
2. A deliberately failing node leaves a recorded partial state with dependants unreleased.
3. `pnpm check`, `pnpm hygiene` and both CI jobs pass.
4. Subsequent SB/SD slices prove exact resource counts, selected asset/version, paused creation,
   observation and a separate approved launch for each supported format on an eligible profile.
   Unsupported objective/destination combinations remain explicit gaps. Library selection and
   own-video upload pass their actual browser workflows and scoped live checks.

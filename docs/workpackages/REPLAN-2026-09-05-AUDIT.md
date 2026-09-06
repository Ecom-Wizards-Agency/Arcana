# Re-plan audit and corrections, 2026-09-05

## Implementation resumed, 2026-09-06

### Latest preparation checkpoint

**Campaign review shared prerequisite:** three independent candidates were compared in
`_local/campaign-approval-design/`. The selected design is a pure projection of an already
loaded snapshot, avoiding an artificial database reader while campaign persistence is absent.
The new shared contract retains canonical plan payloads, exact node/check and asset coverage,
source timestamps, scope, and distinct none/unavailable/recorded admission. It validates full
receipt and execution joins before a future browser projection strips worker artifacts.
Guardrails, provenance and the frozen profile label are explicitly not recorded by current
plans. No `canApprove` flag, generated approval, executable action URL or provider call is added.
Shared validation and web projection do not prove actual database membership or snapshot isolation.
The web consumer and fixtures follow the shared contract commit; real reader/routes remain pending.

Review corrected four evidence problems: legacy asset scope was unverifiable, a video could
receive image metadata and remain current, a new check could lend freshness to old asset
processing evidence, and library metadata could carry an unsupported moderation badge.
Legacy asset observations now require a new scoped plan; exact purpose/type and observation
event binding govern freshness; library moderation is always unknown. Five initial test cases
failed, including one malformed legacy fixture which was corrected to its historical purpose.
Private probes independently reproduced and rechecked the scope/type cases. A final timestamp
test accepts equivalent UTC spellings without conflating sub-millisecond events.
**228 shared tests**, **22 workspace typechecks** and focused lint pass. Evidence under
`_local/campaign-approval-design/`: `review-regressions-before.log`, `shared-tests-final.log`
(the legacy fixture failure), `shared-tests-rechecked.log`, `workspace-typecheck.log`,
`source-authority-review-results-fixed.json` and `presentation-implementation-review.md`.
No real reader, UI submission, deployment or provider eligibility is proven by these tests.

**SP exact creation observation consumer implemented:** `observeNode` on the existing inert
adapter validates the plan, approval receipt, observation job, historical admission and exact
recompiled request before token/provider I/O. It performs one exact-ID list request for any of
the nine supported SP resources, includes all states and verifies the singleton/count/page
envelope. Required missing fields, malformed IDs/numbers/JSON and unsupported optional controls
stay pending. Exact settings, parent identities, inherited versus explicit bids and dates are
compared without rounding provider numeric tokens. Reads may continue after write expiry;
unknown moderation/delivery stay unknown. No failed read or absent resource permits recreation.

Independent protocol review reproduced invalid/oversized resolved predicates being observed
and malformed added controls being called a confirmed conflict. Eight regression assertions
failed before correction. Positive/negative read predicates now use their distinct pinned enums
and bounds; placements validate exact integer/range/enum shape before comparison. Unverified
nonempty shopper controls remain pending. Pending takes precedence for a partially understood
row even when another field differs; field-level diagnostics are future work. A final date
regression also verifies removal of an approved end date.

Verification: **652 Ads API tests**, **22 workspace typechecks**, focused lint and the independent
protocol/authority probes pass. The authority review covered input mutation during authentication,
parent conflict after child admission, reads after write expiry, cancellation, token timeout and
one-attempt HTTP refusal. Evidence is under `_local/sp-creation-observation-design/`:
`protocol-regressions-before.log`, `readback-tests-final.log`, `consumer-workspace-typecheck.log`,
`consumer-eslint.log`, `protocol-implementation-review.md`, and
`consumer-authority-review-results.json`. Shared prerequisite CI passed at `444bcbe`, run
`34030023201`; this is not yet a CI claim for the consumer commit.

The consumer is not registered in a worker. A durable read-attempt audit, atomic claim/evidence
checks, campaign ledger, runtime credentials provenance, approval/status screens and scoped live
checks remain required. No new migration, production setting, Amazon call or client edit occurred.

**Creation observation history repaired in source:** three independent candidate designs exposed
a shared contract bug: a later parent observation invalidated a child admitted under an earlier
valid observation. Per-node history now advances strictly and latest-only accounting preserves
existing single-observation fixtures. Historical intent checks use the last dependency state
at reservation, not any earlier success. Non-null IDs are bound in every observation state,
and unknown moderation is representable. Old intent-only observations survive a late provider
result; rejected creates no longer count that old history as pending observation.

Nine regressions failed before repair. Independent review then reproduced three additional
failures: a parent's recovery erased the justification for a terminal dependency block; later
conflict demanded rewriting a terminal refusal; and a delayed contradictory read could pass
proposal verification while invalidating already admitted history. Those are corrected with
terminal reason preservation and stale-read refusal. The future store must still enforce
append-only records, immutable terminal dispositions and claim/evidence-version checks in one
transaction. This source verifier cannot establish commit visibility or actual read provenance.

All **199 shared tests** and **22 workspace typechecks** pass. The initial typecheck rejected
`includes` on a union containing empty dependency tuples; the existing predicate style fixed it.
Private evidence under `_local/sp-creation-observation-design/`: `shared-regressions-before.log`,
`review-regressions-before.log`, `shared-history-tests-final.log`, `workspace-typecheck-final.log`,
and the three candidate designs. S1's fresh provider-source fetch matches its existing digest.
At that prerequisite checkpoint the consumer was pending; it is now implemented above.
Read-specific audit evidence, durable ledger and live verification remain pending.
No production action or frontend client edit occurred.

**Synthetic frontend preview prepared:** main `9672d93` has a separate clean worktree on
`wp-213-marketer-preview`. Existing E2E setup runs only against the dedicated loopback
PostgreSQL test container on port 55439, with mock Amazon hosts and an allowlisted synthetic
process environment. A private welcome helper on port 3986 issues existing development-only
test session cookies and links to the real app on port 3987. Both HTTP listeners bind only
127.0.0.1. No deployed authentication setting or frontend source was changed.

Count assertions verify 30 added campaigns (31 including the tenant fixture), 400 added daily
facts per SP/SB/SD product and 41 profile fact dates including the base fixture day. Five
authenticated HTTP page checks return 200 with no application-error marker. The first private
seed attempt omitted required profile currency, failed, and cleaned up its owned resources;
the corrected attempt passed. Evidence: `_local/frontend-preview/READY.json`,
`HTTP-CHECKS.json`, `server.log`, `start.py` and `preview.ts`. This is route/data evidence,
not rendered browser verification: Chrome control timed out despite installed/enabled
extension and valid native-host diagnostics. No screenshot or interaction pass is claimed.
The local preview is available for operator review; production still has the older revision.
Source CI run `34024384544` passed at `2f60425` before this documentation-only update.

**Live frontend readiness independently checked:** public `/api/healthz` and the authenticated
Vercel deployment health both return `44da7ac32e5a0503993e567c41aaccffd5c39b06`. Vercel lists the
latest production deployment at 2026-08-30 16:09:49 UTC, with no newer hosted preview. Main is
`9672d93`; PR #144's table changes and the earlier sidebar/brand changes are merged but not
live. Only draft PR #141 is open. No write approval client page or direct-to-Amazon campaign creation screen
has been added on the source branch. A finished inert transport slice is not marketer-release
readiness. Evidence: `_local/frontend-readiness-2026-09-06.json` and the Vercel health response
in `_local/frontend-readiness-health-2026-09-06.json`. These were read-only checks; no deployment,
production setting or supervisor change occurred. The next reviewable frontend candidate and
compatible release remain product priorities before WP-201–205.

**SP creation transport implemented and tested:** shared prerequisite `1c53d80` lands before
the inert `./sp-creation-adapter` export. `prepareNode` returns digest/positions without I/O;
`executeOneAttempt` rejoins authority, declared scope against the frozen plan and exact recompiled request,
then performs at most one POST. The private decoder enforces all nine endpoint spellings,
lossless string IDs, duplicate-member/index/count rejection and supplied parent-ID agreement.
It records sanitized outcome evidence and a digest of status/request binding/exact response bytes.
Whole-request definite refusals remain distinct; malformed, unknown and transport failures never
cause another create. Returned representations are not authoritative observations.

Adversarial review found and reproduced five failed assertions: expiry during the header/fetch
microtask gap; conflicting returned parent identity; valid400 with an empty error list; and two
contradictory/unrecognized row error labels. All are corrected. The final fetch wrapper checks
the deadline synchronously with no intervening await before the underlying fetch. Row errorType
agreement is a conservative local rule because S1 leaves that string open. Independent reviewers
verified the corrections and reported no residual finding within those bounded scopes.

Verification: **157 focused tests** (40 compiler, 50 adapter, 67 decoder), **566 total Ads API
tests**, **186 shared tests**, **22 workspace typechecks** and **five import-boundary tests**
pass. Private evidence under `_local/sp-creation-adapter-design/`: `review-regressions-before.log`,
`focused-tests.log`, `ads-api-tests-verified.log`, `shared-tests.log`, `workspace-typecheck.log` and
`import-boundary-tests.log`. A final fixture-import cleanup initially failed the codec suite; the duplicate type import was
removed, then all 566 Ads API tests and package typecheck/lint passed on the corrected source.
The existing compiler test data was extracted into a synthetic shared
fixture without changing production compiler behavior. No database migration, runtime registration,
Amazon call or production setting change occurred. Durable exclusive admission, current gates,
observation-only recovery, campaign/frontend contracts and live checks remain required.

**Final verification correction:** the shared verifier also now rejects a proposed create call ID
already used by a read-check result. The new regression failed before correction; all 186 shared
tests, shared typecheck and 50 adapter tests pass afterward. Evidence: `read-call-collision-before.log`,
`shared-tests-final.log`, `shared-typecheck-final.log` and `adapter-shared-fix-tests.log` under the
same private evidence directory. Scope validation is explicitly validation of a caller-supplied
scope; it cannot attest to raw credential provenance. The future worker/store must resolve scope
and credentials from the same owned connection record. Cross-model review requested this
clarification and direct test-log pointers in the private decision trail.

The inert transport is committed at `2411c18`, after `1c53d80`. Clean-checkout repository lint
passed at `2411c18` (exec session3748, exit0); the source was pushed and PR #141's description
updated. The subsequent shared correction retains the same consumer contract. No hosted operation
or frontend file is part of either source change.

**SP transport design and prerequisite:** three independent designs were synthesized in
`docs/design/WP-215-SP-TRANSPORT.md` under the authorized implementation plan. The shared intent
verifier now rejects reused call/attempt identities from a different pending node before I/O;
all 62 campaign-creation tests and shared typecheck pass. S1 was freshly fetched and its pinned
raw-byte digest is unchanged. The transport itself is the next source slice, not deployed work.
CI run `34017391131` passes both jobs at `88ba5d3`. Main remains `9672d93` and is already merged.
The replan status board now records PRs #144/#145 and the completed first hosted window; stale
first-window access/approval requests were removed. No new production operation was performed.

**Recovered-history local rehearsal passed:** the dedicated loopback PostgreSQL 17.11 instance
replayed all **46 exact observed files**, both recorded operational permission repairs, then all
**ten pinned additions**, each migration in its own transaction. Application migrations ran as
`postgres` with NOSUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS. The historical custody migration
reproduced 18 owner/ACL warnings; the exact operational repair then corrected all eight functions.
The ten additions produced no warnings.

Postflight exactly matches the ten captured role records and 17 membership edges, retains all
158 preview SELECT grants, verifies disabled login/bypass/default SELECT, and checks all nine
new tables for presence, RLS and absence of anonymous or preview authority and authenticated
writes. New constraints/indexes are valid, the eight fenced functions still permit only the
worker among application callers, and both write gates remain absent/closed. Codex independently
checked ordered counts, artifact hashes and all ten additions against current source `0db04d3`,
then reran postflight against the disposable database.
Cross-model review found that the durable gate query omitted the native profile-allowlist head.
The verifier now also asserts that head is empty; its read-only rerun confirms environment,
profile and MCP authority heads all have zero rows. The postflight and artifact hashes were
refreshed, with the correction appended to the private trail. No schema was rerun for this check.

Evidence directory: `_local/write-window-exact-rehearsal/`; files `RUN.json`, `POSTFLIGHT.json`,
`REHEARSAL-STATUS.json`, `ARTIFACTS.json` and `ROOT-VERIFICATION.json`. The verified input ledger
is `f62c9388644580480e2093a649d39e3391f501c907ed4922f5ef981ac9774bf0` for 56 files / 921,245 bytes,
excluding the separately recorded operational repairs and platform fixture setup. A startup-only
readiness failure is retained separately; it applied no application schema.

This passes the recovered-history catalog/permission rehearsal. It uses synthetic platform
auth/Vault/cron and empty application tables; it does not prove managed-platform behavior,
production data/index duration, contention, provider execution or live UI flows. The old fixed
policies remain unchanged. Adoption of the reconciled input manifest, source review/merge and
host-specific pre/post checks still precede a separately authorized production window.

**Main integration verified:** `a78a8b4` records the recommendation view/fixture handoff;
`2dd1688` merges main `9672d93`, including Claude's table conversion and window record. The
only merge conflict was the WP-209 brief: both the earlier requirements and Claude's complete
closeout/performance evidence were retained. Claude's client and owned status files arrived
unchanged through the merge. All **141 web files / 736 tests pass**, including the 16 new
view/fixture checks, with disposable loopback PostgreSQL and the database required. Web
typecheck, unmodified repository lint in the clean verification checkout, hygiene and diff
checks pass. Private logs use the `_local/pr144-main-integration-` prefix: `web-tests.log`,
`typecheck.log`, `clean-lint.log` and `hygiene.log`.

The first root-checkout lint attempt encountered an isolated nested source clone; it was moved
outside the repository. The next root attempt reported lint errors in private probe scripts.
Neither lint configuration nor private evidence was weakened or deleted. The clean checkout
at the identical source revision passes the unchanged command; those earlier failures remain
in their logs. Client fixes in the handoff remain pending despite the green existing suites.

**Table integration follow-up:** PR #144 merged at `5c90c88`, with both CI jobs green;
PR #145's window record also merged, advancing main to `9672d93`. A source review of table head
`8c95f77` verified three client issues: omitted revision references in decision/export requests;
`revision_changed`/`unavailable` refusal reasons installed as optimistic persisted statuses;
and a hidden explicit selection converted to `ids: null` whole-run export. Codex's narrow
server patch retains required revision identity and presents the existing same-statement
counted window. Synthetic scenarios cover edited decimal values, truncated counts, mixed
refusals and hidden selection. **16 view/fixture tests, web typecheck and focused ESLint pass**
before the following main integration. Client corrections and browser proof remain Claude-owned
and pending. The exact interface and failure cases are in
[the PR #144 handoff](HANDOVER-CLAUDE-PR144-2026-09-06.md).

**Fresh hosted-history reconciliation:** read-only SQL-editor recovery found the missing
experiments migration: 6,932 bytes, SHA-256
`f78487d3cd0b8e9e373f50a2078abea2e3bc7d389d06578a8655033ca0e24cdc`, exactly the old pin.
All 46 old-policy files are now reconstructed. A subsequent independent live ledger inventory
contains 46 versions through `20260901060000`, but only **36/46** match those historical pins
under the documented statement-array rendering. Ten differ. Hardening is substantive against
the old policy: 16,449 pinned bytes versus 42,800 recorded rendered bytes (current source is
42,822). All ten actual bodies were then recovered through read-only SQL and independently
checked against the database's byte lengths and SHA-256 digests; none was reconstructed by
editing current source. Exact comparison then confirmed all ten differ from current source only
by deleted blank lines. Nine also differ from the old policy only by blank lines; hardening is
the sole substantive old-policy change. All 46 recovered renders were assembled and independently
hash-verified: 672,673 bytes. The same ten write-path additions produce **56 inputs / 921,245 bytes**.
This is a verified input inventory, not a completed rehearsal or production bundle approval.

Private reconstruction evidence is in `_local/write-window-baseline-reconstruction/`:
`HOSTED-EXPERIMENTS-RECOVERY.json`, `HOSTED-LEDGER-DIGESTS-2026-09-06.json` and
`HOSTED-LEDGER-COMPARISON.json`. The recovered-body directory is
`_local/hosted-observed-baseline-2026-09-06/`, containing `RECOVERY.json` and ten SQL files.
The old-policy rehearsal stopped before creating a database or applying SQL. Its bundle wrapper
correctly refused a source branch that was not clean main. Preserve both fixed policies;
review a distinct reconciled baseline before production preparation. A local rehearsal against
the recovered history and two completed operational changes remains pending at this checkpoint.
No hosted migration or ledger repair was performed during recovery.
The later assembly/comparison evidence is `_local/write-window-exact-rehearsal/`:
`VERIFICATION.json`, `observed-inputs.json` and individual files under `diffs/`. Captured
role attributes, memberships and retained grant identities support the local rehearsal;
Supabase platform components remain explicit fixture doubles.

**Unused-login restriction completed, 2026-09-06:** the operator asked Codex to continue
in response to the exact credential-change approval request. A fresh production read confirmed
LOGIN/BYPASSRLS enabled, zero active sessions, one creator default SELECT rule and 158 existing
public SELECT grants. Codex executed the prepared transaction to remove the postgres/public
default SELECT rule and set NOLOGIN/NOBYPASSRLS. Independent postflight confirms both flags
false, zero automatic SELECT rules, zero sessions and all 158 grants retained. The fingerprint
of existing relation/column/function/schema ACLs and the complete membership row are identical
before and after. The role and its password were not deleted; its origin remains unexplained.
Private evidence: `_local/unknown-preview-role-closed-2026-09-06.json`.

The two postflight grant-count differences reported by Claude remain expected while those
existing grants are retained. Removing them or dropping the role later is not authorized by
this restriction. The second-window rehearsal must include both completed operational changes:
the eight-function ACL repair and this login/default-grant restriction. No migration-ledger row
was inserted for either operation.

Both jobs in [CI run 34014347807](https://github.com/Ecom-Wizards-Agency/openspell/actions/runs/34014347807)
have passed for source `5c8bd01`. PR #144's client file scope stays with Claude.

**Hosted ACL repair completed, 2026-09-06 05:23:54 UTC:** Codex ran the operator's
exact eight-function revoke block through the linked production Supabase SQL editor.
It reported success, but independent ACL reads showed no changes: the managed `postgres`
session had neither inherited nor SET authority over the executor-owned functions. All
eight functions also lacked an explicit worker grant; effective worker access came from PUBLIC.
The operator then explicitly authorized the corrected repair.

The tested transaction temporarily acquired SET authority through the existing ADMIN-only
edge, assumed the executor, granted EXECUTE to the worker and revoked all function privileges
from PUBLIC, anon, authenticated and service_role. It restored the original membership graph
and checked all eight signatures, owners, function bodies, direct grants and effective privileges
before committing. Independent subsequent queries confirmed **8/8 worker grants**, **0/8 ambient
execute grants**, and the original two ADMIN=true / INHERIT=false / SET=false edges, with no
temporary edge remaining. The unknown database login was not altered. No sudo was needed.
Private evidence: `_local/recommendation-acl-hosted-2026-09-06.json` records the ineffective
first attempt; `_local/recommendation-acl-hosted-2026-09-06-repaired.json` records the correction.

The additive source repair is `20260906050000_recommendation_fenced_function_acl.sql`, with
five-second lock timeout and the existing advisory DDL lock. Historical `20260901060000` and
the fixed first-window/ten-file write-window policies remain unchanged. The repair SQL was
applied operationally; **no Supabase migration-ledger version was inserted**. Its later migration
application is idempotent and needs a separately reviewed scope. Full fresh replay now has
57 source migrations. The second-window rehearsal must start from the fetched 46-file schema
plus this verified ACL repair, while keeping its ten additions explicit. See
[the repair handoff](WP-196-ACL-REPAIR-2026-09-06.md).

Four focused regressions pass against a separate disposable loopback PostgreSQL 17 instance:
non-superuser repair, missing ADMIN refusal, idempotence and complete rollback after a failed
postflight. They inspect exact ACL rows and real RPC permission failures. The first test run
incorrectly used SET ROLE to impersonate the worker; the existing guard correctly requires
session identity. The corrected test uses SET SESSION AUTHORIZATION and reaches the existing
authority guard. All **39 custody/migration regressions**, DB typecheck and focused ESLint pass.
Typecheck initially found an optional notice message; the callback now retains an explicit
placeholder so every notice still fails the test. No runtime permission check was relaxed.

The first full DB run passed 621/622 tests and exposed one source-convention failure: the
migration safety gate forbids anonymous DO blocks and requires the advisory lock immediately
after `lock_timeout`. The executed operational repair was atomic and had both locks, but its
source wrapper did not match that migration contract. The additive migration now uses invoker
helpers created and dropped inside the transaction, with the exact required lock prefix.
All **28 focused ACL/lock tests** pass. The non-superuser fixture now models the migration
principal's app-schema creation permission and asserts that no helper survives. The operational
SQL remains preserved in private evidence; it was not rerun merely to match this source wrapper.
The final full DB rerun passes **66 files / 622 tests** with the database required, logged in
`_local/recommendation-acl-db-package-tests-final.log`. The existing 46-to-56 repository
upgrade test also passes; it remains distinct from the pending exact hosted-history rehearsal.

**Earlier unknown-login read-only follow-up:** the operator relayed Claude's discovery of a creator
default grant. Codex independently verified LOGIN and BYPASSRLS enabled, no validity deadline,
zero current connections at the check, one postgres/public default SELECT grant, and an
ADMIN-only operator membership. At that checkpoint no production change to this login was authorized or applied.
The proposed closure removes that default SELECT grant and sets NOLOGIN/NOBYPASSRLS; existing
table grants and the role remain. Its separate authorization was still required then and has
since been granted and executed as recorded above.
The second read counted 158 existing public SELECT grants and confirmed that the current
administrator has the authority needed for the proposed closure. A synthetic transactional
rehearsal verifies disabled login/bypass, retained old SELECT and no SELECT on a new table;
all test objects were rolled back. The guarded production script was prepared at
`_local/unknown-preview-role-closure-2026-09-06.sql`.

**Cron restored, 2026-09-06 05:11:08 UTC:** the operator relayed Claude's completed-window,
database-cron and worker checks and explicitly requested immediate restoration. Codex enabled
Vercel cron, independently verified `disabledAt=null` and identical schedule definitions, and
recorded a **36.34-minute** pause. Evidence: `_local/vercel-cron-window-2026-09-06-restored.json`.
The optimizer-edit/recommendation-creation freeze remains in place until the compatible deploy.

Before the ACL source addition, clean `6472d30` passed all **21 serial non-UI package tasks**
and both jobs in [CI run 34012964187](https://github.com/Ecom-Wizards-Agency/openspell/actions/runs/34012964187).
Those results do not certify the later repair commit; its focused checks are recorded above.

**Authorized cron pause, 2026-09-06 04:34:48 UTC:** the operator asked Codex to pause
Vercel cron for Claude's migration window, targeting 30 minutes and at most 60 minutes.
The authenticated Vercel CLI read the linked project's identity and enabled state, patched
only cron enablement to false, then independently read back a non-null `disabledAt` and
identical schedule definitions. The operator later extended the target by 20 minutes: the planned restoration was 05:24 UTC, with the
60-minute boundary at 05:34 UTC (12:24 and 12:34 Bangkok). No automatic restart was scheduled because WP-207
requires postflight and worker restoration first. Private before/after evidence is in
`_local/vercel-cron-window-2026-09-06-before.json` and
`_local/vercel-cron-window-2026-09-06-paused.json`. Claude owns the migration;
Codex did not run it or change the unresolved database login. No sudo was needed.
Earlier statements that no hosted settings changed describe checkpoints before this pause.

PR #142 and #143 merged to main at `0897f20`; `19db83d` incorporates them into this source
branch. The replan conflict was reconciled by keeping Claude's status board and the detailed
server handoff, updating their ordering to the accepted marketer-release plan. Claude's client
files arrived through the merge; their worktrees were not edited.

The power outage stopped PostgreSQL and removed the temporary verification checkout/processes.
Committed work survived. The dedicated synthetic test container was restarted, and the clean
verification checkout was recreated on persistent storage. No sudo command or hosted action
was needed.

Clean source `a39e197` passes unmodified ESLint, all 22 workspace typechecks and all 21 serial
non-UI package tasks, including **618 DB, 552 worker, 66 MCP and 686 web tests**. The existing UI
suite passes 163 ordinary tests and nine performance cases; the high-cardinality option-set
case fails at **151.44 ms against 125 ms**. No Claude-owned test or threshold was changed.
Hygiene passes with all nine private denylist terms, and all four analytical skill declarations
pass. This is not a full local `pnpm check` pass. Both jobs in
[CI run 34010928039](https://github.com/Ecom-Wizards-Agency/openspell/actions/runs/34010928039)
have now passed for pushed `d3330f8`. Later local commits require their own CI run.

Asset Library contracts (`d3330f8`, six shared tests) precede the isolated provider client
(`d3540b5`). Search, exact-version reads, upload-location preparation and single-attempt
registration are implemented without runtime wiring. Failed/uncertain registration is preserved;
temporary transport URLs stay out of durable outcomes. The client tests and package typecheck
pass. A fresh package run passes **405 tests**: the earlier 352 plus 52 Asset Library cases
and one additional automatically enumerated purity check for the new source file. Web/MCP
provider subpaths are now explicitly prohibited, including the new asset client
inside OAuth callbacks; the five boundary tests pass. Binary upload, private Storage, durable
upload recovery, picker screens and live eligibility remain pending.

The separate write-window policy/entrypoint (`8d32ae6`, command `002b35f`) pins 46 baseline files
plus ten additions: **56 files / 895,200 bytes**, ledger
`491acc42c424a74beb33ce6af874cdf3bd90ecec9aa430f49887fc6b6efb0956`. Its 12 new tests plus 29
existing bundle tests pass, with unchanged original first-window policy. These tests use an
explicitly synthetic baseline where exact hosted bytes are unavailable; production wrappers
correctly refuse that substitute. They do not certify a hosted bundle.

**Earlier offline baseline checkpoint, superseded by the recovery above:** only 45 of 46 pinned baseline files were recovered
offline with matching bytes/digests. The missing file is
`20260814172712_20260814180000_experiments.sql`. Some differences are fetch formatting; the
hardening migration is a substantive historical difference: the old policy pin matches `5a3ea64`
(16,449 bytes), while `fb9e693` expanded today's source to 42,822 bytes. The `b5767ab` regression
therefore proves the current repository's 46-to-56 upgrade, not the exact fetched hosted schema.
Obtain the actual history, verify every fixed pin and rehearse it before requesting the second
hosted apply. Never fill the missing file with current source or change the policy to make it pass.

Campaign v2 contracts are committed at `fa83ba5`. All **181 shared tests** and all **22 workspace
typechecks** pass with this slice. Fixed v1 hash goldens remain unchanged, mixed-version plans
are refused, and new v1 SB/SD dispatch is refused while historical observation remains readable.
V2 records all six SB formats, explicit campaign settings, and SD ad-group-bound image/video
properties with checked asset versions. Tests enforce observed-parent dependencies and refuse a
second create after an uncertain result. This is a contract checkpoint; current profile
eligibility, provider recipes, persistence and execution remain separate pending work.

The provider-boundary review found one further omission: the plan did not freeze the resolved
Amazon profile/connection or seller/vendor account type. `75c0512` adds required v2 provider
scope and hashes it into the plan, while preserving fixed v1 digests. All **186 shared tests**
pass. Every new v1 provider call is now refused; historical observation remains supported.
The tests show that changing any scope field invalidates the original fingerprint/receipt.
SP dispatch refuses unsupported negative-target predicates, manual campaign-level negative
expression targets, agency product ads and seller product ads without a checked SKU. The
independent review also clarified that synthetic completed-evidence fixtures test contract
consistency, not actual provider dispatch; the helper now states that limit explicitly.

SP request compilation is committed at `dd64e2c`, after money-helper extraction `e3750df`.
All **40 compiler tests, 447 Ads API package tests, 186 shared tests and 22 workspace
typechecks** pass. Existing money rules and helper bodies are unchanged after the import/type
extraction; the old adapter/codec's 81 tests also pass. The compiler prepares one node and one
request, binds its ordered position, provider scope and exact body into digests, and refuses
missing observed parents or an existing intent/result. It explicitly refuses unverified
portfolio/rule-based recipes and never rounds money. Independent review found no concrete
defect in this bounded slice. It has no transport, runtime export or persistence; it is not
a campaign executor or a frontend release milestone.

CI for pushed `72e77d7` failed one boundary test after 617 other DB tests passed. The failure
was an explicit provider import-ban string in `eslint.config.js` matching the runtime
activation scanner. A local run reproduced the exact failure. `d210fbf` replaces the two
named OAuth bans with a ban on every provider subpath, including future/nested subpaths;
the unchanged activation scan and all five import-boundary tests now pass. No scanner
exception or runtime permission was added. The next pushed head needs its own complete CI.

Clean checkout `2a14088` passes unmodified repository ESLint. Hygiene initially flagged the
new test's literal synthetic credential values and a combined before/after evidence filename.
The fixtures now assemble the same synthetic values from fragments, and the docs list the
two actual evidence paths separately. All 52 Asset Library tests still pass; hygiene scans
1,585 of 1,586 tracked files cleanly with all nine private denylist terms. No real credential
was present and no hygiene rule/exemption changed.

### Committed source checkpoint

`37025c2` fixes revision purge and approval retry; `4f10487` requires DB evidence in CI;
`8a22152` couples the write worker to its configured store; `721e0e8` fixes date-filtered
Time Machine suppression. Three new timeline regressions failed before that fix and all
15 timeline tests pass afterward, including cursor-independent deduplication.

The recorded-preview contract, DB reader and web handoff are committed at `10bd35b`,
`72c98a5` and `94f2323`. Nine shared tests, nine database tests and seven web tests pass.
The DB suite proves one read-only repeatable snapshot during a concurrent committed edit;
the HTTP suite proves repeated GET/server loads leave ledger counts unchanged. Forward,
MCP and inverse plans preserve verified frozen evidence and prior admission.
Initial web integration exposed a nonexistent `profile.label` column; the reader now derives
the display label from the existing account-name field, and the HTTP tests pass.

`87243b8` adds executable MCP root/subpath provider-import prohibitions and pins existing
root provider consumers individually. The test first exposed that ESLint's existing helper
blocked roots only; MCP now includes subpath patterns. Five blast tests and the existing
runtime-consumer assertion pass. Production worker registration remains absent.

Presentation fixtures cover current, stale, unavailable, queued and inverse review with
verified plan fingerprints and a lost-response sequence. The browser seed produces one new
plan with one action and no approval/outbox rows for that plan. Existing tenant fixture history
is counted separately. Web typecheck and focused lint pass. Hygiene scans 1563 files cleanly
with the operator's private denylist present. None of these results proves a rendered approval
screen or a deployed marketer release; those remain pending Claude integration and activation.

`918f7a5` adds read-only archived-keyword observation support without widening mutable states.
Consumers are committed at `9ed8e6d`. All 36 focused contracts, 352 Ads API tests, 28 DB
mirror/approval/history tests, 12 MCP history tests and 26 loop tests pass. A final added
archived-sync regression also passes; the loop file now has 27 tests. The real-clock test
survives restart, refuses to infer absence from a failed read after the deadline, then records
one missing and one archived/conflicting row with no repeated mutation. It adds roughly
150 seconds to that suite. The still-unhosted `20260905030000` now accepts the explicit
archived receipt without inventing a bid or promoting stale mirror state.

Claude's Time Machine label must distinguish an archived receipt from a newer local bid;
WP-214 specifies `observedState: 'archived'` and the required retained-bid wording. The client
presentation has not been changed here.

`b5767ab` adds a real 46-to-56 upgrade regression with existing synthetic data. It proves
the current review RPC fails with `42883` before the second window, applies exactly ten files
with separate commits, preserves the old proposal/bid, refuses direct authenticated UPDATE,
and successfully revises/accepts through the new RPC afterward. No dispatch plan, approval,
request or profile/environment gate is created. The test and DB typecheck/lint pass.
Initial test setup incorrectly depended on a fixture-only auth helper, then misspelled the
gate table; both test errors were corrected. This is local schema evidence, not a hosted
dry run, lock-duration measurement or authorization.

The root combined check passed workspace typecheck, then stopped at lint: 180 errors came
from existing gitignored exploratory scripts and one from the new approval-retry regression's
missing synthetic error cause. The latter is fixed in `b5767ab`; a clean source checkout is
being prepared for unmodified lint and CI-equivalent serial tests. No lint rule was relaxed.

Verified repairs committed in this source branch:

- Revision deletion: the new regression failed with `23503` before the fix. Cascading only
  the recommendation-parent FK and allowing immutable DELETE only after organization removal
  yields 10 passing revision/export tests. Direct mutation, live-parent deletion and truncate
  remain refused; service-role organization purge removes all counted child rows and preserves
  another organization's receipts.
- Approval retry: the new real-database regression returned `outcome_unknown` instead of
  `source_changed`. Mapping the retry error fixes it; all 11 approval tests pass, including
  lost-commit/enqueue recovery and double-unknown behavior.
- Worker composition: the factory now requires the actual configured `PostgresWorkerStore`
  and uses its handle. Three construction tests and 21 loop tests pass, including a native bid
  followed by a console edit and a repeated sync with no duplicate Time Machine history.
- Required database: nine tests cover required/optional availability and sanitized failures.
  Required mode is configured in CI and forwarded through Turbo's strict environment. Those
  nine tests plus eight revision tests pass; the Turbo dry run confirms forwarding.

These checks used disposable databases in a dedicated local PostgreSQL 17 container on
loopback port 55439. The existing local Supabase role could connect but lacked `pg_authid`
access required by the migration test platform. Its permissions were not changed. DB/worker
typechecks and focused lint passed for the completed repairs. The reader, web fixtures and
Time Machine date fix and terminal-observation consumers are committed as recorded above.

The [Amazon capability matrix](WP-215-AMAZON-CAPABILITIES-2026-09-06.md) verifies the current public
SP, SB, SD and Asset Library contracts without account access. It corrects three material plan
assumptions: Amazon creates SP automatic clauses itself; all SB types includes classic product
collection and Brand Gallery/RSOV; SD creative endpoints and ad-level reports are documented.
Asset-level performance remains unproven without temporally valid joins. Profile eligibility,
upload field spelling behavior and provider observation latency remain live-unverified.
WP-215 now permits contract/client source work in parallel with WP-214 while retaining the
live write/inverse prerequisite for creation activation. Its initial corrective contract slice
rejects impossible automatic target creates at `15e45e6`. Its 31 contract tests and the
existing 741 pure campaign tests pass; both package typechecks and focused lint pass.
Valid fingerprint serialization is unchanged; an invalid automatic-target create plan must
be regenerated, never silently rewritten. The workbook planner is a separate contract and
does not yet have a direct-create conversion; it must not silently discard clause overrides.

The operator accepted the marketer-release plan, including direct SP/SB/SD campaign
creation, Asset Library selection, own-video upload and frontend ownership by Claude.
WP-201 through WP-205 remain parked unless a concrete dependency requires a narrow part.
Source work continues on `wp-214-sp-write-source`; this request does not authorize a hosted
migration or live Amazon operation.

Merged main `3313a8a` at `26a557a` without conflicts or rebasing. This incorporates
Claude's WP-207 without editing its implementation. PR #142 and PR #143 remain open at
this checkpoint; Claude's worktrees are untouched.

Both CI jobs passed source head `72358d3`: [check](https://github.com/Ecom-Wizards-Agency/openspell/actions/runs/33991605485/job/101374759480)
and [Playwright](https://github.com/Ecom-Wizards-Agency/openspell/actions/runs/33991605485/job/101374759614).
At that head, `loop.test.ts` has 20 tests and `mcp-history.test.ts` has 12. These historical
results do not prove that Claude's newly identified failures have been fixed.

One handover question is answerable from source: `app.defer_sp_write_outbox_claim` uses
15, 30, 60, 120, 240 and then 300 seconds for every defer reason, including `shutdown`.
Whether non-allowlisted work materially delays the pilot needs a scheduling regression.
The hosted web role and current Amazon endpoint behavior remain unverified here.

Original reviewed source: `560d5e2`. Original handoff commit: `1e62a92`. The audited handoff is
`REPLAN-2026-09-05.md`. Documentation review used `wp-207-replan-audit`; authorized source work
now continues on `wp-214-sp-write-source`. This document records meaningful implementation
changes as well as the original audit.

The initial review changed documentation and package scope. Subsequent source work is described
below. Tests use disposable local PostgreSQL 17 and synthetic provider facts. No hosted database,
deployment, credential store or Amazon account was accessed.

## Operator direction incorporated

- Claude Fable 5.1 owns frontend design, including the new write-preview client components.
- The operator expects to work with Claude on D1/WP-207 and D2/WP-216. GPT provides the
  corrected handoff and does not begin those implementations.
- Both write entrypoints are required: changes submitted through the OpenSpell UI and
  programmatic changes through its authenticated MCP connection. WP-214 proves UI-driven
  Amazon writes first; WP-217 completes MCP discovery, preview, apply and status against the
  same backend. The MCP path must work without browser cookies or a per-change UI action
  within its operator-issued delegation. A separate REST service is not a prerequisite.
  HTTP tests cover the UI backend and the actual MCP connection.
- Goal-mode building is now authorized. Every MCP change and linked reversion must be recorded
  and visible in Time Machine; add execution-ledger projection and real reversion support.
- Source work, testing and review can proceed autonomously. A tested operational window can
  receive one scoped authorization for its exact targets and restoration steps; attendance and
  per-command confirmations are not technical requirements. Live bounds are not invented here.
- Keep this audit current whenever a meaningful implementation or verification result changes.
- Keep the main replan's current Claude handoff aligned with this audit, including committed
  versus in-progress work, integration contracts, ownership and additional migration dependencies.

## Implementation progress, 2026-09-05

### Current MCP admission, connection and history checkpoint, 2026-09-06

Source implementation is committed at `e9c6411` and published for review in
[draft PR #141](https://github.com/Ecom-Wizards-Agency/openspell/pull/141). Required CI and review
status are tracked on that PR; it is not merged or enabled. Plain ESLint also passes from a clean
committed checkout, without excluding any source path or changing lint rules.

**Implemented and verified locally:** atomic delegated admission, permanent UTC row charges,
exact request replay, legacy/direct/inverse previews and all three authenticated MCP tools.
`queries/mcp-write-application.ts` exposes preview/apply/status through the explicit MCP DB
subpath; the transport does not call Amazon or impersonate human approval. External client
request identity remains key-scoped; the internal approval identity is independently generated.
The existing worker records provider results, observations, mirror updates and linked Time
Machine entries for both human and MCP authority. Each inverse has its own actor and allowance.

The last SQL review reproduced and fixed three artifact/authority defects:

- A primed `REPEATABLE READ` transaction could spend a stale daily-cap snapshot after another
  admission committed. The service admission RPC now requires `READ COMMITTED` (`25001`
  otherwise); the production facade invokes it directly at that isolation. Forced key-lock
  contention proves one admission/one refusal at the final available row, and the primed
  snapshot regression proves one charge after refusing the second transaction.
- Generic service-role audit insertion could forge a second admission event and poison exact
  replay. A narrow invoker trigger reserves that event type for the controlled admission
  owner; ordinary audit writes remain supported. Both insert and update spoofing refuse.
- SQL microseconds could leave a receipt window that JavaScript considered empty. Admission
  and receipt construction now compare the millisecond-normalized validity boundary while
  preserving recorded timestamp precision. The deterministic real-constructor test rejects
  equal-millisecond bounds and reloads an adjacent valid receipt. The new legacy/inverse
  recorder also rejects noncanonical fingerprint preimages and samples one inverse clock.

Authority settlement uses the existing outbox facade's private claim token. It rechecks custody
following lock waits, returns zero changes for a stale claim, and rolls back partial bookkeeping
if custody expires during insertion. Closed authority resolves only previously unresolved rows;
committed intents/results/observations remain intact. Tests force both authority-lock orders,
revocation before provider access and revocation after the first 100 positions of a 101-row plan.
A locally paused/stopped dispatcher defers queued refusals until it resumes; there is no separate
cleanup scheduler. The database MCP gate prevents new delegated intents without redeployment.

**Deliberate source boundary:** the default-off transport registration in `apps/mcp/src/server.ts`
and `writes.ts` is part of WP-217 source. It requires `OPENSPELL_MCP_WRITES_ENABLED=1` and a
verified write credential. Exact static consumer/registration inventories now include those
files, the operator key loader and the two synthetic HTTP/worker fixtures. Runtime HTTP tests
prove read-key and flag-off denial. Provider worker registration, deployment scripts, seeded
keys and enabled gate/config remain absent. No global scan or provider activation rule was removed.
The analyst test fixture supplies the required false config field; no analyst behavior changes.

Final local verification:

| Check | Result |
|---|---|
| Full database suite, serial files | **593 tests passed in 62 files**, including all migrations, source boundaries and the five pilot-template checks |
| MCP package through real HTTP/disposable PostgreSQL | **66 tests passed**, including seven write HTTP cases, discarded committed response, strict-input and audit-failure behavior |
| Existing worker loop plus delegated history suite | **32 tests passed** with the real ledger and synthetic providers |
| Selected UI write, Time Machine and key-management backend suites | **18 tests passed** |
| Shared contract checkpoint | **137 tests passed** before the dependent implementation |
| Workspace typecheck and product lint | **22 typechecks passed**; ESLint passed with gitignored exploratory scripts excluded |
| Public hygiene and analytical skill declarations | Hygiene passed with all nine private denylist terms active; four read-only skill declarations passed |

The preceding full DB run passed 587 and failed one stale latest-migration assertion; the exact
inventory was corrected and the full run above passed. The new pilot test initially failed
TypeScript's dictionary-value check; explicit case typing/value presence fixed it before the
final 22-task pass. Staged hygiene first flagged a synthetic refresh-token literal and a
dense SQL fragment; runtime assembly/spacing corrected those two findings without changing
the checker or test values. The final staged scan is clean. Full root `pnpm check` is not certified green: earlier crosscheck/parallel DB
and Claude-owned UI timing failures remain recorded below. Targeted results do not erase them.

The two-row MCP cycle produces four native Time Machine entries, two provider result positions
and two observed/mirrored rows in each direction, with both initial bids restored. Original-key
revocation does not erase history; an inverse under a separately valid key or human approval
retains reciprocal operation links. Lost-response HTTP recovery produces one admission and
one permanent charge; admission audit/enqueue failures roll back the transaction. Failed
pre-handler attempt audit prevents the handler from running. Error responses never claim an
uncertain admission made no change.

[The source activation preparation](../deploy/sp-write-activation.md) and
`_local/sp-write-gate-seed.TEMPLATE.sql` are now present. The template refuses unresolved
placeholders, unexpected existing environment authority, changed profile routing/grant or an
expired seed window. Its default rollback is nonpersistent; a synthetic explicit-commit copy
creates exactly one environment head and scoped grant with no MCP gate or approval. The seed
window does not automatically expire those gate heads; the runbook requires explicit shutdown.
All ten WP-214/WP-217 source migrations remain outside Claude's original five-file WP-207 window.

Remaining delivery boundary: source PR/CI review, Claude's confirmation client, the separate
worker activation and immutable release scripts, later reviewed schema window, and exact scoped
live UI then MCP forward/inverse proof. No hosted database, credential store or Amazon action
has occurred. WP-201–205 stay parked and PR #135 is closed without merging; its worktree remains.

The checkpoints below are historical states, preserved with their verification limits. The
current state above supersedes their former pending-work lists.

### Delegated admission identity correction, 2026-09-06

The next implementation design is selected from three independent candidates and recorded in
[the delegated design](../design/WP-217-DELEGATED-WRITES.md). It keeps one immutable admission
and UTC charge, atomic audit/enqueue, and the existing executor. Shared
`SpWriteAuthoritySettlement` supports claim-bound refusal before worker preflight; otherwise
expired/closed delegated rows would stay queued before reaching canonical reservation.
Local process pauses defer this bookkeeping until dispatch resumes. SQL admission/settlement
is declared in `20260906030000_mcp_write_admissions.sql`, and atomic legacy/inverse preview
mapping in `20260906040000_mcp_write_preview_sources.sql`. Both are under implementation and
outside WP-207. No database admission or MCP connection result is claimed yet.

The controlled source checkpoint is committed at `605548e`. All three admission design
reviews identified the same mismatch: external apply request IDs are scoped by org/key,
but `sp_write_approval_requests.approval_request_id` is a global primary key. Delegated v2
now records an explicit `mcpRequestId`, verified against the external request, separately
from its server-generated `approvalRequestId`. Historical receipt rehydration uses the
external ID too. Human v1 shape and bytes remain unchanged. Shared verification passes
137 tests in 12 files, plus typecheck and targeted lint. SQL admission and MCP tools remain
pending; this shared correction precedes their implementation.

The committed source snapshot also passes plain `eslint .` from a clean detached worktree,
using the installed ESLint binary directly. An initial `pnpm lint` attempt there stopped
at pnpm's guard against replacing the external symlinked dependency directory, before lint
ran. No original dependency directory or lint rule was changed. This confirms the earlier
plain-lint errors came from ignored exploratory scripts rather than tracked source.

### MCP producer review and sequence correction, 2026-09-06

**Verified source result:** controlled keyword proposal preparation and its atomic audit,
replay, private source closure and legacy export exclusions are implemented. The final
targeted DB run passed 96 tests in five files, including the corrected timestamp refusal,
raw service recorder boundaries, both source ownership races and existing human persistence.
The final shared run passed 136 tests; the selected web/backend suites passed 19 tests.
All 22 workspace typechecks passed. Product lint passed with gitignored `_local` review
scripts excluded; plain repository lint also scans those exploratory scripts and reports
their lint errors. One product type-only import error was fixed. No lint rule was relaxed.

The full serial DB run passed 565 tests and failed one stale source-inventory assertion.
That assertion now lists the declared key-mutation facade and all three MCP migrations;
it and the other 48 legacy persistence checks pass in the final 96-test rerun. No runtime
registration was added. This is not a claim that full `pnpm check` is green; the earlier
crosscheck/DB timing and Claude-owned UI performance observations remain documented below.

Independent final review checked 67 outcomes with no accepted/unreadable artifact. Its
500-row producer run stored and reloaded all 500 actions in source order in 1.733 seconds
locally, with exactly one preview/source/batch/plan/evidence/audit and no new approval or
execution request. The two-row fake-provider cycle records one real provider call per
direction, two result positions and two observed/mirrored rows per direction. Time Machine
retains four native entries with operator attribution and reciprocal original/inverse links;
the initial values are restored exactly after revocation of the source key. These are human
approvals of an MCP-origin proposal; delegated execution remains pending.

Shared source sequence is committed at `69af518`; timestamp handling is corrected at
`a7ec15c`. SQL source work remains outside WP-207 and no hosted/Amazon operation was run.

The later integrated review reproduced a raw v2 inverse that PostgreSQL could record with
a one-microsecond validity window but JavaScript could not reload. The initial shared-only
millisecond-format fix (`43ba21a`) was too narrow: the existing database formatter emits six
fractional digits. Integrated tests caught that regression before database source commit.
The corrected v2 contract permits up to six fractional digits and SQL compares truncated
milliseconds, matching JavaScript. V1 is retained. Shared amendments precede SQL consumers.

The controlled source producer now checks current key/issuer/profile authority and atomically
records request, source rows, plan, evidence and key-attributed preview audit. Its 32-test local
DB checkpoint passed, including 22 raw service SQL cases, eight application cases and two
forced source-ownership races. Injected audit failure leaves no source or execution residue;
replay and recovery after a lost committed response return the same plan. A human-approved
fake-provider forward/inverse cycle remains available after source-key revocation. This does
not prove delegated MCP admission or execution, which remain unimplemented.

Independent raw SQL review found malformed notes, nested JSON shapes and noncanonical
fingerprint preimages that could commit but fail reload. The producer now validates the exact
bounded serialization and rejects those cases atomically. Multi-row review additionally found
that SQL preserved an array the v1 parser rejected under its locale-dependent ordering. The
[selected sequence design](../design/WP-217-PLAN-SEQUENCE.md) adds explicit keyword plan v2;
old v1 fingerprint hashes were captured before editing. Shared contracts precede dependent
SQL/inverse changes. Full v2 source and inverse proof remains pending at this checkpoint.

All tests use disposable loopback PostgreSQL and synthetic data. The implementation remains
unmerged and inactive. These changes add no hosted migration, frontend component or live
Amazon action. The source migration remains outside Claude's WP-207 window.

### Confirmed supervisor parking and scope, 2026-09-05

The operator explicitly decided to park WP-201–205. No work on that program was performed
by this build. [PR #135](https://github.com/Ecom-Wizards-Agency/openspell/pull/135) was still
open when checked and is now closed without merging. The branch remains at `6f86ffd` and
its worktree is retained, including its existing uncommitted `ci.yml` and `HANDOVER.md`
changes. No deletion, reset or rebase was performed. WP-202–205 are not being started.

Remote main and merged [PR #136](https://github.com/Ecom-Wizards-Agency/openspell/pull/136)
were verified at `fc29fb9`. The claim that this merge commit is already an ancestor of the
implementation branch is technically incorrect: their common ancestor is the brief commit
`1e62a92`, which the implementation branch does contain. The audited documents remain on
`wp-214-sp-write-source`; no history rewrite is needed to preserve their work.

The supervisor tradeoff supports parking, with these evidence corrections:

- `230` is the workflow timeout, not measured cost per push. The latest four successful
  trusted-kernel runs lasted roughly 2–2.5 minutes; the latest was
  [run 33971635117](https://github.com/Ecom-Wizards-Agency/openspell/actions/runs/33971635117).
  On checked main, it runs after successful CI for a main push. Claude owns changing this
  workflow in WP-207.
- The four retained tool packages contain 52,116 tracked lines including tests, fixtures
  and documentation. PR #135 adds 41,056 lines and removes 127 across 48 files. These counts
  establish substantial scope; they do not establish a remaining duration of weeks.
- WP-201's source brief explicitly provides an offline, synthetic preparation proof with
  no apply capability or authorized live target. Isolation and formal recovery are design
  benefits, not proof of a deployed production supervisor or elimination of human error.
- Availability of the required narrowly scoped credentials remains unverified here.
  The supervisor would still require a rehearsed, authorized operational window.
- Nine refers to five previously reported unapplied merged migrations plus four local
  WP-214 source migrations. Hosted state was not freshly queried. The latter require a
  second window after WP-214 source review/merge and are not part of WP-207's five-file scope.

Claude's active branches/worktrees were inspected. This build will not edit WP-207, WP-216,
their protected program documents/workflow, or the WP-208/WP-211 frontend scopes. All four
new WP-214 migrations were checked for the five-second lock timeout and shared advisory DDL
lock; their exact identities and compatibility considerations are now in the WP-214 brief.
The second window must precede deployment of a web revision containing native Time Machine:
its read queries require the new evidence tables even when write execution is disabled.

### Integration checkpoint, 2026-09-06

Proposal revisions are committed at `bfde49f`, following shared decision contracts at
`bbc0eb5`. Merge `2ad012e` brings published main `325c689` and Claude's merged sidebar (#138),
optimizer fallback (#139) and hygiene scrub (#140) into this source branch without conflicts.
This supersedes the earlier ancestry/hygiene status: `fc29fb9` is now an ancestor and the
private-denylist hygiene scan passes. Protected worktrees and WP-207-owned files were not edited.

All 22 workspace typechecks and repository lint passed on the merged source. The default
combined tests failed on two 10-second crosscheck cleanup hooks, with all 65 assertions passed.
An independent rerun passed all seven crosscheck suites and cleanup. Serializing packages then
exposed two DB migration-lock tests failing with `division by zero`; this failure is still under
investigation. The subsequent DB run without file parallelism passed all 508 tests in 53 files. No timeout was widened and no
production behavior was changed to suppress the failure. Full `pnpm check` is not yet green.

The remaining package run passed the existing MCP, analyst, backfill and crosscheck suites,
then found Claude's newly merged fallback fixture still asserted exactly 46 migration files.
This branch has 51. The only fallback integration change is in
`apps/worker/src/recommendations-run.test.ts`: require the actual custody migration needed
by the test, while the harness continues to apply every migration. All 23 tests in that file
and targeted lint passed; the initial run's three skipped lifecycle cases now execute and pass.
The fallback runtime implementation is unchanged. The web counterpart in
`apps/web/src/optimizer-runs-route.test.ts` had the same fixed-count assertion and received the
same narrow correction; all 11 route tests and targeted lint passed. The preceding full web
run passed 666 tests with only that fixture failing and skipping its 11 cases. Skill lint passes.
UI functional checks passed; its separate performance suite passed nine tests and failed the
50,000-option threshold at 146.8 ms against 125 ms. The UI package remains in Claude's active
scope, so no threshold or implementation was changed here. Default `pnpm check` remains failing.

WP-217 grounding now traces bearer verification, issuance, frozen source evidence, manual
admission, final SQL provider reservation and Time Machine. Three architecture candidates are
being compared before the delegated authorization contracts. No MCP write key is enabled.

### MCP authorization contract checkpoint, 2026-09-06

The reviewed policy and shared contract slice is committed at `707cf6e`.

[The delegated write design](../design/WP-217-DELEGATED-WRITES.md) records three independent
candidates and the selected separate application facade. The alternative shared application
kernel would relocate human orchestration; it was rejected for the unnecessary wider change.
The selected design preserves the single SP executor, exact old human receipt bytes and
recommendation source evidence. Admission will record immutable UTC budget charges, audit,
receipt and outbox in one SQL transaction. No automatic refunds or inverse cap exemptions apply.

The shared source now defines immutable fingerprinted delegation limits and scope, exact
integer-based absolute/relative bid comparisons, a strict delegated v2 receipt, actor-free MCP
preview/apply/status/issuance inputs and request-ID recovery. Human confirmation input and its
v1 receipt verifier remain human/bounded-only. Time Machine's shared actor derives key, issuer
and delegation version from the immutable receipt. Existing recommendation bid validation now
aliases the same keyword decimal schema to prevent precision drift. `AGENTS.md` is amended
coherently for this authorized delegation model; this does not issue a key or enable execution.

All 127 shared tests passed, including eight new MCP contract cases; shared typecheck and
targeted lint passed. An initial typecheck found a misnamed existing hash helper and it was
corrected. Independent review compared 600 decimal boundary cases with an integer oracle and
found no mismatch. It also reproduced an inverse receipt accepting a different source execution
cycle; the verifier now rejects that mismatch, with a focused regression. Execution/job
rehydration also verifies the recorded delegation fingerprint and caps without needing today's
live key, so revoked-key history remains readable. Final review reran the inverse reproducer through three verifier entrypoints and confirmed
refusal. It also proved old/current parser byte parity for manual and bounded receipts. DB,
worker and web typechecks pass; staged hygiene passes with the private denylist active. Database delegation/admission, MCP HTTP tools, proposal evidence v2,
Time Machine server attribution and runtime activation remain unimplemented.

### MCP enum prerequisite, 2026-09-06

The additive `20260906000000_mcp_write_delegation_mode.sql` adds only the delegated approval
mode. It creates no key, gate, grant, receipt or work item. The DB enum mirror now uses the
shared execution-mode schema; human confirmation schemas still accept only their old modes.
The new migration is outside WP-207 and must commit before the later admission migration uses
its label. The current migration inventory and inert-source scan were updated explicitly.

Twenty-seven disposable PostgreSQL checks passed across the new enum proof, migrations and
activation boundaries. The proof first attempts enum use in the adding transaction, confirms
PostgreSQL refuses and rolls the label back, then commits the migration and verifies later use.
It also counts zero keys, grants, gates, receipts and outbox wakes afterward. DB typecheck and
targeted lint passed. Delegated issuance and admission are the next source slice.

### MCP key authority checkpoint, 2026-09-06

Commit `5a783da` adds `20260906010000_mcp_write_delegations.sql`. It separates immutable
operator-issued key authority from the later atomic write-admission work. Owner/admin issuance
locks current membership and owned profiles, verifies exact canonical fingerprint bytes and
policy bounds, and writes the key, immutable delegation and sanitized operator audit together.
Write keys cannot be upgraded, expanded, deleted or unrevoked in place. Their audited revocation
preserves authority/history. Last-use tracking and existing read-key issuance still work. The
migration seeds no key, gate or work item, and is outside WP-207's window.

Direct PostgreSQL tests cover malformed inputs with zero side effects, permission refusal,
concurrent membership downgrade, duplicate issuance, immutable evidence, revocation replay,
organization purge and rollback when audit insertion fails. Independent executable review found
two SQL/shared discrepancies: malformed UUID/time fields and semantically equivalent fingerprint
JSON with different bytes could be stored but later fail runtime verification. Both are corrected
and reproducers now refuse. Unicode/escaping and numeric-boundary parity were independently
verified. A final duration check uses exactly 2,160 hours so session timezone/DST cannot enlarge
the 90-day lifetime. All 36 focused DB checks, DB typecheck and targeted lint pass.

The existing MCP read suite passes all 58 tests after its legacy-write fixture is updated to
seed an old write row directly and separately prove a read key cannot upgrade. Its first run
exposed a Date-versus-ISO-string binding error in that new fixture; the fixture is corrected.
Web issuance, typed database facade, write admission, MCP tools and server-side Time Machine
key attribution remain outstanding. The authority tests do not establish those capabilities.

The next contract slice separates actor-free operator policy, server-minted token digest,
one-time plaintext response and persisted management summary. The web issue endpoint will be
`POST /api/mcp-keys/write`; its loader/action scope is `apps/web/src/data/mcp-keys.ts`, the new
route, the existing revoke route and synthetic route/data tests. Claude retains all key-management
client components. Shared contracts precede these consumers at `7fe1fe9` (128 shared tests passed).

Commit `80df51b` implements operator key management using those contracts: an explicit DB facade
builds authority from authenticated identity, owned profile currencies and database time, then
verifies the RPC result inside the transaction. A Drizzle mirror covers the private tables.
The new HTTP endpoint uses the existing session/MFA actor gate, owner/admin capability,
same-origin bounded JSON, strict policy parsing and no-store responses. The body-free revoke
endpoint now uses audited operator revocation for both read and write keys. `listMcpWriteKeys`
exposes immutable limits and revocation metadata without token/hash material for Claude's page.

Eight new/existing key-route/data tests, 14 DB authority/mirror/boundary checks, DB/web
typechecks and targeted lint pass. The first typecheck required Drizzle's enum object overload;
the first boundary run required declaring the new error wrapper and synthetic count fixture.
Independent probes confirm malformed successful RPC output rolls back key/delegation/audit,
legacy read credentials authenticate before revocation and fail afterward, and membership
removal/forged input cannot add authority. Unknown failures return sanitized 503 responses
without claiming no change or exposing token/SQL text.

Deployment dependency: the new web revoke route requires `20260906010000` even with MCP writes
disabled. A disposable pre-migration probe confirms 503 and an unchanged active read key when
that RPC is absent. Rehearse/apply the required source migrations before this web revision;
Claude's original five-file window is insufficient. If issuance loses its response, the plaintext
cannot be recovered; inspect the key list and revoke the unused issuance before replacing it.
Write admission, MCP tools, proposal evidence and Time Machine key attribution remain pending.

### MCP direct-proposal evidence contract, 2026-09-06

The shared source contract adds an explicit batch source kind, exact decimal MCP proposal rows,
a versioned proposal artifact and v2 preview evidence bound to its creator and full delegation.
The original v1 parser remains available; serializer labels branch by version without changing
v1 bytes. The application preview contract accepts either source. Internal bearer context and
canonical request preimages remain separate from tool input/output. No database producer or
MCP tool exists in this checkpoint.

Independent review reproduced two weaknesses in the new verifier: a generic name overstated
its v1 value validation, and its preview window could extend beyond delegation expiry. The
verifier now accepts MCP v2 only, validates exact row/action values, and bounds both frozen and
expiry times. Legacy evidence retains its existing SQL validator. Final probes reject forged
sources, rehashed over-cap plans and expired windows; six old/new comparisons preserve v1
parser and fingerprint bytes, including revised proposals.

Shared tests pass all 130 cases. DB/web typechecks exposed legacy consumers requiring explicit
v1 narrowing; the recommendation builder and its fixtures now assert that branch. All 24
preview/admission compatibility tests pass with those changes. Contracts are committed before
the consumer adjustment. No legacy SQL source assertion is weakened.

The consumer audit found MCP drafts would otherwise appear as bulk exports before admission,
and direct download/reversion getters bypass list filtering. Next scope: additive
`20260906020000_mcp_bid_proposal_sources.sql`; source/mirror/preview queries and tests; legacy
Time Machine, export, sync-link, dashboard and strategy server filters. Markers and immutable
source records must agree in the same transaction, including null recommendation ancestry.
MCP drafts must not create export lifecycle states; admitted original/inverse operations use
native history with receipt-derived actors. No client component or protected Claude file is added
to this scope.

### Source progress

MCP source boundary checkpoint, 2026-09-06: `20260906020000` now separates source counts,
protects source identity and private request/artifact rows, and requires the batch, every apply
row and every normalized plan action to agree at transaction commit. Independent review found
the original legacy export-count constraint contradicted MCP counts and reproduced an extra
normalized-action gap; both are corrected. Creator/prepared time, plan source, exact values and
row counts are checked. Normal legacy updates and organization purge still work.

Legacy download/reversion getters, timeline/facets, sync linker/cooldown and dashboard/strategy
server summaries now distinguish the source kind. Exact-string sync events remain visible
without native attribution; null recommendation ancestry still permits legacy inverse exports.
The native history projection derives actors from receipts and omits legacy export metadata for
v2. Delegated history through actual MCP admission remains unproven until that path exists.

Evidence: 12 new DB boundary tests pass; the earlier six-file regression run passed 72 checks;
11 web tests include all three direct download formats and legacy inverse refusal. DB typecheck
and targeted lint pass. Independent disposable DB probes force both native/legacy ownership
race orders, observe PostgreSQL lock waits and assert only the winning path commits. The source
fixture is explicitly root-only synthetic setup, not proof of the pending controlled producer.
The new filtered web queries require `20260906020000` before deployment even with MCP writes
disabled. This file remains outside WP-207; producer, admission and transport work continues.

Proposal revision persistence is implemented on the source branch. The new additive
`20260905040000_recommendation_proposal_revisions.sql` is a fifth WP-214 migration, outside
Claude's original WP-207 window. It retains the five-second lock timeout/advisory DDL lock.
The implementation preserves engine rows, appends immutable edit receipts, resets prior review,
routes authenticated decisions through one atomic audited function, and freezes selected revision
identities in exports. It also extends the existing SQL preview source assertion to validate the
effective revised value. This remains locally verified source; it has not been deployed.

Independent review reproduced direct-RPC acceptance of whitespace-only notes and identified
different proposal lock orders between export and decision. SQL note validation now follows the
shared whitespace rules; export prelocks the exact selected rows in UUID order before rendering.
Analysts retain proposal review rights. The first test attempt stopped at an undeclared `zod`
import in the DB package; validation was moved to the authoritative shared contract instead.
Local lifecycle, concurrency and rollback tests now pass. Seven revision tests cover exact
replay after later edits, concurrent edit/edit and edit/export, rollback on edit and decision
audit failure, membership revocation, direct RPC input refusal, immutable source history and
complete missing/stale selection accounting. The real SQL preview accepts an edited export
and binds its frozen revision ID. All 28 affected web tests passed, including numeric JSON
and Excel downloads, existing write HTTP behavior and server view fixtures. No approval is
added by the edit/review/export flow.

All 119 shared tests passed; DB/web typechecks and targeted lint passed. The broader DB run
passed 76 tests and failed one activation scan because the new HTTP test reads the synthetic
approval ledger. That exact test path was added to the existing test-only allowance; runtime
registration remains prohibited. The subsequent 33-test run passed the revision lifecycle,
schema and activation-scan suites. A separate 36-test run passed the real preview and schema
checks; earlier RLS/export/population regressions also passed. Schema review caught a stale
authenticated UPDATE policy after the privilege was revoked; the additive migration now
removes that policy and keeps analyst decisions behind the audited RPC. The old cross-tenant
HTTP test was updated to require a counted, nondisclosing `unavailable` refusal. A test-fixture
handle mismatch was corrected before the passing typechecks.

Independent final review found no new blocking bypass. Its disposable PostgreSQL probe refused
24 malformed/unauthorized direct calls with zero revision/audit/head changes, refused receipt/base/
head tampering and post-export edits, preserved exact revision/value through the native preview,
and refused historical replay after membership revocation. A forced transaction interleaving was
not independently reproduced; the normal concurrent edit/edit and edit/export tests passed here.
The later integration checkpoint above records the now-passing hygiene scan and the remaining
combined-test failures. These focused results are not a full-tree check or live proof.

| Change | Verified source and behavior | State |
|---|---|---|
| Shared application and immutable source contracts | `packages/shared/src/sp-write-application.ts` and `sp-write-preview-evidence.ts`; exact operation identity includes execution and plan IDs, and frozen evidence retains original export bytes and strategy/group snapshot text. | Committed before dependent implementation. |
| Immutable previews | `5aa18d8`; `packages/db/src/queries/sp-write-plan-builder.ts` and migration `20260905000000_sp_write_preview_evidence.sql`. Reconstructs the actual export digest, reconciles every source row, preserves exact decimals and timestamp microseconds, and atomically stores plan and policy/provenance evidence. | Local tests prove tenant isolation, immutable replay, false-hash/source/policy refusal, rollback on evidence-storage failure and parent-first locks during concurrent run deletion. |
| Approval, status and inverse operations | `25e771e`; `sp-write-approval.ts`, `sp-write-operation-read.ts`, `sp-write-inverse-preview.ts` and migration `20260905010000_sp_write_preview_approval.sql`. Direct authenticated approval checks frozen source/current scope, binds retries to the original actor/request, and prevents another confirmation from admitting the same plan again. | Synthetic forward and inverse each reach recorded provider result and observation through the real ledger. Original/inverse operation links are returned in both directions. Lost approval/enqueue responses and enqueue failure preserve a recoverable operation identity. |
| Verified reversion after an ambiguous response | The inverse builder accepts `observed_after_ambiguous` only when every requested value was subsequently observed, matching the existing shared dispatch contract. | Regression passed. Partial or unresolved observations remain ineligible; current bid/profile/connection changes refuse approval. |
| UI HTTP backend | `apps/web/app/api/sp-writes/{preview,approve,inverse-preview,status}/route.ts` and `apps/web/src/writes/http.ts`. Uses the existing session/assurance gate, owner/admin capability, fixed-origin JSON POSTs, bounded bodies, strict shared inputs, sanitized error codes and uncached responses. | Local HTTP tests pass preview→approval→status→inverse using the real request database, with no MCP process. Client presentation remains with Claude. |
| Database client compatibility | JSON text parameters in preview persistence, inverse reads and the existing staging facade now use `::text::jsonb`. Plain request connections otherwise encode serialized proof arrays twice; Drizzle-backed tests did not expose this. | The real HTTP request-database test caught the mismatch and passes after the fix. |
| Older database and lost-response safety | Migration `20260905020000_sp_write_application_entry.sql` adds `app.approve_sp_write_preview_v1`. Both initial approval and recovery use that versioned entry with the same immutable confirmation identity. | Review reproduced an unsafe fallback when a connection loss masked the missing-function error. The table-based recovery was removed. PostgreSQL regressions now prove zero enqueue both for an absent entry and a masked error, even with a matching existing receipt. |
| Inert worker orchestration | `apps/worker/src/sp-write-outbox/{artifacts,providers,loop}.ts` and explicit `@wizard-ads/db/sp-write-worker` reads. Resolves credentials before claim, checks current dispatch gates before provider access, admits attempts only with a fresh reservation ticket, and keeps reconciliation available when dispatch closes. | **13 real-ledger/fake-HTTP tests passed**, including recovery after both real deadlines, durable recovery with unavailable credentials, and later observation after the real delivery backoff. Mirror persistence is a required callback and is not implemented by this slice; no entrypoint registration. |
| Partial refusal and large batches | The ledger may refuse only stale positions. Adapter compilation now accepts a unique selection of unchanged actions from the verified full plan; the worker selects unresolved actions from ledger evidence and preserves the original plan fingerprint. | Mixed-batch and 101-row probes passed: one stale row remains untouched while the valid row completes; 101 accepted and observed rows reconcile across exactly two provider calls. The larger probe exposed different collation between plan ordering and predispatch evidence; provider calls now use the evidence contract's exact entity/action ordering. |
| Mirror concurrency finding | The original ordinary-sync path captured its persistence timestamp after provider listing and performed unconditional mirror upserts. An older listing could overwrite a newer native bid observation. | Addressed by the committed optional keyword-mirror capability and race tests below. Activation must configure it on every ordinary entity-sync owner before enabling native writes. |
| Ordinary sync merge contract | Shared `KeywordMirrorMergeRequest` validates unique keywords within one tenant/profile/product and records the database read-start time. Counts include every input, stale bid/tombstone and actual diff. | Five focused shared tests and shared typecheck passed before dependent implementation. |
| Mirror contracts | `packages/shared/src/sp-write-mirror.ts` defines separate promotion/current/superseded/missing receipts, exact decimal and bigint transport, attribution of actual diffs, and reconciled ordinary-sync counts. | All **107 shared tests** passed, plus shared typecheck and targeted lint. Dependent persistence is implemented in the following slice. |
| Native mirror persistence and inert composition | Migration `20260905030000_sp_write_mirror_observations.sql`, `packages/db/src/queries/sp-write-mirror.ts` and `apps/worker/src/sp-write-outbox/composition.ts`. Atomically records an observation receipt, updates the keyword bid when current evidence permits it, and links the exact entity-change ID. Conflicting observations retain separate attribution. | Local tests prove concurrent replay creates one diff, receipt-storage failure rolls back the bid/diff together, and a forward/inverse pair creates two distinct diffs and restores the starting bid. Current-schema parity, RLS, immutability and worker-only RPC permissions passed alongside 53 persistence/blast checks (55 tests total). Time Machine projection and ordinary sync integration are recorded below. |
| Ordinary keyword-sync fencing | `queries/keyword-mirror.ts` captures database time before provider listing, serializes mirror promotion with native observations, and atomically writes actual keyword diffs. The optional worker-store capability counts stale bids and tombstones, preserves newer full-entity evidence, and passes counts into the durable sync-job result. | Four PostgreSQL tests passed for stale values, tombstones/resurrection, precision/scope refusal and rollback on lost diff rows. Two real-worker tests passed for a concurrent native observation and for a write that completes during an ordinary listing. Worker typecheck and targeted lint passed. The capability remains unconfigured in runtime entrypoints. The broader regressions passed **122 worker tests in three files** and **76 DB tests in four files**, including the existing ordinary-sync cases and persistence boundaries. |
| Mirror status contract | `SpWriteOperationDetail` now requires separate mirror counts, including observations still awaiting a receipt. The observation total must match the verified provider ledger. | Eleven shared tests and shared typecheck passed before the status-query implementation. The query now verifies receipts only for observations in the ledger snapshot. Three worker tests, 12 DB tests and four HTTP tests passed; DB/web typechecks and targeted lint passed. The HTTP fixture truthfully reports one pending mirror receipt despite its synthetic direct mirror edit. |
| Native Time Machine read plan | The application architecture now declares the exact projection and server wiring scope. Ordering uses immutable approval time and preserves timestamp microseconds; legacy/native candidates share one repeatable-read snapshot. Only exact provenance or attributed mirror IDs suppress duplicate entries. | The shared `time-machine-writes` contract is now defined, with exact cursors and actor/action/observation/inverse binding. Fourteen focused shared tests, shared typecheck and targeted lint passed. The feed now merges legacy and native entries within one read snapshot and returns exact original/inverse metadata. Eleven existing DB timeline tests and four real-worker history tests passed, including one-row pagination, stable ordering during execution, exact diff suppression, a refused inverse, and preservation of a conflict observation after legacy linking. Server labels/navigation/cursor wiring and all 10 production-build browser tests have passed. Independent review corrections and their regression evidence are recorded below. Conflict observations must remain visible even if a legacy export linker later attaches a batch; the MCP actor is added only with WP-217 delegated receipts. |

The native Time Machine slice is committed at `d74c5de`.

The recommendation population handoff now has a shared contract and declared file scope in
the application architecture. Exact loaded/total/limit counts must reconcile with the
truncation flag. Two focused contract tests and shared typecheck passed before dependent
implementation. The additive `listRecommendationWindow` DB loader now returns exact metadata
and rows from one SQL statement using `count(*) over()` before the 20,000-row cap. It reconciles
safe counts and unique row IDs; the legacy array loader retains its interface. Export download
now refuses a truncated proposal population instead of losing workbook create rows.
Five DB tests passed, including a counted 20,001-row export fixture, scoped/filtered/empty
populations and existing export drift checks; 16 web route regressions passed. DB/web
typechecks and targeted lint passed. The first new fixture used a nonexistent `completed`
run status; it was corrected to the schema's `succeeded` value before these passing runs.
Claude-owned client files are unchanged. Proposal revision design is the next backend slice.

Population implementation is committed at `4bd9c36`. Its final hygiene invocation **failed**:
the private denylist became available and exposed 15 existing matches in the three documents
reserved for Claude's WP-211 scrub. The earlier absence/skipping notes below describe earlier
runs only. No new population source file was reported. These protected documents were not
edited here; the current branch's hygiene gate remains failing until the scrub is integrated.
The local decision trail's initial population checkpoint incorrectly said staged hygiene
passed; a subsequent correction records the nonzero result and existing-document findings.

Proposal revision design is now grounded and synthesized from three independent candidates in
[the declared design](../design/WP-214-PROPOSAL-REVISIONS.md). It preserves original recommendation
and run identities, appends immutable revisions and uses exact content references for review
and export. Replacement proposal rows would conflict with existing run custody. The Python
export validator skips string-valued money, so the chosen bounded numeric export boundary must
prove an exact decimal JSON round trip. Four representative serializer boundaries passed a
local probe; the edit/export lifecycle is not yet implemented. One additional source migration
is planned beyond the four committed WP-214 migrations, outside Claude's original window.

The shared proposal revision contract now defines normalized decimal inputs, explicit content
revision references and immutable edit receipts. The existing preview evidence accepts an
optional frozen proposal revision ID without changing older evidence bytes. All 118 shared tests
passed, including 10 focused tests; shared typecheck and targeted lint also passed. The first typecheck caught an optional
array element in the new test fixture; it was fixed and the checks rerun successfully. Persistence,
edit/decision/export integration and the planned additional migration are still unimplemented.
No fifth source migration was created by this contract slice.

This contract slice is committed at `903e793`. A separate-model review checked the parking
evidence, recent test claims and decision trail. Missing contract checkpoints and ambiguous
older evidence paths were corrected with append-only trail entries and rechecked. Repository
hygiene still fails on the 15 protected-document findings above. This review does not establish
production activation, hosted migration success or MCP write completion.

The main replan now contains a current Claude handoff, including the locally verified
native-history slice. It documents the four UI HTTP
contracts, separate provider/mirror states, exact history links, frontend ownership and the
four additional migration dependencies. It makes no claim that MCP or production activation
is finished. Native-history server verification has passed five web helper tests, web/worker
typechecks and targeted lint; 64 DB regression tests also passed.

Rendered-history verification passed **all 10 Time Machine browser tests** against a
production Next build and the disposable database. The new fixture records synthetic forward
and inverse results through the real ledger and native mirror RPC; the browser follows both
operation links and verifies their exact values and observed states. The legacy export path,
cursor handling, filters, bounded response and tenant isolation still pass. The captured page
was visually inspected. This does not exercise Amazon or the unbuilt confirmation client.
The fixture now uses Node assertions so both Vitest and the browser runner can use it; its
older direct synthetic mirror mode remains explicitly distinct from native reconciliation.
The affected existing callers passed **63 DB tests and eight HTTP/helper tests**. A cursor
fixture was corrected to use an actual bigint change ID, and export-panel copy now describes
that export's effect instead of claiming the whole platform cannot write to Amazon.

Independent query review reproduced a history-loss bug: legacy linking could hide an ordinary
sync event by attaching it to a native source batch, without a native mirror receipt. The
committed regression failed with four visible rows instead of five before the query fix.
Native source batches now preserve such sync evidence; only the exact write-attributed receipt
suppresses its diff. **All 12 timeline DB tests passed** afterward. A smaller blank-field
normalization inconsistency was also corrected and verified in the real-worker history test.
The reviewer additionally verified tenant/profile isolation and seven-input/seven-output
one-row pagination with distinct microsecond timestamps. Review source and reproduction
remain in the gitignored decision-trail evidence.

Latest complete database verification: **478 tests in 48 files passed** with `--maxWorkers=1`.
After HTTP integration and JSON transport fixes, the affected database suites also passed
**78 tests**, and HTTP/role/assurance suites passed **15 tests**. Web and DB typechecks and
targeted lint passed.
The later worker slice passed **13 integration tests** in 98 seconds, **335 Ads API tests**
(including 64 adapter/codec tests), and **53 persistence/blast tests**. Worker typecheck and targeted lint passed. The recovery test
uses real database deadlines and delivery backoff; it does not alter immutable timestamps.
With real mirror persistence connected, all **16 worker integration tests** passed in 100 seconds.
DB/worker typechecks, targeted lint and hygiene also passed for this slice.
These are local source checks, not hosted or live Amazon proof. The WP-188 raw-plan facade suite
still runs against its preceding admission contract; new application/HTTP suites exercise current
migrations and source-backed admission. No lifecycle or custody assertion was removed.

Remaining: Claude's native preview/confirmation client, delegated MCP policy/contracts/persistence/transport, proposal revision
and completeness handoff, immutable release/activation artifacts, and scoped live proof. The
current history screen is locally tested, not a claim that MCP or the new confirmation client
is finished. Worker registration and production write enablement have not occurred.

The four new WP-214 migrations are additional source dependencies. They are not silently added
to Claude's original D1 operational window. Deployment must account for them before exposing the
new write flow; hosted migration state has not been inspected. The version-specific entrypoint
refuses admission when its database implementation is absent.

The latest parallel DB run passed 477 of 478 tests; the existing recommendation-preview DDL
lock test reported a division-by-zero error. That test passed in an isolated retry alongside the
new approval-entry regressions (12 tests total). No recommendation migration/test was edited.
The subsequent complete serial DB run passed all 478 tests. The parallel-run failure was not
reproduced in that run; its cause is not established. These results do not certify parallel CI.

## Findings incorporated into the briefs

| Finding | Evidence at the reviewed source | Correction |
|---|---|---|
| Main's parser rejects the old queue row shape | `packages/db/src/queries/job-wire.ts` lines 51-62; SQL completes before mapping at `packages/db/src/queries/jobs.ts` lines 34-39 | WP-207 must prove the durable running row/consumed attempt, recover it, then assert exactly one successful claim. Ordered upgrade is 41 to 44 to 46 files; five new ledger rows. Worker integration tests belong in `apps/worker`. |
| Legacy preview fallback cannot trust only an environment flag | `packages/db/src/queries/recommendation-readiness.ts` lines 44-79; `supabase/migrations/20260901060000_recommendation_claim_custody.sql` lines 921-926,1229-1231 | WP-216 requires fresh legacy/legacy database authority, refuses post-cutover flag reversal and keeps scheduled production separately gated. |
| Pinned pilot general role starts unrelated timers | `397eff8:apps/worker/src/deployment-role.ts` lines 112-129; `397eff8:apps/worker/src/main.ts` lines 122-147 | Use the report role on that exact pre-fencing revision. Do not substitute current main's fenced report role or general role without a reviewed replacement. |
| Pilot rollback can disable cron and strand creative work | `apps/worker/src/deployment-role.ts` lines 90-100; cron refusal at `apps/web/app/api/cron/sync/route.ts` lines 74-80 | Disable production, drain/account for SB-linked work while the SB-capable claimant exists, then restore report ownership. Producer-on/lane-off is invalid. |
| Pilot acceptance assumes nonexistent fields and uncontended timing | Historical health at `397eff8:apps/worker/src/health.ts` lines 7-12,52-55; producer counts at `packages/db/src/queries/creative-sync-producer.ts` lines 70-83,102,137-142; terminal status at `apps/worker/src/sb-video-ingestion.ts` lines 351-357 | Verify actual health fields, exactly one daily durable job and reconciled deduplication/pending counts. Distinguish intermediate `report_pending` from terminal `completed`. |
| Migration fingerprints can change after capture | `apps/worker/src/recommendation-observer.ts` lines 142-148; preserved fingerprint in [prefix-46.sql](../../tools/hosted-migration-bundle/sql/wp-197-hosted-migration-prefix-46.sql) lines 100-109 | Freeze producers, claimants and observation passes before the frozen preflight. Restore exact prior states after postflight. |
| Planned legacy-worker update uses a retired deployment path | `docs/deploy/always-on-worker.md` lines 30-44,72-74 | WP-213 keeps compatible worker releases pinned. WP-214 owns a dedicated immutable integration/write-worker release instead of an in-place checkout update. |
| F5's SQL permission claim was false | `supabase/migrations/20260901020000_sp_write_persistence_ledger.sql` lines 4116-4125 | Approval is granted to `authenticated`; staging/execution use `service_role`. The authenticated actor helper is appropriate, with production-safe transaction cleanup. |
| Source PR would fail the existing blast assertions | `packages/db/src/sp-write-persistence-blast.test.ts` lines 75-85,110-153; `packages/db/src/sp-write-persistence.test.ts` lines 8032 | Source PR allows exact inert modules while forbidding entrypoint registration. Activation changes only the deliberate registration allowance. Several HTTP helpers do not imply several provider executors. |
| Campaign creation releases dependants too early | `packages/shared/src/campaign-creation.ts` lines 2222-2241 | Persist an exact observed parent before child dispatch. End-only resync is insufficient. Pending/ambiguous creates must not be retried as new resources. |
| MCP amendment left contradictory approval rules | `AGENTS.md:25-30,118-156`; current modes at `packages/shared/src/sp-writes.ts` lines 933,1026-1041 | WP-217 coordinates policy, delegated receipt and persistence changes. A key is an explicit authorization source, not a simulated human click. Current policy remains in force until that slice lands. |
| MCP key ownership/input staging are incomplete | `supabase/migrations/20260814120000_mcp_api_keys.sql` lines 35,52; `apps/mcp/src/keys.ts` lines 35-47,114-119,209-238; `apps/mcp/src/http.ts` lines 120-126; SP provenance at `packages/shared/src/sp-writes.ts` lines 232-247,529 | The write enum already exists. Add verified owner/scope propagation, versioned delegation and real proposal source rows; never trust caller-supplied actors or invented apply-row IDs. |
| Audit-after-handler cannot safely wrap a write | `apps/mcp/src/server.ts` lines 155-188 | Transactionally bind audit, exact plan, delegation, idempotency, daily capacity and enqueue; report unknown outcomes truthfully. Check revocation/kill switches again before dispatch. |
| Design scopes overlap or omit required parents | Initial WP-208/209/211 scopes; parent widths in `apps/web/app/recommendations/page.tsx` lines 231 and `apps/web/app/ngrams/page.tsx` lines 126 | Serialize theme changes; WP-209 alone changes shared UI files; add missing parent pages. Centralize HANDOVER/STATUS integration. |
| Table conversion risks lost selection, truncated population claims and late restore races | `apps/web/app/optimizer/campaign-workspace.tsx` lines 90-121; `packages/db/src/queries/recommendations.ts` lines 419,681; `packages/ui/src/views.ts` lines 57; `apps/web/app/grid/grid-client.tsx` lines 399 | Preserve existing selection, declare the initial four workspaces, add backend proposal/completeness handoffs and retain asynchronous restoration safety. Optimizer pagination itself is a client-side slice. |
| Overview confused implementation, policy and evidence | Cron/worker source above; `AGENTS.md:118-121`; `supabase/tests/supabase-platform-shim.sql` lines 38-40; `.github/workflows/ci.yml`; `package.json` | Describe the web credential discrepancy explicitly. Service role bypasses RLS. Local check has five checks; CI does not invoke skill lint. Repository filenames do not prove hosted state; repair multiline inventory discovery. |

## Executed evidence

The actual row parser was called with a synthetic pre-column row and with `claim_token: null`.
The missing-column case threw `claim function returned an invalid claim capability`; SQL null
returned `claim: null`. The current policy functions also confirmed general role enables
background passes and producer-on/lane-off throws. These tests do not prove a hosted claim
transaction or migration rehearsal.

Reproduce the parser/policy assertions from the repository root:

```bash
pnpm exec tsx -e '
import assert from "node:assert/strict";
import { claimedJobFromRaw } from "./packages/db/src/queries/job-wire.ts";
import { resolveWorkerDeploymentPolicy, resolveCreativeSyncPilotPolicy } from "./apps/worker/src/deployment-role.ts";
const row = {
  id: "00000000-0000-4000-8000-000000000001",
  org_id: "00000000-0000-4000-8000-000000000002",
  profile_id: "00000000-0000-4000-8000-000000000003",
  job_type: "entity.sync", payload: {}, attempts: 1, max_attempts: 3,
  dedupe_key: null, claimed_by: "synthetic-worker"
};
assert.throws(() => claimedJobFromRaw(row as never), /invalid claim capability/);
assert.equal(claimedJobFromRaw({...row, claim_token: null} as never).claim, null);
const types = ["creative.sync", "report.request", "report.poll", "report.fetch"] as const;
assert.equal(resolveWorkerDeploymentPolicy(undefined, types).startsBackgroundPasses, true);
assert.throws(() => resolveCreativeSyncPilotPolicy({OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: "1"}), /exclusive Evo report lane/);
console.log("PASS: parser and policy assertions");
'
```

An independent review executed the exact historical deployment-role module, not a restatement
of its logic. Run from the repository root:

```bash
node --import tsx --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const require = createRequire(process.cwd() + '/apps/worker/src/deployment-role.ts');
const source = execFileSync('git', ['show', '397eff8:apps/worker/src/deployment-role.ts'], { encoding: 'utf8' });
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
runInNewContext(compiled, { exports, require });
const general = exports.resolveWorkerDeploymentPolicy(undefined, exports.EVO_REPORT_LANE_JOB_TYPES);
const lane = exports.resolveWorkerDeploymentPolicy('evo-report-lane', exports.EVO_REPORT_LANE_JOB_TYPES);
assert.equal(general.startsBackgroundPasses, true);
assert.equal(lane.startsBackgroundPasses, false);
assert.throws(() => exports.resolveCreativeSyncPilotPolicy({ OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '1' }), /exclusive Evo report lane/);
console.log(JSON.stringify({ revision: '397eff8', general, lane, rollbackLaneOnly: 'throws' }));
NODE
```

Observed: exit 0, general background passes true, report-role background passes false, lane-only
rollback throws. The pinned revision's health does not expose a protocol field.

Four selected existing campaign-creation tests passed in two invocations:

```bash
pnpm --filter @wizard-ads/shared exec vitest run src/campaign-creation.test.ts -t 'enforces execution dependencies|represents staged running work|keeps operator, provider'
pnpm --filter @wizard-ads/shared exec vitest run src/campaign-creation.test.ts -t 'joins the exact frozen plan'
```

The second command includes rejection of an ad-group dispatch while its successfully created
campaign remains unobserved (`packages/shared/src/campaign-creation.test.ts` lines 1667-1734).

## Limits and next validation

- Production ledger/deployment/service claims remain dated reported evidence. Refresh them
  before the relevant operational window. This review provides no live-write execution evidence.
- Full prefix upgrade, committed failed-claim recovery and preview lifecycle need the disposable
  database tests assigned to Claude in WP-207/216. Static source and parser calls do not replace
  those tests.
- Source-phase assertions now admit only the declared HTTP application consumers and local HTTP
  fixture. Only the declared inert provider adapter/loop modules may execute in synthetic tests; entrypoint registration remains forbidden by those checks. The source
  branch is local; PR/CI and activation evidence remain outstanding.
- Delegated daily-budget races, durable audit admission, revocation and runtime kill-switch
  behavior are requirements for code that does not exist yet, not passed test claims.
- WP-212 still owns full reproducible overview inventories. This audit corrected misleading
  claims and discovery commands; it does not certify every overview count or environment list.

## Initial audit repository verification

`pnpm check` passed typecheck and lint, then stopped on an existing core timing assertion:
109.9 ms against a 100 ms limit during concurrent package tests/Rust builds. Its isolated rerun
passed all four tests in that file. The serial retry
reached DB suites but the local Supabase principal cannot lock `pg_catalog.pg_authid` in
`supabase/tests/supabase-platform-shim.sql` line 29. This is a test-bootstrap limitation, not
proof that migration 060000 needs that permission: its role installer explicitly avoids the
catalog lock. Claude's WP-207 rehearsal must use a disposable test principal compatible with
this shim, such as the plain-Postgres CI service, before certifying the migration procedure.

The database retry used a fresh disposable `postgres:17` container bound to loopback, with
both `DATABASE_URL` and `WIZARD_ADS_TEST_DATABASE_URL` pointing only at that container. All 21
non-UI package test tasks passed with CI-style serialization:

```bash
pnpm exec turbo run test --filter=!@wizard-ads/ui --concurrency=1 -- --maxWorkers=1
```

The container was stopped and removed after testing. Existing local Supabase permissions were
not changed. This passes the existing migration suites; the new WP-207 prefix/recovery scenario
still needs implementation and its own evidence.

UI verification used `pnpm --filter @wizard-ads/ui run test`: 14 functional files and 163 tests
passed, plus nine of ten performance tests. The existing high-cardinality option extraction
assertion in `packages/ui/src/pipeline.perf.test.ts` line 158 failed at 149.4 ms against a
125 ms local limit. Its isolated retry failed at 144.6 ms:

```bash
pnpm --filter @wizard-ads/ui exec vitest run src/pipeline.perf.test.ts --maxWorkers=1 -t 'extracts a high-cardinality option set'
```

This is a measured pre-existing local performance failure; this branch changes no UI code.
The overall `pnpm check` is not certified green. No timing assertion, DB privilege or test skip
was changed to make it pass. Typecheck, lint, skill lint, staged diff checks and hygiene passed.
Hygiene scanned 1461 of 1462 tracked files, with one existing exemption. The private denylist
is absent, so client-name checking was skipped; the documented WP-211 scrub is still required.
All 12 handoff brief links and 32 audited source citation paths/line bounds were checked.
The initial audit changed 16 Markdown documents. A subsequent four-document clarification
made the MCP submission requirement and connection-level acceptance explicit. That clarification
changed no runtime source or deployment state. Later implementation is recorded in the progress
section above; it does not claim deployed tools.

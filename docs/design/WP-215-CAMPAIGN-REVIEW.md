# WP-215 campaign review foundation

## Usage and scope

```ts
const view = projectCampaignCreationApproval(
  { orgId: actor.orgId, profileId, planId }, recordedSnapshot,
);
// Claude's rendering example; the component is a separate frontend slice.
// <CreationApprovalScreen view={view} />
```

The projection accepts an already loaded snapshot. It verifies the exact saved plan,
scope, dated checks and recorded admission; it performs no I/O. There is no campaign
ledger or authenticated reader yet. The later `loadCampaignCreationApproval(headers,
request)` must establish membership/capability and load one consistent read-only
snapshot before calling this function. A missing record never triggers generation.

This slice owns `packages/shared/src/campaign-creation-approval.ts` and its test,
the explicit shared subpath export, and
`apps/web/src/campaigns/creation-approval-{loader,fixtures}.ts` plus loader tests.
Codex also updates WP-215, replan and audit. Claude owns the future client component.
No route, page, browser registry, database migration or worker registration is added.

## Selected contract

Reuse the full canonical `CampaignCreationPlan`; never flatten or duplicate its SP,
SB and SD payload variants. Current display labels, exact-plan capability/prerequisite
checks and selected-version asset observations remain outside that frozen artifact.
Checks cover every node exactly once, with node fingerprints and actual observation
validity times. They are advisory source evidence, not permission to execute.

```ts
type CampaignCreationApprovalSource = {
  plan: CampaignCreationPlan;
  profile: { id: string; label: string };
  checkedAt: string;
  current: {
    orgId: string; profileId: string; planFingerprint: string;
    providerScope: CampaignCreationProviderScope | null;
    checks: CampaignCreationReviewCheck[];
    assets: CampaignCreationReviewAsset[];
  };
  admission: { kind: 'none' } | { kind: 'unavailable' }
    | { kind: 'recorded'; receipt: CampaignCreationAuthorizationReceipt;
        execution: CampaignCreationExecutionEvidence | null };
};
// Shared view reuses plan/current checks and projects admission to actor/time,
// execution identity and verified accounting only. Worker artifacts stay server-side.
```

The projector rejects mismatched tenant/profile/plan data before returning a view.
Cryptographic fingerprints prove internal consistency, not actual saved provenance.
The future database reader must prove ownership, membership and snapshot isolation.
Tests of this projector do not claim those database properties.

Freshness derives from expiry, legacy version, provider-scope changes, incomplete or
stale exact-node checks and selected-asset evidence. There is no invented global TTL.
A newer library version does not invalidate the selected older version. The reader
must read that exact selected identity; mismatching returned evidence cannot silently
replace it. Asset purpose/type must match; the eligibility check's validity horizon belongs
to the exact observation event. Equivalent UTC spellings compare without losing fractional
precision. Legacy plans lack frozen provider scope and therefore cannot expose current asset
observations. Processing and eligibility remain separate; library moderation is always unknown
because it has no created ad/creative identity to support a moderation decision.

Admission `none` means a successful read found none. `unavailable` means unknown,
including the currently missing reader. A recorded receipt can remain visible after
expiry; unavailable execution evidence cannot be shown as queued or successful.
The projector verifies the complete receipt/plan binding and any execution evidence
before stripping attempts, generations, digests and provider messages from presentation.

Existing plans have no saved guardrail/provenance snapshot or frozen profile label.
The view explicitly reports those records unavailable. It supplies no executable
confirmation request, action URL or `canApprove` flag. Current checks do not imply
that approval or worker execution is available. Later admission requires frozen
guardrail/provenance evidence bound to approval and a fresh authority check.

## Rendering contract

Counts distinguish campaigns, explicit planned create operations and read checks. SP automatic
targeting also creates clauses inside Amazon; those are not separate `target.create` requests
and are excluded from the planned-create count. Do not label that count as every resource
Amazon will produce. Budgets retain
their currency and daily/lifetime type. Exact schedules, destination choices, asset
versions/crops and bid inheritance remain in canonical payloads. SB automatic collection
means automatic product selection, not automatic campaign targeting.

Campaigns, ad groups, ads and targets start paused. SD creative records have no independent
state field. Creation cannot be deleted by reverting; pause/archive and launch require
separate reviewed writes. Asset ACTIVE processing is not creative moderation approval.

Synthetic examples exercise current/expired/unknown checks, selected asset versions,
processing with unknown moderation, unavailable/recorded admission and execution accounting. They
have no real action URL. A component example can render these without Amazon access;
actual confirmation/browser workflows remain a separate acceptance requirement.

## Synthesis and verification

Three candidates considered a pure projector, an authenticated injected reader, and a
presentation-specific view. Select the pure projector because there is no real ledger
to wrap yet. Retain the other candidates' full canonical plan, dated check coverage and
explicit unknown admission. Avoid flattened payload schemas and raw worker evidence in
the browser. This hides meaningful validation behind one function without inventing a
database abstraction. No ownership boundary is changed.

Design accepted under the operator's autonomous implementation instruction. Shared
contracts are implemented before the web consumer. All 228 shared tests and 22 workspace
typechecks pass. Review found legacy cross-profile asset display, mismatched file types,
unbound old processing evidence and unsupported moderation badges; those are corrected.
Four regression assertions exposed the latter cases. The first legacy regression fixture
itself used a v2 asset purpose; correcting its historical shape made it exercise the intended
scope check. Private independent probes separately reproduced the legacy leak and verified
its correction. A further test covers equivalent timestamp spellings and sub-millisecond
differences. The web projection and fixtures now follow shared commit `abe8530`, with 17
consumer tests, web typecheck and focused lint passing. The six rendering formats are SP
manual/automatic, SB video detail/Store destinations and SD image/video. Further SB variants
and partial execution fixtures remain later work. Independent consumer review also corrected
the planned-create count wording above. The fixtures are server-side sources/views which a
rendering example can pass as serialized props; no production reader imports them.

Verification covers immutable plans, count/identity joins,
expired and future-dated checks, exact asset version/scope, none versus unknown admission,
receipt/execution mismatches and projection without input mutation. Real authenticated
snapshot isolation, persistence, approval routes and live tests remain unimplemented.

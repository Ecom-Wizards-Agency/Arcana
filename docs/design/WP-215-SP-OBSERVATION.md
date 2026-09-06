# WP-215 SP creation observation

## Problem and usage

Amazon's acceptance of a create request does not prove that its exact settings are observable.
Every dependent create must wait for that proof. Repeated reads must also preserve the evidence
under which earlier children were admitted.

```ts
const observation = await adapter.observeNode({
  plan, authorization, job: observeJob, currentEvidence,
  nodeId, sourceSyncJobId: claimedJob.id,
});
// Future persistence API: recheck the claim and append the observation atomically.
await store.appendObservation(claim, observation);
// Refresh the execution projection before considering another create.
```

The adapter is the existing inert `createSpCreationAdapter` subpath. Its observation method
accepts shared domain artifacts and returns `CampaignCreationResourceObservation`. It does not
expose arbitrary filters, expected wire bodies or another creation path. This document is the
implementation contract; acceptance below distinguishes completed prerequisites from future work.

## Shared history prerequisite

`CampaignCreationExecutionEvidence.observations` becomes chronological history per node. Existing
single-observation records remain valid. Repeated or non-advancing timestamps for the same node
are rejected; persistence must deduplicate an identical event before appending it. Current
accounting and new admission use the latest observation per node.

An existing child intent instead uses the latest dependency observation at or before that
intent's recorded time. That observation must be successful, and its completion must also
precede the child provider attempt. An earlier success followed by a conflict before admission
cannot qualify. A later parent refresh or conflict does not invalidate already admitted work.
Current pending children still become blocked when a terminal dependency conflict is recorded;
the future store must update that projection in the same transaction.

Terminal refusals retain their original reason when a parent later conflicts. Existing
dependency blocks may cite a historical parent conflict and remain blocked when that parent
recovers; observing recovery does not silently reopen stopped work. The eventual ledger must
enforce terminal disposition immutability across writes, beyond validating one supplied view.

A delayed non-observed read whose timestamp would rewrite an existing child admission is
refused. Store it as a read-attempt failure and perform a fresh read; do not change its timestamp
to make it pass. The eventual append transaction must compare the same evidence version and
claim used for validation. Read completion time alone does not prove durable visibility, and
this pure contract does not provide database compare-and-swap or claim fencing.

Conservative historical `intent_reconciliation` records may survive a late conclusive provider
result. They never identify a resource or become observed. A rejected result removes that node
from current observation accounting; its earlier read history remains. New observation admission
still validates its basis against the current provider result. Every non-null identity under
`provider_result_identity` must equal that result's exact ID, including pending/conflict states.
Existing null-bearing non-observed records remain valid. Moderation gains explicit `unknown`.

## Observation implementation shape

The compiler's private graph-to-request mapping and digest construction are shared by two
distinct guards. Create preparation still requires an exclusively pending node and currently
observed parents. Observation preparation retains all committed intents and reconstructs the
original request from immutable parent result identities, then compares its whole-call and
per-node digests to the saved intent. It does not erase intents to simulate pending work.

The adapter validates plan, receipt, observe job, current evidence, node and source job UUID
before I/O. Missing, ambiguous or rejected create identities refuse exact lookup; no name search
or recreation is attempted. Observation remains permitted after write authority expires.
Credential provenance and source-job claim ownership remain the future worker/store's duties.

Each of the nine SP operations uses one read-only `/list` POST with the exact entity-ID filter
and all states, with no parent or name filter that could conceal a conflict. The private decoder
shares bounded lossless JSON parsing with the create decoder. A complete matching representation
is observed; a complete changed representation conflicts; a complete empty result is not found;
malformed, incomplete, paginated or failed reads remain pending. Pending does not mean absent.
The latest unsuccessful read may block new work; historical successful evidence is retained.

Compare every planned field, explicit versus inherited bid, exact parents, paused state and
known material optional controls. Missing requested settings cannot be supplied from defaults.
Negative list identity fields differ from create envelopes and need explicit mappings. Numeric
IDs are rejected; decimal comparisons must preserve precision. Moderation and delivery remain
unknown until separately supported evidence establishes them. Read-response digests/diagnostics
and a durable observation-attempt record remain necessary before an audited live release.

## Synthesis decision

Three independent candidates explored extending the existing adapter, an authority-focused
observer with immutable witnesses, and a narrow protocol observer with separate matching.
Use the first's single method/constructor, the second's historical admission checks, and the
third's private nine-kind matcher and exact endpoint inventory. Keep the authority verifier at
both the adapter boundary and eventual persistence boundary. A generic lookup leaks comparison
policy to callers; a second full constructor duplicates scope and token ownership. Independently
mutable history and latest-state records would create another consistency problem; derive the
latest view from one history.

## Source and scope

[Amazon SP v3 OpenAPI](https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json)
was fetched again on 2026-09-06; S1 SHA-256 remains
`fec774c5ba95e860bd732f1f56d4e5a401ffeb76d500b3a2e059f4eb51c198c3`.
All nine exact ID filters exist. Optional list arrays, campaign bidding fields and ad identity
fields require conservative incomplete-evidence handling. Live normalization and eligibility
remain unverified.

Own shared campaign-creation schema/tests first, then the Ads API creation compiler/adapter,
private JSON/readback modules and synthetic tests. Update WP-215, replan and audit per slice.
No client component, production migration, worker registration or supervisor work is included.

## Verification and implementation state

Design accepted under the operator's autonomous implementation instruction. Shared history,
identity and moderation repairs are implemented in source. Nine regressions failed before the
initial repair; review then reproduced three more failures covering terminal dispositions and
delayed reads. All 199 shared tests and 22 workspace typechecks now pass. The first typecheck
found a tuple-union `includes` narrowing error; using the existing predicate style corrected it.
The inert observation adapter and matcher remain the next implementation step. Regressions cover
parent refresh/conflict after admission, conflict before admission, non-advancing history,
late response reconciliation, exact identity and latest-only counts. The consumer then requires
all nine endpoint/settings tests, partial pages, malformed/numeric IDs, precise money, mutable
inputs, after-expiry reads and no create retry. Neither this design nor the local frontend demo
claims those pending consumer or live workflows are complete.

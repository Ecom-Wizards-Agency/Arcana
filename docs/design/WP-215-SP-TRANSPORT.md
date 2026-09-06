# WP-215 SP creation transport

## Problem and caller contract

The compiler can freeze one SP create request, but sending it through ordinary bulk clients
would conceal retry/chunk behavior. The new inert `./sp-creation-adapter` subpath exposes
`createSpCreationAdapter(options, { hasher, providerScope })`, returning `prepareNode` and
`executeOneAttempt`. Options use the existing Ads API effects and clock. Scope uses the shared
creation scope and must match the frozen plan exactly, including connection and account type.

```ts
const candidate = adapter.prepareNode({ plan, currentEvidence, nodeId });
// Future store API below is pseudocode; this slice does not implement admission.
const reservation = await store.reserveExclusiveIntent(candidate);
if (reservation.kind !== 'newly_reserved') return observeOrQuarantine(reservation);
const result = await adapter.executeOneAttempt({
  plan, authorization, job, intent: reservation.intent,
  evidenceBeforeReservation: reservation.evidenceBeforeReservation,
});
await store.recordResult(result);
// Observe the exact returned ID before releasing dependent nodes.
```

Preparation exposes only the existing request digest and position tuple. Execution accepts shared
plan, receipt, dispatch job, intent and evidence types, returning the shared provider-result type.
It reuses the compiler and shared verifier; callers cannot override a URL, body or provider profile.
Inputs are parsed/copied before asynchronous work. The authority deadline is checked after authentication and once more synchronously at the
underlying fetch boundary, closing the asynchronous header-resolution gap. Construction and preparation perform no I/O.

The evidence is explicitly the reservation transaction's retained **pre-reservation** snapshot.
The current post-reservation projection correctly refuses dispatch. Never erase an intent to
manufacture that snapshot. Only the unique transaction winner may call the transport. The adapter
promises one POST per invocation; durable ownership, current gates and recovery belong to the
future worker/store. Neither an in-memory token nor an old snapshot proves exclusive admission.

## Synthesis

Three independent candidates compared minimal surface, authority/crash behavior and response
correlation. Use the response candidate's two domain operations to keep wire details private,
the authority candidate's exact credential-scope check and explicit historical witness, and the
minimal candidate's reuse of existing shared results. A private decoder isolates protocol
knowledge without exposing raw responses. A generic raw-wire sender leaks provider policy;
a mutable one-use handle loses its guarantee across processes. Both alternatives were rejected.

Before this consumer, shared verification now rejects reused provider-call or attempt IDs even
when the proposed pending node differs from the previous one. The regression lives in the shared
campaign-creation suite. No shared lifecycle or accounting enum is widened for this transport.

## Provider response contract

[Amazon's SP v3 OpenAPI](https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json)
was fetched again on 2026-09-06 and matches S1's pinned SHA-256
`fec774c5ba95e860bd732f1f56d4e5a401ffeb76d500b3a2e059f4eb51c198c3`.
All nine POST routes document 207 and string resource IDs. Require exactly one index zero across
`success` and `error`, the endpoint's exact ID field, and agreement with any returned representation, including supplied parent IDs from the exact request.
Reject duplicate JSON members, malformed UTF-8, wrong/missing/duplicate indexes, contradictory
branches and numeric IDs. IDs remain exact strings; the private parser retains numeric tokens
lexically, so none can be rounded into an accepted identity. Unknown response shapes stay ambiguous.

A definite row refusal needs a documented error selector and allowlisted reason. As a conservative
local rule, its open-string `errorType` must equal that sole selector; unknown spellings and
internal/contradictory classifications stay ambiguous. This does not claim a provider errorType enum. Structured whole-request 400/401/403/415/429 refusals require the matching
documented code and message shape; a valid empty optional 400 error list remains a refusal.
Provider prose is discarded. 5xx, undocumented success statuses,
malformed bodies, redirects, body limits and network failures stay ambiguous. No response causes a
second create. Results bind all intent identities and digests, use fixed local messages, and hash
status plus exact response bytes into evidence without retaining the body. Request-header IDs are
not retained in this slice. Conclusive results require a response digest.

Header/token failure after reservation remains conservative ambiguity: the shared accounting counts
reserved intents as attempted and has no durable not-sent outcome. This is not an Amazon rejection
or permission to recreate. A later ledger may distinguish proven non-dispatch with a separately
reviewed contract. Provider acceptance alone never means synchronized observation.

## Scope and proof

Own shared verifier/test correction first; then `packages/ads-api/src/sp-creation-adapter.ts`,
`sp-creation-response.ts`, their tests and a shared synthetic creation fixture used by codec/adapter
tests; the Ads API subpath export; this design, WP-215, replan and audit. Existing compiler behavior
stays unchanged. Tests prove zero calls for invalid authority/scope/digests, one attempt under all
operational failures, exact route/count/ID correlation, immutable inputs and sanitized evidence.

Durable ledger/executor, observation clients, frontend contracts/screens, SB/SD transport and scoped
live checks remain separate pending slices. No runtime registration or production setting changes.

## Implementation evidence

Shared prerequisite `1c53d80` precedes the consumer. The inert adapter and private decoder now
implement this design. Forty compiler tests, 50 adapter tests and 67 decoder tests pass (157 total).
The full Ads API suite has 566 passing tests; all 186 shared tests, all 22 workspace typechecks
and five import-boundary tests pass. Adversarial review reproduced five failures before correction
and verified the expiry-gap, parent-conflict, empty-error and contradictory-classification repairs.
No remaining finding was reported within those review scopes. Actual persistence, current database
gates, provider observations and live behavior remain unverified by these tests.

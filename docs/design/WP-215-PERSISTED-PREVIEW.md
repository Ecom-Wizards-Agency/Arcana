# WP-215 persisted campaign preview

## Usage and shape

```ts
// Separate trusted server-planning command; no public recording route in this slice.
await recordCampaignCreationPreview(database, actor, frozenPlan);
// GET never generates, records, approves or enqueues a plan.
const view = await loadCampaignCreationApproval(headers, { profileId, planId });
```

The pure review projector has no real store to read. Add one immutable table, a recorder
and an authenticated reader using existing shared plan/request/source/view contracts:

```ts
recordCampaignCreationPreview(db, actor: SpWriteActor, plan: CampaignCreationPlanV2)
  : Promise<CampaignCreationApprovalRequest>;
readRecordedCampaignCreationPreview(db, actor: SpWriteActor, request: CampaignCreationApprovalRequest)
  : Promise<CampaignCreationApprovalSource>;
loadCampaignCreationApproval(headers: Headers, request: CampaignCreationApprovalRequest)
  : Promise<CampaignCreationApprovalView>;
```

These DB operations own storage integrity, tenant checks, transactions and retry recovery.
Web owns session/capability adaptation and projection. The shared error-code enum lands before
DB/HTTP consumers. No second payload model, actor shape or generic repository is introduced.
The recorder is for trusted server code and tests; a later planning adapter must supply the
real producer. Existing export output is not silently treated as an API creation plan.

## Persistence and authority

`campaign_creation_previews` stores canonical text, a checked JSONB copy, its byte digest,
scoped identity, database recorder and persistence time. Its primary key is
`(org_id, profile_id, plan_id)` with a compound profile FK. Historical recorder IDs have no
mutable user FK. They identify who stored the artifact, not who approved Amazon execution.

A narrow definer recorder derives the user from authenticated claims. It locks the org and
current owner/admin membership, then serializes identical scoped plan IDs. Exact retries
return the original identity/time even after expiry or profile changes; changed bytes refuse.
Another current admin may recover the same record without replacing its original recorder.
New records require v2, nonfuture/unexpired times, an active same-org connection, a sync-enabled
profile and agreement with provider fields actually stored on that profile. The profile table
has no marketplace ID; recording does not verify it. No environment write gate is implied.

SQL guarantees its stated storage/tenant boundaries, not every Amazon payload rule. Shared
graph/count/fingerprint verification runs before recording and on every product read. An
authorized direct RPC caller could store invalid content in its own scope; every read must
refuse it, and it never grants execution authority. Do not advertise a storage hash as an
approved plan. A future approval envelope must bind genuine frozen guardrail/provenance
evidence before admission is implemented.

## Reads and deletion

The reader uses repeatable-read/read-only with transaction-local authenticated role/claims,
plus explicit actor/org/profile/plan/owner-admin predicates. It selects the saved artifact and
current profile label, no credential columns. Byte digest, shared fingerprints, relational
scope and persistence time are verified before returning data. Foreign/missing records share
not-found; corruption yields sanitized unavailable. A read is authorized at its snapshot;
the next request sees revocation, without pretending already-read bytes can be withdrawn.

Every saved node receives unknown/unavailable checks with null check times. Selected assets
receive null observations and unknown moderation. Admission is unavailable without an authority
ledger. Complete current provider scope stays null: never copy the frozen marketplace into
fresh evidence. The DB read timestamp is not an Amazon check timestamp. Expired or historical
valid records remain readable without reconstruction. No executable confirmation is supplied.

Ambient table mutations and recorder execution outside the authenticated role are denied.
Immutable triggers also constrain owner DML: updates and truncation fail; deletion is allowed
only when the owning organization is actually absent. A definer trigger checks true parent
existence, not RLS visibility or trigger depth. Thus org deletion can cascade; standalone
profile deletion while its org exists cannot erase evidence. Connection changes do not rewrite it.

## Synthesis and accepted limits

Three independent candidates compared a narrow store, a rich frozen evidence envelope and
existing export/write stores. Select the authority candidate's byte integrity plus shared
semantic verification, the minimal candidate's two operations and the presentation candidate's
unchanged honest view. Reject a second partial Amazon schema in SQL. A rich envelope belongs
before approval, when its policy/evidence producer exists. Existing mutable `apply_batches`
and mutation/inverse `sp_write_plans` do not own creation DAGs; a generic CRUD layer would
leave ownership and retry policy to callers.

This slice accepts unknown current checks/admission in exchange for real saved reads. It has
no public generator or actionable client and does not achieve the full frontend-foundation
or marketer-release milestone. The operator's autonomous instruction authorizes implementation.

## Scope and verification

Codex reserves the additive enum in `packages/shared/src/campaign-creation-approval.ts`;
new `packages/db/src/campaign-creation-previews.ts`, its query/schema modules and query tests,
package/schema exports, `packages/db/src/migrations.test.ts` for the exact new migration tail,
`packages/db/src/sp-write-persistence-blast.test.ts` for the exact HTTP count-assertion fixture,
and `packages/db/src/rls.test.ts` for nonempty coverage of the new
owner/admin-only table; the existing campaign approval loader; and
`GET /api/campaign-creation/preview` with focused HTTP tests. Claude client/pages, browser
registry, HANDOVER/STATUS and the parked supervisor remain untouched.

New `20260906060000_campaign_creation_previews.sql` belongs to a separate campaign window,
outside the fixed five-file and ten-file windows. It uses the five-second lock timeout and
existing advisory DDL lock. Tests use disposable PostgreSQL on port 55439, preserving the
existing `wizard_ads_e2e` preview database. No hosted schema or provider action is authorized.

Required executable proofs: exact SP and asset-bearing SB/SD round trips; identical/conflicting
concurrent retries; actor/scope/role/RLS isolation; membership/profile changes; byte and semantic
corruption refusal; actual org cascade and standalone deletion refusal; function/table ACLs;
unchanged plan/approval/job counts across repeated reads; actual read-only transaction behavior,
pooled claims cleanup and authenticated no-store GET behavior. Source tests are not live evidence.

## Claude integration

The server loader is `loadCampaignCreationApproval` in
`apps/web/src/campaigns/creation-approval-loader.ts`. Its arguments are request headers and
`{ profileId, planId }`; its result is `CampaignCreationApprovalView` from the explicit shared
`campaign-creation-approval` subpath. Client refreshes may use the same view returned by
`GET /api/campaign-creation/preview?profileId=...&planId=...`. No POST is exported. Unknown,
duplicate and missing query fields return 400; signed-out requests return 401; insufficient
current role returns 403; foreign/missing records share 404; corrupt/unavailable storage returns
503. Existing authentication challenges retain their code/location. Every response is no-store.

Server-side rendering examples remain in `creation-approval-fixtures.ts`. The real reader
currently produces the unknown-check/asset/admission case; richer synthetic scenarios illustrate
the stable view without claiming a real producer for those observations. Use the full frozen
plan for settings and counts. The current profile label is not a saved approval label. Do not
render an enabled Amazon confirmation from this response: campaign admission and a genuinely
frozen approval envelope are still pending. Refresh may retry the GET after a failed read,
but never call a planner or infer that unknown admission means unapproved.

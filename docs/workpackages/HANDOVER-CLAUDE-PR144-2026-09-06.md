# Recommendation table integration after PR #144

PR #144 merged at `5c90c88`, with both CI jobs green. The table conversion is delivered.
The following integration issues were verified against its source head `8c95f77`; the new
revision backend in PR #141 makes the first two visible. Codex has supplied the server view
contract and synthetic scenarios below. Claude owns the recommendation page, client and browser
tests. No client files were changed for this handoff.

## Required client corrections

1. **Submit the revision the operator saw.** `review.tsx` decision and export requests omit
   `expectedRevisions`. That omission identifies the unchanged engine proposal; an edited row
   therefore receives `revision_changed` or an export conflict. The server presenter now retains
   the exact `proposalRevisionId`. Both actions must submit one
   `{ recommendationId, revisionId }` for every explicitly selected ID. A null revision means
   the original proposal; never replace a missing revision with null.
2. **Keep refusal reasons out of row status.** `readRefused` accepts any string, and the
   optimistic update writes it into the row's status. `revision_changed` and `unavailable` are
   refusal reasons, not persisted statuses. Existing lane grouping can consequently hide the
   row. Parse the shared decision result, retain the last displayed status for those two
   refusals, show the reason and refresh. Do not say every refusal means an already exported,
   applied or superseded proposal. Check that refused IDs belong to the offered set and that
   `updated + refused.length === offered.length` before inferring which rows moved.
3. **Do not broaden a hidden selection.** `selectedIds` currently intersects selection with
   visible rows. If all selected rows are filtered out, export sends `ids: null`, requesting
   every accepted proposal in the run. Retain and explicitly submit the selected identities
   and their reviewed revisions, or refuse until the selection is cleared. Whole-run export
   must have its own clear confirmation and count; an empty visible intersection is never one.

Source locations at `8c95f77`: `apps/web/app/recommendations/review.tsx` lines 289, 471,
630, 655 and 724. These locations were checked against the actual source, not inferred from CI.

## Server interface available in PR #141

Codex owns `apps/web/src/recommendations/view.ts`, `view.test.ts`,
`revision-fixtures.ts` and `revision-fixtures.test.ts`. These extend existing shared and DB
contracts; they introduce no second revision or population schema.

Use the existing `listRecommendationWindow` in the authenticated server page. It returns
`{ rows, population }` from one SQL statement, including edited values and their revision IDs.
Present that result with:

```ts
const window = await listRecommendationWindow(database, {
  orgId: actor.orgId,
  runId,
  profileId,
  limit: 20_000,
});
const review = toRecommendationReview(window, {
  strategySnapshot: run?.strategySnapshot ?? null,
});
```

`review.proposals` is `ReviewedProposalView[]`: the existing display fields plus a required
`proposalRevisionId: string | null`. `review.population` is the shared
`RecommendationPopulation` with `loaded`, `total`, `limit` and `truncated`. The presenter
rejects inconsistent counts and duplicate identities. Preserve these counts and their scope;
do not derive an exact filtered total from a separate run summary. This completes the server
handoff for WP-209 item 12; its client integration is still open.

For explicit decision and export selections, retain the identities from the displayed rows:

```ts
const expectedRevisions = RecommendationRevisionSelection.parse(
  reviewedRows.map((row) => ({
    recommendationId: row.id,
    revisionId: row.proposalRevisionId,
  })),
);
// Send both ids and expectedRevisions to the existing decide/export routes.
```

The decision HTTP response adds `offered` to the shared strict result. Parse
`{ updated: response.updated, refused: response.refused }` with
`RecommendationDecisionResult`, then reconcile it against the submitted identities and count.
Do not parse the entire response with that strict schema. A failed or malformed response does
not authorize an optimistic status update.

WP-209 item 13 uses `POST /api/recommendations/revise` with the shared
`RecommendationRevisionRequest`: `requestId`, `profileId`, `recommendationId`,
`expectedRevisionId`, decimal-text `proposedValue` and `note`. The result is an immutable
`RecommendationRevisionReceipt`; a stale edit returns HTTP 409. Preserve a request ID when
retrying the same edit after an uncertain response. Editing returns the proposal to review;
it does not approve an Amazon write. The client proposal editor is still to be implemented.

## Synthetic integration cases and verification

`recommendationRevisionFixtures()` in `apps/web/src/recommendations/revision-fixtures.ts`
provides an original proposal, an edited proposal with an exact decimal, a truncated window,
mixed stale/missing refusals, and a selected row hidden by filtering. Import it only into tests
or fixture tooling. It needs no database or Amazon access.

The view and fixture suites pass **16 tests**. After merging main in `2dd1688`, the full web
suite passes **736 tests**, with the local database required; web typecheck, clean-checkout
repository lint and hygiene pass. Existing database tests cover revision persistence,
concurrency and counted windows. These results do not replace client browser acceptance.

Claude's browser checks should prove that an edited value's revision is submitted on decision
and export, stale/missing refusals keep rows visible, hidden selections cannot expand an export,
truncated counts stay explicit, and a saved decimal edit survives refresh and export. Preserve
the table package's selection, filters, grouping and scroll checks. Serialize any shared browser
registry changes with Codex.

This handoff is source-ready, not deployed. The compatible web deployment follows the reviewed
second migration window. The existing optimizer-edit/recommendation-creation freeze remains
until that deployment. The approval screen's separate loader/fixture handoff remains in WP-214;
this document does not claim that screen or the marketer release is complete.

# WP-209 — Table ergonomics for the first four operator workspaces

Owner: Claude Fable 5.1 (frontend design). The implementer must not edit the owned files.

Depends on: no write activation for the initial conversion. Preserve the selection and proposal
controls already present. New bulk proposal revision/editing consumes the backend contract/API
handoff in WP-214; it does not require a live Amazon test. Serialize shared-file handoffs before
editing. This package implements WP-211's requested changes inside `packages/ui/src/**`.

## Definition of done, from the operator's recording of 2026-09-05

Every operator table behaves like the AdLabs grids the operator compared against: continuous
scrolling with no pagination, click-to-sort on every header, drag a column header into a group
bar to group and nest, and full-width layout instead of a narrow centered column. The Campaign
Optimizer table is the first target because it was the one shown. This package delivers Grid,
Optimizer campaigns, Recommendations and N-grams. Inventory remaining tables in the close-out
with follow-up owners; do not report every operator table complete from these four surfaces.

## Findings

`packages/ui` Data Grid already has sticky header, pinned first column, resize, reorder, totals,
multi-sort, nested group-by through a dropdown, categorical filters, saved views and CSV export on
a sound pipeline with a 50,000-row performance suite. It is missing selection, inline editing,
tiles and chart, entity search, density, keyboard navigation and a viewport-filling height. The
other tables do not use it: `apps/web/app/optimizer/campaign-workspace.tsx` paginates at 25 rows
without sorting, `apps/web/app/recommendations/review.tsx` calls `window.location.reload()` on
every decision, and `apps/web/app/ngrams/explorer.tsx` prints raw numbers. WP-24 ordered the
dense grid chrome, tile row and chart for the grid and it was never delivered there. Two grid
gates delay first paint: the row fetch and a saved-layout restore that could be synchronous.

## Owned files

- `packages/ui/src/**`;
- `apps/web/app/grid/**`, `apps/web/app/optimizer/page.tsx`,
  `apps/web/app/optimizer/campaign-workspace.tsx`, `apps/web/app/recommendations/review.tsx`,
  `apps/web/app/ngrams/explorer.tsx`, `apps/web/app/recommendations/page.tsx`,
  `apps/web/app/ngrams/page.tsx`, `apps/web/src/ui/cockpit.tsx`;
- `apps/web/e2e/grid.spec.ts`, `apps/web/e2e/recommendations.spec.ts`;
- this brief.

## Required behavior

Initial conversion, shipped after the recorded checks pass:

1. Split `DataGrid.tsx` into header, totals, body and cell components and `GridToolbar.tsx`
   into filter builder, column picker, grouping levels and saved views, behavior-preserving,
   under the existing tests.
2. Grid first paint: add a hydration-safe synchronous cache path where browser storage supports
   it and debounce persistence. Preserve `ViewStore`'s asynchronous implementation support,
   cancellation on scope changes and the protection against late restoration overwriting user
   input. Measure first paint; removing the gate universally is not the acceptance criterion.
3. Full-width workspace layout for grid, optimizer, recommendations and n-grams; grid height
   fills the viewport with a fullscreen toggle and a density setting.
4. Drag a header into a group bar; the existing dropdown stays as the keyboard path. Group
   chips are reorderable and removable; nesting recomputes ratios from sums as today.
5. Click-to-sort on sortable data columns of the four scoped workspaces, with shift-click
   multi-sort. Selection and action headers do not pretend to have a data ordering.
6. Optimizer campaign table rendered through the Data Grid without its client-side 25-row
   slice; the current loader returns the full campaign set. Preserve selection immediately.
7. Recommendations queue rendered through the Data Grid; decisions update in place with
   `router.refresh()` and optimistic status so filters, selection and scroll survive.
8. N-gram drill-down uses the shared formatters and the Data Grid.
9. Tiles and chart above the grid through the existing cockpit and daily loaders, streamed
   outside the row path.
10. Toolbar: free-text entity search, clickable filter chips that prefill the builder, view
    delete, grouped and searchable column picker; rename the `RPC category` header to
    `Campaign role` keeping the column id.
11. Keyboard navigation: roving focus on rows, arrow and home and end movement, Enter opens,
    Space toggles selection, Escape clears.

After the WP-214 backend proposal/completeness handoff:

12. Preserve existing checkbox selection in the initial conversion. Add a bulk proposal bar
    after its backend exists. Select-all names its exact population: the current grid caps at
    50,000 and reports truncation; recommendations cap at 20,000 without completeness metadata.
    Use the backend's completeness/count contract before calling loaded rows the whole filtered
    set. Reconcile selection, proposal and export counts; retain truncation notices.
13. Editable proposed value uses the backend revision API, decimal contract and concurrency
    token. Show conflicts and invalidated previews; export and the WP-214 builder freeze the
    chosen persisted revision. UI-local edits must not disappear on export.

## Acceptance

1. A recorded click-through on the optimizer page reproduces the operator's video actions:
   scroll the whole campaign list, sort by spend, drag a header to group, nest a second level.
2. Existing `packages/ui` tests and the performance suite stay green; new e2e for sort, drag
   grouping and decision persistence pass.
3. Grid first paint on the reference fixture does not regress; synchronous-cache and delayed
   asynchronous restoration cases preserve interaction and scope safety.
4. Selection remains usable during conversion; truncated result sets never present select-all
   or export counts as a complete population. Remaining operator tables have an explicit inventory.

## Local performance baseline from the handoff audit

On 2026-09-05, the unchanged UI passed 163 functional tests and nine of ten performance tests.
`packages/ui/src/pipeline.perf.test.ts` line 158 failed locally at 149.4 ms, then 144.6 ms in
isolation, against its 125 ms local budget. Record the comparable environment and resolve the
baseline before claiming the conversion preserves performance; do not weaken the assertion
merely to get a green result. Full evidence is in `REPLAN-2026-09-05-AUDIT.md`.

## Close-out

### Performance baseline

Slice 1 (behavior-preserving split of `DataGrid.tsx` and `GridToolbar.tsx`) measured
`packages/ui/src/pipeline.perf.test.ts` before and after the change with the package's own
invocation, `vitest run src/pipeline.perf.test.ts --maxWorkers=1`, three runs each, nothing else
running. The suite exercises only the pure pipeline (`pipeline.ts`, `filter-options.ts`,
`fixtures.ts`); it never imports the components that were split, so no delta was expected and
none beyond run-to-run noise appeared.

Environment: AMD Ryzen AI 9 HX 470 (24 threads), 57 GiB RAM, Linux 7.0, Node 26.8.1, pnpm 11.21,
Vitest 4.1.10, `CI` unset (local budgets). One-minute load average was 0.5 to 0.9 during the
"before" runs and 1.6 during the "after" runs; the machine was otherwise idle.

| Run | Line 158 best-of-5 (budget 125 ms) | Other nine assertions |
|---|---|---|
| before 1 | 149.2 ms | pass |
| before 2 | 156.0 ms | pass |
| before 3 | 148.4 ms | pass |
| after 1 | 151.3 ms | pass |
| after 2 | 154.6 ms | pass |
| after 3 | 147.6 ms | pass |

The line 158 failure ("extracts a high-cardinality option set and applies a large exact
selection") is pre-existing at the same magnitude before and after, and matches the handoff
audit's 149.4 ms and 144.6 ms. The threshold was not changed. Resolving that baseline remains
open for the slice that touches `filter-options.ts` or the pipeline; this slice did not touch
either file.

Functional `packages/ui` suite: 163 of 163 before and after, with `DataGrid.test.tsx` and
`GridToolbar.test.tsx` unmodified.

### Slice 2: Data Grid capabilities

Delivered in `packages/ui/src/**` and wired on `/grid` (`apps/web/app/grid/**`):

- **Group bar** (`toolbar/GroupBar.tsx`, `grouping.ts`): every header is a drag source carrying
  its column id in the `DataTransfer` under a private MIME type; dropping a dimension on the bar
  appends a level, dropping it on a chip nests before that chip, chips drag onto each other to
  reorder, and each chip has remove and move up/down buttons. The `Add grouping level` select
  remains the keyboard path. A metric dropped on the bar is refused. Ratios keep coming from the
  pipeline's summed bases; the bar only edits the ordered list.
- **Layout** (`grid/GridViewport.tsx`, `grid/styles.ts`, `apps/web/app/grid/page.tsx`): the
  page is full width instead of a `96rem` centred column; the grid is a CSS flex fill inside a
  viewport-measured column (no fixed `620px`), with a fullscreen toggle (Escape exits when the
  grid did not claim the key) and a `compact / normal / comfortable` density whose row heights
  live in `density.ts`. Density persists in the saved layout beside widths; a layout written
  before density existed restores at `normal`, and an unknown density value is rejected.
- **Toolbar** (`toolbar/EntitySearch.tsx`, `entity-search.ts`, `FilterBuilder.tsx`,
  `ColumnPicker.tsx`, `column-groups.ts`, `SavedViews.tsx`): the entity search box compiles to a
  `LIKE` filter on the level's pinned dimension and reads it back, so it is a chip, saves with the
  view and round-trips; clicking a chip prefills the builder and `Update` replaces it in place;
  `Delete view` targets the view just applied and calls `ViewStore.remove`; the column picker is
  grouped (attributes, selected-period metrics, comparison, Δ, Δ%) with one search box.
- **`RPC category` reads `Campaign role`**, id `rpc_category` unchanged, so saved views and
  filters keep working.
- **Keyboard** (`DataGrid.tsx`, `grid/GridBody.tsx`): rows are a roving tab stop; Arrow, Home,
  End, PageUp and PageDown move it (scrolling the virtual window), Enter is `onRowClick`, Space
  toggles selection through `selectedRowIds` / `onSelectionChange`, Escape clears it, Left/Right
  collapse and expand a group. Keys on a control inside the grid (pin button, group toggle) are
  left to that control. Headers carry `aria-sort`; the sort glyph shows on hover when unsorted
  and with direction and multi-sort rank when sorted. Click and shift-click sort were already
  present and are covered by the new e2e.

Evidence:

- `packages/ui`: 198 of 198 functional tests (`vitest run --exclude src/pipeline.perf.test.ts`),
  35 of them new across `DataGrid.interaction.test.tsx`, `GridToolbar.interaction.test.tsx`,
  `grouping.test.ts`, `density.test.ts`, `toolbar/entity-search.test.ts`,
  `toolbar/column-groups.test.ts`, plus additions to `columns.test.ts` and `views.test.ts`. The
  keyboard-target test was run with its fix stashed (fails: Enter on `Pin Spend` was
  default-prevented) and with it (passes).
- `apps/web`: `vitest run app/grid` 15 of 15, including the density-persistence and
  grouped-header case in `grid-client.test.ts`.
- e2e `auth` suite (`pnpm --filter @wizard-ads/web test:e2e:auth`, disposable local Postgres 17):
  5 of 5, including the new `grid sorts on a header click, groups by dragging headers into the
  group bar, and persists density`, which asserts full width against `main`, no `620px` scroller,
  click and shift-click `aria-sort`, a real Chromium HTML5 drag of `State` then `Ad type` into
  the bar producing a two-level treegrid, and density surviving a reload. Its first run failed
  on a strict-mode locator (`Clicks` also matched `Clicks Δ%`); the locators are now exact.
- `pnpm typecheck`, `pnpm lint`, `pnpm hygiene`, `git diff --check` clean.

Performance, same invocation and environment as slice 1 (`vitest run src/pipeline.perf.test.ts
--maxWorkers=1`, three runs, load average 2.2 falling to 1.3 as the e2e server exited):

| Run | Line 158 best-of-5 (budget 125 ms) | Other nine assertions |
|---|---|---|
| slice 2, run 1 | 148.9 ms | pass |
| slice 2, run 2 | 160.9 ms | pass |
| slice 2, run 3 | 147.6 ms | pass |

Line 158 remains the pre-existing failure at the slice 1 magnitude (147.6 to 156.0 ms). This
slice touched neither `pipeline.ts` nor `filter-options.ts`; the threshold was not changed.

Open from this slice: the group bar and viewport are wired on `/grid` only; optimizer,
recommendations and n-grams adopt them in slices 3 and 4. Selection is exposed through props
and the footer count but has no bulk action bar yet (WP-214 handoff, item 12). The
remaining-table inventory is due in slice 5's close-out.

#### Slice 2 review fixes

The slice 2 review accepted the work with one medium finding inside the owned files, one
medium finding outside them, and four low findings. Fixed here, each with a test that was run
with the fix reverted (fails) and applied (passes):

- **Tab stop after a native scroll** (`grid/GridBody.tsx`). The roving tab stop lived only on
  the active row, so once a wheel or scrollbar scroll had virtualised that row out of the DOM
  the grid had no row in the tab order at all. When the active index is not among the rendered
  rows, the first rendered row now carries the stop; focusing it makes it the active row through
  the existing `onActivate`, so Tab always re-enters the grid on a real row and the arrows work
  from there. Test: `DataGrid.interaction.test.tsx` "keeps one tab stop in the grid after a
  native scroll" (5,000 rows, `scrollTop` 90,000, exactly one `tabindex=0` row); reverted, it
  fails with `expected [] to have a length of 1 but got +0`.
- **Metric over the group bar** (`grouping.ts`, `grid/GridHeader.tsx`, `toolbar/GroupBar.tsx`).
  Browsers hide the drag payload during `dragover`, so the bar decided from the MIME type alone
  and lit up for every header, refusing a metric only on drop. Headers now also write
  `DIMENSION_DRAG_TYPE` when the column is a dimension, and the bar accepts on that type (or a
  chip's `GROUP_LEVEL_DRAG_TYPE`), so a metric never lights it up and `dropEffect` stays `none`.
  The id is still checked against the bar's own dimensions on drop. Tests: "refuses a metric"
  now asserts the `dragover` feedback (reverted: `expected 'true' to be 'false'`); "marks it as a
  dimension only when it is one" checks what the header writes for `Match` and `Spend`; the
  e2e drag in `grid.spec.ts:163` passed against real Chromium on the new type (5 of 5).
- **Keyboard sort on headers** (`grid/GridHeader.tsx`). Headers carried `aria-sort` but were not
  focusable. They are now in the tab order; Enter and Space sort exactly as a click does, Shift
  adds a key, and a key on the pin button or resize handle inside the header stays with that
  control. Test: "sorts from the keyboard" (reverted: `expected null to be '0'`, the missing
  `tabindex`).
- **Border longhands** (`toolbar/styles.ts`). `groupBar` and `groupingLevel` used the `border`
  shorthand while their active variants set `borderColor` / `borderStyle`, which React reports
  as a styling bug on every highlight toggle (the review counted four in the e2e dev-server log).
  Both now use `borderWidth` / `borderStyle` / `borderColor`. Test: "toggles the drop highlight
  ... without a React style warning" spies `console.error` (reverted: three warnings captured);
  the fixed tree's e2e run logged zero.

Evidence on the fixed tree: `packages/ui` 202 of 202 functional tests (`vitest run --exclude
src/pipeline.perf.test.ts`), `apps/web` `vitest run app/grid src/e2e-suite-registry.test.ts`
19 of 19, e2e `auth` 5 of 5, `pnpm typecheck` 22 of 22, `pnpm lint`, `pnpm hygiene` and
`git diff --check` clean. Performance, same invocation as above with the machine otherwise
idle (load average 1.3 to 1.8): line 158 best-of-5 at 155.0 / 155.7 / 144.6 ms against the
125 ms local budget, other nine assertions passing each run. The magnitude is unchanged from
slice 1 and the handoff audit; this slice still touches neither `pipeline.ts` nor
`filter-options.ts`, and the threshold was not changed.

**Required edit outside this package's owned files** (reported, not made): the browser-suite
ownership registry `apps/web/src/e2e-suite-registry.ts` declares `expectedTests: 4` for the
`auth` suite (`dashboard.spec.ts` + `grid.spec.ts`), but slice 2 added a fourth test to
`grid.spec.ts`, so the suite now runs 5 (`grep -c '^test('` gives 4 + 1; the runner reports
"5 passed"). The registry and its test only compare against constants, so nothing fails, but
the contract now understates the suite. The owner of `apps/web/src/e2e-suite-registry*.ts`
should set `auth` to `expectedTests: 5` and move the registry test's `EXPECTED_REGISTRY` entry
and its conserved total from 75 to 76, as `01f557c` did for the sidebar spec.

### Slice 3: Campaign Optimizer table

The surface in the operator's recording, converted to the Data Grid.

- **No pagination** (`apps/web/app/optimizer/campaign-workspace.tsx`). `CAMPAIGNS_PER_PAGE`,
  the page state, the page-reset effect and the pager are gone. The grid holds the whole
  campaign set the loader already returns and the DOM holds one viewport of it.
- **Click-to-sort on every data column**, shift-click to add a key, through the same
  `toggleSort` the grid has always used. Default order is spend descending, which is the
  order the loader's SQL already produced.
- **Drag-to-group** through the slice-2 `GroupBar`, wired to the workspace's own `groupBy`
  state; nesting recomputes ACOS from summed bases at each level.
- **Full width** (`apps/web/app/optimizer/page.tsx`): the page no longer uses the shared
  84rem `tokens.page` measure. `GridViewport` supplies the flex column and a fullscreen
  toggle, plus a density select. The measured fill always resolves to its floor here — the
  table starts below the tile row and the trend chart — so the floor is an explicit 560,
  and fullscreen is the gesture that gives the table the whole screen.
- **Selection preserved exactly.** `selectedCampaignIds` is still the whole transient set
  and still lives in this component: the header checkbox owns the complete *filtered
  eligible* population rather than the rendered rows, narrowing or widening a filter never
  touches what is selected, `Clear selected` clears the whole set including hidden rows,
  the counts and the explicit all-eligible-versus-selected radio pair are unchanged, and
  the preview scope, idempotency key, polling and observation deadline are untouched. The
  grid's own Space key routes through `applyGridSelection`, which drops any id whose
  campaign is not selectable, so the checkbox and the keyboard cannot disagree.

New in `packages/ui`, because a checkbox column is a column on screen and nothing in the
data: `ColumnKind` gains `control`. A control column carries no `aria-sort`, no tab stop,
no hover hint, no sort gesture and no drag payload; `GridCell` renders it empty; the totals
row skips it when placing its population label; and `DataGrid.renderCell` / `renderHeader`
let the host draw it. Overrides apply to source rows only, so a group row keeps its
group-header cell and the totals row keeps the formatter.

Two deliberate model decisions:

- Rows carry base sums and `comparison: null`. The campaign loader
  (`apps/web/app/_lib/optimizer-campaigns.ts`, not owned here) returns prior-window *spend*
  and no other prior base sum, so a `comparison` row would need five invented zeros. The
  spend change ships instead as a per-campaign `spend_change` dimension, and a group row
  shows `—` for it, which is the truth.
- `currentRows === 0` reads as "No activity in this period" under the campaign name rather
  than as a zero, keeping the old table's distinction between absent and zero.

Evidence:

- `packages/ui`: 203 of 203 functional tests (`vitest run --exclude src/pipeline.perf.test.ts`),
  one new — `DataGrid.interaction.test.tsx` "gives a control column host-rendered cells, no
  sort ordering, and no totals label". Run with the change reverted it fails with
  `expected 'none' to be null` (the control header still advertised `aria-sort`).
- `apps/web`: 672 of 672 (`vitest run`, local disposable Postgres 17). `app/optimizer` is 25
  of 25, seven of them rewritten or new. Two targeted before/after proofs: the new
  "renders every campaign in one continuous scroll with no pagination control" fails against
  the pre-slice component with `expected '…' not to contain 'Page 1 of'` (25 rows and a
  pager); "refuses the grid keyboard a selection an ineligible campaign could never have"
  fails with `expected '1 campaign selected…' to contain 'No campaigns selected'` when the
  `selectable` guard in `applyGridSelection` is removed.
- e2e `auth` suite (`pnpm --filter @wizard-ads/web test:e2e:auth`): 6 of 6, the sixth being
  the new optimizer walk-through of the recording — full width, no pager, a scroll that
  reaches the cheapest of forty campaigns, the Spend header's descending/ascending/off
  cycle, `State` dragged into the group bar and `Bid strategy` nested under it, then the
  header checkbox taking all thirty eligible campaigns matching a name filter and keeping
  them when the filter is cleared. Against the pre-slice component it fails immediately on
  the missing `grid-viewport`. `apps/web/src/e2e-suite-registry.ts` moves `auth` to
  `expectedTests: 6` and the conserved total from 76 to 77, per the ratified exception.
- `pnpm typecheck` (22 of 22), `pnpm lint`, `pnpm hygiene` (clean) and `git diff --check`
  clean. Screenshots at 1440x900 before and after are with the coordinator, untracked.

Performance, same invocation and environment as slices 1 and 2
(`vitest run src/pipeline.perf.test.ts --maxWorkers=1`, three runs; one-minute load average
4.4 falling to 4.2, which is higher than the earlier slices' 0.5–2.2):

| Run | Line 158 best-of-5 (budget 125 ms) | Other nine assertions |
|---|---|---|
| slice 3, run 1 | 153.3 ms | pass |
| slice 3, run 2 | 154.8 ms | pass |
| slice 3, run 3 | 156.0 ms | pass |

Line 158 remains the pre-existing failure inside the slice 1 and 2 range (144.6 to 160.9 ms).
This slice touched neither `pipeline.ts` nor `filter-options.ts`; the threshold was not changed.

**Required edit outside this package's owned files** (reported, not made):
`apps/web/e2e/optimization-groups.spec.ts` asserts the pagination this slice removed and now
fails. Confirmed by running the suite: 1 passed, 1 failed at line 72,
`expect(page.getByText('1–25 of 56', { exact: true })).toBeVisible()` — element not found.
Its owner needs four edits in "selects filtered campaigns across pages and polls the exact
read-only preview scope":

1. line 72 — replace the page-window text with the workspace's count, which now reads
   `56 of 57 campaigns` (the tenant fixture's own campaign is the 57th):
   `await expect(page.locator('.wa-optimizer-campaigns__shown')).toHaveText(...)`.
2. lines 84, 108 and 112 — the three `Next →` clicks have no successor control. Reaching a
   campaign that is not currently rendered is either a scroll of
   `page.getByTestId('grid-scroller')` or, more robustly, typing that campaign's name into
   `Find campaign`; the surrounding assertions about selection surviving a narrowed filter
   already work that way.
3. line 72's `1–25` framing in the test name ("across pages") is now "across a filter".
4. nothing else in that file depends on the table's markup; the checkbox roles, testids and
   accessible names are unchanged.

#### Slice 3 review fixes

The slice 3 review returned one high finding outside the owned files, one medium inside them
and four low. Fixed here, each with the command that proved it:

- **Absent is not zero on an ineligible campaign** (medium,
  `apps/web/app/optimizer/campaign-workspace.tsx`, `packages/ui/src/DataGrid.tsx`). The
  campaign-name subline chose between the ineligibility reason and the no-activity note, so a
  campaign that is both — a paused Sponsored Brands campaign Amazon reported nothing for —
  lost the note entirely and read as `$0.00` spend, `$0.00` sales and `0` orders it never
  measured. Both notes now render, and spend, spend change, sales, ACOS and orders read `—`
  for a campaign with `currentRows === 0`, which is what the table this replaced showed. The
  grid supports that without the host reimplementing money, ratios or the empty marker: a
  `renderCell` override may return `undefined` for a row it has nothing to say about and the
  grid draws its own cell. Group and totals rows are untouched — summing an absent row adds
  nothing — and the override still reaches source rows only. Tests: `packages/ui`
  "lets a cell override speak for one row and leaves every other row to the formatter"
  (reverted `DataGrid.tsx`: `expected '' to match /^\$[\d,]+\.\d\d$/`) and `apps/web`
  "keeps both notes on an ineligible campaign that reported nothing and prints no zero it
  never measured" (reverted `campaign-workspace.tsx`: `expected 'Synthetic campaign 02Only
  Sponsored P…' to contain 'No activity in this period'`, with the received text showing the
  `$0.00 -100.0% $0.00 — 0` row the review described).
- **Select-all assertion strengthened** (low, `campaign-workspace.test.ts`). `checked ||
  disabled` was satisfiable by a window of disabled, unchecked boxes. It now names the exact
  population: every enabled box in the window is checked and the checked count equals the
  enabled count. Proved against a mutant that disables and unchecks every row checkbox — the
  new assertion fails at `expected 0 to be greater than 0`, while the old one passed that
  line and only failed several assertions later.
- **Escape is now a decision, not an inherited default** (low). The brief's keyboard contract
  (item 11) makes Escape clear the selection, and on this workspace `Clear selected` has
  always owned the whole transient set including campaigns no filter shows. New test "clears
  the whole selection on Escape in the grid, hidden campaigns included" pins exactly that: 12
  selected, filter narrowed to one row, Escape on that row clears all 12.
- **Stale pagination wording** (`campaign-workspace.tsx`): the selection note said
  "Selections outside the current page or filters remain selected" on a surface that no
  longer has pages; it now reads "Selections hidden by the current filters remain selected".
  No test or spec asserted the old sentence.
- **`GridViewport` measured fill** (low, not changed here, deferred to slice 4 with the
  component). The review is right that `viewportHeight - (rect.top + scrollY) - bottomGap`
  can only ever resolve to the floor on a page whose grid starts below the fold, so the
  optimizer grid claims the window only in fullscreen. The fix the review proposes —
  measuring viewport-relative `rect.top` — only changes anything if the measurement is
  re-run on scroll, which makes the document's height change as the operator scrolls into
  the grid and needs checking at real viewport sizes on all four surfaces. Slice 4 reuses
  this component for recommendations and n-grams; it belongs there, with an e2e that
  measures the gap below the grid rather than a unit test that cannot see layout.

Outside the owned files, reported and not fixed (unchanged from the list above):
`apps/web/e2e/optimization-groups.spec.ts` (still red, edits listed above),
`apps/web/app/optimizer/loading.tsx` (still the shared 84rem `tokens.page` measure while the
loaded page is full width, so the route flashes a narrow column) and the now-dead
`.wa-optimizer-campaigns__tablewrap`, `__pagination` and `__empty` rules in
`apps/web/src/ui/theme.css`.

Evidence on the fixed tree: `pnpm typecheck` 22 of 22, `pnpm lint`, `pnpm hygiene` and
`git diff --check` clean; `packages/ui` 204 of 204 functional tests; `apps/web` `vitest run`
673 passed with the one known `verifier-subprocess` load flake, which passes 3 of 3 in
isolation; `app/optimizer` 27 of 27.

Remaining tables inventory is still due in slice 5's close-out.

### Slice 4: Recommendations queue

`apps/web/app/recommendations/review.tsx` and `page.tsx`, converted to the Data Grid.

- **One grid, not three nested tables.** The decision lanes and their reason
  `<details>` clusters are gone. Every loaded proposal is a row, in the order
  `groupByDecision` has always produced — needs review, then ready to export, then
  completed, by reason inside each — and the lane it belonged to is a `Queue` column on
  the row. Twelve columns: two `control` (the selection checkbox and the evidence
  toggle) and ten dimensions. Click-to-sort on every data column, shift-click to add a
  key, a `GroupBar` above the grid, a density select and a fullscreen toggle, all the
  slice-2 components unchanged.
- **It opens ungrouped, deliberately.** Grouping in this grid *replaces* source rows
  with their aggregates (`aggregate.ts` returns `GroupedRow[]` only), which is right for
  a metric grid and wrong as a default for a decision queue: an operator cannot tick a
  checkbox on a summary. Dropping `Queue` on the group bar rebuilds the three lanes as a
  treegrid whenever the counts are what is wanted, and the surface then says the rows
  became summaries rather than leaving an operator hunting for the controls they lost.
  This was found by measurement, not by reasoning: the first wiring defaulted to
  `groupBy: ['queue']` and rendered one group row and no proposals at all.
- **Full width** (`page.tsx`): the `96rem` centred column is gone; the application frame
  already supplies the horizontal padding, as on `/grid` and `/optimizer`.
- **No `window.location.reload()` anywhere.** A decision posts to the unchanged
  `/api/recommendations/decide`, reads that route's own `updated` / `refused` answer,
  writes an optimistic status per id (the refused ones take the status the route
  reported, not a hopeful one), calls `router.refresh()` and renders the result inline
  in a `decision-result` status region. An effect retires each optimistic entry as the
  refreshed server payload agrees with it, so a slow refresh never flickers a row back
  to the status the operator just changed. The run's status tiles move with the same
  bookkeeping and conserve the total. A successful export also refreshes rather than
  leaving the queue showing the world before the batch.
- **Filters, selection, evidence and scroll survive a decision**, because none of them
  is server state any more. Selection is the workspace's own set and the grid paints it;
  `Select all N filtered loaded rows` and the new header checkbox add the filtered rows
  without disturbing rows the filter hides, matching the optimizer's slice-3 contract,
  and `Clear selection` is the control that empties it. Evidence is a stack of
  provenance panels under the grid rather than an expanded row (the grid is virtualised
  and uniform-height by design); several can be open at once.
- **The grid keeps a floor.** The evidence stack and the grid are flex children of the
  same `GridViewport` column, and a grid with `minHeight: 0` shrinks to nothing to make
  room for an open panel — which is exactly what it did the first time this was wired
  (the e2e failed with the treegrid `hidden`). The grid now sits in a wrapper with
  `minHeight: 200` and the evidence region is capped at 40% of the column and scrolls
  itself. The e2e asserts the scroller is still over 100 px tall with a panel open.
- **Loaded rows are never presented as the run.** `listRecommendations` caps this page at
  20,000 rows and returns no completeness metadata, so `page.tsx` now passes that cap by
  name and the workspace compares what arrived against the run's own per-status counts —
  a database aggregate over the whole run. The filter count reads `N of M loaded rows
  shown`, the selection reads `N of M filtered loaded rows selected`, the button reads
  `Select all M filtered loaded rows`, and a `queue-truncated` notice appears when the
  run holds more than arrived. The export control is the one count that may speak for
  the run, because an export with no selection is executed server-side over every
  accepted proposal; its copy already said so and still does.

Evidence:

- `apps/web`: `vitest run` 679 of 679 (local disposable Postgres 17).
  `app/recommendations/review.test.ts` is rewritten as a jsdom DOM test on the real
  component (the `initialGridRect` seam, as `campaign-workspace.test.ts` uses) and grew
  from 1 test to 6: the ungrouped queue in decision order, grouping on request and what
  it costs, click-to-sort in both directions, a decision keeping the filter/selection/
  evidence and reporting itself, the optimistic status retiring on a server-confirmed
  refresh, and the truncation notice. All six were run against the pre-slice component
  (`git show HEAD:…/review.tsx`) and all six fail there — `expected null not to be null`
  for the grid shell, `no grouping select`, `no column header labelled 'Entity'`,
  `expected '' to be '2 of 3 loaded rows shown'`, `expected 'proposed' to be 'accepted'`,
  and `expected '' to contain 'loaded 3 of the 40 proposals in this…'`.
- e2e `tags-goto` suite (`pnpm --filter @wizard-ads/web test:e2e:tags-goto`, disposable
  local Postgres 17): 33 of 33. The spec follows the queue onto the grid and adds a fifth
  test, `a decision keeps the active filter, the selection and the open evidence, and
  reports itself inline`. Against a mutant that restores `window.location.reload()` in
  place of the optimistic status and `router.refresh()`, that test fails at
  `expect(locator).toHaveText('1 of 1 proposals moved to accepted.')` and takes the
  accept/dismiss/export test with it: 31 passed, 2 failed. With the change, 33 passed.
  The 390×844 mobile keyboard test and the three-act export gesture are unchanged in
  substance; only the control copy they assert moved to the loaded-rows wording.
  `apps/web/src/e2e-suite-registry.ts` moves `tags-goto` to `expectedTests: 33` and the
  conserved total from 77 to 78, per the ratified exception.
- `packages/ui`: 204 of 204 functional tests (`vitest run --exclude
  src/pipeline.perf.test.ts`), unchanged — this slice touches no file in that package.
- `pnpm typecheck` (22 of 22), `pnpm lint`, `pnpm hygiene` (1,488 of 1,489 tracked files,
  clean) and `git diff --check` clean.

Performance, same invocation and environment as slices 1 to 3
(`vitest run src/pipeline.perf.test.ts --maxWorkers=1`, three runs; one-minute load
average 6.3 falling as the e2e server exited, higher than the earlier slices):

| Run | Line 158 best-of-5 (budget 125 ms) | Other nine assertions |
|---|---|---|
| slice 4, run 1 | 153.5 ms | pass |
| slice 4, run 2 | 149.8 ms | pass |
| slice 4, run 3 | 158.7 ms | pass |

Line 158 remains the pre-existing failure inside the slice 1–3 range (144.6 to 160.9 ms).
This slice changed nothing in `packages/ui`; the threshold was not changed.

**Dead CSS left behind, reported and not fixed** (`apps/web/src/ui/theme.css` is outside
this package's owned files): `.wa-review__lane`, `.wa-review__lane-head`,
`.wa-review__clusters`, `.wa-review__cluster`, `.wa-review__cluster-count` and
`.wa-review__tablewrap` have no markup left to style. Its owner should remove them, the
same way the optimizer's `__tablewrap` / `__pagination` / `__empty` rules from slice 3
are still waiting.

#### Slice 4 review fixes

The slice 4 review returned one high finding, five medium, four low and no scope
violations. Every one is addressed below, each with the command that proved it: the test
was run with the change reverted (fails, message quoted) and applied (passes).

- **An optimistic decision is now tagged with the refresh it *asked for*, not the last one
  that landed** (high, `review.tsx`). The reconciliation counted arriving payloads, so a
  decision taken at t0 and a decision taken while refresh #1 was still in flight carried
  the same generation, and payload #1 — which predates the second decision and cannot know
  about it — retired both. The row the operator had just moved flickered back to the status
  they had changed, while `decision-result` still reported the move and the tiles ticked
  back. The clock is now two refs: `requested`, incremented immediately before every
  `router.refresh()` in both `decide` and `exportBatch`, and `landed`, incremented when the
  server payload's identity changes. A write records `requested.current` and is retired
  once `landed` has passed it. Test: `review.test.ts` "does not flicker a second decision
  back when a slow earlier refresh lands"; with the tag reverted to `landed.current` it
  fails with `expected 'exported' to be 'accepted'`.
- **The commit that retires on time rather than on agreement now has a test** (medium,
  `review.test.ts`). `6ae8e52` shipped with six tests that all passed against the pre-fix
  component, because the only one naming reconciliation exercised the agreement path the
  old code also satisfied. New test "retires the optimistic status when the refreshed
  payload disagrees with it": a concurrent run moved the proposal to `superseded` while
  this operator was accepting it, and the row and the run tiles follow the server. With the
  retirement condition reverted to agreement-only it fails with `expected 'accepted' to be
  'superseded'`.
- **Scroll survives a decision in the queue's most ordinary workflow** (medium,
  `packages/ui/src/DataGrid.tsx`, `review.tsx`). Filtering to `Status = proposed` and
  working down the list is the workflow, and every decision dropped its rows out of the
  filtered set, changed `model.matched`, and returned the scroller and the roving tab stop
  to zero — the operator thrown back to the top by their own decision. `DataGrid` gains an
  optional `filterKey`: a host that can tell "the operator re-asked the question" from
  "rows left because their data moved" supplies a key that changes only for the former, and
  the grid uses it in place of the matched count. Sorting and grouping still reset
  regardless, because those really are a new ordering. The queue's key is its four filter
  fields. Tests: `DataGrid.interaction.test.tsx` "keeps the scroll when rows leave a set the
  operator never re-filtered" (reverted: `expected +0 to be 4000`) and `review.test.ts`
  "keeps the operator in place when a decision drops the row out of their filter" — 400
  proposals, filtered to `proposed`, scrolled to 4,000 px, one accepted; with `filterKey`
  removed from the call site it fails with `expected +0 to be 4000`. Both also assert that
  moving a filter still returns to the top. There is no e2e for this: the browser fixture
  seeds three proposals (`apps/web/e2e/run.ts`, outside this package's owned files) and
  three rows cannot scroll, so the deterministic 400-row jsdom test is the artifact.
- **The grid's own footer no longer prints a truncated queue as its own population**
  (medium, `packages/ui/src/DataGrid.tsx`, `review.tsx`). `3 of 3 rows` sat directly under
  the rows — nearer the eye than the truncation notice at the top of the page saying 40.
  `DataGrid` gains `rowNoun` and `populationNote`, and the queue passes `loaded rows` and,
  when truncated, `40 in this run`, so the footer reads `3 of 3 loaded rows · 40 in this
  run` and an untruncated queue still reads `3 of 3 loaded rows`. Tests:
  `DataGrid.interaction.test.tsx` "counts a capped row set in the host's own words"
  (reverted: `expected '12 of 12 rows' to be '12 of 12 loaded rows · 40 in this run'`) and
  `review.test.ts` "qualifies the grid footer count when the queue is a slice of the run".
  The `packages/ui` revert fails with `expected '12 of 12 rows' to be '12 of 12 loaded rows
  · 40 in this run'`.
  `aria-rowcount` is left reporting the loaded set deliberately: it counts the rows this
  grid holds, including the virtualised ones, and the grid genuinely holds only what the
  capped query returned. A number describing rows that are not in the grid does not belong
  in that attribute; the footer and the notice are where the run's size is stated.
- **The evidence disclosure states the relationship it claims** (medium, `review.tsx`). The
  per-row toggle carried `aria-expanded` while the panel it opens lives in the stack below
  the grid, possibly hundreds of virtualised rows away, with no `aria-controls`, no
  announcement and focus left on the button. Each panel now has a stable id
  (`evidence-panel-<id>`), is a named `role="group"`, and the toggle points at it with
  `aria-controls` while it exists — only while it exists, because `aria-controls` pointing
  at nothing is a broken relationship rather than a weaker one. Opening or closing one
  announces itself in a polite live region ("Evidence for X opened below the queue");
  focus deliberately stays on the toggle so the operator keeps their place in the queue.
  Row control names were also non-unique — one run proposes a bid *and* a budget for one
  campaign, and `Select <entity>` named both checkboxes identically — so the checkbox and
  the toggle now carry the field and the scope as well. Test: "names each row control for
  the proposal it acts on, not just the entity"; with the entity-only name restored it
  fails with `expected [ Array(2) ] to deeply equal [ …(2) ]`, the received pair being
  `"Select Synthetic keyword one"` twice.
- **`GridViewport` measured fill: carried to slice 5, not dropped** (medium). The slice 3
  review deferred this to slice 4 and the slice 4 close-out failed to mention it, which is
  the part of the finding that was simply true. It is not fixed here either, and this is
  why: the expression is `viewportHeight - documentTop - bottomGap` in *document*
  coordinates, so on any page whose grid starts below the fold it resolves negative and
  clamps to the floor (420 on this queue). The proposed repair — measure viewport-relative
  `rect.top` and re-measure on scroll — is a feedback loop in ordinary document flow:
  scrolling down by *d* reduces `rect.top` by *d*, which grows the grid by *d*, which grows
  the document by *d*, which allows another *d* of scrolling. Making it converge means the
  page itself stops scrolling and the grid page becomes a fixed-height app shell, which is a
  layout change across grid, optimizer, recommendations and n-grams and needs checking at
  real viewport sizes on all four. Slice 5 is the slice that touches the fourth surface and
  writes the remaining-table inventory; it takes this, with the e2e that measures the gap
  below the grid at a real viewport size. Until then fullscreen is the gesture that gives a
  table the whole screen, as recorded in slice 3.
- **A group summary can no longer enter the operator's selection** (low, `review.tsx`).
  `applyGridSelection` took whatever the grid emitted, and the grid's Space handler emits
  the current row's id for a group row too, so the grid footer read `1 selected` while the
  workspace read `0 of 2 filtered loaded rows selected` and `Clear selection` was enabled
  for a selection that did not exist. Incoming ids are now filtered through the proposal
  map, mirroring the optimizer's slice 3 guard. Test: "refuses the grid keyboard a
  selection a group summary could never have"; reverted it fails on the grid footer with
  `expected 'EntityQueueReasonObjectiveScopeFieldC…' not to contain 'selected'`, the
  received text ending `3 matched source rows of 3 · 1 selected` while `selection-count`
  reads `0 of 3 filtered loaded rows selected`.
- **The refusal message names every refused state, and no move is claimed for a row the
  route did not report moving** (low, `review.tsx`). `DECIDABLE_FROM` is
  `['proposed','accepted','dismissed']`, so `superseded` is refused as well — and
  `superseded` is exactly the concurrent-run case the reconciliation exists for. The
  message now reads "already exported, applied or superseded". Separately,
  `decideRecommendations` returns a refusal only for ids that still resolve to a row in the
  org, so an id resolving to nothing was neither updated nor refused and still got a
  hopeful optimistic status while the message reported a smaller `updated`. The client now
  writes the optimistic decision only when `offered.length - refused.length === updated`;
  the refusals themselves are exact — the route read those statuses out of the database —
  so they are written either way, and anything unaccounted for waits the one refresh.
  Test: "claims a move only for the rows the route reports moving, and names every
  refusal"; reverted in two halves, it fails first on the wording
  (`'… exported or applied cannot be decided again.'`) and then on
  `expected 'accepted' to be 'proposed'` for the row the route never mentioned.
- **Every count on the screen is formatted once** (low, `review.tsx`). The queue count, the
  selection count and the select-all label printed raw integers beside a truncation notice
  using `toLocaleString`, so at the 20,000-row cap the queue read "20000 of 20000 loaded
  rows shown" next to "20,000 of the 41,000 proposals". One `int()` helper now formats the
  run tiles, the queue count, the selection count, the select-all and header-checkbox
  labels, the decision button labels and every export count. Covered by the existing
  assertions on those exact strings.
- **The 390 px queue is usable, and asserted** (low, `review.tsx`,
  `e2e/recommendations.spec.ts`). `Select` (44 px) plus a pinned `Entity` (260 px) claimed
  304 of 390 pixels and left the other ten columns 86 to share; the mobile e2e passed while
  asserting nothing about the grid at all. Below `PINNED_ENTITY_MIN_WIDTH` (640) the
  identity column scrolls with the rest of the row and only the checkbox stays pinned; the
  breakpoint is measured in an effect, not guessed, and the server render is the wide case
  so hydration matches. The existing mobile test now asserts the pinning, that the scroller
  overflows, and that after scrolling to the far end the `Status` header is wholly on
  screen and clear of the pinned column — no new test, so the suite registry is unchanged
  at 33. Proof: with `Entity` forced back to `pinned: true`,
  `pnpm --filter @wizard-ads/web test:e2e:tags-goto -- --grep mobile` fails at
  `recommendations.spec.ts:146` with `unexpected value "sticky"`; with the change, the whole
  suite is 33 of 33. Unit mirror: "stops pinning the identity column when the viewport
  cannot afford it" (reverted: `expected 'sticky' to be 'relative'`).

Evidence on the fixed tree, with `WIZARD_ADS_TEST_DATABASE_URL` and `DATABASE_URL` both
pointing at the disposable local Postgres 17:

- `apps/web`: `vitest run` 687 of 687 (was 679; eight new tests in `review.test.ts`, which
  goes from 6 to 14). `vitest run app/recommendations` 14 of 14.
- `packages/ui`: `vitest run --exclude src/pipeline.perf.test.ts` 206 of 206 (was 204; two
  new in `DataGrid.interaction.test.tsx`).
- e2e `tags-goto` (`pnpm --filter @wizard-ads/web test:e2e:tags-goto`): 33 of 33, the same
  33 the registry declares — no test was added or removed, so
  `apps/web/src/e2e-suite-registry.ts` and its test literal are untouched, and
  `vitest run src/e2e-suite-registry.test.ts` is 4 of 4.
- e2e `auth` (`pnpm --filter @wizard-ads/web test:e2e:auth`): 6 of 6. These fixes change
  `packages/ui/src/DataGrid.tsx`, which `/grid` and the optimizer also render through; both
  omit the new props and get exactly the previous behaviour.
- `pnpm typecheck` 22 of 22, `pnpm lint`, `pnpm hygiene` and `git diff --check` clean.

Performance, same invocation and environment as slices 1 to 4
(`vitest run src/pipeline.perf.test.ts --maxWorkers=1`, three runs; one-minute load average
3.3 to 3.5):

| Run | Line 158 best-of-5 (budget 125 ms) | Other nine assertions |
|---|---|---|
| slice 4 fixes, run 1 | 150.8 ms | pass |
| slice 4 fixes, run 2 | 146.7 ms | pass |
| slice 4 fixes, run 3 | 149.7 ms | pass |

Line 158 remains the pre-existing failure inside the slice 1–4 range (144.6 to 160.9 ms).
These fixes touch `DataGrid.tsx` but neither `pipeline.ts` nor `filter-options.ts`; the
threshold was not changed.

**Still outside this package's owned files, reported and not fixed**: the dead
`.wa-review__*` and `.wa-optimizer-campaigns__*` rules in `apps/web/src/ui/theme.css`
listed above, and `apps/web/e2e/optimization-groups.spec.ts` from slice 3. Nothing in these
fixes adds to either list.

Remaining tables inventory is still due in slice 5's close-out, together with the
`GridViewport` measured fill carried forward above.

### Slice 5: N-grams, the cockpit above the grid, first paint, and what is not converted

The closing slice. Three surfaces of work and one inventory.

#### N-gram drill-down (`apps/web/app/ngrams/explorer.tsx`, `page.tsx`)

The gram table was already the Data Grid. The **drill-down** — the search terms
behind a selected gram, and the population "propose as negative" acts on — was a
hand-rolled `<table>` printing `row.cost.toFixed(2)`: a bare number with no
currency, no thousands separator, no locale and no absent marker, beside raw
`clicks`, `purchases7d` and `sales7d`, with no derived ratio at all.

It is now the same Data Grid, with its columns taken from the shared registry
(`allMetricColumns`), so spend and sales are the profile's currency through
`formatMoney`, clicks and orders are grouped integers, and CVR, RPC and ACOS are
recomputed from the summed bases at the level on screen rather than printed from
a row. Base sums only, `comparison: null`, `units` left at zero because the
search-term fact does not carry it and no column shows it — the same call
`src/ngrams/rows.ts` already makes for grams.

- **Selection is unchanged in substance and stricter in fact.** The proposal set
  is still the workspace's own `selectedTerms`; the grid paints it. The header
  checkbox takes or clears every term behind the gram, and ids arriving from the
  grid's Space key are filtered through the term map, so the grid's selection
  and the "propose selected as negatives" population cannot disagree — the same
  guard the optimizer and the queue apply.
- **Every count on the screen is formatted once**, through `formatInteger`: the
  gram count, the filtered gram count, the term count and the select-all label.
- **The gram grid gains the slice 2 chrome** it never had: `GridViewport` with a
  420 floor (the height it shipped with), the density select and the fullscreen
  toggle, through `GridToolbar`'s own controls. The drill-down keeps a bounded
  320 px box: two grids competing for one viewport leaves neither usable.
- **The page is full width** (`page.tsx`), like `/grid`, `/optimizer` and
  `/recommendations`. The `96rem` centred column is gone.

Evidence: `apps/web/app/ngrams/explorer.test.ts`, new, 3 tests, jsdom on the real
component through the `initialGridRect` seam. Run against the pre-slice explorer
(`git stash push apps/web/app/ngrams/explorer.tsx`) all three fail with `Error:
the drill-down is not a Data Grid`; with the change, 3 of 3. They assert the
formatted cells (`$1,234.50`, `$9,876.25`, `4,000`, `1,000`, `25.0%`, `$2.47`,
`12.5%`) against the raw numbers the old table printed, that the section holds no
`<table>` at all, 400 terms in one continuous scroll with a viewport in the DOM
and a header click reversing the order, and that "propose" posts exactly the term
that was ticked.

#### Tiles and chart above `/grid` (`apps/web/app/grid/page.tsx`)

WP-24 ordered a KPI tile row and a trend chart for this page and it was never
delivered here. It is the same `Cockpit` and the same `loadProfileDailyRows` the
dashboard and the optimizer mount — one component, one loader, three pages — with
the dashboard's coverage clamp, so a profile whose facts begin after the settled
window opens is not described as sixteen settled days while four of them exist.

It is inside a `Suspense` boundary rather than awaited in the page body. The rows
the operator came for arrive over `/api/grid/rows`, which the browser cannot
request until the document has streamed; a profile-daily query awaited above the
workspace would put itself in front of that request for nothing. A profile with
no daily facts renders nothing rather than an empty chart.

Evidence: `grid.spec.ts` gains "grid carries the performance tiles and trend
above the rows, streamed outside the row path" — the cockpit region is visible,
carries the `Performance trend` heading and at least one tile, its box ends above
the grid viewport's, the rows still reach `data-ready="true"`, and the browser
still makes exactly one `/api/grid/rows` request. Against the pre-slice page it
fails at `expect(locator).toBeVisible()` / `element(s) not found` for the cockpit
region. `apps/web/src/e2e-suite-registry.ts` moves `auth` to `expectedTests: 7`
and the conserved total from 78 to 79, per the ratified exception; the suite runs
7 of 7.

#### Grid first paint (`packages/ui/src/views.ts`, `apps/web/app/grid/grid-client.tsx`)

Two gates delayed the first usable frame and one of them was a promise around a
synchronous read.

- **Synchronous cache read.** `LocalViewStore` now also implements
  `SynchronousLayoutSource` (`cachedLayout`), and the workspace restores the
  remembered layout in a state initializer, so the operator's own columns,
  filter, sort, grouping and density are on the first frame the rows allow
  instead of behind a "Restoring your saved grid layout…" render. It is
  hydration-safe by construction: this subtree renders only after the client's
  own row request resolves, so there is no server HTML for it to disagree with,
  and the browser store is constructed only when `window` exists.
- **The asynchronous port is untouched.** `cachedLayout` is an optional
  capability, not a required method, precisely so a remote store is not forced to
  invent a synchronous lie. A store without it — `MemoryViewStore`, the tests'
  `DeferredViewStore`, any future database-backed store — takes exactly the path
  it took before, gate and all. Cancellation on a scope change is unchanged, and
  a client-side entity switch gets the same synchronous read from inside the
  effect.
- **Late restoration can no longer overwrite the operator.** A scope restored
  synchronously never asks for `lastLayout` at all, so there is no late answer to
  overwrite anything with. `viewReady` still opens only for the matching
  entity/deep-link scope. A campaign deep link (`?campaign=`) is never restored
  over: it names the scope the operator asked for.
- **Debounced persistence.** `LayoutWriteBuffer` writes the first change of a
  gesture immediately — so a single click is persisted at once and a reader that
  looks straight after it sees the truth — and collapses everything inside a
  200 ms window into one trailing write. It flushes on a scope change and on
  unmount, because the state the operator ended on must never be the one that is
  dropped. A rejecting store is caught: losing a preference is not worth an
  unhandled rejection in the middle of a resize.

Evidence, each run with the change reverted (fails, message quoted) and applied:

- `packages/ui` `views.test.ts`, 4 new tests: `cachedLayout` agrees with
  `lastLayout` and keeps every defence (wrong entity, unknown density, corrupt
  JSON all yield null); `hasCachedLayout` is false for `MemoryViewStore` and
  null; forty simulated mouse moves produce one leading and one trailing write
  carrying the last width; `flush()` writes the queued state and cancels the
  window; a rejected write does not stop the next one.
- `apps/web` `grid-client.test.ts`, 2 new tests. "opens on the remembered layout
  with no restoring state when the store can answer synchronously" — reverted:
  `expected <p role="status" …(2)></p> to be null`, the restoring gate. It also
  drives a late, disagreeing `lastLayout` answer in after the operator has
  sorted, and the operator's sort stands. "writes the first layout change at once
  and collapses the rest of a burst into one write" — against a mutant that
  restores `void store?.rememberLayout(next)` in place of the buffer:
  `expected [ { id: 'default', …(10) }, …(2) ] to have a length of 1 but got 3`.

**First paint on the reference fixture**, `pnpm --filter @wizard-ads/web
test:e2e:grid-performance` (3,597 seeded search-term rows, disposable local
Postgres 17, `usableMs` = navigation start to the export button reporting the
complete set). Interleaved before/after runs, alternating on the same machine
because the run-to-run spread turned out to be larger than the change:

| Run | before (HEAD before slices 5b/5c) | after |
|---|---|---|
| pair 1 | 1,473.8 ms | 1,537.3 ms |
| pair 2 | 1,616.3 ms | 1,454.3 ms |
| pair 3 | 1,368.6 ms | 1,584.1 ms |
| block of five, before | 1,490.2 / 1,583.2 / 1,905.0 / 1,500.8 / 2,020.9 ms | — |
| block of five, after | — | 1,384.0 / 1,410.9 / 1,581.1 / 1,866.9 / 1,492.9 ms |

Median before 1,490 ms, median after 1,493 ms, against the suite's 2,000 ms
reference budget. The honest reading is **no regression and no demonstrable
improvement in this suite**, and the reason is worth stating rather than hiding:
the fifth "before" run *failed the suite at 2,020.9 ms on the unchanged tree*
(one-minute load average 4.5), so this measurement is dominated by the dev
server and the 1.29 MB row payload, not by the layout gate. It also cannot show
the synchronous-cache benefit at all: the suite opens a fresh browser context
with no remembered layout, so `cachedLayout` returns null there and the code path
under test never fires. The deterministic artifacts for that path are the two
jsdom tests above — the gate is not rendered, and `lastLayout` is not called.
Initial document 80,764 → 81,513 bytes (the suspended cockpit's shell), one row
request, 3,597 rows, exports identical in both.

#### `GridViewport` measured fill, carried from the slice 3 and slice 4 reviews

Resolved, and measured rather than reasoned about. The expression is
`viewportHeight - documentTop - bottomGap` in document coordinates, so on a page
whose grid starts below the fold it resolves negative and clamps to the floor.
Adding the tile row and the trend chart made `/grid` such a page, and its default
floor of 320 was *smaller* than the height the grid had before them — so this
slice's own change is what forced the decision. `/grid` now takes an explicit
560 floor, the same number and the same reason as the optimizer's since slice 3.

The measurement the reviews asked for is in `grid.spec.ts`: at the suite's real
1280x720 viewport it reads the grid viewport's own rectangle and asserts both
that the grid keeps 560 px and that its bottom edge is at or below the bottom of
the window — no screen space is left unused underneath it, the page scrolls to
the rest. Without the floor the same assertion fails at
`expect(received).toBeGreaterThanOrEqual(expected)` with the 320 default. All
four converted surfaces now resolve the fill to their floor, which makes the
floor the design and fullscreen the gesture that gives a table the whole screen.
Re-measuring `rect.top` viewport-relatively on scroll is still refused, for the
slice 4 reason: it is a feedback loop in ordinary document flow.

#### Also fixed here, previously reported outside the owned files

- `apps/web/e2e/optimization-groups.spec.ts` (manager-ratified for this slice)
  had been red since slice 3 removed the 25-row page slice: it asserted the page
  window `1–25 of 56` and turned pages with `Next →`. Confirmed still failing
  before the edit — 1 passed, 1 failed at line 72, element not found — and 2 of 2
  after. The four edits are exactly the ones the slice 3 close-out listed: the
  count becomes `56 of 57 campaigns` from `.wa-optimizer-campaigns__shown`, the
  three `Next →` clicks become a narrowed `Find campaign` (what the surrounding
  assertions already did), and "across pages" in the name becomes "across a
  filter". What the test is about is untouched: the header checkbox still owns
  the complete filtered eligible population, hidden selections survive a narrowed
  filter, `Clear selected` still empties the whole transient set, and the preview
  scope, fingerprint and stored-batch assertions are unchanged. No test was added
  or removed, so that suite stays at `expectedTests: 2`.
- `apps/web/app/optimizer/loading.tsx` used the shared 84rem `tokens.page` measure
  while the loaded optimizer is full width, so the route flashed a narrow column
  and jumped wider. It now takes the measure of the page it stands in for, with
  `app/optimizer/loading.test.ts` as the artifact (reverted: `expected '<main
  style="margin:0 auto;max-width:…' not to contain 'max-width:84rem'`).

#### Operator tables this package did **not** convert

Four surfaces were in scope and four were delivered. These eight were not, and
none of them should be reported as done. Each is a follow-up, not a defect.

| Surface | File | State, in one line |
|---|---|---|
| Creative performance | `apps/web/app/creative/creative-performance.tsx` | Two `wa-table` tables (creatives, and an ad-level drill-down inside an expanded row) with no sorting, no grouping and no virtualisation; the drill-down's expand-in-place model is the part that does not map onto a uniform-height virtual grid without a design decision. |
| Dayparting | `apps/web/app/dayparting/page.tsx` | Not a table at all: a day-of-week × hour heatmap plus a proposed-schedule list, filtered by a server `<form method="get">`. The grid is the wrong shape for the heatmap; the schedule list below it is the convertible half. |
| Query intelligence | `apps/web/app/query-intelligence/workspace.tsx` | Three `wa-table` tables, two of them hard-sliced in the client (`queryLimit` 250, `ppcLimit` 150) with the count stated honestly; a conversion would remove the slice, which is exactly the change the optimizer needed. |
| Experiments | `apps/web/app/experiments/list.tsx` | A `<ul>` of experiment cards, not a table — status, window and scope per card. Converting it is a product decision about whether the roster should be scannable as rows, not a mechanical port. |
| Time machine | `apps/web/app/time-machine/page.tsx` | Batch history navigation plus day-grouped change sections, paged server-side at `TIMELINE_PAGE_SIZE` 50 with an older/newer window. The pagination is a real server boundary over an unbounded history, so removing it is not free the way the optimizer's client-side slice was. |
| Crosscheck | `apps/web/app/crosscheck/panel.tsx` | Two small evidence tables (per-day verdicts, per-week campaign verdicts) rendered from a bounded comparison artifact. Small enough that the grid's machinery would be the larger half of the screen. |
| Tags | `apps/web/app/tags/tag-manager.tsx` | A nested `<ul>` tag tree and a campaign assignment list. A tree of tags is not a row set; the grid's grouping replaces rows with aggregates, which is the wrong model for editing a hierarchy. |
| Sync status | `apps/web/app/sync-status/page.tsx` | Three plain inline-styled tables (profile freshness, job queue, report ledger). Deliberately plain and read-only; the parsed/loaded reconciliation columns matter more than the ergonomics, and it is the surface an operator reads when something is already wrong. |

Still outside this package's owned files, reported and not fixed: the dead
`.wa-optimizer-campaigns__tablewrap` / `__pagination` / `__empty` and
`.wa-review__lane` / `__lane-head` / `__clusters` / `__cluster` /
`__cluster-count` / `__tablewrap` rules in `apps/web/src/ui/theme.css` — all
still present in the stylesheet and referenced by no markup, confirmed by grep on
the delivered tree. Nothing in this slice adds to that list; the n-gram
conversion introduced no CSS of its own.

#### Evidence on the delivered tree

With `WIZARD_ADS_TEST_DATABASE_URL` and `DATABASE_URL` both on the disposable
local Postgres 17:

- `pnpm typecheck` 22 of 22, `pnpm lint`, `pnpm hygiene` (1,489 of 1,490 tracked
  files, clean) and `git diff --check` clean.
- `packages/ui`: `vitest run --exclude src/pipeline.perf.test.ts` 210 of 210 (was
  206; four new in `views.test.ts`).
- `apps/web`: `vitest run` 692 of 692 functional tests with the one known
  `verifier-subprocess` load flake, which passes 3 of 3 in isolation — the same
  flake slice 3 recorded. `vitest run app/grid` 17 of 17, `app/ngrams` 3 of 3,
  `app/optimizer` 29 of 29 including the new loading-width test,
  `src/e2e-suite-registry.test.ts` 4 of 4.
- e2e `auth` 7 of 7, `tags-goto` 33 of 33, `optimization-groups` 2 of 2,
  `grid-performance` 1 of 1.

Performance, same invocation and environment as slices 1 to 4 (`vitest run
src/pipeline.perf.test.ts --maxWorkers=1`, three runs; one-minute load average
7.1 falling, the highest of any slice because the full web suite had just run):

| Run | Line 158 best-of-5 (budget 125 ms) | Other nine assertions |
|---|---|---|
| slice 5, run 1 | 154.3 ms | pass |
| slice 5, run 2 | 159.0 ms | pass |
| slice 5, run 3 | 155.3 ms | pass |

Line 158 remains the pre-existing failure inside the slice 1–4 range (144.6 to
160.9 ms). This slice added `SynchronousLayoutSource` and `LayoutWriteBuffer` to
`views.ts` and touched neither `pipeline.ts` nor `filter-options.ts`; the
threshold was not changed. Resolving that baseline is still open for whoever
touches the pipeline.

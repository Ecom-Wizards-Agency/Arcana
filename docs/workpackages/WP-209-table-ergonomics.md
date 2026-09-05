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

/**
 * @wizard-ads/ui (owned by WP-06).
 *
 * The component layer: a virtualized, no-pagination DataGrid on TanStack Table
 * + Virtual, the dashboard widgets, and the pure model underneath both.
 *
 * The package has one governing rule, and it is the reason the pure modules
 * (`metrics`, `rows`, `filter`, `sort`, `aggregate`, `pipeline`) are separate
 * from the components at all: **a ratio is never stored, summed or averaged.**
 * ACOS is `sum(spend) / sum(sales)` computed at the level being displayed, and
 * there is no code path that could do otherwise, because no row anywhere in
 * this package carries an ACOS to add up. That is the single most common source
 * of quietly wrong numbers in ads tooling, and the recon
 * (`https://github.com/Ecom-Wizards-Agency/openspell/blob/1ca9bd7c253e2a3f6b8c8b5848ee7bfad695781f/tools/recon/02-data-grid.md` §4) names it as the one thing the incumbent
 * got right by making the correct path the only path.
 *
 * Everything here is presentational or pure. No I/O, no database, no Amazon
 * calls, no framework state beyond a component's own — the data arrives as
 * props from `apps/web` server components.
 */
export const PACKAGE_NAME = '@wizard-ads/ui' as const;

export * from './metrics.js';
export * from './rows.js';
export * from './filter.js';
export * from './filter-options.js';
export * from './sort.js';
export * from './aggregate.js';
export * from './columns.js';
export * from './pipeline.js';
export * from './format.js';
export * from './csv.js';
export * from './views.js';
export * from './virtual.js';
export * from './density.js';
export * from './grouping.js';
export * from './theme.js';
export { entitySearchColumn, readEntitySearch, writeEntitySearch } from './toolbar/entity-search.js';
export { groupColumns, searchColumns } from './toolbar/column-groups.js';
export type { ColumnGroup } from './toolbar/column-groups.js';

export { DataGrid } from './DataGrid.js';
export type { DataGridProps } from './DataGrid.js';
export { GridViewport } from './grid/GridViewport.js';
export type { GridViewportProps } from './grid/GridViewport.js';
export { GridToolbar, describeFilter } from './GridToolbar.js';
export type { GridToolbarProps } from './GridToolbar.js';
/** The group bar on its own, for a workspace that has no `GridToolbar`. */
export { GroupBar } from './toolbar/GroupBar.js';
export type { GroupBarProps } from './toolbar/GroupBar.js';

export * from './dashboard/freshness.js';
export { FreshnessBanner } from './dashboard/FreshnessBanner.js';
export { TrendChart } from './dashboard/TrendChart.js';
export type { TrendChartProps, TrendPoint, TrendSeries } from './dashboard/TrendChart.js';
export { StatTile } from './dashboard/StatTile.js';
export type { StatTileProps } from './dashboard/StatTile.js';
export { PacingWidget } from './dashboard/PacingWidget.js';
export type { PacingStatus, PacingView } from './dashboard/PacingWidget.js';
export { FlagsPanel } from './dashboard/FlagsPanel.js';
export type { FlagSeverity, FlagView } from './dashboard/FlagsPanel.js';

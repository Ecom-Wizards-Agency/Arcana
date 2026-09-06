# @wizard-ads/ui

Reusable grid, chart and dashboard components, with pure models for metrics,
filtering, sorting, grouping, aggregation and CSV export. Components receive data
through props. This package performs no database, provider or other I/O; application
loading and authorization belong in `apps/web`.

## Components and data contracts

[src/index.ts](src/index.ts) is the public export list. It includes `DataGrid`,
`GridViewport`, `GridToolbar`, `GroupBar`, `TrendChart`, `StatTile`, `PacingWidget`,
`FlagsPanel` and `FreshnessBanner`, plus their model helpers and types. Use those
exports instead of duplicating grid or metric behavior in a page.

Ratios are derived at the displayed grain. ACOS is total spend divided by total
sales; never store, sum or average row-level ratios. Numeric columns use tabular
figures and right alignment. Percentage deltas follow the metric's `better`
direction through `deltaColor`, not the sign alone: a spend decrease is not
automatically an improvement. Keep missing data distinct from zero.

## Theme contract

The application stylesheet is
[apps/web/src/ui/theme.css](../../apps/web/src/ui/theme.css). It owns semantic CSS
custom properties. [src/theme.ts](src/theme.ts) provides matching `var()` references
and standalone fallback values for this package. Application surfaces consume the
semantic tokens rather than adding literal colors.

Themes have three scopes, in order: light `:root`, OS dark preference scoped to
`:root:not([data-theme='light'])`, and explicit `:root[data-theme='dark']`. Preserve
the `wizard-ads.theme` preference and the pre-paint theme initialization in the
[application layout](../../apps/web/app/layout.tsx). Test both light and dark modes,
including an explicit light choice on a dark OS.

| Token family | Meaning |
| --- | --- |
| `--wa-bg`, `--wa-surface`, `--wa-surface-2`, `--wa-surface-3` | Page, panels and raised/hover surfaces |
| `--wa-text`, `--wa-text-dim`, `--wa-text-faint` | Primary, supporting and tertiary text |
| `--wa-border`, `--wa-border-strong`, `--wa-ring` | Hairlines, control edges and keyboard focus |
| `--wa-accent`, `--wa-accent-grad`, `--wa-on-accent` | Primary action and its readable foreground |
| `--wa-indigo`, `--wa-indigo-soft` | Selection and navigation emphasis |
| `--wa-{good,warn,bad,info}-{text,bg,border}` | Status combinations; use the complete combination |
| `--wa-viz-*` | Chart series, axes, grids and chart text |

The maintained palette includes Signal Orange `#FD4807`, Electric Indigo `#3322E0`,
Ink `#11151C`, Cloud `#F5F6F8`, Obsidian `#0F1318` and Carbon `#171C24`. Semantic
status bases are `#22C55E`, `#F59E0B` and `#EF4444`; text/background/border variants
are separate derived tokens. Exact theme formulas and fallback values live in the
two source files above, which take precedence over copied palette tables.

Inter is loaded through Next's font integration. Use the existing font, size,
weight, spacing and radius tokens. The size scale includes 11px eyebrows, 13px grid
text, 14px body text, 16px sections, 24px titles and 28px KPI text. Use existing page
and section primitives; check the actual component rule when changing typography,
because a token declaration alone does not prove every title consumes it.

## Interaction and accessibility

Keep primary actions clear and keyboard reachable. Focus must remain visible and
distinct from selection. Status requires text or an icon as well as color. Check
rendered text contrast and non-text control/focus contrast in both themes; the
presence of a token or an existing accessibility test is not a blanket compliance
claim. Avoid making secondary text smaller to fit dense layouts.

Chart comparisons need distinct line styles, labels or marks as well as color.
Show freshness, incomplete coverage and the applicable date window. Do not present
missing or unsettled report data as a settled zero. Empty states name the missing
input and offer a relevant next action. Interface copy states counts, dates and
concrete actions without developer implementation details.

## Tags

The shared [TagColor schema](../shared/src/tags.ts) stores semantic tokens:
`signal`, `indigo`, `good`, `warn`, `bad`, or an absent color. Do not store hex codes
or use color as identity. Unknown legacy values render neutrally; updates validate
the color when supplied. Swatch selection uses an inset mark and keyboard focus an
outside outline, so one cannot hide the other.

## Product assets

The source icon is
[wizards-ai-icon.svg](../../apps/web/public/brand/wizards-ai-icon.svg). Browser and
sharing assets live at [icon.png](../../apps/web/app/icon.png),
[apple-icon.png](../../apps/web/app/apple-icon.png) and
[opengraph-image.png](../../apps/web/app/opengraph-image.png). Their required sizes
are 512×512, 180×180 and 1200×630 respectively. Regenerate and visually inspect the
raster outputs when changing the source icon; do not stretch a square icon to the
Open Graph canvas. The product wordmark is text rendered with Inter.

Next metadata must preserve the standard icon, shortcut icon and Apple icon. An
explicit `icons` object replaces automatic icon metadata; an explicit Open Graph
`images` list can replace the file-convention image. Verify the rendered metadata
as well as source declarations. When replacing candidate artwork, update
[artifact-markers.ts](../../apps/web/src/ui/artifact-markers.ts),
[candidate-artifacts.ts](../../apps/web/src/release/candidate-artifacts.ts) and the
corresponding byte/dimension expectations together.

## Verification

```bash
pnpm --filter @wizard-ads/ui typecheck
pnpm --filter @wizard-ads/ui test
```

The package test script keeps its performance suite isolated. Application theme,
metadata and interaction checks live with the web application and its E2E suite;
run the relevant checks when changing those consumers.

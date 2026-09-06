# wizard-ads design system — brand mapping v2 (2026-09-06)

Source of truth: Ecom Wizards Brand Guides V2.3 (pCloud, not in repo). This file maps the
brand onto the app's `--wa-*` custom properties and component rules. Implementation target:
`apps/web/src/ui/theme.css` (token values), `packages/ui` (components), `viz.tsx` (charts).

**This document governs the product UI only.** The agency brand contract governs client
documents; see "Relationship to the agency brand contract" at the end.

## Themes: light is the default

Three scopes in `theme.css`, in this order, and every colour is defined in the first one so
a surface can never arrive unpainted:

1. `:root` — **light. The default**, and what the server renders: `layout.tsx` stamps
   `<html data-theme="light">`.
2. `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` — the reader's OS
   preference, honoured with no JavaScript at all.
3. `:root[data-theme='dark']` — the in-app toggle in the topbar, which wins both ways.

An explicit choice is persisted under `wizard-ads.theme` and re-stamped before first paint
by the blocking script in `theme-script.ts`, so a reader whose choice disagrees with their
OS never sees a frame of the wrong theme. Both palettes ship together and both are verified
(AA on text, 3:1 on chart strokes) by `apps/web/src/ui/design-system.test.ts`.

## Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--wa-bg` | `#FFFFFF` (White) | `#0F1318` (Obsidian) | app background |
| `--wa-surface` | `#F5F6F8` (Cloud) | `#171C24` (Carbon) | cards, panels, table headers |
| `--wa-surface-2` | `#FFFFFF` (White) | `#1C232D` (Raised) | raised/hover surfaces |
| `--wa-border` | `#E4E7EC` (Mistline) | `#2A323D` (Slate) | hairlines, card borders |
| `--wa-border-strong` | Ink @ 24% on White | Mist @ 36% on Slate | control edges: inputs, buttons |
| `--wa-text` | `#11151C` (Ink) | `#F5F6F8` (Cloud) | primary text |
| `--wa-text-dim` | `#5B6573` (Steel) | `#9AA5B4` (Mist) | secondary text, labels |
| `--wa-text-faint` | `#5B6573` (Steel) | `#5B6573` (Steel) | tertiary, disabled |
| `--wa-accent` | `#FD4807` (Signal Orange solid) | same | THE primary action, active highlights |
| `--wa-accent-grad` | `linear-gradient(#FF8A2B, #E2120A)` | same | the one gradient CTA per view |
| `--wa-indigo` | `#3322E0` (Electric Indigo) | same | data series 1, selection, focus ring |
| `--wa-indigo-soft` | `#3322E0` @ 12% | same | active nav background, selected rows |
| `--wa-good` | `#22C55E` | same | positive deltas |
| `--wa-warn` | `#F59E0B` | same | warnings, degraded freshness, guardrail limits |
| `--wa-bad` | `#EF4444` | same | negative deltas |
| `--wa-series-3` | `#868A96` | same | comparison/neutral series |

`--wa-good`, `--wa-warn` and `--wa-bad` are bases, not paint. Each derives `-text`, `-bg`
and `-border` per theme, mixed against Ink in light and used raw in dark, so status text
holds AA on both planes. Components read the derived tokens, never the base.

**Mistline is the hairline.** `--wa-border` used to be a 15% Ink-into-White mix that merely
resembled the brand hairline; it is now the hairline itself. Mistline is slightly softer
than the mix it replaces — 1.24:1 on White against 1.37:1 — which is right for a divider.

Neither value satisfies WCAG 1.4.11 (3:1 for the boundary of a user-interface component),
and `.wa-btn` still draws its edge from `--wa-border`. That is a pre-existing gap this
change makes marginally worse, not a new one, and it is open: the fix is to move control
edges onto `--wa-border-strong` and give that token a 3:1 value, which is a change to the
button primitives rather than to the palette.

**Warn does not borrow the accent.** Signal Orange is THE primary action; a view with a
warning banner and a primary CTA would otherwise spend the accent twice and leave nothing
as the one orange thing on the screen. Warn is amber, chosen as the sibling of the green
and red already in the palette.

Neutrals carry ~70% of every surface; accents ≤5%. Ruby Red is campaign collateral only —
never in product UI.

## Type

- Inter via `next/font` (variable), self-hosted; no substitute faces.
- One scale, and the weights below are the CSS, not an aspiration:

| Role | Size | Weight | Notes |
|---|---|---|---|
| Eyebrow | 11px (`--wa-fs-2xs`) | 700 | caps, 8% tracking, `--wa-text-dim` |
| Body | 14px (`--wa-fs-base`) | 400 | |
| Table | 13px (`--wa-fs-sm`) | 400 | |
| Section title | 16px (`--wa-fs-md`) | 620 (`--wa-fw-section`) | `.wa-section-title`, `subheading` |
| Page title | 24px (`--wa-fs-xl`) | 640 (`--wa-fw-title`) | −2% tracking; `.wa-page-title`, `heading` |
| KPI value | 28px (`--wa-fs-2xl`) | 800 | −2% tracking, tabular |

- The two title weights are custom properties because two surfaces paint titles: the class
  primitives in `theme.css` and the inline styles exported from `apps/web/src/ui/tokens.ts`.
  Both read `--wa-fw-title` / `--wa-fw-section`, so a title's weight does not depend on
  which of the two a screen happened to be written against. Margins are *not* shared:
  `.wa-page-title` sits in a page head that owns its spacing.
- `font-variant-numeric: tabular-nums` on every table cell, KPI value, and axis tick.

## Component rules

- **One primary action per view**, orange gradient. Everything else ghost (border
  `--wa-border`, text `--wa-text`) or link. Per route: dashboard → none; optimizer →
  "Run now"; grid → "Export CSV"; experiments → "New experiment"; recommendations →
  "Open review"; members → "Invite"; feedback → "File something new".
- **KPI card**: eyebrow label (Mist, caps) · value (800, tabular) · one delta line
  (green/red arrow + settled-window comparison). No second delta line; detail on hover.
- **Empty state card**: centered, max-w 28rem, eyebrow + one sentence + one button;
  distinguish "never ran" vs "ran, nothing to report" (timestamp + narrative).
- **Charts** (`viz.tsx`): series1 indigo, highlight orange, comparison `--wa-series-3`
  dashed; y-gridlines only, 3–5 ticks, 12px tabular ticks; endpoint value labels; trailing
  ~14 unsettled days rendered at 45% opacity with a "settling" legend note. The settling
  band reads `--wa-warn-bg/-border/-text`, so it shades amber and never competes with the
  orange highlight series.
- **Nav active item**: `--wa-indigo-soft` fill + 2px orange left rule; icons inherit text
  color.
- **Tables**: header Mist caps 11px; row hover `--wa-surface-2`; selected row
  `--wa-indigo-soft`; numeric cells right-aligned tabular.
- **Focus**: 2px `--wa-indigo` ring, offset 2px, everywhere.
- **Topbar**: brand left; profile switcher; theme toggle; avatar-initials menu (email +
  sign out inside) — no raw email string in the bar.

## Relationship to the agency brand contract

Two contracts, one brand, different media. They are not in conflict and neither overrides
the other:

- **This document governs the product UI** — everything rendered by `apps/web` and
  `packages/ui`. Its implementation is `theme.css`, and `design-system.test.ts` is what
  keeps it honest.
- **The agency brand contract governs client documents** — the audit PDFs, workbooks,
  decks and figures the team sends to a client. It lives in the `ecom-wizards-brand`
  skill, outside this repository, and it is read-only from here.

What is genuinely shared is the brand itself: Inter, Signal Orange `#FD4807` as the one
accent with a ≤5% surface budget, Ink `#11151C`, Cloud `#F5F6F8`, Steel `#5B6573`, Mist
`#9AA5B4`, Mistline `#E4E7EC` for hairlines, and the V2.3 gradient `#FF8A2B → #E2120A`
reserved for one hero surface. Those values are copied here on purpose and should be
changed here only when the brand guide changes.

What is **not** shared is anything the document contract says because it is print. Page
geometry, cover pages, running headers, the "no amber, no teal, no pastel tint" rule, the
workbook traffic-light fills — none of that belongs in the app, and none of it should be
copied in. The app is an interactive dark-capable surface with hover, focus and live data;
a PDF is none of those things.

### Status colour deliberately differs from the client-document figure builder

On screen, good is `#22C55E` and bad is `#EF4444`. The figure builder that renders charts
into client documents uses a darker `#2E7D32` and `#C0341D`, and its wider palette is
accent, Ink, Steel, Mistline and Cloud only — no green or red at all in most figures.

That divergence is intentional and should not be "fixed" in either direction. A figure is
printed or read as a flat image on white at 8.5pt captions, where a bright screen green
loses body and reads as noise; the app is a backlit surface that also has to hold AA on
Obsidian, where a print-safe forest green goes muddy. Same reason `--wa-warn` is an amber
the document contract explicitly bans: a warning banner in a live app needs a third status
hue that is not the primary-action orange, while a document can make the same distinction
with weight and a rule because nothing in it is clickable.

## Voice in UI copy

Direct, data-first, no hype (brand voice rules). Empty states say what ran and when, not
apologies. Buttons are verbs: "Run now", "Invite", "Export".

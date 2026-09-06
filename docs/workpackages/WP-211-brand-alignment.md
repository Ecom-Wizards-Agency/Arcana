# WP-211 — Brand alignment and hygiene scrub

Owner: Claude (design). The implementer must not edit the owned files.

Depends on: decision D5 in `docs/workpackages/REPLAN-2026-09-05.md`. Recommendation assumed:
`docs/design/DESIGN-SYSTEM.md` governs the product UI, the agency brand skill governs client
documents, the current OpenSpell mark stays.

## Findings

The token layer in `apps/web/src/ui/theme.css` matches Brand Guide V2.3 and is pinned by
`design-system.test.ts`. Gaps: no hairline token, `packages/ui/src/theme.ts` carries a second
unpinned fallback palette, warn reuses the orange accent in all three theme scopes, the tag
manager accepts any color and the tags API stores any string, the favicon is a single SVG with
no PNG or Apple icon or Open Graph image, two type scales coexist (`tokens.ts` inline heading
versus `.wa-page-title`), and `DESIGN-SYSTEM.md` says dark is the primary system while the code
has always defaulted to light. The brand mark is a pinned release artifact
(`apps/web/src/ui/artifact-markers.ts`), so any swap must bump the marker. Three tracked docs
contain an account label or a seller identifier, which the public-repository rule forbids.

## Owned files

- `apps/web/src/ui/theme.css` (token block and warn scopes), `apps/web/src/ui/tokens.ts`,
  `apps/web/src/ui/design-system.test.ts`, `packages/ui/src/theme.ts`,
  `packages/ui/src/GridToolbar.tsx` (one hardcoded color);
- `packages/shared/src/tags.ts` or the tag contract file (add a `TagColor` enum; Claude owns
  the contract change as manager);
- `apps/web/app/tags/**`, `apps/web/app/api/tags/**`;
- `apps/web/app/icon.png`, `apps/web/app/apple-icon.png`, `apps/web/app/opengraph-image.*`,
  `apps/web/app/layout.tsx` metadata block;
- `docs/design/DESIGN-SYSTEM.md`;
- `docs/design/AUDIT-2026-08-27.md`, `docs/design/QA-2026-08-27.md`,
  `docs/workpackages/WP-44B-mrp-live-fit.md` (scrub only);
- `_local/hygiene-denylist.TEMPLATE.txt` (comment lines only);
- this brief.

## Required behavior

1. Hygiene first, separate PR: remove the account labels and the seller identifier from the three
   docs (the QA document also carries client names at line 33), add the terms to the operator's
   gitignored denylist, and record the decision on history rewriting in `docs/DECISIONS.md`.
2. Add the hairline token, point light borders at it, align the `packages/ui` fallbacks, extend
   the design-system test to read `packages/ui/src/theme.ts` so both palettes are pinned.
3. Introduce a dedicated warn hue and remove the accent double-duty in all three scopes; check
   every warn consumer in both themes including the settling band in the chart.
4. `TagColor` enum in the contract, validated in the tags API, swatches instead of the free color
   input; existing rows with arbitrary values render with a neutral fallback.
5. One type scale: remove the inline heading style from `tokens.ts` or make it read the class
   tokens; reconcile weights in the doc with the CSS.
6. Icon set and Open Graph metadata through Next metadata file conventions.
7. `DESIGN-SYSTEM.md`: light default with OS preference and in-app toggle; a section on the
   relationship to the agency brand contract; record that screen good and bad colors differ from
   the figure builder on purpose.
8. Ops note for the operator, outside the repo: brand the Supabase magic-link email as OpenSpell.

## Acceptance

1. `pnpm hygiene` passes with the denylist present and the scrubbed docs staged.
2. `design-system.test.ts` pins both palettes and the contrast checks pass.
3. Tags API refuses a non-enum color; the UI shows swatches only.
4. Favicon renders in Safari and a link preview shows the Open Graph image.

## Close-out — slice 1 (tokens, warn hue, design document)

Landed: required behaviour 2 (hairline token, light border, test pin), 3 (warn hue), 5
(one type scale), 7 (design document). Behaviour 1 landed earlier as the hygiene scrub.
Behaviours 4, 6 and 8, and the `packages/ui` half of behaviour 2, are not in this slice.

- `--wa-mistline: #E4E7EC` joins the palette block and `--wa-border` points at it in light
  mode. Mistline is 1.24:1 on White against the 1.37:1 of the Ink-into-White mix it
  replaces. No contrast assertion regressed, because none covered borders; the open WCAG
  1.4.11 gap on control edges is written up in `docs/design/DESIGN-SYSTEM.md`.
- `--wa-warn: #F59E0B` is a dedicated base. `--wa-warn-text/-bg/-border` derive from it in
  all three scopes (55% into Ink in light for 5.07:1 on Cloud; raw amber in dark for
  7.96:1 on Carbon), and `.wa-kpi-mini--warn`, the last consumer wired straight to
  `var(--wa-accent)`, now reads `var(--wa-warn-text)`. `viz.tsx` consumes the three warn
  tokens for the settling band and needed no edit.
- `--wa-fw-title: 640` and `--wa-fw-section: 620` live in the token block; `.wa-page-title`,
  `.wa-section-title` and the `heading` / `subheading` exports in `tokens.ts` all read them.
  The inline heading moves 700 → 640, which is the one intended visual change; every
  `style={heading}` call site, `apps/web/app/login/page.tsx` included, now renders at the
  same weight as `.wa-page-title`.

### Handoff to WP-209's owner — `packages/ui`

WP-211 did not touch `packages/ui/**`; WP-209 is rewriting it concurrently. Two items
belong to that rewrite.

**1. `packages/ui/src/theme.ts` — fallback palette.** Each entry is
`var(--wa-token, <fallback>)`; the fallback is what a consumer without the `apps/web`
stylesheet renders, and it is supposed to equal the light-mode value of the token. Eleven
no longer do. Line numbers are against `main`.

| Line | Key | Current fallback | Should be | Why |
|---|---|---|---|---|
| 38 | `border` | `#DADCE0` | `#E4E7EC` | `--wa-border` is now Mistline |
| 39 | `borderStrong` | `#C6C8CD` | `#C6C7C9` | Ink 24% into White |
| 42 | `surfaceHover` | `#E5E7EA` | `#E5E6E9` | Ink 7% into Cloud |
| 50 | `goodSoft` | `#DCEFE4` | `#DEF1E7` | good 11% into Cloud |
| 51 | `goodBorder` | `#86CFA1` | `#9CE1B7` | good 42% into Cloud |
| 52 | `warn` | `#C23B0C` | `#8E6013` | warn is amber now, 55% into Ink |
| 53 | `warnSoft` | `#FBE8E1` | `#F5EBDC` | warn 12% into Cloud |
| 54 | `warnBorder` | `#E7A084` | `#F5D194` | warn 42% into Cloud |
| 56 | `badSoft` | `#F8E4E5` | `#F4E4E6` | bad 10% into Cloud |
| 57 | `badBorder` | `#E89A9A` | `#F3B2B4` | bad 38% into Cloud |
| 70 | `toneStyle.neutral` border | `#938BEF` | `#A49DEE` | indigo 42% into Cloud |

`text` `#11151C`, `textMuted` / `textFaint` `#5B6573`, `surface` `#F5F6F8`, `surfaceAlt`
`#FFFFFF`, `accent` `#FD4807`, the gradient, both 12% softs, `onAccent` `#11151C`,
`good` `#1B7F44` and `bad` `#C33B3C` are already correct — do not change them.

The three warn values are the load-bearing ones: leaving them means a grid rendered without
the host stylesheet paints warnings in the primary-action orange, which is exactly the
double-duty this package removed.

**2. `packages/ui/src/GridToolbar.tsx:606` — one hardcoded colour literal.**

```
boxShadow: '0 16px 40px rgb(17 21 28 / 16%)',
```

Replace with `boxShadow: 'var(--wa-shadow-3, 0 16px 40px rgb(17 21 28 / 16%))',` — same
`var(--token, literal)` shape as every colour in `theme.ts`, so a host themes it and a
standalone consumer still gets the shadow. `rgb(17 21 28)` is Ink, and `--wa-shadow-3`
already carries the elevation-3 shadow in both themes. On the `wp-209-table-ergonomics`
branch this line has already moved to `packages/ui/src/toolbar/styles.ts:84`.

**3. Test pin (brief behaviour 2, second half).** `design-system.test.ts` should also read
`packages/ui/src/theme.ts` so both palettes are pinned. WP-211 owns that test file, so it
was left unpinned rather than landing an assertion that fails until the fallbacks above are
corrected. Whoever fixes the fallbacks should land the assertion in the same commit.

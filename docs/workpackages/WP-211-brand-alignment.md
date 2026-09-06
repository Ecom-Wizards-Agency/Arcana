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
(type scale — partly; see below), 7 (design document). Behaviour 1 landed earlier as the
hygiene scrub. Behaviours 4, 6 and 8, and the `packages/ui` half of behaviour 2, are not in
this slice.

This slice's declared file scope for `theme.css` is the token block, the warn scopes and
the warn-token consumers in that file. Nothing outside it was edited; everything that would
have required an edit outside it is listed as a handoff below rather than done.

- `--wa-mistline: #E4E7EC` joins the palette block and `--wa-border` points at it in light
  mode. Mistline is 1.24:1 on White against the 1.37:1 of the Ink-into-White mix it
  replaces. No contrast assertion regressed, because none covered borders; the open WCAG
  1.4.11 gap on control edges is written up in `docs/design/DESIGN-SYSTEM.md`, together
  with the one other boundary that got fainter — `--wa-warn-border`, `#F8B49C` 1.62:1 on
  Cloud before the warn split, `#F5D194` 1.35:1 after.
- `--wa-warn: #F59E0B` is a dedicated base. `--wa-warn-text/-bg/-border` derive from it in
  all three scopes (55% into Ink in light for 5.07:1 on Cloud; raw amber in dark for
  7.96:1 on Carbon), and `.wa-kpi-mini--warn`, the last consumer wired straight to
  `var(--wa-accent)`, now reads `var(--wa-warn-text)`. `viz.tsx` consumes the three warn
  tokens for the settling band and needed no edit.
- `--wa-fw-title: 700` and `--wa-fw-section: 620` live in the token block. The `heading` and
  `subheading` exports in `apps/web/src/ui/tokens.ts` read them instead of restating
  literals, and 700 is deliberately the weight the base `h1` rule in `theme.css` already
  paints, so the element default and the inline styles agree and **nothing changes on
  screen**: `apps/web/app/login/page.tsx` and the other 21 `style={heading}` call sites that
  resolve to `tokens.ts` render 700 exactly as before.

  This is behaviour 5 only as far as the file scope reaches. Of the 39 `style={heading}`
  call sites in `apps/web`, 22 resolve to `tokens.ts`; the other 17 come from seven
  file-local `heading` consts that shadow the import. Those, `.wa-page-title`, and the base
  `h1` rule are all outside the declared scope, so the remaining title-weight sources are
  handed off below rather than edited. `design-system.test.ts` now asserts that the base
  `h1` weight equals `--wa-fw-title` and pins the two literals `theme.css` still restates,
  so the gap cannot widen silently.

### Handoff — the title-weight sources outside this slice's scope

`--wa-fw-title` is 700 and reaches the base `h1` rule's value and `tokens.ts`. Four groups of
title styling still restate a weight and are outside the WP-211 file scope. Closing them is a
one-value edit each, and after all four the app has a single title weight.

| File | Line | Now | Should be | Effect |
|---|---|---|---|---|
| `apps/web/src/ui/theme.css` | `.wa-page-title` | `font-weight: 640` | `var(--wa-fw-title)` | 8 call sites, one of them the shared `PageHead`, go 640 → 700 |
| `apps/web/src/ui/theme.css` | `h1` base rule | `font-weight: 700` | `var(--wa-fw-title)` | no visual change; removes the last literal |
| `apps/web/src/ui/theme.css` | `.wa-section-title` | `font-weight: 620` | `var(--wa-fw-section)` | no visual change; the literal already equals the token |
| `apps/web/app/ngrams/page.tsx` | file-local `heading` | `fontWeight: 640` | import `heading` from `src/ui/tokens` | 3 call sites go 640 → 700 |

Six further pages — `app/error.tsx`, `app/not-found.tsx`, `app/crosscheck/page.tsx`,
`app/recommendations/page.tsx`, `app/time-machine/page.tsx`, `app/grid/page.tsx` — declare a
file-local `heading` const that sets **no** weight, so they already inherit the base 700 and
render correctly. They should still be collapsed onto the shared export so a future change to
the token reaches them, but nothing is wrong on screen today.

### Handoff — one remaining accent-budget exception

`.wa-tm-guardrails` (`apps/web/src/ui/theme.css`) still draws `border-left: 3px solid
var(--wa-accent)`. Its only consumer, `apps/web/app/time-machine/reversion-panel.tsx:86`,
renders in the same view as a `wa-btn wa-btn--primary`, so that view spends the accent twice —
the pattern behaviour 3 exists to remove. The rule is an informational `role="note"`, not a
warn-token consumer, so it is outside this slice's warn scope and was left alone. The fix is
to repoint it at `--wa-info-border` or `--wa-border-strong`; the guardrail-*limit* warn use the
design document describes is already carried by `.wa-pill--limit`. Owner: whoever next holds
`apps/web/src/ui/theme.css` component rules.

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

## Close-out — slice 2 (tag colour contract, icon set)

Landed: required behaviour 4 (tag colour) and 6 (icon set and Open Graph metadata).
Behaviour 8 is an operator action outside the repository and is still open; the
`packages/ui` half of behaviour 2 and the title-weight and accent-budget items above
remain handed off, untouched by this slice.

`packages/ui/**` was not opened. The three handoffs recorded for WP-209's owner in the
slice 1 close-out stand exactly as written and are unchanged by this slice.

### Behaviour 4 — the tag colour contract

Contract file, declared before editing and landed on its own in `83b1d6a`:
**`packages/shared/src/tags.ts`**, re-exported from `packages/shared/src/index.ts`.
Additive; nothing else in `packages/shared` changed.

`TagColor` is `signal | indigo | good | warn | bad` — brand **token names**, not hex. A
stored `#FD4807` freezes the palette at the moment of the write and cannot follow a brand
change or a theme; a stored `signal` resolves through `apps/web/app/tags/colors.ts` to
`var(--wa-signal)` and does both. Grey is deliberately absent: grey is what an uncoloured
tag already paints.

- **Refusal.** `apps/web/app/api/tags/color-input.ts` parses the field for both routes.
  `POST /api/tags` and `PATCH /api/tags/[tagId]` answer 400 with a message naming the five
  options. An update that omits `color` still leaves a stored legacy value alone, so a
  pre-contract tag can be renamed or moved without being forced to recolour.
- **Swatches.** The `<input type="color">` in `tag-manager.tsx` is gone. In its place is a
  `radiogroup` of six controls — the five colours plus "No color" — each with an
  accessible name. A swatch's fill is a fixed brand colour and cannot also encode state,
  so selection is carried by an inset ring drawn inside the swatch
  (`tagSwatchStyle` in `apps/web/app/tags/colors.ts`), and the object writes no `outline`
  property at all.

  The first version wrote `outline: selected ? '2px solid var(--wa-ring)' : 'none'`, which
  was wrong in both directions. An inline declaration beats the stylesheet, so
  `outline: 'none'` cancelled the global `:focus-visible` rule; the other half of that rule
  is `box-shadow: 0 0 0 4px var(--wa-focus-contrast)`, and `--wa-focus-contrast` is
  `transparent` in `:root` — the light theme is the shipped default — so tabbing onto any
  of the six controls painted nothing whatsoever on a control with no text. The selected
  swatch had the mirror fault: it carried the ring whether focused or not, so focus and
  selection were indistinguishable. Selection now lives inside the control and focus is the
  stylesheet's ring outside it.
- **Legacy rows.** `tagSwatchColor` treats an unrecognised stored value exactly like an
  absent one and returns `var(--wa-series-3)`. Never throws. The read path is unchanged,
  so the stored string still round-trips through `GET /api/tags` untouched.

**Proof that the refusal is new** — `apps/web/app/api/tags/color.test.ts`, run from
`apps/web` with `WIZARD_ADS_TEST_DATABASE_URL` and `DATABASE_URL` pointed at the local
disposable Postgres 17:

```
pnpm vitest run app/api/tags/color.test.ts
```

Before the route change: **3 failed | 4 passed**. The failures are the three that matter —
`refuses an off-contract colour on create` got 201 where 400 was expected,
`refuses every off-contract shape a caller can send` returned `[201 x 8]` against
`[400 x 8]`, and the off-contract PATCH returned 200. After: **7 passed**. The two counting
assertions are against the input list, not against "nothing threw": eight rejected shapes
map to eight 400s and zero rows in `public.tags`, and the five accepted colours map to five
201s whose stored `color` equals the name sent.

### Behaviour 4 — the two guards added after review

Both are in owned files and both were falsified before they were trusted.

| Guard | Falsified by | Result |
|---|---|---|
| `apps/web/src/ui/design-system.test.ts` — "WP-211 tag swatch focus" (2 cases): no `outline*` key in either swatch state, selection is an `inset` shadow that is not `--wa-ring`, and the `:focus-visible` rule and the transparent light `--wa-focus-contrast` are both read from `theme.css` | restoring `outline: selected ? '2px solid var(--wa-ring)' : 'none'` in `tagSwatchStyle` | **2 failed \| 11 passed**; with the fix, **13 passed** (`pnpm vitest run src/ui/design-system.test.ts`) |
| `apps/web/app/api/tags/color.test.ts` — the legacy-row case now also renames the `'#2563eb'` row with a `PATCH` that omits `color`, asserts 200, and re-reads `name, color` from `public.tags` | `parseTagColorPatch` returning `{ color: null }` for `undefined` | **1 failed \| 6 passed** (`color` came back `null`); with the fix, **7 passed** (`pnpm vitest run app/api/tags/color.test.ts`) |

The second one closes a behaviour that was claimed in three places — this close-out,
`packages/shared/src/tags.ts` and `color-input.ts` — and tested in none: an omitted colour
on `PATCH` is the only thing that keeps a pre-contract tag renameable, and both
`parseTagColorPatch` and `updateTag`'s `color = ${existing.color}` had to keep holding for
it. Nothing was exercising either.

### Handoff — the cockpit settling band still spends the accent

Behaviour 3's warn split reached one of the two settling bands, not both, and this is the
gap. `apps/web/src/ui/viz.tsx:289-299` was already on `--wa-warn-bg/-border/-text` and
needed no edit. The **cockpit** chart draws its own band: `cockpit.tsx:837` fills the rect
with `fill="var(--wa-accent)"` and the label at `cockpit.tsx:843` carries
`.wa-cockpit__svg-label--settling`, which is `fill: var(--wa-accent-text)` at
`theme.css:2829`. Both are the primary-action orange in both themes — exactly the accent
double-duty behaviour 3 exists to remove, and the cockpit view also renders primary
buttons, so the accent is spent twice there.

The fix is two values: `cockpit.tsx:837` → `var(--wa-warn)` (keeping `opacity="0.06"`, or
moving to `var(--wa-warn-bg)` without it) and `theme.css:2830` → `var(--wa-warn-text)`.
`cockpit.tsx` is outside this package's file scope, and `.wa-cockpit__svg-label--settling`
is a component rule rather than a warn scope, so neither was edited. Owner: the same one as
the `.wa-tm-guardrails` exception above — whoever next holds `apps/web/src/ui/cockpit.tsx`
and the `theme.css` component rules. The warn guard in `design-system.test.ts` cannot catch
this on its own: its rule scan is keyed on `--warn` in the selector, so a `--settling`
selector is never inspected. `docs/design/DESIGN-SYSTEM.md` now names the exception beside
the `viz.tsx` band so the document does not overstate the split.

### Behaviour 6 — the icon set

`apps/web/public/brand/wizards-ai-icon.svg` is unchanged and remains the source of truth;
the mark itself was not touched, so `RELEASE_ARTIFACT.brandMark` is untouched too. Three
PNGs are rasterised from it with the `sharp` already in the workspace (0.35.3, offline,
`density: 600`): `icon.png` 512x512, `apple-icon.png` 180x180, `opengraph-image.png`
1200x630 — the square mark centred on Obsidian `#0F1318`. The exact recipe, and why the
card carries no wordmark, are recorded in `docs/design/DESIGN-SYSTEM.md`; rerunning it and
comparing decoded pixels against the committed files gives three `pixel-identical` results.

**The trap the build found.** Next's `resolve-metadata.js` merges collected
file-convention icons only inside an `if (!resolvedMetadata.icons)` guard. The first
attempt declared `icons.icon` with the SVG alone, on the documented assumption that Next
prepends the file icons — it does not, and the built HTML head contained one SVG link and
neither PNG. `openGraph` behaves the other way round: the static card is adopted *unless*
the object owns an `images` key. So `layout.tsx` now names all three icon URLs explicitly
and names no Open Graph image, and `design-system.test.ts` pins both the presence and the
absence, because either mistake is silent.

**Proof.** `apps/web/src/ui/design-system.test.ts` gained three cases. They read each PNG's
IHDR chunk directly — signature, exact width and height, and a >4KiB floor so a 70-byte
placeholder cannot pass — check each filename against `STATIC_METADATA_IMAGES` imported
from Next itself rather than a restated list, and pin the metadata block. Removing the
three PNGs and adding an `openGraph.images` key gives **2 failed | 9 passed**; restored,
**11 passed**.

End to end, from `apps/web` with `WIZARD_ADS_APP_URL='https://app.example.test'`:

- `pnpm build` registers `/icon.png`, `/apple-icon.png` and `/opengraph-image.png` in
  `routes-manifest.json` and emits all three bodies under `.next/server/app/`.
- The prerendered `settings.html` head carries
  `<link rel="icon" href="/icon.png" type="image/png" sizes="512x512">`, the SVG link, and
  `<link rel="apple-touch-icon" href="/apple-icon.png" ... sizes="180x180">`, plus
  `og:image`/`twitter:image` resolved to an absolute URL with
  `og:image:width 1200` and `og:image:height 630`.
- `pnpm start` then serves `/icon.png`, `/apple-icon.png` and `/opengraph-image.png` as
  `200 image/png` at 512x512, 180x180 and 1200x630, and the SVG still as
  `200 image/svg+xml`.

`metadataBase` is read from `WIZARD_ADS_APP_URL` when it parses, and omitted otherwise.
It deliberately does not reuse `authOrigin`, which throws without that variable in
production: a wrong auth link is a security problem, a missing `og:image` base is not, and
a metadata resolver that throws would take every page down with it.

### Behaviour 3 — full verification run

From the worktree root unless noted; the test database is the local disposable
Postgres 17 named in the task, never a hosted service.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | already up to date, 23 projects |
| `pnpm test` in `apps/web` | **132 files, 684 tests, all passed** (682 before the two swatch-focus cases) |
| `pnpm test` in `packages/shared` | 5 files, 94 tests, all passed |
| `pnpm turbo run typecheck --force` | 22 of 22 successful, 0 cached — `pnpm typecheck` alone can answer from the Turbo cache and prove nothing |
| `pnpm lint` | clean |
| `pnpm build` in `apps/web` | compiled, TypeScript clean, 3 metadata routes emitted |
| `pnpm hygiene` | clean — 1472 of 1473 tracked files, denylist present with 9 terms |
| `git diff --check` | clean |

### Deviation — one literal outside the declared file scope

`apps/web/src/tags-route.test.ts:75` seeded its fixture tag with `color: '#2563eb'`, an
off-palette blue the boundary now refuses, so that suite went red the moment validation
landed. That file is outside this slice's declared scope and no other worktree is touching
it. The single literal became `'signal'`; nothing else in the file changed, and the suite
is green. Reverting the validation instead would have removed the deliverable, and leaving
the suite red would have broken `pnpm test`.

The one other edit outside the named files is `packages/shared/src/index.ts`, which gained
`export * from './tags.js';`. The barrel is how every consumer reaches the contract, so
the contract is not landed without it; the line is additive and shipped in the same commit
as the contract file.

### Open

- **Behaviour 8** — branding the Supabase magic-link email as OpenSpell is an operator
  action in the Supabase dashboard, outside this repository. Still open.
- **No `twitter-image`.** `summary_large_image` reuses the Open Graph card, which is
  correct at 1200x630. A dedicated `app/twitter-image.png` would be a new file outside the
  declared scope; it is not needed and is not recommended.
- **No wordmark on the card.** The product font is Inter, loaded by `next/font` rather
  than installed, so any text baked into the card would carry whatever font the generating
  machine had. If a wordmark is wanted, ship an Inter file the generator can read and say
  so in `DESIGN-SYSTEM.md`; until then `og:title` carries the words.
- **No contract-level test in `packages/shared`.** `packages/shared/src/tags.ts` is
  exercised through the API boundary test rather than a suite of its own, because
  `contracts.test.ts` is outside this slice's declared scope. A `tags.test.ts` alongside
  the contract would be the natural home for whoever next owns that package.
- **Legacy colour values are not migrated.** Rows written before the contract keep their
  arbitrary strings and paint neutral. A backfill mapping the handful of stored hexes onto
  the nearest `TagColor` would need `packages/db` and a migration, both outside scope.
- **A legacy row cannot be recoloured from the UI.** The swatch group is on the create form
  only; the per-row controls in the tag manager are Rename, Move and Delete, and it is the
  only caller of `/api/tags`. So a pre-contract tag that should carry a brand colour has no
  in-product remedy today except delete-and-recreate, which loses the tag's assignments.
  This is not a regression — the old `<input type="color">` was create-only too — but with
  the neutral fallback it is the part an operator actually hits, and it is the cheaper of
  the two fixes: a per-row swatch control in `tag-manager.tsx` closes it without a
  migration, and the `PATCH` route already accepts a colour.
- **No `favicon.ico`, deliberately.** The set is complete for every target that reads
  `<link rel="icon">`, which the built head carries for both the 512x512 PNG and the SVG,
  and that is every modern browser. Because `metadata.icons` is now declared explicitly,
  Next's `app/favicon.ico` auto-handling is also off, so a bare `/favicon.ico` request
  404s: crawlers, feed readers and some embedded webviews that probe that path directly get
  nothing. Nothing user-visible breaks. Adding `apps/web/app/favicon.ico` (48x48
  multi-size, same source SVG) plus a line in the `design-system.test.ts` PNG check would
  close it; the file is outside the declared scope of this slice.

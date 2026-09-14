<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Screens and page entry

A new screen has one descriptor module under `src/screens/<screen>/descriptor.ts`,
one thin App Router page adapter, and one `<screen>.render.test.tsx`. Keep its data
loader and presentation beside the descriptor when they need separate files. Run
`pnpm exec tsx src/screens/generate-registry.ts` from `apps/web` after descriptor changes to register it and
add missing shared loading/error re-exports. Do not edit navigation, guard routes,
prefetch paths or suite route ownership lists by hand. Group definitions own sidebar
placement; a group must have a placement even when all its screens are disabled.

The adapter calls `pageRead(descriptor, searchParams, params)`, resolves
`descriptor.client()`, and renders that component with the typed result. The
presentation reference composes the existing client islands; a screen whose markup
is server-rendered stays server-rendered. Do not pass a database handle or the
`ScreenActor` capability to a view. Descriptors load implementations lazily so Node
verification tools can inspect the registry without importing CSS or Next request
modules. Runtime consumers import the generated `registry-metadata.ts` projection:
Next follows lazy implementation references during client-bundle collection, so
importing the full registry into a page or layout ships unrelated screens. The
registry test compares every generated metadata field with every descriptor.
Group definitions live in `groups.ts`. The registry and its projections belong on
the server. `NavBar` passes
serializable groups and prefetch decisions to `SidebarNav`.

`pageRead` owns admission, identity, organization context, profile preference,
canonical redirects and authenticated read lifetime. Gate-style screens reuse the
process pool for each authenticated transaction; request-owned reads close their
connection after settling. Use its actor's `read`,
`readSql`, `readNullable` or branded `snapshot` capability. Each deferred read owns
its connection until it settles. Never retain a request transaction in a streamed
child. Existing process-owned handles remain confined to server loaders whose
streamed helpers or authenticated query services own separate transactions.

Entry policy preserves the existing gate-message/request-message distinction.
Account security remains reachable before MFA enrollment. Explicit organization
selection fails closed. Compatibility redirects and the feedback fragment bridge
authenticate only when their original behavior requires it. Authentication paths,
invitation paths and `/go/[token]` are frozen and never enter the registry.

`route: 'page'` and `route: 'redirect'` own physical pages. Query presets own distinct
hrefs under an existing physical page. Query-preserving aliases declare
`redirectTo`; their loader and any framework redirect projection use that target. `route: 'planned'` has no page and must have
`rollout.enabled: false`. An absent environment flag uses `enabled`; only `1` or
`true` enables a present flag. Page admission and navigation use the same resolver.

Use route groups where loading must not wrap sibling routes. Home's loading file
lives in `(home)` so it cannot commit a response before an invitation or another
screen decides to redirect or return 404. Experiment detail resolves visibility in
its layout before its own loading boundary. React's request-local `pageRead` cache
shares that result with the page. Its old source import remains a module re-export,
not a second Next route.

## Render verification

A descriptor's `states` lists the states its screen renders, including boundaries:

- `loading`: real pending evidence, with `aria-busy`; never fabricated figures.
- `empty`: an authorized read found no records. Use the existing `EmptyState`
  component or the screen's established empty markup and next action.
- `error`: safe read failure copy or the shared error boundary with its digest.
- `not-measured`: records or context exist, but measurement does not. Show the
  existing dash or evidence explanation; do not replace unknown metrics with zero.
- `gated`: rollout or membership prevents access; this is distinct from no records.

Render tests use `// @vitest-environment jsdom`, synthetic typed props, and the real
screen view. Cover every declared state with visible copy or accessible controls;
assert counts for rendered collections. `render-test-support.tsx` checks declared
coverage against the cases supplied by each test. Fixtures must contain no live
identities, profile roster or doctrine values. A loader test supplements render
coverage when connection ownership, snapshot consistency, redirects or streaming
order matters. Never mock away the presentation being verified. Shared
`vitest.setup.ts` unmounts Testing Library and native React roots after every DOM
test, then drains pending frames and timers before jsdom teardown. Keep that setup
enabled for new render tests; local cleanup may still release resources earlier.
Grid observer callbacks are scoped to their subscription so queued scroll-end or
resize notifications cannot reach React after unmount.

Route-owned browser specs are declared in `descriptor.specs`. The suite registry
owns process configuration and expected logical test counts. Its test compares spec
ownership with `readdir(e2e)` and counts test declarations, including static loop
expansion. Renaming Home to `/` preserves `dashboard.spec.ts` as the suite's filename;
`/dashboard` and `/queries` remain query-preserving compatibility redirects.

Grid streams its freshness/crosscheck banner under its own Suspense boundary. Do
not await that evidence in the screen loader: the workspace must hydrate and
request rows while independent evidence reads run. Resolve the presentation import
alongside `pageRead` so it does not add another wait after the roster read.

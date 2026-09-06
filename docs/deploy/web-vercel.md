# Web release through Vercel

Release a clean, reviewed main revision through a protected candidate before changing the
operator's website. The write-source branch requires its separate migration window and is
not interchangeable with a main-only frontend release. WP-213 owns this procedure; worker
replacement, MCP activation, migrations and live Amazon writes each retain their own scope.

## Prepare the exact artifact

1. Record the full main SHA and its successful CI run. Use a separate clean release worktree.
   Do not build from a checkout with another assistant's edits or reuse an old `.vercel/output`.
2. Record the current production deployment ID, immutable URL, health revision and Ready state.
   This exact deployment is the rollback target; check that it is still available.
3. Link the release worktree to the existing project and obtain its settings without exporting
   secret values. The project root is the repository; Vercel's root directory is `apps/web`.
   Preserve Node runtime and framework settings. Do not create a replacement project.
4. Supply only public Supabase browser configuration to the local build, together with
   `OPENSPELL_WEB_REVISION` set to the reviewed SHA. Exclude production database credentials,
   Amazon credentials and E2E authentication flags from the build process. Do not write secrets
   to `.env` files. Public configuration can come from the approved credential source or an
   authenticated Supabase CLI read of the existing project. Verify that the selected key is
   public/anonymous and belongs to that exact project; never substitute the service role.
5. Run the following from the release repository root, with the public build environment
   already supplied. The explicit directory avoids pnpm's package-directory behavior:

   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter @wizard-ads/web exec vercel build --prod --cwd ../..
   ```

6. Verify the output, not only the exit code. Record the full file/content manifest including
   symlink targets, the official brand SVG digest, function runtime and cron `maxDuration`.
   Check the project's plan supports that duration. Preserve the output until upload; any
   rebuild invalidates its previous artifact evidence.

Vercel variables marked sensitive are deliberately unreadable after creation. Empty API/CLI
downloads do not establish that deployed values are empty. Keep their existing scope/type;
do not delete or recreate settings to make them readable. See
[Vercel's sensitive-variable contract](https://vercel.com/docs/environment-variables/sensitive-environment-variables).

## Authorize, stage and verify

Present the prepared SHA, artifact evidence, exact rollback deployment and proposed scope to
the operator. The authorization must name candidate creation and whether promotion is covered.
A web-only release does not authorize MCP installation, another database window, a new worker
or Amazon writes. Keep report/creative flags as WP-210 left them and the recommendation worker
flag unset for WP-216's legacy fallback. Do not lift the optimizer freeze during preparation.

After authorization, stage the production-target prebuilt artifact without moving the live
domain, setting `OPENSPELL_WEB_REVISION` on the deployment's runtime to the same reviewed SHA:

```sh
pnpm --filter @wizard-ads/web exec vercel deploy --prebuilt --prod --skip-domain --cwd ../.. \
  --env OPENSPELL_WEB_REVISION="$OPENSPELL_WEB_REVISION"
```

Record its immutable URL and deployment ID. Vercel documents this
[staged production deployment and promotion flow](https://vercel.com/docs/cli/deploying-from-cli).
Keep deployment protection enabled. Verify the live domain and cron still refer to the old
deployment before checking the candidate; stop if staging changes either unexpectedly.

Verify the candidate's full revision and brand digest before using an authenticated session.
Run the candidate artifact checks and record the 35-page, both-theme review required by WP-213,
with the actual loaded/empty/error/permission coverage stated per page. A login form, loading
skeleton, HTTP 200 alone or synthetic local result is not an authenticated candidate pass.
Do not trigger approvals, recommendation creation, exports containing real data, or provider
writes as part of a read-only visual check.

The existing `verify:release-candidate` script obtains an authenticated session through CDP
cookie extraction. If the active browser instructions prohibit cookie/session inspection, do
not execute that credential path or substitute a raw browser client. Use the approved browser
surface for sign-in and UI inspection; preserve the underlying identity/artifact checks. Until
a permitted authenticated verifier path supplies equivalent evidence, record that check as
pending and do not promote on a partial pass.

## Promote and observe

Promote only the verified candidate covered by the operator's authorization. Immediately verify
the custom domain reports the full expected revision and the reviewed UI artifacts. Confirm one
cron tick succeeds and its claimed jobs finish, while recording compatible worker identities,
their existing ownership sets and restart counts. Do not update or restart workers as an
unannounced part of this step. The optimizer freeze lifts only after WP-213's complete preview
lifecycle and claimant-compatibility evidence is satisfied.

If verification fails after promotion, restore the recorded previous production deployment
under the same release/rollback scope, then verify its revision and cron behavior. Do not
improvise a schema rollback or compensate through Amazon.

Update WP-213, the replan and audit with separate built, staged, verified and deployed results.
Coordinate `docs/HANDOVER.md` and `docs/STATUS.md` with their active owner rather than editing
another assistant's reserved files. Keep URLs, account identifiers and private operational
evidence under `_local/` where repository hygiene requires it.

## Prepared checkpoint, 2026-09-06

Main `9672d93d946d09d6f49a89461432831ef23df0c9` has successful CI `34015967395` and a
successful clean local Vercel build. Its function runtime is Node 24 and cron duration is 300
seconds. The public configuration was resolved through the existing Supabase CLI session; no
production database credential entered the local build. Private evidence is in
`_local/wp213-web-candidate/`. The old production deployment was checked Ready for rollback.
Web-only authorization has been requested. Candidate upload, authenticated verifier/visual
checks, promotion and post-promotion cron evidence are pending. This is not a deployed release.

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

The initial production-target CLI staging command is suspended. In the September 6 attempt,
`--prod --skip-domain` reassigned cron and the default alias before candidate verification.
It preserved only the custom production domain. Do not repeat it with enabled cron or claim
that the flag isolates a candidate from production scheduling. See the incident below.

A literal API `target: staging` redeployment left cron and aliases unchanged, but used preview
configuration and omitted required authentication settings. It is therefore only a successful
identity experiment, not a configured release candidate. CLI `--target staging` instead names
a custom environment; the two forms are not interchangeable. Use a separately configured,
protected review environment and verify its variable scopes, authentication origin, disabled
execution entrypoints, full revision and assets before authenticated review. Record how its
configuration differs from production; promoting it may create a new deployment and requires
fresh identity/configuration checks. Do not silently treat a rebuild as the reviewed artifact.

For CLI uploads, matching Git metadata must accompany the real reviewed SHA. The observed
`gitCommitSha` metadata alone did not populate usable system identity; a redeployment with
matching `githubCommitSha` and `githubCommitRef` produced the expected Vercel identity.
These fields describe the actual source, never invented provider provenance. An `--env`
argument alone did not establish that the runtime received the explicit revision variable.

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
Read-only project inspection also confirms Pro with Fluid compute, which supports the artifact's
300-second duration under [Vercel's duration limits](https://vercel.com/docs/functions/configuring-functions/duration).
The operator subsequently authorized the main-only web release. The first upload and recovery
are recorded below; authentication and final publication remain pending.


## Deployment incident and recovery, 2026-09-06

The first production-target candidate reported unknown revision and took the cron target.
One scheduled request returned 200 before cron was paused. Its job outcomes are not yet counted.
Rollback to the original was initially refused because it was still current production;
restoring its alias alone did not restore cron. Recovery then promoted an old-code staging
clone without evaluating the unknown health response first. This was a gate-order failure.
The immediate rollback raced promotion completion; after observing the completed promotion,
rollback to the exact original succeeded. Cron resumed only after separate checks established
the original deployment ID, public health revision and scheduler target. Its pause lasted
703.669 seconds. A subsequent original-deployment cron request returned 200; this is not
per-job completion evidence. Private records are in `_local/wp213-web-candidate/`.

Every dependent operational gate must be a separate step: issue the mutation, wait for its
terminal state, inspect and assert the artifact/target, then authorize the next mutation.
Never compose a health read and promotion without evaluating the read. Never redeploy or
promote an unverified artifact as a restoration bridge. Keep the exact original rollback
available and verify both custom-domain identity and cron target after restoration.


## Configured review environment

The September 6 continuation created a protected custom `release-review` environment without
a branch matcher. Vercel's server-side import references the production configuration; no
secret export is needed. Before deployment, detach the custom environment from the cron secret
and Amazon credential records, preserving those records' production targets, types and values.
Keep only the database, public Supabase settings, secure cookies and signed-navigation settings.
Use independent custom-only records for the review origin and disabled weekly scheduling.
Never update the value of a shared production record to customize a review deployment.

The seven effective review keys are recorded privately, as are the stable alias and immutable
candidate. Verify key names after Ready and run the existing public identity/brand verifier.
The review origin must be the review alias; a successful login on the public website does not
create a session there. Prove the real email callback stays on that origin. Use the supported CLI user-agent for the management API; the generic client received 403
while the CLI user-agent succeeded. Verify exact redirect allowlist entries before requesting
a review email. The two added callback patterns are recorded privately.
The user is signing in through the permitted browser surface. This step remains incomplete
until the candidate's loaded account screens are actually observed.


## Operator exception for this release

After preview email failed, the operator explicitly requested publication to the main website
and verification there. That instruction supersedes pre-publication authenticated preview
coverage for this release only. Keep those checks pending until observed on the public site;
do not weaken identity, configuration, cron or rollback verification. Production promotion
from the custom review environment produced a new Ready/STAGED production build. Verify that
build's identity and production configuration, then promote it separately. Neither the first
CLI success nor Ready alone proves the custom domain moved.

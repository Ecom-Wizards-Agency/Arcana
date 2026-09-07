# Auth and onboarding acceptance

Run the current application against disposable GoTrue, PostgreSQL and Mailpit,
using the installed Supabase SDK and Chromium. The ordinary CI workflow runs this
suite on every pull request and push to main. Missing dependencies or services,
incomplete checks and cleanup errors fail the command; there are no skip flags.

```sh
pnpm install --frozen-lockfile
pnpm --filter @wizard-ads/web exec playwright install --with-deps chromium
node --test tools/auth-acceptance/support.test.mjs
node tools/auth-acceptance/run.mjs
```

Use Node 22 or newer and native Linux Docker, as supplied by GitHub-hosted Ubuntu.
The Docker context must use a local Unix socket. The harness pulls the immutable
public images listed in [stack.mjs](stack.mjs). It does not require Supabase CLI,
a hosted project, a private repository, environment files or existing services.
Stop other Next dev/build/type-generation work in this checkout before running:
the browser phase owns the web app's ordinary Next dev cache and process.
Existing application `.env` files cause an explicit refusal.

The two diagnostic-redaction tests verify written artifacts. The integration
command runs 24 required checks in two fresh stacks:

- Fourteen provider checks cover signup disabled; missing, unconfirmed and
  confirmed accounts; the maintained invite template; real session cookies and
  password setup/login; token replay, resend and wall-clock expiry; wrong-account
  session replacement; redirect allowlisting; and three committed operations
  whose successful responses are deliberately dropped. Final counts must be ten
  users, ten captured emails and three dropped successful responses.
- Ten browser checks apply every current migration, invoke the actual agency
  operator CLI and use the actual Next pages/actions. Landing GETs have no
  verification effect. Native forms verify email, set a password and accept
  exactly one owner membership, with one audit and the correct org cookie.
  Replay adds nothing. A wrong signed-in account is refused by the page and by a
  direct submission of the real bound form. Fresh hydrated password login must
  show the dashboard **and** reach its actual URL. Final counts must be two
  agencies, two users, two emails, one membership, one acceptance audit, one
  accepted invitation and one pending invitation.

The primary onboarding browser disables JavaScript to test native forms before
hydration. This catches incompatible referrer policies that make an otherwise
valid form send `Origin: null`; Next's origin checks remain enabled. The streamed
dashboard needs JavaScript to display completed content, so its visible state is
checked separately in the fresh password-login browser. The URL assertion also
catches an intermediate Auth checkpoint remaining in the address bar while a
server-action response streams the destination's content.

Each stack owns four labelled containers and an internal Docker network. Only
random loopback HTTP ports are opened; the disposable database is reached through
its private Docker bridge address. PostgreSQL uses tmpfs storage. GoTrue creates
its real Auth schema and performs real verification/password operations. The
repository's platform fixture supplies roles/default ACLs and unused Vault/cron
stand-ins before the unchanged application migrations run. The actual
[invite template](../../supabase/templates/invite.html) is mounted read-only.
Only the unrelated Google Fonts download uses a local font fixture.

All accounts and keys are generated for the run. The Next process receives no
Auth-admin key and both E2E identity bypasses are disabled. The operator CLI alone
receives temporary provisioning/delivery credentials. The browser rejects outside
requests, and the Next/operator fetch guard allows only this run's local origins.
No Amazon worker, real mailbox or provider operation is used.

Results, selected HTTP metadata, rendered mail and Next diagnostics are sanitized
under `node_modules/.cache/auth-acceptance/<run>/`. No cookies, raw request bodies,
browser traces, screenshots or unredacted Auth links are saved. CI uploads this
directory on success or failure. Runtime secrets and invitation tokens are
redacted before writing; the result records image identities, migration hashes,
counted checks and resource cleanup.

Normal failures and SIGINT/SIGTERM close owned browser/Next processes and remove
only containers/networks with matching ownership labels. Cleanup failures fail
the suite. SIGKILL or Docker daemon loss cannot be recovered inside a killed
process; GitHub's disposable runner supplies the final isolation boundary.

This is synthetic application acceptance. It does not attest hosted SMTP
deliverability, managed migration-owner permissions, production HTTPS cookies,
MFA/passkey policy, team-invitation browser flows, concurrent owner claims or
general cross-agency data access. Those require their own focused checks. Changing
an image pin or the template requires rerunning both suites; adding a check also
requires updating its explicit expected count.

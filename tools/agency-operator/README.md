# Agency installation commands

An installation operator can create an independent agency and its first-owner
invitation. The operator receives no agency membership. The owner connects their
Amazon accounts and invites their team after acceptance. Ordinary team invitations
cannot grant ownership, and this command does not copy another agency's settings.

This is an infrastructure command, not a public API or an organization role.
Run it from a reviewed checkout with credentials injected by the installation's
secret manager. Do not store credentials in a local `.env` file.

## Installation prerequisites

Apply the reviewed database migrations before using these commands or publishing
the dependent web release. The migration/function owner needs `SELECT` on the
canonical `auth.users` identity/email/confirmation columns, `REFERENCES` for the
user foreign key, and permission to lock those rows. PostgreSQL permits `FOR SHARE`
with `UPDATE` on any one column; `UPDATE(id)` is sufficient. A preflight refuses
the migration if row locking is unavailable. Grant these privileges only to the
trusted migration owner through the installer's database administration process,
never to `anon` or `authenticated`. The migration does not alter Auth table grants.

Use a PostgreSQL operator login with the application's service authority. It is
an infrastructure credential, independent of tenant roles and worker credentials.
It can invoke the fixed provisioning functions; no product role grants that
authority. Supabase API keys are not PostgreSQL connection passwords.

Configure Supabase Auth with public signup disabled, the Site URL set to the
installation's web origin, and a redirect allowlist holding only that origin and
these paths:

```text
https://your-web-origin/agency-invite/*
https://your-web-origin/invite/*
https://your-web-origin/auth/recovery/callback*
```

Replace the example origin; a review deployment needs its own entries. Those two
settings are all that link delivery needs. Invitations, first-owner invitations
and owner/admin password reset links are returned once to the person issuing
them, who sends them over the team's own channel; nothing is emailed and every
account still enters through an invitation. SMTP is optional. It serves only
the email path (`--send-email` here, **Also send by email** on the Members
screen) and self-service password recovery, and it needs the
[invite template](../../supabase/templates/invite.html), whose continuation is an
application path with no query string. Supabase can silently replace an
unallowlisted redirect with the Site URL, so verify a rendered email link in a
disposable test mailbox before sending real invitations by email. The landing
GET consumes no token: the recipient explicitly verifies, sets a password and
accepts access. Existing enrolled authenticators remain required.

Inject these variables into the command process:

| Variable | Purpose |
| --- | --- |
| `OPENSPELL_OPERATOR_DATABASE_URL` | Infrastructure PostgreSQL connection for this installation |
| `WIZARD_ADS_APP_URL` | Exact HTTPS web origin, without a path or query |
| `OPENSPELL_OPERATOR_AUTH_URL` | Matching Supabase project URL, for a new-account link or `--send-email` |
| `OPENSPELL_OPERATOR_AUTH_KEY` | Matching Auth administration credential, for a new-account link or `--send-email` |

The web tier uses its separately configured server-only Auth key for
manager-authorized team invitation links and emails and for owner/admin reset
links. It never creates preconfirmed recipients or chooses their passwords.
Without that key, team invitation links work only for existing accounts and
reset links are unavailable.

## Create, reconcile and reissue

Choose and retain one UUID for the provisioning request. The name, slug and owner
email are bound to that UUID; a changed request is refused. For example, after
replacing the synthetic recipient and request identifier:

```bash
pnpm --filter @wizard-ads/agency-operator agency provision \
  --request-id "$PROVISION_REQUEST_ID" \
  --name "Example agency" --slug "example-agency" \
  --owner-email "owner@example.test"
```

Add `--send-email` to use the email path instead of link delivery.

The JSON output distinguishes the stored agency/invitation from delivery. It
shows the invitation URL once. Treat that URL as a private bearer credential:
deliver it through the intended recipient's approved channel and keep it out of
tickets, shared logs and Git.

Without `--send-email`, link delivery is used. With the operator Auth variables
set, the command asks Auth for a one-time account link without sending email and
records `agency.invitation_link_issued` (never the link):

- `link_ready` means the printed URL carries a one-time Auth token. It opens the
  invitation, verifies the address and lets the owner set a password.
- `existing_account` means the printed URL is the plain invitation; the owner
  signs in with their normal password and accepts.
- Without the Auth variables the delivery is `not_requested` and the plain URL
  works only for an existing account.

With `--send-email`, Auth sends the invitation instead:

- `accepted_by_provider` means Auth accepted the email request. It does not prove
  inbox delivery, a chosen password or agency membership.
- `existing_account` means the recipient already has a confirmed account. Share
  the application invitation URL; they sign in with their normal password. The
  command does not replace their password or send a magic login/reset link.
- `uncertain` or `failed` retains the stored invitation. A lost response can follow
  successful email delivery; check before explicitly requesting another send. In
  link delivery the printed URL is the plain invitation; reissue for a new
  account link.
- `token_unavailable` means a retry found existing state but cannot recover the
  original bearer token. It does not create a duplicate organization or send email.

Repeating `provision` with the same request parameters reconciles stored state.
If the original link was lost, explicitly reissue against the returned generation:

```bash
pnpm --filter @wizard-ads/agency-operator agency reissue \
  --request-id "$PROVISION_REQUEST_ID" --expected-generation 1
```

The new generation invalidates the old application's invitation. A concurrent
acceptance or reissue is reconciled or refused; an accepted owner cannot be
replaced by reissue. Previously issued Auth email links and existing Auth sessions
have their own lifecycle and are not revoked by rotating an application invite.

To revoke an open invitation:

```bash
pnpm --filter @wizard-ads/agency-operator agency revoke \
  --request-id "$PROVISION_REQUEST_ID" --expected-generation 2
```

Revocation is idempotent for that generation and does not remove an accepted
owner. Membership changes use the agency's normal reviewed member controls.

Exit `0` indicates a completed command; exit `2` carries a structured delivery or
token-recovery outcome requiring attention. Exit `1` means completion could not
be established. Always inspect the JSON receipt and reconcile the same request;
an exit code alone is not proof of the resulting state.

## Recipient recovery and verification

An existing account signs in, completes any enrolled authenticator challenge and
accepts the invitation. New recipients follow the email, choose their password and
then accept. The database checks current canonical verified email and inserts the
membership, acceptance receipt and audit together. A retry does not duplicate
membership or restore access that an owner later removed.

If email verification consumed a link but its response was lost, use ordinary
sign-in with an already chosen password, or explicitly request password recovery.
The independent agency invitation can remain pending while Auth is recovered.

Before external onboarding, verify the configured Amazon application permits
external customer authorization and that the worker-owned connection workflow is
installed. These commands create no Amazon connection, synchronized profile,
strategy, job, campaign or advertising mutation.

Tests use disposable services and synthetic recipients:

```bash
pnpm --filter @wizard-ads/agency-operator test
```

Database tests require the explicit `WIZARD_ADS_TEST_DATABASE_URL` used by the rest
of the repository. Do not point this test command at a hosted/shared database.

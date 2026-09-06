# Recommendation authority command

The recommendation worker reads and executes recommendation jobs with its restricted
database credential. It cannot change the installation's claim protocol, revision or
admission gate. A separate, root-owned command performs those deployment transitions.

The command accepts exactly one of these forms:

```text
/usr/local/libexec/openspell-recommendation-authority block EPOCH OLD_OR_DASH TARGET
/usr/local/libexec/openspell-recommendation-authority activate EPOCH - TARGET
/usr/local/libexec/openspell-recommendation-authority rebind EPOCH OLD TARGET
/usr/local/libexec/openspell-recommendation-authority authorize EPOCH CURRENT CURRENT
```

Revisions are full lowercase Git object IDs. Epochs are canonical nonnegative safe
integers. Rebind requires different revisions; authorize requires equal revisions.
There are no connection, executable, credential-path, SQL or environment flags.

The broker calls one of the four existing authority functions once in a transaction,
using fixed `SET LOCAL ROLE service_role`, parameterized SQL and disabled prepared
statements. It emits one counted, validated JSON result only after COMMIT returns.
Fixed connection, statement and lock timeouts bound ordinary failures; a 15-second
process deadline also bounds a lost response on an open socket. An error or deadline
does not retry the transition or expose driver/credential details.

The deployment scripts independently read the resulting authority using the worker's
separate credential. Broker exit status is not completion evidence. Exact expected
state permits continuation; unchanged state stops the attempted transition; foreign
or unavailable state requires reconciliation. Each readback attempt and credential
decryption is bounded. Never repeat a transition merely because its response was lost.

## Install the verified artifact

Installation requires a clean checkout at the exact approved `origin/main` revision,
Node22 or newer at the resolved system Node path, pinned workspace dependencies and
the Linux deployment tools used by the worker installer. The build runs without
privileges. Require successful public CI for that exact revision before authorizing
installation. Run the following only within an authorized operation:

```sh
bash docs/deploy/install-recommendation-authority.sh --revision "$APPROVED_REVISION"
```

The installer stages eight regular files under
`/opt/openspell-recommendation-authority/releases/<revision>`, including standalone
broker/verifier bundles, source hashes, artifact hashes and a complete file census.
Only Node built-ins remain external bundle imports. It refuses retained artifacts
whose bytes differ, symlinks, unsafe ownership/modes and unexpected files. It verifies
the installed artifact before atomically replacing the regular launcher at the fixed
libexec path. The launcher pins the immutable bundle and resolved system Node binary,
and clears the caller's environment. Runtime verification checks the launcher,
bundle, hashes and every parent directory again.

Installation shares the recommendation deployment lock. It does not create or decrypt
credentials, connect to a database, change authority, update worker units/current,
reload systemd or start/stop services. Retained immutable releases remain available.

## Separate infrastructure credential

Provision the ciphertext through the installation's approved secret process at:

```text
/etc/credstore.encrypted/openspell-recommendation-authority-database-url
```

It must be a root-owned regular file, mode0400 or0600, with safe root-owned parent
directories. The broker decrypts only this fixed path through `/usr/bin/systemd-creds`,
captures a bounded private pipe and retains the connection string only in memory.
It has no `DATABASE_URL` fallback. The URL supports an optional single `sslmode`
parameter (`disable`, `require`, `verify-ca` or `verify-full`); other query parameters
are refused so they cannot override the broker's fixed connection settings.

This is a distinct PostgreSQL LOGIN with service-role authority, not the worker login
or an API service token. A managed NOINHERIT login with SET membership in `service_role`
is compatible. That membership is broad infrastructure authority: root custody and
the fixed command limit its use by the deployment caller. It is not a narrow database
principal. Never give this credential or broker installation to web, MCP, the worker,
an application account or a worker release directory.

For every production transition, record the exact source/artifact revision, credential
identity, expected old/new authority, compatible worker/web revisions and independent
readback. Credential provisioning and production transitions require their own scoped
authorization; running the installer does not authorize them.

## Verification

The public `@wizard-ads/recommendation-authority` test task exercises malformed input,
fixed SQL dispatch, query/commit response failures without replay, managed PostgreSQL
authority/refusals, timeout configuration, bounded credential loading, artifact
tampering and an actual installed root launcher in a networkless disposable Node22
container. A separate transport regression forwards exactly one real CAS and COMMIT
through an owned Unix-socket bridge, drops its acknowledgement, verifies the installed
process's deadline, and reconciles the committed row through independent readback.
Only the decrypt executable is synthetic in that container. Installer regressions also
prove that changed clean revisions or compiled-source hashes cause refusal before any
privileged operation. No test receives hosted database or Amazon credentials.

The [worker deployment proof](test-recommendation-worker-deployment.mjs) separately
checks transition/readback classification and the restricted runtime import graph.
CI runs both tasks publicly on standard hosted runners; Docker or database failure is
a failed required check, not a passing skipped installation test.

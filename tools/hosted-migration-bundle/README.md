# Hosted migration bundle CLI

This tool constructs and independently verifies the fixed artifact described by
[src/policy.ts](src/policy.ts). Its public command interface is
[src/cli.ts](src/cli.ts); checks and synthetic SQL fixtures live in this package.
It does not authorize or perform a hosted migration, migration-history repair, credential change,
service change, authority transition, deployment, provider call, or Amazon write.

## Boundary

The bundle preserves a byte-authoritative 41-file hosted-history snapshot and appends the five
reviewed Git blobs fixed by the policy. This is not a current-schema exporter or a fresh-install tool. The history snapshot is input evidence, not repository history.
Do not replace its files with similarly named repository migrations and do not replay it on a new
database.

Construction has no network or database capability. A successful local verification proves only
the artifact's bytes and source provenance. It does not prove that the snapshot is fresh, identify
a hosted project, or grant permission for any later operation.

Construction requires Linux with a mounted, usable `/proc/self/fd`. It claims the output basename
through a held parent-directory descriptor, opens and holds the claimed output inode, and performs
every later marker, payload, private-check and sync operation through that output descriptor. It
rechecks canonical parent and output path bindings against the held descriptors. `build` fails closed
when that custody path is unavailable; the public `verify` operation may remain portable.

Keep all generated material outside the repository. Use fresh, private, disposable work
directories for the history input, sealed output, and any later CLI clone. Never reuse the sealed
bundle itself as a CLI work directory.

## Construct the sealed artifact

Start from a clean checkout where `HEAD`, local `origin/main`, and the fully reviewed 40-character
revision are identical. The history work directory must contain exactly the fetched
`supabase/migrations` directory required by the fixed policy. Its CLI-owned `.temp` data and every sibling are
out of scope and must not be copied.

Choose a new output path that does not exist and is outside both the checkout and history input.
Then run:

```bash
pnpm migration:bundle -- build --history-workdir "$history_workdir" --output-workdir "$bundle_workdir" --revision "$revision"
pnpm migration:bundle -- verify --mode sealed --bundle-workdir "$bundle_workdir" --revision "$revision"
```

Do not infer success from an exit code. Capture the bounded JSON from both commands and require exact
agreement on:

- source revision;
- 41 baseline files and five additions;
- 46 total files and 646628 total bytes;
- terminal version `20260901060000`;
- baseline ledger digest
  `9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea`;
- bundle ledger digest
  `baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458`;
- one identical manifest digest.

The published tree must contain only `BUNDLE_MANIFEST.json` and 46 regular files under
`supabase/migrations`. It must not contain `.BUNDLE_UNPUBLISHED`, `.temp`, configuration, target
linkage, credentials, seeds, functions, hooks, SQL outside the fixed migration set, or another
top-level entry.

If construction loses its response, do not delete or rebuild the requested output. Run sealed
verification against that exact output. A marked artifact is unpublished and must be refused; an
unmarked artifact is accepted only if the complete independent verification succeeds.

## Review custody

The reviewer receives the sealed artifact, the two local evidence records, and the exact reviewed
revision. Review the deterministic manifest, all 46 migration entries, the five Git-blob hashes,
canonical ordering, byte totals, ledger digests, and absence of unrelated files. Keep the sealed
artifact read-only and under single-party custody during review.

Any later dry run uses a new private clone. After CLI metadata has been created, verify that clone
in `cli-workdir` mode. That mode permits only `supabase/.temp` beyond the sealed layout, ignores its
contents, and rehashes every migration and the manifest. Discard the clone after its evidence phase;
never promote it back to the sealed artifact.

## Read-only database evidence

The SQL files under [sql/](sql/) are offline evidence queries, not
migrations or deployment assets:

1. `wp-197-hosted-migration-probe.sql` closes the exact ordered ledger version list, terminal
   version, prefix classification and milestone-object pattern. It reports separate aggregate counts
   for other granted/waiting holders of the shared schema-DDL advisory key and for all, active and
   lock-waiting sessions under the fixed guarded-CLI application-name prefix. It selects exactly one
   prefix script.
2. Run only the selected `wp-197-hosted-migration-prefix-41.sql` through
   `wp-197-hosted-migration-prefix-46.sql` file.
3. Run the universal probe again. Require its complete typed row to canonicalize to the same JSON
   and SHA-256 as the first probe row, and require all five activity counts to remain zero.
4. Require every returned `pass` value to be true, all rows to carry the same
   `prefixEvidenceSha256`, and each of the four named fingerprints to be present and identical on
   every row.

Every script opens a repeatable-read, transaction-read-only transaction, sets bounded timeouts,
uses static SQL only, returns aggregates or digests, and rolls back. It accepts no target, expected
fingerprint, freeze, CLI, or credential argument. A failed, missing, duplicate, non-ASCII, or
unexpected row makes the observation invalid.

The prefix scripts close these forward-only states:

| Prefix | Terminal version | Required evidence |
|---:|---|---|
| 41 | `20260901010000` | All WP-187 through WP-196 objects are absent. |
| 42 | `20260901020000` | WP-187 objects and ACLs exist; all 28 row-bearing SP relations are empty. |
| 43 | `20260901030000` | WP-192 delivery heads close one-for-one in genesis state; events are empty. |
| 44 | `20260901040000` | WP-194 claim tokens are null; report authority is `legacy`, epoch zero. |
| 45 | `20260901050000` | WP-195 preview/scope relations are empty; historical scope fields are null. |
| 46 | `20260901060000` | WP-196 roles, grants, policies, scheduler exclusion, and `legacy/legacy` authority close. |

The named `queueFingerprint`, `recommendationFingerprint`, `scheduleFingerprint`, and
`outOfScopePrivilegeFingerprint` are observations, not embedded expected values. A guarded runner
must compare the current values byte-for-byte with separately retained target-bound
preflight evidence. The standalone bundle CLI does not implement such a runner or
issue authorization. Any mismatch refuses further authorization.

The standalone probe and unguarded probe/prefix/probe sequence are instantaneous review evidence.
Because the three scripts are separate transactions, they do not close either gap around the prefix
query and are never apply or suffix-authorization evidence. The public SQL reports aggregates only;
it cannot identify or bind a matching migration session. It also cannot prove target identity,
enqueue-freeze custody, CLI identity, local artifact custody, an already-running child process, or
the absence of an actor that ignores the shared advisory key. Those require separately established operational evidence and exclusivity; a passing
query makes no claim about them.

## Verification and operational limits

Run the package's public offline checks from the repository root:

```bash
pnpm --filter @wizard-ads/hosted-migration-bundle typecheck
pnpm --filter @wizard-ads/hosted-migration-bundle test
```

Keep all seven SQL files public and unchanged with their consumers. The historical
work-package labels in the fixed policy and SQL filenames are artifact identifiers,
not instructions to retrieve a private plan. This tool needs the exact independently
supplied history bytes, never access to a private repository.

Database observations require a separately scoped target and credential context;
the offline build and verify commands do not make those connections. No successful
build, verifier or SQL observation authorizes a migration, a runtime authority
transition, a service activation or an Amazon write. A later operation must bind its
exact target, revision, artifact, runtime, observed state and single-use operator
authority. A lost or ambiguous execution response requires read-only reconciliation.
Blind retry, migration-history repair, reverse SQL and replay of an applied file are
not recovery procedures supplied by this package.

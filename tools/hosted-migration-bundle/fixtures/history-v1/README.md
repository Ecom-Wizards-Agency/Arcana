# Historical schema fixture

These 41 SQL files are the exact schema baseline pinned by
`HOSTED_MIGRATION_BUNDLE_POLICY`. Tests verify every filename, byte count and
SHA-256 before replaying the baseline and its five authorized transition inputs
in a disposable PostgreSQL database. The fixture contains schema source only;
the tests create synthetic migration-ledger rows and test cases themselves.

This fixture keeps migration-evidence regression tests independent of a private
checkout or a hosted database. Its bytes are immutable. It is not the current
installation schema: new installations use the repository's root
`supabase/migrations` directory.

The SQL evidence suite uses this fixture by default. Its catalog proof includes
cluster-global roles, so run it against a fresh disposable PostgreSQL 17 cluster
using `WP197_EXACT_HISTORY_DATABASE_URL`. The public CI job supplies a separate
`postgres-history` service for this purpose. Recreate that cluster before another
run; dropping only its test database does not remove PostgreSQL roles. Do not
point it at an existing shared or hosted cluster.

A local operator can set
`WP197_EXACT_HISTORY_WORKDIR` to another directory with the same exact baseline;
all policy hashes still apply. CI requires its disposable PostgreSQL service and
fails if that service is unavailable.

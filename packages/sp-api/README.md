# `@wizard-ads/sp-api`

Pure Selling Partner API transport and report parsing for worker-owned jobs. It
depends only on `@wizard-ads/shared`, performs no database I/O, and never owns or
persists Amazon credentials. The web application must not import this package.

The first supported workflow is weekly Brand Analytics Search Query Performance:

- one marketplace per report;
- Sunday-through-Saturday periods;
- report reuse can be implemented by the worker around the request identity;
- ASIN report options are batched to Amazon's 200-character limit;
- parsing accounts for every source row as parsed or refused, then reports
  deduplication and output counts explicitly.

The package also supplies an LWA access-token provider whose refresh value is
read lazily from worker-owned custody, cached only as a short-lived access
token, and reread after invalidation. The worker injects the configured regional
SP-API endpoint. No token reaches request logs or returned errors.

## Adding a report module

The client owns Reports API transport, not report-specific parsing or persistence.
Keep a new report's request planner and parser in a sibling of `src/sqp.ts`; export
its report-type constant, counted request plans, and counted parse result from the
package barrel. JSON reports use `downloadReportDocument`; TSV and other text
reports use `downloadReportDocumentText`, which also handles GZIP. Download URLs
receive no SP-API authorization headers.

`createReport` has a zero transport retry budget. A definitive 401/403 can
replace authentication once, preserving the existing auth recovery contract. A definite
throttle is returned to the worker with its retry delay. Transport loss, server
failure, or an unreadable/missing create ID raises `SpApiAmbiguousOutcome`. The
worker must persist a create intent before calling the client, persist and verify
the returned report ID, and refuse to replay an unresolved intent. SQP implements
this checkpoint pattern. A new worker source registers its plan, execute, counts,
and coverage target with `IngestionRegistry`; the registry writes freshness using
the WP-256 producer. No provider module imports a database or starts a scheduler.

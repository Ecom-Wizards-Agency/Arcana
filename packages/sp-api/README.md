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

## Additional report families

The report contracts and synthetic fixture provenance are pinned in
[`src/fixtures/README.md`](src/fixtures/README.md). These adapters use the existing
Reports transport and are registered on the worker's `integrations` lane:

| Job | Provider options | Stored grain |
| --- | --- | --- |
| `retail.report.request` | `GET_SALES_AND_TRAFFIC_REPORT`, `dateGranularity=DAY`, `asinGranularity=CHILD`, one day | Seller/marketplace/date total separately from child ASIN |
| `aba.report.request` | `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT`, `reportPeriod=WEEK`, completed Sunday–Saturday | Provider period/department/query header and three ranked slots |
| `catalogue.report.request` | `GET_MERCHANT_LISTINGS_ALL_DATA`, current observation, TSV | Immutable report/listing/SKU/ASIN observation |

Every request uses one marketplace and an explicitly enabled exact seller binding.
Source, schedule and policy-acceptance gates default to false; consent and credentials
do not activate them. The source row retains its pinned provider policy. Retail
requests permit two calendar years of lookback and serialize creates at three per
five minutes. The optional recent restatement bound is an operator setting, capped
at 30 days. ABA requests use completed weeks; catalogue requests capture current
observations. No undocumented ABA or catalogue historical lookback is assumed.
Reports document retention is 90 days; stored evidence has separate local retention.
Catalogue periods use the UTC day of the original provider observation. A cached
or delayed report observed on a different day from its request is refused, so a
current inventory cannot be presented as a historical snapshot.

The worker persists intent before POST, verifies the provider ID, polls, refreshes
expired document URLs, parses, promotes transactionally and independently reads the
destination. Uncertain creates remain quarantined across restarts. Source, parsed,
refused, duplicate, added, canonical and loaded counts are reconciled separately.
Pending provider states defer the durable job without consuming failure retries;
an unknown provider state is refused.
Replay preserves the original observation time. Missing fields remain unknown and
partial documents cannot publish complete coverage. A valid empty document is
distinct from a failed or truncated document.

Retail receipts deduplicate across Ads profiles bound to the same seller. Readers
recompute conversion from compatible summed units and sessions; TACOS requires
complete matching seller, currency, date and SP/SB/SD spend evidence. Child rows
are never added to the seller total. ABA shares describe the reported ranked slots,
not organic rank; only a complete observed query can establish “Not top 3”. Listing
certainty is frozen against the preceding evidenced observation. Missing fields,
source switches and later arrival of older reports cannot invent historical changes.

## Fulfillment Outbound transport

`FulfillmentOutboundClient` is a sibling transport with injected fetch and no
worker registration, scheduler or live caller. Preview, create and lookup use the
pinned 2020-07-01 contract. Shared contracts bind caller request ID, seller order ID,
canonical payload fingerprint and item IDs. Callers must persist the uncertain
intent before POST; a repeated uncertain or accepted intent reconciles by stable
seller order identity. A changed payload is refused. Partial lookup responses retain
requested, returned and missing item counts.

This bounded client does not implement COD, scheduled delivery or India's required
declared-value extension. Future execution needs separate worker authority. Tests
use synthetic recipients and injected fake transport only.

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

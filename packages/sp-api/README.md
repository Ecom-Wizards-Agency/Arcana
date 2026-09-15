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

### Report bounds, replay and published evidence

Document downloads stream at most 32 MiB of transport bytes and 128 MiB of
uncompressed UTF-8 bytes by default. `maxDocumentBytes` and
`maxDecompressedDocumentBytes` can lower or explicitly raise those independent
limits. Oversize input or GZIP expansion aborts the request and cancels the stream.
Presigned downloads still carry no authorization headers.

Provider report/document identity is unique within tenant, seller, marketplace
and family, across caller request IDs and Ads profiles. A repeated document
returns its original immutable receipt and observation time; changed content
under that identity is refused. Checkpoints retain their caller identity while
referencing the original provider receipt.

Retail, ABA and catalogue readers require a matching WP-256 coverage publication
for each exact provider period as well as exact destination readback. SQP also
publishes its verified period start through that producer. Period-specific grains
avoid treating disjoint weekly observations as a continuous interval. Missing or
failed publication is unavailable; partial publication remains partial. Freshness
uses the published observation and the shared cadence policy: 30 hours for daily
sources and 174 hours for weekly ABA (cadence plus six hours). Receipt replay never
advances that observation.

Admission exposes stable shared refusal codes for source/binding disablement,
profile sync, credential availability and seller/marketplace/region/connection
mismatches. A conflicting ABA slot retains its conflict marker after canonical
row deduplication, and readers withhold its measured identity and shares.

## Seller consent onboarding

Seller consent is separate from Amazon Advertising authorization and reporting.
The web application saves selected agency profiles in a signed, one-use operation.
The callback accepts `selling_partner_id` and `spapi_oauth_code`; it does not exchange
tokens. The general worker makes one bounded LWA request and returns only the refresh
value to the existing Vault custody boundary. Transport failure or an unreadable
success requires new consent. A recognized OAuth refusal is reported separately.

Onboarding requires known seller profiles whose stored account identity, country and
region match the selected association. Unknown identities and vendor profiles fail
closed. The callback seller must match that saved association. These checks do not
independently prove that the returned token grants marketplace access. Every selected
binding is saved disabled, and onboarding never enables profile synchronization or
report sources.

### Deployment configuration

Apply `20260915310000_spapi_onboarding.sql` before releasing the compatible worker
and web code. The migration preserves existing connections and binding states; pending
operations without profile selections require fresh consent.

| Variable | Runtime | Purpose |
| --- | --- | --- |
| `OPENSPELL_SPAPI_CONNECTIONS_ENABLED` | Web and general worker | Disabled unless exactly `1` |
| `SP_API_APPLICATION_ID` | Web and worker | Seller Central application identity |
| `SP_API_LWA_CLIENT_ID` | Web and worker | LWA application client identity |
| `SP_API_LWA_CLIENT_SECRET` | Worker only | Injected application secret |
| `SP_API_OAUTH_REGION` | Web and worker | `NA`, `EU` or `FE`; pins the regional consent endpoint |
| `SP_API_OAUTH_REDIRECT_URI` | Web | Exact registered callback URI |
| `SP_API_OAUTH_ALLOWED_REDIRECT_URIS` | Worker | Exact comma-separated callback allowlist |
| `SP_API_OAUTH_BETA` | Web | Requests the draft application only when exactly `1` |
| `AMAZON_OAUTH_STATE_KEY` | Web | Existing signing key; SP uses a distinct state version and nonce cookie |

Routes are under `/api/amazon/spapi/`: `oauth/start` accepts a same-origin POST with
the connection label and profile/marketplace selections; `oauth/callback` accepts the
provider redirect. `operations/[operationId]` reads or cancels saved progress.
`connections/[connectionId]` reads health or revokes custody. Status, cancellation and
revocation remain available when new consent admission is disabled.

The test-only consent endpoint override requires the non-production browser fixture
gate and a loopback URL. Fake worker transport maps the fixed LWA endpoint to its
local server. Neither override is a hosted setup instruction.

### Hosted steps for Victor

Resolve the existing scoped hosted authorization, confirm the registered application's
regional consent/login/redirect contract and supported seller account identity, then
review the migration and inject the worker secret through the approved runtime.
Keep both connection gates and all source/binding gates off until a bounded consent
test is authorized. Verify custody counts and cross-agency isolation, then authorize
any selected binding/source enablement separately. Live consent and marketplace access
are not proved by the offline fixtures.

Protocol reference: [Amazon website authorization workflow](https://developer-docs.amazon/sp-api/docs/website-authorization-workflow).

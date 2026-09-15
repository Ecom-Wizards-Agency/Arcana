# @wizard-ads/ads-api

The Amazon Ads API, typed. LWA tokens, profiles, entity lists, Exports,
Reporting v3, budget usage, and Sponsored Products v3 writes — with regional
hosts, throttle-aware retry, and one parser per report schema.

A pure client: no database, no filesystem, no scheduling. Every Amazon call in
the system happens in `apps/worker`, which is the only package allowed to import
this one at product runtime. Web and MCP validate, preview and enqueue through
application contracts; they do not call Amazon or receive Amazon credentials.
[AGENTS.md](../../AGENTS.md) governs this boundary. A legacy caller in source is
not an exception to that rule.

The package's [public exports](src/index.ts), [client](src/client.ts),
[endpoint definitions](src/endpoints.ts) and synthetic tests are the maintained
usage reference. Upstream reference code is specification only, never a runtime
or installation dependency.

## What the worker gets

```ts
const client = new AdsApiClient({ credentials, region: 'NA' });

const campaigns = await client.listSpCampaigns(profileId);
// campaigns.items    -> mirror rows, minus profileId (the worker's uuid)
// campaigns.raw      -> what Amazon sent
// campaigns.skipped  -> what could not be mapped, and why
// items + skipped === raw. Assert it. That is Rule 4 as data.

const created = await client.createReport(profileId, {
  reportType: 'spTargeting', startDate: day, endDate: day,
});
const meta = await client.getReport(profileId, created.reportId);   // poll: worker's job
const download = await client.downloadReport(meta.url!);            // gunzip + JSON
const parsed = parseSpTargetingReport(download.rows);               // rows + skipped + input
```

Two deliberate absences:

- **No polling.** Reporting v3 takes up to three hours. `createReport`,
  `getReport` and `downloadReport` are three calls so a killed worker resumes
  from a report id instead of losing the report.
- **No `profileId` on the rows.** The contract's `profileId` is our database
  uuid; this package only knows Amazon's. The worker holds both halves.

## Sponsored Products writes

The client exposes batch create, sparse update, and archive operations for SP
campaigns, ad groups, keywords, product targets, ad-group and campaign negative
keywords/targets, and product ads. Campaign updates also carry placement bid
adjustments and `offAmazonSettings.offAmazonBudgetControlStrategy` for the
off-Amazon serving-control seam.

Amazon returns HTTP 207 for mixed batches. Every result keeps both halves:

```ts
const result = await client.updateSpKeywords(profileId, updates);
// result.items.length + result.errors.length === result.submitted
```

The client enforces that equality and throws on an unaccounted or duplicate
response index. It automatically splits lists at 100 items. It retries writes
only when Amazon explicitly returns 429; transport failures and 5xx responses
are ambiguous and are never resent. HTTP 425 becomes `DuplicateWriteError`.

Legacy Sponsored Brands media/creative methods are implemented in the client.
Their `/media/upload`, `/media/describe` and `/sb/v4/creatives` seams do not
provide a complete current Asset Library registration or campaign-creation workflow.
Do not treat a callable method as a release enablement or live-verification claim.

## Retry, and who owns what

The client owns *per-request* retry: exponential backoff with jitter on 429
(honouring `Retry-After` when Amazon sends one, which is not always), a retry on
5xx and transport failures for reads only, and a single forced token refresh on
401. Writes are never re-sent on an ambiguous failure.

The worker owns *pacing*. It reads `client.throttleState` between jobs and gets
an `onRetry` callback as each decision is made. Amazon publishes no quota
headers, so an observed throttle rate is the only signal that exists.

## Report types

`spCampaigns` is campaign grain; `spTargeting` is the target grain that is the
spine of the product. `spPlacement` is not an Amazon report type — placement is
a *grouping* on `spCampaigns`, which is why a placement report cannot also ask
for `topOfSearchImpressionShare`. Column lists for Sponsored Brands and
Sponsored Display are documentation-derived and unverified live; every call
takes a `columns` override so an operator can correct a rejected column set
without a code change.

## Capability and version boundaries

Keep four questions separate when adding or documenting a capability: whether the
provider exposes it, whether this package implements the exact protocol, whether
the worker/application provide an authorized workflow, and whether that complete
path has authoritative provider evidence. Unit fixtures prove protocol behavior;
they do not prove a profile's current availability or a hosted release's readiness.

| Source surface | Client contract | Limit |
| --- | --- | --- |
| [Profiles and LWA](src/auth.ts) | Regional discovery and credential exchange/refresh helpers | Credentials remain worker-owned; an account grant is not write approval. |
| [Entity endpoints](src/endpoints.ts) | Legacy SP entity graph; SB and SD campaign/ad-group listing | Preserve each endpoint's dialect and pagination; deeper SB/SD resources are not implied. |
| [Reporting v3](src/reports.ts) | Typed report specifications and parsers; SP target requests include `topOfSearchImpressionShare`; worker forwards column/filter/name/time-unit overrides | Target impression share awaits live verification (`pnpm smoke --reportType spTargeting`); withheld values remain null. Supported columns, attribution window and grain must match the actual report. |
| [Unified Reporting](src/unified-reporting.ts) | Create/retrieve protocol and counted outcomes | Separate from Unified campaign management and from canonical report promotion. |
| [Bid recommendations](src/suggested-bids.ts) | Theme-based SP v3 reads, scoped per campaign/ad group, at most 100 keyword/auto expressions per request; counted reconciliation into daily history | contract rewritten to spec, live verification pending |
| [Budget usage](src/budgets.ts) | Product-specific SP/SB/SD endpoints with counted indexed results | Client support is not application pacing integration or proven provider availability. |
| [SP writes](src/writes.ts) | Counted create/update/archive responses | Application authority, persistence, conflict checks and observation are worker responsibilities. |
| [SB ad/asset probe](src/sb-ad-assets.ts) | Narrow observed ad-to-asset data and search responses | Page-scoped evidence does not prove a complete asset catalog or eligibility. |
| [Legacy SB media](src/sb-media.ts) | Media and creative resource helpers | Does not implement the Asset Library upload/register sequence or full SB creation. |

Unified campaign management and Unified Reporting are different APIs. The client
contains Unified Reporting code; that does not provide Unified SP/SB creation.
Choose a proven dialect for each resource before compiling an immutable plan and
never switch dialect after an ambiguous provider outcome. Reporting promotion,
restarts, freshness and source parity belong in the worker/data path.

Amazon Asset ID is the root creative identity. Preserve its exact version lineage:
Asset Library `version`, registration `versionId` and creative input `assetVersion`
are distinct field names. Names and headlines are display metadata, not join keys.
Do not assign an ad group's totals to a guessed asset or present generic `ACTIVE`
status as proof of program/marketplace eligibility, moderation approval or delivery.
Missing, partial, rejected and pending states remain visible and fail closed.

Product eligibility, brands/Stores, Asset Library registration/moderation and ad
delivery need their own proven provider contracts before being offered in a creation
workflow. SP-API retail/Brand Analytics data cannot be reconstructed from advertising
reports. Marketing Stream needs separate delivery infrastructure, subscription
binding and counted provider-to-ledger translation; an HTTP client alone does not
provide it.

## Tests and operator smoke tools

```bash
pnpm --filter @wizard-ads/ads-api typecheck
pnpm --filter @wizard-ads/ads-api test
```

The package's smoke tool consumes an operator-owned config shaped by
[ads-api.config.TEMPLATE.json](../../_local/ads-api.config.TEMPLATE.json). A read
smoke creates a report and consumes provider quota; it is an explicit live operator
action, not a CI test. This legacy script reads credential values from its config
file; it does not fetch or inject secrets itself. Supply an external, access-restricted
runtime secret file through the approved secret manager, never a real credential
file inside the checkout. The explicit config argument overrides its historical
`_local/ads-api.config.json` default. Its output never prints credentials.

```bash
pnpm --filter @wizard-ads/ads-api smoke "$smoke_config_path"
```

Review profile counts, report request/poll/download identity, downloaded/parsed/
skipped rows, decompression byte counts and campaign-name join coverage. A successful
command alone does not prove complete ingestion or production readiness.

The historical CLI also exposes `--writes` and a `writes` configuration with
`campaigns`, `adGroups`, `keywords`, `targets`, `negativeKeywords`,
`campaignNegativeKeywords`, `negativeTargets`, `campaignNegativeTargets` and
`productAds`. Each supports `create`, `update` and `archive` arrays; campaigns also
have `placement`. Empty arrays make no call, and `--writes` with no mutation fails.
Those flags are not an authorization mechanism. Do not use the raw-client smoke as
a shortcut around the worker-only immutable preview, explicit scoped authority,
idempotent execution, audit and observation requirements in
[AGENTS.md](../../AGENTS.md). Live write proof must use that guarded path.

### Bid recommendation probe

```bash
pnpm --filter @wizard-ads/ads-api smoke --mode bid-recommendations "$smoke_config_path"
```

This mode makes one recommendation request for one existing ad group and prints
its raw HTTP status and JSON body shape (array lengths and the first three item
shapes). It does not write history, request reports, or run mutations. A non-2xx
response exits nonzero. It rejects `--writes` and `--reportType` combinations.
The config needs `lwa`, `region`, `profileId`, and this additional object; `date`
is optional in this mode:

```json
{
  "bidRecommendations": {
    "campaignId": "<campaign-id>",
    "adGroupId": "<ad-group-id>",
    "targetingExpressions": [
      { "type": "KEYWORD_EXACT_MATCH", "value": "synthetic keyword" }
    ]
  }
}
```

The vendored SP contract uses `POST /sp/targets/bid/recommendations`, media type
`application/vnd.spthemebasedbidrecommendation.v3+json`, and
`recommendationType: BIDS_FOR_EXISTING_AD_GROUP` for both keywords and auto
expressions. Each request accepts at most 100 expressions. Manual product
expressions require v4. The unsupported separate keyword recommendation path has been removed. The
legacy keyword/product/target method names now call the same theme endpoint and
require scoped targets; flat ID arrays fail before HTTP. Production and smoke
use the same request builder and endpoint constants. The probe prints the raw
status and body shape before response reconciliation.

### Daily corridor reconciliation

Production selects the `CONVERSION_OPPORTUNITIES` theme. Seasonal themes do not
replace the daily corridor. Responses match the exact expression type and value
within the submitted campaign/ad-group batch, regardless of response order.
Duplicate request identities or expressions and duplicate returned matches fail
before history is written. Unknown returned expressions are counted and excluded.

| Count | Meaning |
| --- | --- |
| `offered` | Active SP mirror targets supplied to the read. |
| `eligible` | Targets with complete scope and a supported v3 expression. Manual product targets, refinements, and missing keyword text are excluded. |
| `requested` | Eligible target expressions sent, across all batches. |
| `returned` | Requested expressions matched to at least one available bid value. |
| `refused` | Requested expressions omitted by Amazon or returned without any bid values. HTTP failures throw and fail the profile pass. |
| `written` | Daily context rows stored, including rows without a corridor. |
| `unmatched` | Extra response expressions in the base theme that match no requested target in that batch. |

For completed profile reads, `offered >= eligible = requested`,
`requested = returned + refused`, and `written = offered`. The worker logs these
counts and aggregates completed profiles; failed profiles are logged separately.
The daily gate and history grain remain unchanged. Refused or ineligible targets
retain their bid/CPC context with null corridor values.

The three `bidValues` slots map to low, median, and high in order. Missing slots
or missing `suggestedBid` values stay null; zero is retained only when Amazon
returns zero. No midpoint or chosen suggestion is inferred. Numeric strings in
the vendored examples are accepted, while negative, nonnumeric, and descending
corridors fail parsing. A v4 manual-product integration needs a separate contract
change and live verification.

### SB keyword verification

`listSbKeywords` uses the candidate `POST /sb/keywords/list` contract with
`application/vnd.sbkeywordresource.v3+json` and response key `keywords`.
`LIST_ENDPOINTS['sb.keywords'].verificationStatus` is `unverified`. No vendored
SB keyword specification was available in the operator's main checkout `_local/`
directory during WP-246. Path, media type, response key, filters and pagination
remain subject to operator verification; synthetic tests are not provider evidence.

```bash
pnpm --filter @wizard-ads/ads-api smoke sb-keywords "$smoke_config_path"
```

This mode uses the config's single profile, requests one page with `maxResults: 1`,
and prints the endpoint's verification status, raw response keys and array counts.
It does not enumerate profiles, create reports, follow pagination or mutate Amazon.
Keys are printed before checking the candidate response key. A mismatch fails the
command. Supply credentials through the external runtime secret file described
above. Record sanitized live evidence and correct the endpoint contract before
marking it verified and enabling worker sync. This smoke mode was not run in WP-246.

## Stream, Asset Library and read graph evidence (WP-313)

The additional clients are pure HTTP adapters with injected transports. Importing
one does not install a worker source, acquire infrastructure authority or enable a
schedule. Tests use synthetic fixtures and the public contracts listed below;
they do not establish hosted capability.

- `StreamSubscriptionsClient`: sponsored `/streams/subscriptions` list/create,
  exact lookup and archive. The documented update supports status/notes, not a
  destination change. SNS confirmation validates the approved challenge against
  exact region/topic/destination and uses a fixed SNS host. Provisioning is a
  separate default-denied worker authority; an uncertain create is never resent.
- `AssetLibraryClient`: validated upload, single and asynchronous batch
  registration, counted search, and exact ID/version lookup. URLs and upload
  handles remain transient. Registration acceptance, processing, specification
  checks and moderation are separate observations. The DB admits an exact immutable request against separately issued asset
  authority. Worker execution validates bytes and provider scope before reserving
  an attempt; campaign write authority cannot authorize these calls. No production
  upload/registration caller is composed.
- `ModerationClient`: v4 result reads and SD creative moderation. Ad and creative
  versions require verified associations to Asset Library versions. The public
  Unified Pre-moderation contract exposes submission; this implementation parses
  supplied evidence but provides no implicit submission or claimed status reader.
- `readProviderGraph`: eleven product-specific SB/SD resources, strict counted
  pages and typed node/edge observations. It does not replace the existing entity
  mirror or adopt Ads v1. Remaining SB target/negative and localization contracts
  remain unsupported pending their prerequisites and a named consumer.

The eight additional Stream datasets register strict `fixture.v1` parsers with
synthetic recorded payloads. Each uses the existing SQS durable receipt boundary,
one `marketing_stream.extensions.project` job on `integrations`, independently
verified event counts and WP-256 partial coverage. These fixtures do not establish
Amazon wire parity. Unknown versions are refused; live contract/access evidence
is required before activation.

Both `OPENSPELL_STREAM_EXTENSIONS_ENABLED=1` and an exact
`OPENSPELL_STREAM_EXTENSIONS_DESTINATION_ARN` are required for intake. Projection
execution also requires an explicit job claimant and a confirmed, enabled,
capability-verified binding matching the advertiser, profile, region and queue.
No event schedule is installed. After opt-in, startup and bounded 60-second
DB-only reconciliation repair missing work using the existing queue custody,
backoff and eight-attempt ceiling. Existing normalizer claimant sets stay intact.

Stored observations feed Campaigns, Ad groups, Products, Targets, Target 360,
Creatives, Creative detail, Creative campaign, Timeline, Time Machine,
Recommendations, Home and Sync status. Aggregate measures require verified
creative/asset/campaign associations throughout the event window. Windows remain
separate from report totals; zero is rendered only when measured. Provider budget
advice exposes `readStreamBudgetHandoff` with Stream provenance, no observed usage
and no approval authority for the WP-292 consumer.

Accepted asset registrations enqueue the existing `asset-library.search` consumer
once. Search persists immutable ownership/version evidence before coverage.
`OPENSPELL_ASSET_RECONCILIATION_ENABLED=1` and an explicit search claimant opt into
restart repair; interrupted writes become uncertain and cannot be uploaded again.
Only an independently verified read can settle an uncertain provider identity.
The shared/DB `readAssetSelectionEvidence` seam provides scope-specific moderation
to the builder; builder wiring remains with its owner. Prompt/video extension
reports remain disabled and unsupported until real identity mapping and capability
evidence exist, followed by reporting recovery and separate activation.

Public contract references:

- [Sponsored Stream subscriptions](https://dtrnk0o2zy01c.cloudfront.net/openapi/en-us/dest/AmazonMarketingStream_prod_3p.json)
- [Asset Library v3](https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/creative-asset-library/creative-asset-library-openapi.yaml)
- [Moderation](https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/Moderation_prod_3p.json)
- [Unified Pre-moderation](https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/PreModeration_prod_3p.json)

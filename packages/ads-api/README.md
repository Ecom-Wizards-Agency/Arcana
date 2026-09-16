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

Product Metadata v1, Product Eligibility v1, Validation Configurations v1 and
Change History v1 are page or bounded-batch reads. Their worker sources remain
disabled by default. Metadata and eligibility do not return provider observation
timestamps, validation does not return a provider configuration version, and Change
History does not return a provider event id. Arcana preserves those absences; a
derived event fingerprint is never presented as an Amazon-issued id.

Brands/Stores, Asset Library registration/moderation and ad delivery need their own
proven provider contracts before being offered in a creation workflow. SP-API retail/Brand Analytics data cannot be reconstructed from advertising
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

## Core reporting expansion (WP-310, disabled)

`CORE_REPORT_FAMILIES` in shared owns the dated 2026-09-07 audit candidates.
The 17 family/grouping variants run in C1–C5 order. C6 adds seven logical metric
variants (`spCampaignMetrics`, `spTargetMetrics`, `spQueryMetrics`,
`spPlacementMetrics`, `sbCampaignMetrics`, `sdCampaignMetrics`, `sbAdMetrics`)
which request the existing provider report IDs at their original grains. The six
default report requests and their column lists remain unchanged.

All variants use the existing `report.request` → `report.poll` → `report.fetch`
source on the report lane. There is one transactional fetch registration. Workers
require `OPENSPELL_CORE_REPORTING_ENABLED=1` and a persisted profile/family capability
with enabled status, recovery evidence, marketplace observation and the exact
approved configuration (columns, format, time unit and attribution generation).
SB also requires recorded preview eligibility. Multi-touch storage is separate
from legacy facts, but provider admission refuses it until its exact column
contract is pinned; evidence alone cannot relabel a legacy request. No local test supplies
hosted authorization. The Unified sidecar does not admit these variants.

`provisionCoreFamilySchedules` creates three disabled schedules only for each
explicitly enabled profile/family capability. Missing or disabled capabilities
produce zero persisted schedules. The eligible family templates contain:
three recent calendar days daily, at most 32 calendar days weekly for restatement,
and a bounded weekly comparison window. The maximum *date difference* and oldest
permitted date are validated separately. SB purchased-product retention never
implies a default 731-day request. Reads retain facts after a family is disabled.

The entity prerequisites use existing `entity.sync` general lanes. They require
both `OPENSPELL_CORE_ENTITY_SYNC_ENABLED=1` and membership in
`OPENSPELL_CORE_ENTITY_PROFILE_IDS`. Unlisted SD kinds and SP campaign negative
targets are protected from tombstoning while disabled. Synthetic contract v1
fixtures verify product-specific identities and source accounting. The SP campaign
negative-target list uses `targetId`; write-response IDs are not list identities.

DAILY facts use distinct family/grain keys; SUMMARY uses interval facts and is
never expanded into invented daily values. Metric selections have separate variants,
and replay retains the original observation time. Refusals block replacement;
promotion independently reads destination identities and values before completion
and coverage. Purchased ASINs never receive invented spend or advertised identity.
The Products grid measures exact advertised-product observations in multi-ASIN ad
groups; missing facts remain unmeasured. Video/NTB evidence is retained at ad grain,
without assigning ad-group measurements to creative assets.

These tests establish local contracts only. The audit does not pin complete,
marketplace-specific provider column specifications. Every candidate column set,
preview restriction and retention boundary needs hosted verification before its
configuration can be approved. Exports was not needed: no named bulk identity join
required it; unresolved provider identities remain explicit. Audience reports stay
deferred for the documented conflict, and prompt/video-extension lifecycle belongs
to WP-313.

## Provider recommendation evidence (WP-312)

### Identity and authority

`AdsApiClient.readProviderEvidence` reads a fixed catalog of 55 HTTP operations.
Each descriptor pins its method, media types, request/response schema and public
contract SHA-256 in `src/provider-contracts.ts` (retrieved 2026-09-15). Tests use
synthetic recorded transport responses. No fixture proves live eligibility.

Provider evidence is separate from Arcana proposals. There is no provider accept,
status-update, rule-write or association-write operation in this catalog.

### Contracts and collection grain

`@wizard-ads/shared` owns scope, immutable observation, estimate, run, checkpoint,
comparison and availability contracts. Unknown amounts, units, objectives,
horizons and attribution remain null. Estimates always carry `Amazon estimate`.
Top-level list items are observations; aggregate research and forecast trees are
one observation each. Nested SB forecast successes/errors are indexed campaign
results. Counts describe those envelopes, not observed impressions or sales.

Global routes and country-bearing requests/responses require `scope.countryCode` and restrict country maps to that one
profile country. No name-based entity matching is performed. Unresolved, missing
and ambiguous entities retain explicit mapping status. Target readers also show
ad-group evidence for an exactly mirrored target's parent.

### HTTP families and named consumers

All rows below share source `amazon_provider_evidence`, typed job
`provider.evidence.collect`, and lane `integrations`. They do not join
`evo-recommendation`. Each run binds one family, operation and source config.

| Family | Consumers | Opt-in cadence | Pinned operations |
| --- | --- | --- | --- |
| tactical | Recommendations, Home | Daily or manual | `tactical.ListRecommendations` |
| sp-budget | Recommendations, Home | Daily or manual | `sp.GetSPBudgetRulesForAdvertiser`, `sp.GetBudgetRuleByRuleIdForSPCampaigns`, `sp.GetCampaignsAssociatedWithSPBudgetRule`, `sp.getCampaignRecommendations`, `sp.fetchCampaignRecommendations`, `sp.getBudgetRecommendations`, `sp.SPGetBudgetRulesRecommendation`, `sp.getBudgetRecommendation`, `sp.ListAssociatedBudgetRulesForSPCampaigns` |
| sp-bid | Target 360, Recommendations | Daily or manual | `sp.GetMultiCountryThemeBased` + `BidRecommendationForAdGroup_v1`, `sp.GetThemeBasedBidRecommendationForAdGroup_v1` |
| sp-research | Query Intelligence, Target 360 | Daily or manual | `sp.getGlobalRankedKeywordRecommendation`, `sp.getNegativeBrands`, `sp.searchBrands`, `sp.ListTargetPromotionGroups`, `sp.GetTargetPromotionGroupsRecommendations`, `sp.ListTargetPromotionGroupTargets`, `sp.getKeywordGroupRecommendations`, `sp.getTargetableCategories`, `sp.getCategoryRecommendationsForASINs`, `sp.getRefinementsForCategory`, `sp.getRankedKeywordRecommendation`, `sp.getTargetableASINCounts`, `sp.getProductRecommendations` |
| rule-evidence | Recommendations | Daily or manual | `sp.GetOptimizationRuleEligibility`, `sp.GetRuleNotification`, `sp.GetCampaignOptimizationRule`, `sp.SearchOptimizationRules`, `sb.ListSponsoredBrandsOptimizationRules`, `sd.listOptimizationRules`, `sd.get--sd-optimizationRules-optimizationRuleId`, `sd.get--sd-adGroups-adGroupId-optimizationRules` |
| sb-research | Query Intelligence | Daily or manual | `sb.SBTargetingGetNegativeBrands`, `sb.SBTargetingGetTargetableCategories`, `sb.SBTargetingGetTargetableASINCounts`, `sb.SBTargetingGetRefinementsForCategory` |
| sb-recommendations | Recommendations, Creatives, Query Intelligence | Daily or manual | `sb.SBOptimizationRecommendation`, `sb.getHeadlineRecommendations`, `sb.GetBudgetRecommendations`, `sb.SBInsightsCampaignInsights`, `sb.GetSBBudgetRulesForAdvertiser`, `sb.GetBudgetRuleByRuleIdForSBCampaigns`, `sb.ListAssociatedBudgetRulesForSBCampaigns`, `sb.GetCampaignsAssociatedWithSBBudgetRule` |
| sb-forecast | Recommendations | Weekly or bounded manual refresh | `sb.SBCampaignPerformanceForecasts` |
| sd-recommendations | Recommendations, Target 360, Creatives | Daily or manual | `sd.getTargetRecommendations`, `sd.getSDBudgetRecommendations`, `sd.getTargetBidRecommendations`, `sd.getHeadlineRecommendationsForSD`, `sd.GetBudgetRuleByRuleIdForSDCampaigns`, `sd.GetSDBudgetRulesForAdvertiser`, `sd.GetCampaignsAssociatedWithSDBudgetRule`, `sd.ListAssociatedBudgetRulesForSDCampaigns` |
| sd-forecast | Recommendations | Weekly or bounded manual refresh | `sd.createSDForecast` |

Tactical detail reads use the pinned list endpoint with an exact
`RECOMMENDATION_ID` filter. The pinned document has no detail GET; its per-ID PUT
is a mutation and is excluded. Existing SP bid-corridor collection remains its
own source; this catalog uses the same HTTP dialect for separate evidence.

### Default-off admission

The worker requires `OPENSPELL_PROVIDER_EVIDENCE_ENABLED=1`, an enabled scoped
`provider_evidence_configs` row and `config.enabled=true`. Configs default off;
there are no seed configs or implicit profile enrollments. A valid credential
never enables collection. Only the dedicated schedule owner sets
`OPENSPELL_PROVIDER_EVIDENCE_SCHEDULE_OWNER=1`; unrelated web/worker runtimes do
not reconcile its schedules. Forecast schedules accept weekly cadence only.
Every provider page rechecks source authorization. Manual refreshes use the same
bounded config and typed job.

### Persistence and restart

Migration `20260915350000_provider_recommendation_evidence.sql` adds configs,
runs, immutable observations and immutable run membership. Runs contain capability
outcomes and pagination checkpoints. Identity includes agency, profile, family,
operation namespace, provider ID and version; absent IDs use a deterministic
SHA-256 of the pinned operation, request, scope and sanitized observation.
Versions with a stable provider ID ignore retrieval options, so changing page
size cannot renew an unchanged observation. ID-less aggregates retain request
context to distinguish their subjects.
Conflicting versions are retained. Identity locks serialize concurrent versions.
Readback compares immutable normalized contents, not only the supplied digest.

A page and its checkpoint commit together. Failed retrieval records a safe failed
state while retaining the checkpoint; retries resume it and retain partial
history. Replaying evidence retains its original generation, observation and
expiry timestamps. Indexed omissions, refused rows, changed pagination totals
and partial pages cannot publish complete coverage.

### Counts and freshness

Every family reconciles `source = parsed + refused`,
`parsed = canonical + duplicates`, and
`canonical = written + existing = independent readback`.
Only independently verified persistence reaches the shared report-coverage
producer. Empty complete retrieval is measured with zero rows; absence remains
not measured. Expired/stale observations remain visible. No forecast enters an
observed-performance table.

### Readers and comparisons

Authenticated readers scope agency/profile/entity in SQL and retain tenant RLS.
Recommendations, Home, Query Intelligence, Target 360, Creatives, Market position
and Sync status receive source-labeled evidence and counts. The read-only MCP
`get_provider_evidence` tool exposes the same estimates and availability.

Arcana values are read separately. Comparison requires matching entity, action,
units/currency, objective, horizon, attribution and observed baseline. Missing
comparison dimensions produce `not-comparable`; provider values never overwrite
Arcana facts. Using advice still requires a new immutable Arcana preview and the
ordinary application approval/delegation gates.

### Conditional D/E dispositions

These extensions remain incomplete and cannot be collected through a fabricated
operation. Their shared descriptors explain the missing contract/measure in the
existing readers; no measured coverage is claimed.

| Audit rows | Disposition / missing prerequisite |
| --- | --- |
| catalog-05, catalog-07, catalog-61 | Conditional identity dependencies deferred: current HTTP scope resolves through the existing profile binding; no required brand/manager/account join is established. |
| catalog-12, catalog-45 | Audience discovery/insights deferred: pinned payload and Query Intelligence measure missing. |
| catalog-15, catalog-16, catalog-21, report-08 | Brand Metrics, Store and benchmark evidence deferred: comparable market-position grain/payload missing; report variants require WP-310 and reporting recovery. |
| catalog-43 | Partner Opportunities deferred: stable identity, eligibility and Home/Recommendations payload missing. |
| catalog-60 | Target KPI deferred: pinned action, units and observed baseline missing. |
| catalog-67 | Cross-program reach/performance forecasts deferred: objective, horizon and account binding missing. |
| catalog-44 | Tactical list and exact-ID detail filtering implemented. |
| sp-family-10, sp-family-12 | Budget and campaign recommendation reads implemented; usage remains outside this evidence source. |
| sp-family-11, sp-family-16 | Budget-rule and optimization eligibility/state/search reads implemented; writes excluded. |
| sp-family-13 | Global/local bid and impression-analysis evidence adapters; existing bid corridor preserved. |
| sp-family-14, sp-family-15 | Keyword/global-keyword, products/counts, categories/refinements, keyword groups, negative brands and promotion-group reads implemented. |
| sb-family-05, sb-family-06 | Target discovery, optimization, headline, budget, insights and forecasts implemented. |
| sb-family-08 | Optimization/budget-rule reads implemented; association and rule writes excluded. |
| sd-family-09, sd-family-11 | Target/bid/budget/headline/forecast and rule evidence reads implemented; writes excluded. |
| catalog-46, catalog-47, catalog-51, catalog-53 | WP-311 owns Product Metadata, Eligibility, Validation Configurations and Change History; no E delivery claim. |

### Reporting boundary

This implementation collects HTTP evidence only. A future report-backed extension
must use the existing request → create/adopt → poll → fetch → parse → stage →
promote → facts lifecycle and pass reporting recovery before activation. This
catalog supplies no alternate report creation or loading path.

### Verification

Provider tests cover fixed HTTP media/method/account binding, pagination, indexed
errors, nulls, timestamps, duplicates, conflicts, restart, immutable/RLS storage,
read-only collection, comparison incompatibilities and named-reader states.
Full gate results and exact counts belong to the round report under `$WP_SCRATCH`.
Built, tested, merged, deployed, enabled and verified in use are separate states.

### Hosted steps for Victor

Verify reporting recovery and current public contracts/eligibility; apply the
reviewed migration and release readers/workers with sources off. Authorize a
bounded family/profile config, reconcile returned/refused/persisted/displayed
rows, verify two-agency isolation and zero writes/approvals/execution cadences,
then separately authorize collection schedules. Resolve conditional extension
contracts before probing them. Provider-derived application remains a separate
guarded action.
## Catalogue and Amazon Change History

The four clients in `src/catalogue.ts` use the public OpenAPI documents inspected
on 2026-09-15. Fixtures in `src/catalogue.test.ts` are synthetic protocol examples;
they do not verify live permissions or provider availability.

| Delivery row | Pinned document under `https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/` | SHA-256 |
| --- | --- | --- |
| catalog-46 | ProductSelector_prod_3p.json | f57ee28943b52097697ab74959ce827dd07a224f81c3b61ba241154a720343ff |
| catalog-47 | Eligibility_prod_3p.json | f9e23e41e87582c50482e460bc210f59a8a77c740c7f58b479a10bbbede2ea83 |
| catalog-51 | ValidationConfigurationsAPI_prod_3p.json | fec38640f4a6e8ff2558f4dc2da703b51679bec8d3c9afa083b4fd1e1870902a |
| catalog-53 | Changehistory_prod_3p.json | a4944c16e893322b3e560452c33c3033db2c2f872c68a64b405404683a2bbc57 |

All four use POST reads. Metadata accepts up to 300 ASINs and returns a cursor;
eligibility accepts 50 ASINs and may return multiple SKU rows per ASIN. Validation
uses separate campaign and targeting-clause endpoints, with explicit country,
entity-type and ad-product contexts. Its schema response keys take precedence over
the inconsistent descriptive prose. The provider has no configuration version
field, so persistence caches content digests.

Change History v1 uses 200-event pages and a bounded window within the documented
90-day retention. It excludes SD and the v1.1 THEME event type. The pinned schema
has no provider event ID or actor: the ledger labels its identity as derived from
tenant scope, entity, change type and occurrence time. Different payloads under
that key remain visible as conflicts. Timestamp units need bounded hosted
verification; the worker accepts contemporary millisecond timestamps only.

Metadata has no observation timestamp or inventory quantity in this contract.
Retrieval and acquisition times remain separate from a null provider observation
time. Missing members create unavailable evidence, and signed image URLs are
excluded. Product eligibility never establishes asset moderation approval.
All four source gates and provisioned schedules remain disabled by default;
reporting recovery evidence and explicit source authorization are prerequisites.

### Product-evidence consumer handoff

The DB reader `readCampaignProductEvidence(handle, request)` accepts an exact
organization/profile/marketplace, advertised ASINs, ad product, optional SKU and
staleness cutoff. It returns one product and one check per requested ASIN. Missing,
refused, unknown, stale or ambiguous SKU evidence produces an unavailable check;
fresh explicit eligible/ineligible evidence retains its provider reasons. The
response explicitly carries `campaignCreationAuthority: false` and
`assetModeration: 'unknown'`. Its DB contract tests cover eight evidence states
and conflicting SKU candidates. Campaign-builder screen wiring remains deferred
to that screen's owner.

Change History keys include the pinned metadata discriminators (including
`placementGroupPosition` and full targeting expressions before display
truncation). They remain derived identities with `provider_id_unavailable`
ambiguity. Identical simultaneous provider events cannot be proven distinct by
this contract; conflicting payloads under a derived identity remain inspectable.
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

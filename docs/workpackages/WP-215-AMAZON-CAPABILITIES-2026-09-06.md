# WP-215 — Amazon campaign and creative capabilities

Research date: 2026-09-06. Owner: Codex. Scope: public source research for WP-215
campaign creation and WP-218 Sponsored Display insights.

This records documentation retrieved on that date, including SHA-256 hashes of the
raw response bytes. It is not live verification: no advertiser account, credential,
profile capability endpoint, campaign mutation or hosted database was accessed.
It neither enables writes nor authorizes a live test. The WP-215 delivery brief
and the repository's Amazon write contract govern implementation and activation.

## Evidence levels

- **Documented:** a current primary Amazon specification or guide describes the
  operation, field or restriction. This establishes a source contract, not access
  for a particular profile.
- **Inferred:** an implementation or attribution conclusion drawn from separately
  documented operations. Its assumptions must be preserved and tested.
- **Live-unverified:** profile eligibility, actual response behavior, observation
  timing or attribution evidence that this research did not establish.

The main corrections to the earlier plan are:

1. SD image/video creative creation and SD ad-level performance are documented.
   The old Postman warning that SD custom creatives are unsupported is stale.
2. SD asset-level performance is not a documented report grain. An ad-to-asset
   mapping needs temporal evidence and may remain ambiguous.
3. SP automatic targeting clauses cannot be manually created through the SP v3
   create-target operation. Observe the provider-created clauses before applying
   any approved overrides.
4. The SB component schema contains six creative variants. Classic product
   collection is distinct from the newer manual/automatic collections; Brand
   Gallery is an additional format within reserve-share-of-voice campaigns.

## Campaign creation matrix

Schema names below refer to `#/components/schemas/<name>` in the cited source.
They identify contract fields rather than profile eligibility guarantees.

| Product / variant | Documented operation or shape | Implementation consequence and unverified boundary |
|---|---|---|
| SP manual | S1 documents POST `/sp/campaigns`, `/sp/adGroups`, `/sp/productAds`, `/sp/keywords`, `/sp/targets` and corresponding list operations. | Existing pure SP clients are useful building blocks. Creation still needs immutable approval, durable intent, exact response accounting and authoritative parent observation. |
| SP automatic | In S1, `SponsoredProductsTargetingExpressionPredicateType` describes `QUERY_BROAD_REL_MATCHES`, `QUERY_HIGH_REL_MATCHES`, `ASIN_ACCESSORY_RELATED` and `ASIN_SUBSTITUTE_RELATED` as automatic clauses that cannot be manually created. `SponsoredProductsCreateTargetingExpressionPredicateType` excludes all four. | Do not translate planned automatic clauses into POST `/sp/targets`. Model provider-created clause discovery and any approved bid/state overrides separately. Their actual appearance timing and complete discovery remain live-unverified. |
| SB classic product collection | S2: `SBCreateComponentCreative.productCollectionSettings` → `SBCreateProductCollectionSettings`. Includes brand, logos, custom images, headlines and landing page; products have a maximum of three. Landing-page types include ASIN_LIST, STORE and vendor-only CUSTOM_URL. | Add a distinct classic variant. The existing newer manual-collection variant does not establish coverage of this shape. Validate the destination and advertiser type. |
| SB manual collection | S2: `componentCreative.manualCollectionSettings` → `SBCreateManualCollectionSettings`; `productInclusions` has 3–10 entries, with brand and destination in `sharedSettings`. | Preserve this separately from classic collections. Account eligibility and objective/destination combinations remain unverified. |
| SB automatic collection | S2: `componentCreative.autoCollectionSettings` → `SBCreateAutoCollectionSettings`; shared settings and optional product exclusions. | Current OpenAPI permits 1,000 exclusions; the existing repository evidence records another official source with a bound of 100. Preserve the conservative existing bound until the discrepancy is resolved. |
| SB Store Spotlight | S2: `componentCreative.storeSpotlightSettings`; brand, one logo, one headline, exactly three cards and Store landing page. | Validate the selected Store and card destinations against the profile's actual resources. |
| SB product video | S2: `componentCreative.productVideoSettings`; exactly one video with `assetId` and `assetVersion`, 0–3 products, and DETAIL_PAGE or STORE destination fields. | Schema alternatives do not prove every combination is eligible. Vertical video has additional destination/objective restrictions described below. |
| SB Brand Gallery / RSOV | S2: `componentCreative.brandGallerySettings`; brand, logo, custom image, headline, Store landing page and 3–5 category/collection cards. Amazon's May 28, 2026 announcement explicitly includes API access within reserve-share-of-voice campaigns. | Add a distinct capability-gated recipe. Do not show the profile as eligible without evidence of its RSOV access and required reservation/deal configuration. This research did not establish reservation purchase behavior or pricing. |
| SD image | S3: POST `/sd/campaigns`, `/sd/adGroups`, `/sd/productAds`, `/sd/targets`, `/sd/creatives`. `CreateCreative` binds **adGroupId** and `properties`. `Image` binds assetId, assetVersion and optional croppingCoordinates. | Replace a generic asset list with exact image roles/crops and an ad-group binding. The existing generic SD creative node points at an ad. |
| SD video | S3: ad-group `creativeType: VIDEO`; creative properties support single `video` or aspect-specific `squareVideos`, `horizontalVideos`, `verticalVideos`. Each video binds assetId/assetVersion. VIDEO is supported for ASIN/SKU product ads, not STORE/OFF_AMAZON_LINK destinations. | Enforce the chosen representation and destination. Single `video` cannot be combined with the aspect arrays; currently each array supports one asset. Validate asset eligibility before campaign approval. |

SB unified operations in S2 include POST `/adsApi/v1/create/campaigns`,
`/adsApi/v1/create/adGroups`, `/adsApi/v1/create/targets` and
`/adsApi/v1/create/ads`, with corresponding `/adsApi/v1/query/...` operations.
Use the operation-specific request and response schemas; do not carry a batch
limit or response-correlation assumption over from SP or an older SB dialect.

### Objectives, bidding and destinations

For SB, S2's `SBCampaignCreate` requires `costType` as well as the campaign identity,
budget, marketplace scope, start time and state. Its optimization fields include
`optimizations.goalSettings.kpi` and `optimizations.bidSettings.bidStrategy`.
The former includes CLICKS and TOP_OF_SEARCH_IMPRESSION_SHARE; the latter includes
MANUAL and SALES_UP_AND_DOWN. A `targetedPGDealId` field also exists.

These schema enums are not a compatibility matrix. Do not generate the Cartesian
product of creative format, objective, cost type, destination, targeting and
marketplace, or treat a generic goal enum as the actual request field. An enabled
creation recipe must name a documented combination and have sufficient current
profile eligibility evidence. Missing evidence produces an explicit unavailable
state with a reason; it does not silently substitute another campaign type.

Amazon's [vertical SB video launch](https://advertising.amazon.com/resources/whats-new/sponsored-brands-video-introduces-vertical-video-creatives)
documents vertical video for Store destinations, rather than product detail pages,
with 1–3 products for page visits and 0–3 for brand impressions. The broad
`productVideoSettings` schema alone cannot express every such restriction.

Amazon's [Brand Gallery launch](https://advertising.amazon.com/en-us/resources/whats-new/sponsored-brands-brand-gallery/)
dated May 28, 2026 establishes that this is an API-accessible SB format within
RSOV campaigns. Its presence in S2 is not proof that a particular profile can
create one. Reservation/deal eligibility and the exact approval payload still
require their own verified recipe.

For SD, S3's `BaseCampaign.costType` supports cpc/vcpm. `BaseAdGroup.bidOptimization`
supports clicks/conversions/reach, with clicks and conversions associated with
cpc, and reach with vcpm in that specification. `CreateAdGroup.creativeType`
distinguishes IMAGE and VIDEO. The current shared campaign settings need these
explicit inputs before the provider adapter is implemented.

S3's older single-`Video` technical table describes 16:9 media, while its newer
aspect-specific arrays explicitly include square and vertical video. Do not turn
the old table into a global aspect-ratio restriction or infer that any arbitrary
upload is eligible. Validate against the selected creative representation and
the applicable current program specifications.

## SD creation, observation and performance attribution

### Authoritative observation

S3 documents the following read paths:

- GET `/sd/productAds` and `/sd/productAds/extended`, with ad/campaign/ad-group
  filters, establish the ad-to-ad-group relationship and returned entity state.
- GET `/sd/creatives`, filtered by `adGroupIdFilter` or `creativeIdFilter`, returns
  creativeId, adGroupId, properties, creativeType and moderationStatus. The two
  filter kinds are mutually exclusive. Its offset pagination uses startIndex
  and count, with a documented maximum count of 100.
- GET `/sd/moderation/creatives` supplies moderation details and requires a
  language parameter. Creative moderation is distinct from asset processing.

S4 states that only one creative can be associated with an SD adGroupId. That is
a statement about the current association, not historical identity for every
past report day.

Creation acceptance, observed entity state, asset processing and creative
moderation must remain separate statuses. S3's `CreativeResponse` and
`ProductAdResponse` contain a code, description and provider ID, but no explicit
request index. A defensible initial adapter sends one resource per provider call
until bulk response correlation has been proved. An ambiguous create response
does not authorize redispatch as a new create; a same-name resource alone is not
proof of ownership of the original intent.

Image properties carry asset/version identity and crop coordinates. Video
properties may additionally return `originalAssetId` and `originalAssetVersion`
when translation produces a different served asset. Preserve original and served
identity rather than discarding that distinction. Provider numeric ID schemas
also require lossless parsing before conversion to the repository's string IDs.

### The report grain that is documented

S5 documents Reporting v3 `sdAdvertisedProduct` with:

- `adProduct: SPONSORED_DISPLAY`, `groupBy: ["advertiser"]`;
- DAILY or SUMMARY time units and GZIP_JSON output;
- a 31-day maximum date range and 65-day retention;
- identifiers including adId, adGroupId, campaignId, promotedAsin and promotedSku;
- cost, clicks, impressions and conversion metrics, plus videoCompleteViews,
  videoFirstQuartileViews, videoMidpointViews, videoThirdQuartileViews and
  videoUnmutes.

Thus the existence of an SD ad-level report is **documented**. Its published SD
column list contains neither creativeId nor assetId. It does not establish a
report that directly attributes performance to an individual media file.

### The asset mapping that is inferred

The following mapping is an **inference** from the separate documented APIs:

```text
report.adId
  -> observed productAd.adGroupId
  -> observed creative and its effective identity
  -> assetId + assetVersion, with original/served identity where relevant
```

The join can support asset-specific insights only when the evidence establishes
the relevant association over the reporting period. A current snapshot alone
cannot prove a historical association. A creative change during the day, several
images, multiple aspect videos or a translated asset can make single-asset
allocation ambiguous even when all API calls succeed.

Keep the ad/creative aggregate available with a clear mapping status in those
cases. Do not allocate the whole ad's metrics to every associated asset. Retain
unmapped and ambiguous rows in accounting so a successful ingestion cannot hide
lost coverage. The first live read-only check needs to reconcile reported ad IDs,
observed product ads, creative identities, asset versions and the time interval
covered by those observations.

### Legacy and unified SD APIs

S3 is a current public legacy SD specification with working documented creative
operations. It supersedes the stale unsupported warning in S10's Postman
collection for source-contract purposes.

S4 also recommends the newer unified Campaign Management APIs, and S8 contains
current SD campaign, ad-group, ad and target examples. Consequently, legacy SD
must not be described as the only currently available API. This research has
**not fully pinned the current unified SD schema**. S8 is evidence that the
unified SD surface exists, not a replacement for a complete schema or proof that
all legacy creative properties map identically. The chosen legacy dialect can
be implemented from S3 while compatibility with the newer dialect is evaluated
as a separately declared change.

## Creative library selection and own-video preparation

| Stage | Documented contract | Required distinction |
|---|---|---|
| Search | S6: POST `/assets/search`, request `caSearchRequestCommon` with text, filterCriteria, sortCriteria and pageCriteria; response assetList, totalRecords and token. | Count and paginate all returned assets. Search results belong to the requested profile; an asset name is not its identity or eligibility proof. |
| Read exact asset | S6/S9: GET `/assets` with assetId and optional version; response assetVersionList and assetGlobal. | Bind the selected ID and version in the immutable preview. Omitting version may return multiple versions. |
| Prepare upload | S6: POST `/assets/upload` returns a temporary upload URL; media bytes are uploaded with PUT and the appropriate content type. | The URL is temporary transport state, not a campaign asset reference or durable evidence field to expose publicly. |
| Register | S6: POST `/assets/register` takes URL, name, asset type/subtypes and applicable association/version metadata; returns assetId, versionId and failedSpecChecks. | HTTP success can coexist with failed program specification checks. Do not equate registration with ad-format eligibility. |
| Process | S7: poll GET `/assets` until ACTIVE; video transcoding may take time and failure can lead to INACTIVE. | Processing is distinct from creative moderation and campaign delivery state. |

There is a concrete public-source discrepancy: the current S6 OpenAPI request
uses **`fileName`**, while S7 and the older Postman examples use **`filename`**.
An adapter should pin its spelling to the selected current schema and preserve
this discrepancy as an explicit activation check. Source research alone cannot
establish whether the service accepts both spellings.

S6's current GET/search media types are
`application/vnd.creativeassetsgetresponse.v3+json` and
`application/vnd.creativeassetssearchassetsresponse.v3+json`, respectively. The
existing Asset Library search is distinct from the older SB media/creative
client; that older client does not implement this upload/register lifecycle.

Only the worker may call Amazon's upload/register APIs. Claude's UI needs a
profile-scoped asset picker and explicit upload, processing, eligibility and
moderation states. The campaign preview binds an eligible Amazon asset ID and
version, never the upload URL. Uploading or registering a file does not create
or approve a campaign.

## Repository consequences

These are source follow-ups, not completed implementation claims:

- `packages/shared/src/campaign-creation.ts` needs distinct classic collection
  and Brand Gallery/RSOV recipes, exact objective/destination controls, SD
  image/video properties bound to an ad group, and an SP-auto operation that
  reflects provider-created clauses. Shared contracts remain authoritative and
  must precede dependent adapters.
- `packages/ads-api` has pure SP creation clients and Asset Library search, but
  the required SB/SD creation and asset upload/register/observation paths are
  not supplied by those clients. Add format-specific provider contracts and
  response/observation tests in their own declared slices.
- The creative feature job/report contract currently supports SB. SD needs
  `sdAdvertisedProduct` ingestion, product-ad/creative observation and explicit
  mapping coverage with retained ambiguous/unmapped results.
- The Campaign Builder's export workflow does not satisfy direct creation.
  Campaign approval/status and asset preparation need stable server contracts
  and synthetic fixtures for Claude before client integration.
- Campaign creation, asset preparation and SD insights should remain separate
  reviewable slices. Their migrations and activation work do not join an
  existing hosted window implicitly. WP-201–WP-205 remain parked under the
  operator's current priority decision.

Source contracts and synthetic tests can advance now. Live activation still
needs the actual profile's eligibility, accepted payloads where documentation
conflicts, exact response correlation, observation timing and adequate temporal
mapping evidence. An unavailable eligibility result must remain unavailable;
it cannot be replaced by an assumed country, ASIN, objective or format.

## Source provenance and raw-byte pins

All sources below were retrieved during this research on **2026-09-06**. The
hashes are SHA-256 of the raw HTTP response bytes, before newline normalization
or JSON/YAML parsing. No Git commit is claimed for the mutable CDN documents;
their content hashes identify the retrieved versions.

Amazon's [SD API portal page](https://advertising.amazon.com/API/docs/en-us/sponsored-display/3-0/openapi)
declares `d3a0d0y2hgofx6.cloudfront.net` as its documentation content host. The
portal's public [contract index](https://d3a0d0y2hgofx6.cloudfront.net/en-us/contracts.json)
and [navigation index](https://d3a0d0y2hgofx6.cloudfront.net/en-us/toc2.json)
were used to resolve the actual specification and guide URLs. The SP contract
index entry points to the separate `d1y2lf8k3vrkfu.cloudfront.net` host in S1.

The official `amzn/ads-advanced-tools-docs` repository's `main` was independently
checked through GitHub's public API. It resolved to
`5c1c432c3dbe676a571780aa0c4d0217659a5f3a`, committed 2026-08-27. The GitHub files
below use that full immutable commit rather than a moving branch URL.

| ID | Exact primary retrieval URL | SHA-256 of raw bytes |
|---|---|---|
| S1 | [SP v3 OpenAPI](https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json) | `fec774c5ba95e860bd732f1f56d4e5a401ffeb76d500b3a2e059f4eb51c198c3` |
| S2 | [Unified SB OpenAPI at the pinned official commit](https://raw.githubusercontent.com/amzn/ads-advanced-tools-docs/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/api-specs/unified-api-sb.json) | `8c73124a1b4795a1bf1cf6029fca5ac789ccf9527746f2158ea33383e444cec0` |
| S3 | [SD OpenAPI](https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml) | `dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd` |
| S4 | [SD creative guide source](https://d3a0d0y2hgofx6.cloudfront.net/en-us/guides/sponsored-display/creatives.md) | `53e1e06b4e77f71808a0454a86fd26695a8ae47902fac800de05b0ed617278f6` |
| S5 | [Reporting v3 advertised-product guide source](https://d3a0d0y2hgofx6.cloudfront.net/en-us/guides/reporting/v3/report-types/advertised-product.md) | `8e7a35a6c93a7636ab3420a9624724c958996568a8a77845823cf7387c347cb8` |
| S6 | [Creative Asset Library OpenAPI](https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/creative-asset-library/creative-asset-library-openapi.yaml) | `fd71719107615a3178f6f77bf0f94665d6e647e024efac4991ac8d2ec173a520` |
| S7 | [Asset-creation guide source](https://d3a0d0y2hgofx6.cloudfront.net/en-us/guides/creative-asset/creating-assets.md) | `5887ebe6577ba63da4339d636aa7a2b2ee92cc1e5a3394ca33638f086ea318e3` |
| S8 | [Unified campaign example payloads](https://d3a0d0y2hgofx6.cloudfront.net/en-us/guides/campaign-management/example-payloads.md) | `08161fad888cb0e76631fc6d8073794255295196eab8a751ac7318c322d0fe1f` |
| S9 | [Asset-management guide source](https://d3a0d0y2hgofx6.cloudfront.net/en-us/guides/creative-asset/managing-assets.md) | `fa4e8fd03b9a8a1cf6d6f3029072afcd1619d116b648efc0ae7952e74b8d55a8` |
| S10 | [Older Postman collection at the pinned official commit](https://raw.githubusercontent.com/amzn/ads-advanced-tools-docs/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/postman/Amazon_Ads_API.postman_collection.json) | `3e8188e69f603d5dc68bc63038f798ab2f40cbc310fa3ab22d9fd0876c783f37` |

S10 is retained to identify the stale claim and conflicting example spelling;
it is not the authority for overriding the newer SD or Asset Library schemas.
The two launch announcements linked above provide format and availability
context. Their page bodies are not included in the raw-byte pin set.

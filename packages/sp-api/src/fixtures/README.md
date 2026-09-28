# SP-API synthetic fixture provenance

The fixtures in `../report-families.test.ts` and `../fulfillment-outbound.test.ts`
were authored for tests. They contain no seller exports, recipient records,
credentials or copied model example values. Provider transports are injected fakes.

## Pinned models

The report field contracts and Fulfillment Outbound model were inspected at
Amazon's `selling-partner-api-models` commit
`3659f96867bfc669aca7a524c2f95744ff0e4478` before implementation.

| Contract | SHA-256 of inspected bytes |
|---|---|
| [Sales and Traffic](https://github.com/amzn/selling-partner-api-models/blob/3659f96867bfc669aca7a524c2f95744ff0e4478/schemas/reports/sellerSalesAndTrafficReport.json) | `ace48b83cbe4b8838d1e3c76eebdd3b44430bf4a0a79bafb7fef1b1634bd7548` |
| [Brand Analytics search terms](https://github.com/amzn/selling-partner-api-models/blob/3659f96867bfc669aca7a524c2f95744ff0e4478/schemas/reports/sellingPartnerSearchTermsReport.json) | `fc4f1ad5c1d09077fad8554a2c57d62f541c883259f20ef59899b6a1efcd3816` |
| [Fulfillment Outbound 2020-07-01](https://github.com/amzn/selling-partner-api-models/blob/3659f96867bfc669aca7a524c2f95744ff0e4478/models/fulfillment-outbound-api-model/fulfillmentOutbound_2020-07-01.json) | `319753932311d306e11f11e9c615ed7001616554935c2db866f3889d472c29aa` |

The local documentation-policy transcription reviewed on 2026-09-15 has SHA-256
`5c8f4d7ea91d08ab32a0ac12cab02efb29ee00d54ba3b4e0adb77ad8bed46dd0`.
It records the [inventory report documentation](https://developer-docs.amazon.com/sp-api/docs/report-type-values-inventory),
[analytics report documentation](https://developer-docs.amazon.com/sp-api/docs/report-type-values-analytics)
and [report retention documentation](https://developer-docs.amazon.com/sp-api/docs/report-type-values).
The transcription lives in implementation scratch. The inventory contract is
documentation-backed; Amazon's inspected report schema directory provided no
equivalent JSON schema for the listing TSV.

## Supported options and limits

- Retail requests use `dateGranularity=DAY`, `asinGranularity=CHILD`, one marketplace
  and one day. Child rows aggregate the requested period, so a one-day request is
  necessary for their daily storage grain. The pinned schema specifies two calendar
  years of lookback. The reviewed documentation states three requests per five
  minutes and advises multi-day requests for efficiency; this adapter chooses daily
  requests to preserve its grain.
- ABA requests use one completed Sunday–Saturday `WEEK`. Wire rows are ranked ASIN
  slots within a department and query. The parser adds one query row per group and
  accounts for that increase separately. No historical lookback limit was found in
  the inspected evidence; an unknown limit does not authorize historical scheduling.
- Listing requests use the default all-listings TSV and
  `preferredReportDocumentLocale=en_US`. Supported identities are `listing-id`,
  `seller-sku` and `asin1`; supported optional fields are `item-name`,
  `item-description`, `image-url`, `quantity`, `status` and `item-condition`.
  The documentation describes UTF-8 with BOM and warns that caching can return a
  different locale. Missing or duplicate identity headers fail closed; unknown
  optional columns are ignored. Currency is not inferred from
  listing price. This adapter supplies observations from the captured inventory;
  it does not reconstruct older inventories. Requests must name their UTC request
  day, and the source observation must fall on that same UTC day. Cached or delayed
  reports observed on another day are refused rather than assigned a historical
  date. Replay retains the original observation time.
- The reviewed Reports documentation gives 90-day default document retention,
  subject to report-specific overrides. None was found for these three families.
  Document retention is separate from historical request lookback.
- Fulfillment tests cover the non-COD Standard/Expedited/Priority request subset.
  Create returns no per-item receipt, so HTTP acceptance leaves items unobserved
  until status lookup. Scheduled delivery, COD and India-required declared-value
  fields are outside this subset. Durable authority and intent storage belong to
  a future worker caller.

## Count assertions

Every parsed family asserts `sourceRows = parsedRows + refusedRows` and
`canonicalRows = parsedRows - duplicateRows + addedRows`, then checks canonical
array length and unique identity count. These are parser checks. Destination
readback and coverage publication need independent worker/database tests.

JSON fixtures cover retail total/child separation, unknown and zero sessions,
currency validation, mismatched periods, duplicate/conflicting rows and explicit
empty documents. ABA fixtures cover complete/incomplete slots, query absence,
department identity, malformed slots, unknown shares and duplicate conflicts.
Listing fixtures cover BOM, quoting, embedded separators, missing fields,
truncation, plain text and GZIP download without credential access.

## Fulfillment Outbound sandbox observations (WP-338k)

`apps/worker/src/mcf-sandbox-cli.ts` asks the NA SP-API sandbox
(`sandbox.sellingpartnerapi-na.amazon.com`, dynamic sandbox for v2020-07-01)
what it answers for the behaviours the model leaves open. Sandbox answers are
**indicative**: production may differ, and a row stays indicative until a
production read or the scoped live test confirms it. Record the HTTP status and
`errors[].code` from the run's journal lines (`mcf_sandbox_probe`) and the run
date; never an order id, a message or an address. A `matches: false` row
becomes a named follow-up package before the live test.

| Probe | Design assumption | Writer or reader mapping | Observed status and codes | Confirmed in production |
|---|---|---|---|---|
| `unknown_id`: getFulfillmentOrder, unknown id | 404 | 404 is `not_found`; any other status throws | not run yet | no |
| `create_explicit`: Ship and FillOrKill sent | 200 | `accepted` | not run yet | no |
| `read_explicit`: read after the create | 200, found, one unit | `found:<status>` | not run yet | no |
| `create_duplicate`: same sellerFulfillmentOrderId again | a 4xx, never a second order | 4xx is `rejected`, then getOrder | not run yet | no |
| `read_duplicate`: the first order after the duplicate | found, same status, one unit | `found:<status>` (`:units_<n>` when not 1) | not run yet | no |
| `create_omitted`: action and policy omitted | none (observe the defaults) | as for any create | not run yet | no |
| `read_omitted`: defaults Amazon filled in | 200, found, one unit (observe the defaults) | action and policy read | not run yet | no |
| `cancel`: cancelFulfillmentOrder while Received | 200 | `accepted` | not run yet | no |
| `read_cancelled`: read after the cancel | 200, `found:Cancelled` | `found:<status>` | not run yet | no |
| `create_cancelled_id`: create under the cancelled id | none (reuse unknown) | as for any create | not run yet | no |
| `throttle`: up to 30 un-spaced reads | 429 with `errors[].code`; no 429 is an observation, not a mismatch | 429 throws `http (429)` in the reader, `rejected:throttled` in the writer | not run yet | no |

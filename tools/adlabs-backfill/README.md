# AdLabs history backfill CLI

Loads operator-supplied AdLabs CSV exports into OpenSpell with source provenance and
row/total reconciliation. It does not contact AdLabs or Amazon. Export acquisition
is a separate operator action; downloaded files and their account data stay outside
Git. See the public [export contract](../../docs/adlabs-export-contract.md).

## Commands and target selection

The supported CLI is [src/cli.ts](src/cli.ts):

```text
depth   --timeline <csv> [--as-of YYYY-MM-DD]
phase0  --timeline <csv> --roster <csv> [--only <amazonProfileId>] [--dry-run]
        [--archive-root <dir>] [--as-of YYYY-MM-DD]
phase1  --grain <campaign|target|placement|search_term> --file <csv>
        --profile <amazonProfileId> --start YYYY-MM-DD --end YYYY-MM-DD
        [--expect-spend N] [--expect-sales N] [--dry-run] [--archive-root <dir>]
verify  [--profile <amazonProfileId>]
```

`depth` reads a local file without a database. `verify` reads the database. `phase0`
and `phase1` read and write the database; `--dry-run` prevents their writes but still
requires a database connection and reads existing profiles/facts. All commands except
`depth` require an explicit `DATABASE_URL` (or `--database-url`); there is no default
target. Inject credentials into the process instead of placing them on a command
line or in a local `.env` file. Partition creation requires the database authority
checked by `app.ensure_fact_partitions`. Rehearse against a disposable database;
production or shared-database writes need authorization for that exact operation.

From the repository root, with variables naming operator-owned files and the
database credential already injected:

```bash
pnpm --filter @wizard-ads/adlabs-backfill backfill depth --timeline "$timeline_csv"
pnpm --filter @wizard-ads/adlabs-backfill backfill phase0 \
  --timeline "$timeline_csv" --roster "$roster_csv" --only "$amazon_profile_id" --dry-run
pnpm --filter @wizard-ads/adlabs-backfill backfill phase1 \
  --grain campaign --profile "$amazon_profile_id" --file "$campaign_csv" \
  --start "$start_date" --end "$end_date" \
  --expect-spend "$expected_spend" --expect-sales "$expected_sales" --dry-run
pnpm --filter @wizard-ads/adlabs-backfill backfill verify --profile "$amazon_profile_id"
```

Removing `--dry-run` performs the selected load. A successful process exit is not
enough: retain and compare the printed counts and totals. Exit code 2 means a count,
currency or total failed reconciliation; other errors return nonzero. A currency
mismatch can be reported after rows were written with the database profile's currency,
so inspect the result before deciding whether any retry is appropriate.

## CSV and archive formats

The profile timeline consumes `profile_id`, `date`, `impressions`, `clicks`, `spend`,
`orders`, `sales`, `units`; the roster consumes `profile_id`, `currency_code`.
The [timeline parser](src/timeline.ts) drops and counts zero-filled days. The loader
excludes the current day according to each profile's timezone and skips profiles
that have not been onboarded into `ad_profiles`.

All monthly grains consume `impressions`, `clicks`, `spend`, `orders`, `sales`,
`units`, plus these dimensions from [src/rollup.ts](src/rollup.ts):

| Grain | Dimensions |
| --- | --- |
| `campaign` | `campaign_id`, `campaign_ad_type` |
| `target` | `campaign_id`, `ad_group_id`, `target_id`, `campaign_ad_type` |
| `placement` | `campaign_id`, `placement_type_raw`, `campaign_ad_type` |
| `search_term` | `campaign_id`, `ad_group_id`, `search_term`, `campaign_ad_type` |

Filter idle rows before downloading when the export service supports it:
`impressions > 0 OR spend > 0 OR clicks > 0`. Preserve the raw downloaded file;
the parser counts idle rows and sums duplicate dimension tuples instead of silently
letting one row overwrite another.

Use `adlabsbf_<grain>_<scope>_<start>_<end>.csv` under `_local/backfill/`:

```text
all/profile/adlabsbf_profile_all_<start>_<end>.csv
all/profile/adlabsbf_profiles_all_<start>_<end>.csv
<amazonProfileId>/campaign/adlabsbf_campaign_<id>_<start>_<end>.csv
<amazonProfileId>/target/adlabsbf_target_<id>_<start>_<end>.csv
<amazonProfileId>/placement/adlabsbf_placement_<id>_<start>_<end>.csv
<amazonProfileId>/search_term/adlabsbf_search_term_<id>_<start>_<end>.csv
manifest.jsonl
```

The prefix intentionally differs from the crosscheck's `adlabs_` inbox contract.
Each non-dry load appends a manifest record with filename, grain, scope, period,
rows, bytes, SHA-256, pull/load times and eligible/loaded counts. Nonconforming names
are loaded but recorded as `unarchived`; inspect that warning. Download URLs are
bearer credentials and must never enter a manifest, log or tracked file.

## Storage and reconciliation

`phase0` loads `fact_profile_daily` through a `report_requests` row marked
`adlabs_backfill`. Existing Amazon API days are protected; only prior backfill rows
are eligible for replacement. The crosscheck excludes backfilled report requests,
so data derived from AdLabs cannot independently verify AdLabs. The isolation is
covered by [backfill-isolation.test.ts](../crosscheck-cli/src/backfill-isolation.test.ts).

`phase1` loads `fact_monthly_rollup` with its own `source = 'adlabs_backfill'` and
grain/dimension identity. Reconcile rows seen, idle, merged, eligible and loaded,
then compare file and stored spend/sales and the separately obtained expected totals
to the cent. Review all printed impressions, clicks and orders as well. `verify`
reports stored depth and rollup counts; it does not prove export completeness.

The loader stores the source's unwindowed sales/orders in the 7-day columns and
leaves monthly 14-day columns null. This is a storage convention, not evidence that
the export uses 7-day attribution. Preserve the source marker and disclose that
uncertainty in downstream comparisons. A monthly rollup's `days` is the requested
window length, not observed days with data.

Current-state export rosters can omit archived/deleted entities from historical
periods. Do not infer full history from a successful load. Campaign, target,
placement and search-term grains need like-for-like coverage before comparing totals;
product and placement exclusions must remain visible. Ad-group/daily entity history
and SQP extraction are not implemented by this CLI. Do not extend backfill into
optimizer daily facts until attribution and coverage are established.

```bash
pnpm --filter @wizard-ads/adlabs-backfill typecheck
pnpm --filter @wizard-ads/adlabs-backfill test
```

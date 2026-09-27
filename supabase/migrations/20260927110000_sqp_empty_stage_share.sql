-- WP-337: an SQP share may be null when its funnel stage had no events that week.
-- Amazon sends no purchase or cart-add share for a query with zero purchases or
-- cart adds. The share of nothing is unknown, not 0 %, so a complete row may
-- carry a null share only when that stage's total and ASIN counts are both 0.
-- Every count stays required. This loosens the check; every existing row passes.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter table public.fact_sqp_weekly
  drop constraint fact_sqp_weekly_contract_complete,
  add constraint fact_sqp_weekly_contract_complete check (
    marketplace_id is null
    or (
      btrim(marketplace_id) <> '' and normalized_query is not null
      and btrim(normalized_query) <> ''
      and total_impressions is not null and asin_impressions is not null
      and (impression_share is not null or (total_impressions = 0 and asin_impressions = 0))
      and total_clicks is not null and asin_clicks is not null
      and (click_share is not null or (total_clicks = 0 and asin_clicks = 0))
      and total_cart_adds is not null and asin_cart_adds is not null
      and (asin_cart_add_share is not null or (total_cart_adds = 0 and asin_cart_adds = 0))
      and total_purchases is not null and asin_purchases is not null
      and (purchase_share is not null or (total_purchases = 0 and asin_purchases = 0))
    )
  );

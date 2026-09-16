import type { KeepaProduct } from '@wizard-ads/keepa-api';
import { ListingSnapshot, ListingFieldObservation, type CollectorScope } from '@wizard-ads/shared';
/** Only the current scoped fetch proves marketplace; legacy BSR rows are never reused. */
export function scopedKeepaListing(scope: CollectorScope, product: KeepaProduct, collectedAt: string): ListingSnapshot | null {
  const fields: ListingFieldObservation[] = [];
  const add = (field: ListingFieldObservation['field'], value: unknown, observedAt: Date) => {
    const parsed = ListingFieldObservation.parse({ field,value,provenance:{ source:'keepa',sourceIdentity:`${scope.marketplace}:${product.asin}:${field}`,observedAt:observedAt.toISOString(),collectedAt } });
    fields.push(parsed);
  };
  for (const [field,history] of [['price',product.newPrice],['buyBoxPrice',product.buyBoxPrice],['rating',product.rating],['reviewCount',product.reviewCount]] as const) {
    const latest = [...history].sort((a,b) => a.observedAt.getTime()-b.observedAt.getTime()).at(-1);
    if (latest) add(field,latest.value,latest.observedAt);
  }
  const rank = [...product.salesRank].sort((a,b) => a.observedAt.getTime()-b.observedAt.getTime()).at(-1);
  if (rank && product.category) add('bsr',{ category:product.category,rank:rank.value },rank.observedAt);
  if (product.updatedAt) {
    if (product.lightningDeal !== null) add('lightningDeal',product.lightningDeal,product.updatedAt);
    if (product.coupon !== null) add('coupon',product.coupon,product.updatedAt);
  }
  return fields.length ? ListingSnapshot.parse({ scope,asin:product.asin,sourceIdentity:`keepa:${scope.marketplace}:${product.asin}`,collectedAt,fields }) : null;
}

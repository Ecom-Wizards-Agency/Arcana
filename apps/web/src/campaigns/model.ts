import type { CampaignBuilderContext } from '@wizard-ads/shared';

export function builderBidEvidence(context: CampaignBuilderContext, keyword: string) {
  const normalized = keyword.trim().toLocaleLowerCase();
  return context.bidEvidence.find((row) => row.keyword.trim().toLocaleLowerCase() === normalized) ?? null;
}

export function builderBounds(context: CampaignBuilderContext, groupId: string) {
  const group = context.groups.find((item) => item.id === groupId);
  const marketplace = context.capabilities.marketplace;
  return { floor: group?.floor == null || marketplace == null ? null : Math.max(group.floor, marketplace.bidMin),
    ceiling: group?.ceiling == null || marketplace == null ? null : Math.min(group.ceiling, marketplace.bidMax),
    exposureCeiling: context.exposureCeiling, decimalPlaces: marketplace?.decimalPlaces ?? 2 };
}

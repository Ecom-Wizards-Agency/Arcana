import type { ControlChange } from '@wizard-ads/shared';
import { SpPlacementChange, type SpCompleteCampaignBiddingState } from '@wizard-ads/shared';
const properties = { top_of_search: 'topOfSearch', rest_of_search: 'restOfSearch', product_pages: 'productPages', amazon_business: 'amazonBusiness' } as const;

/** Build one provider step against the complete state left by the preceding step. */
export function coordinatedPlacementChange(current: SpCompleteCampaignBiddingState,
  change: Extract<ControlChange, { control: 'placement_adjustment' }>): SpPlacementChange {
  const property = properties[change.placementKey];
  if (current.placements[property] !== change.current) throw new Error('Dependency placement baseline has changed');
  return SpPlacementChange.parse({ expected: current,
    requested: { ...current, placements: { ...current.placements, [property]: change.proposed } },
    approvedPlacementKeys: [change.placementKey] });
}

import type { CapabilityMatrix, CapabilityMatrixEntry } from '@wizard-ads/shared';

/** Versioned provider mechanics captured in the method specification; no tenant policy. */
const entry = (value: Pick<CapabilityMatrixEntry, 'adProduct' | 'costType' | 'control' | 'unit'> & Partial<CapabilityMatrixEntry>): CapabilityMatrixEntry => ({
  available: false, range: null, precision: 'decimal', decimalPlaces: null,
  overlapRule: 'unknown', apiVersion: 'unverified', verifiedOn: '2026-09-07', ...value,
});
export const SP_COORDINATED_CAPABILITIES: CapabilityMatrix = {
  version: 'sp-coordinated-capabilities.1',
  entries: [
    entry({ adProduct: 'SP', costType: 'cpc', control: 'target_bid', unit: 'currency_per_click', available: true,
      range: { min: 0, max: null }, decimalPlaces: 2, overlapRule: 'not_applicable', apiVersion: 'SP v3' }),
    ...(['top_of_search', 'rest_of_search', 'product_pages'] as const).map((placementKey) => entry({
      adProduct: 'SP', costType: 'cpc', control: 'placement_adjustment', placementKey, unit: 'percentage',
      available: true, range: { min: 0, max: 900 }, precision: 'integer', decimalPlaces: 0,
      overlapRule: 'exclusive', apiVersion: 'SP v3',
    })),
    entry({ adProduct: 'SP', costType: 'cpc', control: 'audience_adjustment', unit: 'percentage',
      range: { min: 0, max: 900 }, precision: 'integer', decimalPlaces: 0, apiVersion: 'SP v3' }),
    entry({ adProduct: 'SP', costType: 'cpc', control: 'bidding_mode', unit: 'mode', available: true,
      precision: 'enum', overlapRule: 'multiplicative', apiVersion: 'SP v3' }),
    ...(['SB', 'SD'] as const).flatMap((adProduct) => (['cpc', 'vcpm'] as const).flatMap((costType) =>
      (['target_bid', 'placement_adjustment', 'audience_adjustment', 'bidding_mode'] as const).map((control) => entry({
        adProduct, costType, control, unit: control === 'target_bid'
          ? costType === 'cpc' ? 'currency_per_click' : 'currency_per_thousand_impressions'
          : control === 'bidding_mode' ? 'mode' : 'percentage',
      })))),
  ],
};

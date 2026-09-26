import { ProductAssignmentDerivation, ProductAssignmentEvidence } from '@wizard-ads/shared';

/** Pure: input spend covers only the counted mature days the evidence reports. */
export function deriveProductAssignment(raw: ProductAssignmentEvidence): ProductAssignmentDerivation {
  const input = ProductAssignmentEvidence.parse(raw);
  const ads = input.ads.filter((ad) => ad.state !== 'archived');
  const asins = [...new Set(ads.flatMap((ad) => ad.asin ? [ad.asin] : []))].sort();
  const costs = new Map(input.spend.map((row) => [row.asin, row.spend]));
  if (costs.size !== input.spend.length) throw new Error('Product spend must contain one aggregate per ASIN');
  const candidates = asins.map((asin) => {
    const rows = ads.filter((ad) => ad.asin === asin);
    const parents = new Set(rows.map((ad) => ad.parentAsin));
    return { asin, skus: [...new Set(rows.flatMap((ad) => ad.sku ? [ad.sku] : []))].sort(),
      parentAsin: parents.size === 1 ? rows[0]!.parentAsin : null, spend: costs.get(asin) ?? null };
  });
  const result = (assignedAsin: string | null, source: ProductAssignmentDerivation['source'], reason: string | null) =>
    ProductAssignmentDerivation.parse({ adGroupId: input.adGroupId, assignedAsin, source, ambiguous: source === 'proposed', reason, candidates });
  if (asins.length === 0) return result(null, 'unassigned', ads.length === 0 ? 'No enabled or paused product ads.' : 'Product ads have no identifiable ASIN.');
  // An unidentified live ad prevents proving that every ad shares a product or parent.
  const unidentified = ads.some((ad) => ad.asin === null);
  if (asins.length === 1 && !unidentified) return result(asins[0]!, 'derived', null);
  const parent = candidates[0]!.parentAsin;
  if (!unidentified && parent && candidates.every((candidate) => candidate.parentAsin === parent)) return result(parent, 'derived_parent', null);
  // Unknown spend ranks last; ties and a window without mature days fall back to ASIN order.
  const ranked = [...candidates].sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || a.asin.localeCompare(b.asin));
  const unmeasured = candidates.filter((candidate) => candidate.spend === null).length;
  const ranking = input.matureDays === 0 ? 'mature product spend is unavailable'
    : `ranked on ${input.matureDays} of ${input.windowDays} mature days${unmeasured === 0 ? '' : `; spend is unmeasured for ${unmeasured} ${unmeasured === 1 ? 'product' : 'products'}`}`;
  const basis = unidentified ? 'Some product ads have no identifiable ASIN' : 'Products do not share a known parent';
  return result(ranked[0]!.asin, 'proposed', `${basis}; ${ranking}.`);
}

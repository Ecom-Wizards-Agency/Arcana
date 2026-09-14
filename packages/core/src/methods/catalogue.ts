import { MethodCatalogueEntry, type DraftMethodId } from '@wizard-ads/shared';
import { referenceDescriptor } from './reference.js';
import { coordinatedDescriptor } from './coordinated.js';

const draft = (id: DraftMethodId, displayName: string, purpose: string,
  adProduct: 'SP' | 'SB' | 'SD', controls: MethodCatalogueEntry['controls']): MethodCatalogueEntry => ({
  id, version: 'candidate.1', releaseState: 'draft', displayName, purpose, adProducts: [adProduct], controls,
  requiredEvidence: ['Method-specific evidence and validation are required before release.'],
});

/** Shared by the catalogue and picker; draft descriptions have no evaluator. */
export const OPTIMIZATION_METHOD_CATALOGUE: readonly MethodCatalogueEntry[] = Object.freeze([
  { ...referenceDescriptor, displayName: 'SP bid efficiency', purpose: 'Adjust target bids toward the saved ACOS target. Campaign placement settings stay unchanged.' },
  { ...coordinatedDescriptor, displayName: 'SP placement efficiency', purpose: 'Efficiency · Base bids and placement adjustments together' },
  draft('sp.organic-growth', 'SP organic growth', 'Organic growth · One bounded target-bid step', 'SP', ['bid']),
  draft('sp.discovery', 'SP discovery', 'Learning · Target bids within a learning ceiling', 'SP', ['bid']),
  draft('sp.contribution-profit', 'Contribution-profit experiment', 'Profit · Bounded bid treatments', 'SP', ['bid']),
  draft('sb.bid-efficiency', 'SB bid efficiency', 'Efficiency · Compatible CPC bids and placements', 'SB', ['bid', 'placement']),
  draft('sb.acquisition', 'SB acquisition', 'Acquisition · CPC bids against a CPA target', 'SB', ['bid']),
  draft('sd.bid-efficiency', 'Display bid efficiency', 'Efficiency · Supported Display CPC control', 'SD', ['bid']),
  draft('sd.acquisition-reach', 'Display acquisition or reach', 'Acquisition or reach · Supported vCPM controls', 'SD', ['bid']),
].map((entry) => Object.freeze(MethodCatalogueEntry.parse(entry))));

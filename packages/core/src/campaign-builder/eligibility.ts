import type { CampaignBuilderBidBounds, CampaignBuilderCheck, CampaignCreationPlan, CapabilityMatrix, NamingStrategy } from '@wizard-ads/shared';

export function campaignBuilderEligibility(input: {
  plan: Pick<CampaignCreationPlan, 'adProduct' | 'nodes'>; budget: { minimum: number; maximum: number } | null;
  existingNames: readonly string[] | null; naming: NamingStrategy | null;
  parsedNames: readonly { name: string; naming: NamingStrategy; confidence: 'exact' | 'partial' | 'none' }[];
  bounds: CampaignBuilderBidBounds; audienceAdjustment: number; capabilities: CapabilityMatrix;
}): CampaignBuilderCheck[] {
  const campaigns = input.plan.nodes.filter((node) => node.kind === 'campaign.create');
  const bids = input.plan.nodes.flatMap((node) => node.kind === 'target.create' && node.payload.bid !== null ? [node.payload.bid]
    : node.kind === 'ad_group.create' && node.payload.defaultBid !== null ? [node.payload.defaultBid] : []);
  const names = campaigns.map((node) => node.payload.name);
  const check = (id: CampaignBuilderCheck['id'], label: string, source: string, pass: boolean | null, currentValue: string, requiredAction: string): CampaignBuilderCheck => ({
    id, label, source, status: pass === null ? 'not_measured' : pass ? 'passed' : 'blocked',
    blocking: pass !== true, currentValue, requiredAction: pass === true ? '' : requiredAction,
  });
  const { bounds } = input;
  const maximumMultiplier = Math.max(...campaigns.map((node) => node.payload.settings.product === 'SP'
    ? 1 + node.payload.settings.placementBidding.topOfSearch / 100 : 1));
  const exposures = bids.map((bid) => bid * maximumMultiplier * (1 + input.audienceAdjustment / 100));
  const controls = input.capabilities.entries.filter((entry) => entry.adProduct === input.plan.adProduct && entry.costType === 'cpc');
  const supported = controls.some((entry) => entry.control === 'target_bid' && entry.available)
    && controls.some((entry) => entry.control === 'bidding_mode' && entry.available)
    && (maximumMultiplier === 1 || controls.some((entry) => entry.control === 'placement_adjustment' && entry.placementKey === 'top_of_search' && entry.available))
    && (input.audienceAdjustment === 0 || controls.some((entry) => entry.control === 'audience_adjustment' && entry.available));
  const result = [
    check('budget', 'Daily budget meets the marketplace minimum', 'Marketplace rules', input.budget === null ? null : campaigns.every((node) => node.payload.budget.amount >= input.budget!.minimum && node.payload.budget.amount <= input.budget!.maximum), campaigns.map((node) => String(node.payload.budget.amount)).join(', '), 'Set a budget within the marketplace limits.'),
    check('unique-name', 'Campaign name is not already in use', 'Campaign mirror', input.existingNames === null ? null : new Set(names).size === names.length && names.every((name) => !input.existingNames!.includes(name)), names.join('; '), 'Choose a distinct campaign name.'),
    check('naming', 'Name matches your saved convention', 'Your naming preset', input.naming === null ? null : names.every((name) => input.parsedNames.some((parsed) => parsed.name === name && parsed.confidence !== 'none' && JSON.stringify(parsed.naming) === JSON.stringify(input.naming))), names.join('; '), 'Edit the name to match the saved convention.'),
    check('exposure', 'Bid × placement multiplier stays under the ceiling', 'Your exposure ceiling', bounds.floor === null || bounds.ceiling === null || bounds.exposureCeiling === null ? null : bids.length > 0 && bids.every((bid) => bid >= bounds.floor! && bid <= bounds.ceiling! && Math.abs(bid * 10 ** bounds.decimalPlaces - Math.round(bid * 10 ** bounds.decimalPlaces)) < 1e-7) && exposures.every((value) => value <= bounds.exposureCeiling! + Number.EPSILON), exposures.length ? exposures.map((value) => String(Number(value.toFixed(6)))).join(', ') : 'Unavailable', 'Use marketplace bid precision and lower the bid or placement adjustment; configure missing bounds.'),
    check('capability', 'Ad type supports the controls you set', 'Capability snapshot', supported, input.capabilities.version, 'Use controls verified in this capability snapshot.'),
  ];
  for (const [id, label, source] of [
    ['stock', 'Product is in stock', 'Listing snapshots'],
    ['buy-box', 'Product holds the Buy Box', 'Listing snapshots'],
    ['suppression', 'Listing is not suppressed', 'Listing snapshots'],
    ['moderation', 'Creative is approved by Amazon', 'Moderation status'],
  ] as const) result.push({ id, label, source, status: 'not_measured', blocking: false, currentValue: 'Not measured', requiredAction: 'Review separately before upload.' });
  return result;
}

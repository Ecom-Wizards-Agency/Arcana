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
  const check = (id: CampaignBuilderCheck['id'], label: string, source: string, pass: boolean | null, currentValue: string, requiredAction: string, requiredValue?: string): CampaignBuilderCheck => ({
    id, label: pass === true && id === 'unique-name' ? 'Campaign name is not already in use' : pass === true && id === 'naming' ? 'Name matches your saved convention' : label, source, status: pass === null ? 'not_measured' : pass ? 'passed' : 'blocked',
    blocking: pass !== true, currentValue, requiredAction: pass === true ? '' : requiredAction, ...(requiredValue ? { requiredValue } : {}),
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
  const currency = campaigns[0]?.payload.budget.currencyCode;
  const money = (value: number | null) => value === null ? 'Not measured' : currency
    ? new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 6 }).format(value) : String(value);
  const belowBudget = input.budget !== null && campaigns.some((node) => node.payload.budget.amount < input.budget!.minimum);
  const aboveBudget = input.budget !== null && campaigns.some((node) => node.payload.budget.amount > input.budget!.maximum);
  const budgetRule = input.budget ? `at least ${money(input.budget.minimum)} and at most ${money(input.budget.maximum)}` : 'Marketplace budget limits are not measured';
  const missingBounds = bounds.floor === null || bounds.ceiling === null || bounds.exposureCeiling === null;
  const outsideBase = bids.some((bid) => bounds.floor !== null && bid < bounds.floor || bounds.ceiling !== null && bid > bounds.ceiling);
  const invalidPrecision = bids.some((bid) => Math.abs(bid * 10 ** bounds.decimalPlaces - Math.round(bid * 10 ** bounds.decimalPlaces)) >= 1e-7);
  const exceeded = exposures.some((value) => bounds.exposureCeiling !== null && value > bounds.exposureCeiling + Number.EPSILON);
  const exposureLabel = missingBounds ? 'Bid limits are not measured' : outsideBase ? 'Starting bid is outside the allowed range' : invalidPrecision ? 'Starting bid exceeds marketplace precision' : exceeded ? 'Maximum exposure exceeds the hard ceiling' : 'Bid × placement multiplier stays under the ceiling';
  const result = [
    check('budget', input.budget === null ? 'Marketplace budget limits are not measured' : belowBudget ? 'Daily budget is below the marketplace minimum' : aboveBudget ? 'Daily budget exceeds the marketplace maximum' : 'Daily budget meets the marketplace minimum', 'Marketplace rules', input.budget === null ? null : !belowBudget && !aboveBudget, campaigns.map((node) => money(node.payload.budget.amount)).join(', '), input.budget ? belowBudget ? `Set the daily budget to at least ${money(input.budget.minimum)}.` : `Set the daily budget to at most ${money(input.budget.maximum)}.` : 'Load the marketplace budget rules before validating.', budgetRule),
    check('unique-name', input.existingNames === null ? 'Campaign name availability is not measured' : 'Campaign name is already in use or repeated in this draft', 'Campaign mirror', input.existingNames === null ? null : new Set(names).size === names.length && names.every((name) => !input.existingNames!.includes(name)), names.join('; '), 'Choose a distinct campaign name.'),
    check('naming', input.naming === null ? 'No saved naming convention is available' : 'Campaign name does not match the saved convention', 'Your naming preset', input.naming === null ? null : names.every((name) => input.parsedNames.some((parsed) => parsed.name === name && parsed.confidence !== 'none' && JSON.stringify(parsed.naming) === JSON.stringify(input.naming))), names.join('; '), 'Edit the name to match the saved convention.', input.naming ? `Tokens: ${(input.naming.variable_order ?? []).join(' · ')}; separator “${input.naming.delimiter ?? ''}”` : 'Save a naming convention'),
    check('exposure', exposureLabel, 'Your exposure ceiling', missingBounds ? null : bids.length > 0 && !outsideBase && !invalidPrecision && !exceeded,
      outsideBase || invalidPrecision ? bids.map(money).join(', ') : exposures.length ? exposures.map(money).join(', ') : 'Unavailable',
      missingBounds ? 'Configure the missing strategy and marketplace bid limits.' : `Use a base bid from ${money(bounds.floor)} to ${money(bounds.ceiling)} with at most ${bounds.decimalPlaces} decimal places; keep exposure at most ${money(bounds.exposureCeiling)}.`, money(bounds.exposureCeiling)),
    check('capability', supported ? 'Ad type supports the controls you set' : 'Ad type does not support the selected controls', 'Capability snapshot', supported, `${input.plan.adProduct} · ${input.capabilities.version}`, 'Use controls verified in this capability snapshot.'),
  ];
  for (const [id, label, source] of [
    ['stock', 'Product is in stock', 'Listing snapshots'],
    ['buy-box', 'Product holds the Buy Box', 'Listing snapshots'],
    ['suppression', 'Listing is not suppressed', 'Listing snapshots'],
    ['moderation', 'Creative is approved by Amazon', 'Moderation status'],
  ] as const) result.push({ id, label, source, status: 'not_measured', blocking: false, currentValue: 'Not measured', requiredAction: 'Review separately before upload.' });
  return result;
}

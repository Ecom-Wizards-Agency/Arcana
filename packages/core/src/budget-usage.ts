import type { BudgetUsageEvidence, BudgetUsageObservation, BudgetUsageRead, BudgetUsageSource, CampaignBudgetUsageRead, PortfolioPacingRead, PortfolioSpendEvidence } from '@wizard-ads/shared';

/** Amount and percentage must describe the same provider observation and budget interval. */
export function campaignRemainingBudget(observation: BudgetUsageObservation): number | null {
  if (observation.budgetAmount === null || observation.usagePercent === null || observation.currency === null
    || observation.budgetType === null || observation.period === null) return null;
  return observation.budgetAmount === 0 ? 0 : observation.budgetAmount * (1 - observation.usagePercent / 100);
}

/** Source precedence is per campaign. Receipt time never renews provider evidence. */
export function selectBudgetUsage(evidence: BudgetUsageEvidence, now: string): BudgetUsageRead {
  const enabled = (source: BudgetUsageSource) => (source === 'amazon_ads_api' ? evidence.config.apiEnabled : evidence.config.streamEnabled)
    && evidence.sources.some((row) => row.source === source && row.enabled);
  const anyEnabled = enabled('amazon_ads_api') || enabled('amazon_marketing_stream');
  const fresh = (row: BudgetUsageObservation) => evidence.config.maxAgeSeconds !== null
    && Date.parse(now) >= Date.parse(row.providerUpdatedAt)
    && Date.parse(now) - Date.parse(row.providerUpdatedAt) <= evidence.config.maxAgeSeconds * 1000;
  const campaigns: CampaignBudgetUsageRead[] = evidence.campaigns.map((campaign) => {
    const base = { adProduct: campaign.adProduct, campaignId: campaign.campaignId, campaignName: campaign.campaignName };
    const observations = evidence.observations.filter((row) => row.orgId === evidence.orgId && row.profileId === evidence.profileId
      && row.campaignId === campaign.campaignId && row.adProduct === campaign.adProduct && enabled(row.source))
      .sort((a, b) => Date.parse(b.providerUpdatedAt) - Date.parse(a.providerUpdatedAt) || a.sourceIdentity.localeCompare(b.sourceIdentity));
    const api = observations.find((row) => row.source === 'amazon_ads_api');
    const stream = evidence.config.allowFreshStreamFallback ? observations.find((row) => row.source === 'amazon_marketing_stream') : undefined;
    const usable = (row: BudgetUsageObservation | undefined) => row !== undefined && row.usagePercent !== null && fresh(row);
    const selected = usable(api) ? api : usable(stream) ? stream : api ?? stream;
    if (!selected) return { ...base, availability: anyEnabled ? 'unavailable' : 'disabled', observation: null, nearLimit: null, remainingAmount: null };
    const source = evidence.sources.find((row) => row.source === selected.source);
    const availability = selected.usagePercent === null || evidence.config.maxAgeSeconds === null ? 'unavailable'
      : !fresh(selected) ? 'stale' : selected.completeness === 'partial' || !source?.complete ? 'partial' : 'measured';
    const measured = availability === 'measured' || availability === 'partial';
    return { ...base, availability, observation: selected,
      nearLimit: measured && evidence.config.nearLimitPercent !== null ? selected.usagePercent! >= evidence.config.nearLimitPercent : null,
      remainingAmount: campaignRemainingBudget(selected) };
  });
  const measuredCampaigns = campaigns.filter((row) => row.availability === 'measured' || row.availability === 'partial').length;
  const partialSource = evidence.sources.some((row) => enabled(row.source) && !row.complete && row.requested > 0);
  const availability = !anyEnabled ? 'disabled' : measuredCampaigns > 0
    ? measuredCampaigns !== evidence.totalCampaigns || partialSource || campaigns.some((row) => row.availability === 'partial') ? 'partial' : 'measured'
    : campaigns.some((row) => row.availability === 'stale') ? 'stale' : partialSource ? 'partial' : 'unavailable';
  return { availability, campaigns, measuredCampaigns, totalCampaigns: evidence.totalCampaigns };
}

/** The reader supplies an evidenced budget interval; an unknown policy supplies none. */
export function computePortfolioPacing(evidence: PortfolioSpendEvidence): PortfolioPacingRead {
  const empty = { evidence, budgetToDate: null, pace: null, remainingAmount: null };
  if (evidence.period === null || evidence.budgetAmount === null || evidence.currency === null || evidence.spend === null
    || evidence.memberCampaigns === 0 || evidence.asOf < evidence.period.start || evidence.asOf > evidence.period.end) {
    return { ...empty, availability: 'unavailable' };
  }
  if (!evidence.membershipComplete || evidence.expectedCampaignDays === 0
    || evidence.observedCampaignDays !== evidence.expectedCampaignDays || evidence.oldestLoadedAt === null) {
    return { ...empty, availability: 'partial' };
  }
  const day = 86400000;
  const totalDays = (Date.parse(evidence.period.end) - Date.parse(evidence.period.start)) / day + 1;
  const elapsedDays = (Date.parse(evidence.asOf) - Date.parse(evidence.period.start)) / day + 1;
  const budgetToDate = evidence.budgetAmount * elapsedDays / totalDays;
  return { evidence, availability: 'measured', budgetToDate, pace: budgetToDate > 0 ? evidence.spend / budgetToDate : null,
    remainingAmount: evidence.budgetAmount - evidence.spend };
}

import { describe, expect, it } from 'vitest';
import { CampaignCreationNodeV1, spMarketplaceScopeForCountry, type NamingStrategy } from '@wizard-ads/shared';
import { spCoordinatedCapabilities } from '../methods/capabilities.js';
import { campaignBuilderEligibility } from './eligibility.js';
const id = (n: number) => `27000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const naming: NamingStrategy = { variable_order: ['Keyword'], delimiter: ' / ' };
const common = { adProduct: 'SP', apiDialect: 'sp_legacy_v3', fingerprint: 'a'.repeat(64), effect: 'irreversible_create', rollback: 'none' };
const campaign = CampaignCreationNodeV1.parse({ ...common, nodeId: id(1), kind: 'campaign.create', dependsOn: [], payload: { name: 'synthetic keyword', state: 'paused', budget: { type: 'daily', amount: 7.25, currencyCode: 'USD' }, startDate: '2026-06-10', endDate: null, portfolioId: null, settings: { product: 'SP', targetingType: 'manual', biddingStrategy: 'manual', placementBidding: { topOfSearch: 140, restOfSearch: 0, productPages: 0 } } } });
const target = CampaignCreationNodeV1.parse({ ...common, nodeId: id(2), kind: 'target.create', dependsOn: [id(3)], payload: { targetType: 'keyword', parent: { source: 'plan_node', kind: 'ad_group', nodeId: id(3) }, scope: 'ad_group', polarity: 'positive', text: 'synthetic keyword', matchType: 'exact', bid: 0.36, state: 'paused' } });
const input: Parameters<typeof campaignBuilderEligibility>[0] = { plan: { adProduct: 'SP', nodes: [campaign, target] }, budget: { minimum: 2, maximum: 99 }, existingNames: [], naming,
  parsedNames: [{ name: 'synthetic keyword', naming, confidence: 'exact' }], bounds: { floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 }, audienceAdjustment: 0,
  capabilities: spCoordinatedCapabilities(spMarketplaceScopeForCountry('US', 'NA', 'USD')) };
describe('five runnable campaign creation checks', () => {
  it('passes measured checks and keeps four unmeasured sources separate', () => {
    const result = campaignBuilderEligibility(input);
    expect(result.filter((row) => row.status === 'passed').map((row) => row.id)).toEqual(['budget', 'unique-name', 'naming', 'exposure', 'capability']);
    expect(result.filter((row) => row.status === 'not_measured')).toHaveLength(4);
    expect(result.filter((row) => row.status === 'not_measured').every((row) => !row.blocking)).toBe(true);
  });
  it.each(['budget', 'unique-name', 'naming', 'exposure', 'capability'] as const)('fails the %s check with conflicting inputs', (id) => {
    const changed = structuredClone(input);
    if (id === 'budget') changed.budget = { minimum: 9, maximum: 99 };
    if (id === 'unique-name') changed.existingNames = ['synthetic keyword'];
    if (id === 'naming') changed.naming = { ...naming, delimiter: ' ~ ' };
    if (id === 'exposure') changed.bounds.exposureCeiling = 0.2;
    if (id === 'capability') changed.capabilities.entries = [];
    expect(campaignBuilderEligibility(changed).find((row) => row.id === id)).toMatchObject({ status: 'blocked', blocking: true });
  });
  it('blocks absent rules instead of treating an unknown bound as zero or passed', () => {
    const result = campaignBuilderEligibility({ ...input, budget: null, existingNames: null, naming: null, bounds: { ...input.bounds, exposureCeiling: null } });
    expect(result.filter((row) => row.blocking).map((row) => row.id)).toEqual(['budget', 'unique-name', 'naming', 'exposure']);
    expect(result.filter((row) => row.blocking).every((row) => row.status === 'not_measured')).toBe(true);
  });
  it('records exact budget amounts and both marketplace requirements with a failure-specific label', () => {
    const result = campaignBuilderEligibility({ ...input, budget: { minimum: 9, maximum: 99 } });
    expect(result.find((row) => row.id === 'budget')).toMatchObject({ label: 'Daily budget is below the marketplace minimum', currentValue: '$7.25', requiredValue: 'at least $9.00 and at most $99.00', requiredAction: 'Set the daily budget to at least $9.00.' });
    expect(campaignBuilderEligibility({ ...input, budget: { minimum: 2, maximum: 6 } }).find((row) => row.id === 'budget')?.label).toBe('Daily budget exceeds the marketplace maximum');
  });
  it('distinguishes base range, precision and hard exposure failures and retains the reviewed ceiling', () => {
    expect(campaignBuilderEligibility({ ...input, bounds: { ...input.bounds, ceiling: 0.2 } }).find((row) => row.id === 'exposure')).toMatchObject({ label: 'Starting bid is outside the allowed range', currentValue: '$0.36' });
    expect(campaignBuilderEligibility({ ...input, bounds: { ...input.bounds, decimalPlaces: 1 } }).find((row) => row.id === 'exposure')?.label).toBe('Starting bid exceeds marketplace precision');
    expect(campaignBuilderEligibility({ ...input, bounds: { ...input.bounds, exposureCeiling: 0.2 } }).find((row) => row.id === 'exposure')).toMatchObject({ label: 'Maximum exposure exceeds the hard ceiling', currentValue: '$0.864', requiredValue: '$0.20' });
    const saved = campaignBuilderEligibility(input).find((row) => row.id === 'exposure');
    campaignBuilderEligibility({ ...input, bounds: { ...input.bounds, exposureCeiling: 0.2 } });
    expect(saved).toMatchObject({ status: 'passed', requiredValue: '$2.40' });
  });
});

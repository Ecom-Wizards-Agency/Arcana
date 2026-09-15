import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CampaignBuilderRecipe, verifyCampaignCreationPlanFingerprints } from '@wizard-ads/shared';
import { buildCampaignRecipe, campaignRecipeCreationPlan } from './builder-plan.js';
import { namingSettingsFromStrategy, parseCampaignName } from './naming.js';
import { creationPlanToBulkWorkbook } from './creation-bulk.js';
import { SP_COLUMNS } from './constants.js';
import { planToRows } from './plan.js';
const id = (n: number) => `27000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const recipe = CampaignBuilderRecipe.parse({ adType: 'SP', productKeys: ['synthetic-product'], play: 'rank', groupId: id(5), dailyBudget: 7.25,
  keywords: [{ text: 'synthetic one', bid: 0.36, basis: 'manual' }, { text: 'synthetic two', bid: 0.48, basis: 'manual' }],
  structure: 'keyword-product', topOfSearch: 140, audienceAdjustment: 0, naming: { variable_order: ['Goal','AdType','MatchType','ProductName','Keyword','Custom1'], delimiter: ' / ', suffix: 'QA', custom1_value: 'QA' }, names: {} });
const context = { profile: { id: id(2), label: 'Synthetic account', currencyCode: 'USD', countryCode: 'US', marketplace: null },
  products: [{ key: 'synthetic-product', asin: 'B000000270', sku: 'SKU-SYNTHETIC', name: 'Synthetic product', state: 'enabled', observedAt: null }], today: '2026-06-10' };
describe('builder bulk plan and review graph', () => {
  it('conserves campaign/product/keyword counts and every per-keyword bid', () => {
    const plan = buildCampaignRecipe(recipe, context);
    expect(plan.campaigns).toHaveLength(2);
    expect(plan.campaigns.flatMap((campaign) => campaign.adGroup.keywords.map((keyword) => keyword.bid))).toEqual([0.36,0.48]);
    expect(plan.campaigns.every((campaign) => campaign.state === 'paused')).toBe(true);
    expect(plan.campaigns.flatMap((campaign) => campaign.adGroup.productAds)).toHaveLength(2);
  });
  it('maps the sentence control to one keyword set per product', () => {
    const plan = buildCampaignRecipe({ ...recipe, structure: 'set-product', play: 'profit' }, context);
    expect(plan.campaigns).toHaveLength(1); expect(plan.campaigns[0]!.adGroup.keywords).toHaveLength(2);
  });
  it('freezes a valid ordered graph with no dispatch scope', () => {
    let counter = 20;
    const hasher = { algorithm: 'sha256' as const, digest: (text: string) => createHash('sha256').update(text).digest('hex') };
    const plan = campaignRecipeCreationPlan(buildCampaignRecipe(recipe, context), { orgId: id(1), profileId: id(2), marketplaceId: 'synthetic-market', currencyCode: 'USD', now: '2026-06-10T00:00:00Z', expiresAt: '2026-06-11T00:00:00Z', uuid: () => id(counter++), hasher });
    expect(plan.counts.irreversibleCreates).toBe(8); expect(plan.counts.readChecks).toBe(1);
    expect(plan.nodes.map((node) => node.kind)).toEqual(['eligibility.require_product','campaign.create','campaign.create','ad_group.create','ad_group.create','ad.create','ad.create','target.create','target.create']);
    expect(verifyCampaignCreationPlanFingerprints(plan, hasher)).toEqual(plan);
    expect('providerScope' in plan).toBe(false);
  });
  it('uses the supplied convention and refuses missing or unsupported inputs', () => {
    const name = buildCampaignRecipe(recipe, context).campaigns[0]!.name;
    expect(parseCampaignName(name, namingSettingsFromStrategy(recipe.naming)).slots['Keyword']).toBe('synthetic one');
    expect(parseCampaignName('unparseable', namingSettingsFromStrategy(recipe.naming)).confidence).toBe('none');
    expect(() => namingSettingsFromStrategy({})).toThrow();
    expect(() => buildCampaignRecipe({ ...recipe, adType: 'SB' }, context)).toThrow();
    expect(() => buildCampaignRecipe(recipe, { ...context, products: [] })).toThrow();
  });
  it('exports every frozen resource and exact keyword bid without consulting changed mirror values', () => {
    let counter = 100;
    const plan = campaignRecipeCreationPlan(buildCampaignRecipe(recipe, context), { orgId: id(1), profileId: id(2), marketplaceId: 'synthetic-market', currencyCode: 'USD', now: '2026-06-10T00:00:00Z', expiresAt: '2026-06-11T00:00:00Z', uuid: () => id(counter++), hasher: { algorithm: 'sha256', digest: (text) => createHash('sha256').update(text).digest('hex') } });
    const changedContext = structuredClone(context); changedContext.products[0]!.sku = 'CHANGED-SKU';
    const artifact = creationPlanToBulkWorkbook(plan);
    const rows = artifact.sheet.rows.map((row) => Object.fromEntries(SP_COLUMNS.map((column, index) => [column, row[index]])));
    expect(rows.filter((row) => row.Entity !== 'Bidding Adjustment')).toHaveLength(plan.counts.irreversibleCreates);
    expect(rows.filter((row) => row.Entity === 'Product Ad').map((row) => row.SKU)).toEqual(['SKU-SYNTHETIC', 'SKU-SYNTHETIC']);
    expect(rows.filter((row) => row.Entity === 'Keyword').map((row) => [row['Keyword Text'], row.Bid, row['Match Type']])).toEqual([['synthetic one', 0.36, 'exact'], ['synthetic two', 0.48, 'exact']]);
    const wireColumns = ['Entity', 'Targeting Type', 'Bidding Strategy', 'Keyword Text', 'Match Type', 'Bid', 'SKU', 'ASIN', 'Daily Budget', 'State'];
    const wireValues = (input: Readonly<Record<string, unknown>>[]) => input.map((row) => wireColumns.map((column) => row[column]));
    expect(wireValues(rows)).toEqual(wireValues(planToRows(buildCampaignRecipe(recipe, context))));
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
  });
});

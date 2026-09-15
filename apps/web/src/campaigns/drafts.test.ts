import { describe, expect, it } from 'vitest';
import { CampaignBuilderValidation } from '@wizard-ads/shared';
import { builderContext, savedDraft, fixtureTime } from '../screens/campaigns/render-fixture';
import { validateBuilderDraft } from './drafts';
describe('exact-draft eligibility', () => {
  const validate = (context = builderContext, names: string[] = []) => CampaignBuilderValidation.parse(validateBuilderDraft(savedDraft, context, names, fixtureTime));
  it('runs all eight executable checks and reports all four unmeasured sources without passing them', () => {
    const result = validate(); expect(result.checks).toHaveLength(12);
    expect(result.checks.filter((row) => row.status === 'passed')).toHaveLength(8);
    expect(result.checks.filter((row) => row.status === 'not_measured')).toHaveLength(4);
    expect(result.checks.some((row) => row.blocking)).toBe(false);
    expect(result.planFingerprint).toBe(savedDraft.plan.fingerprint);
  });
  it.each(['budget', 'unique-name', 'naming', 'exposure', 'capability'] as const)('blocks the runnable %s check on changed evidence', (id) => {
    const context = structuredClone(builderContext); const names: string[] = [];
    if (id === 'budget') context.budget = { minimum: 9, maximum: 99 };
    if (id === 'unique-name') names.push(savedDraft.plan.nodes.find((node) => node.kind === 'campaign.create')!.payload.name);
    if (id === 'naming') context.naming = { ...context.naming!, delimiter: ' ~ ' };
    if (id === 'exposure') context.exposureCeiling = 0.2;
    if (id === 'capability') context.capabilities.entries = context.capabilities.entries.map((entry) => ({ ...entry, available: false }));
    expect(validate(context, names).checks.find((row) => row.id === id)).toMatchObject({ status: 'blocked', blocking: true });
  });
  it('requires current product identity, permissions and the saved convention', () => {
    const context = { ...builderContext, canEdit: false, naming: null, products: builderContext.products.map((product) => ({ ...product, sku: 'CHANGED-SKU' })) };
    const checks = validate(context).checks;
    expect(checks.filter((row) => row.blocking).map((row) => row.id).sort()).toEqual(['naming', 'permission', 'product']);
    expect(checks.find((row) => row.id === 'naming')?.status).toBe('not_measured');
  });
  it('rejects a validation document that omits checks or marks unknown listing checks passed', () => {
    const result = validate();
    expect(CampaignBuilderValidation.safeParse({ ...result, checks: [] }).success).toBe(false);
    expect(CampaignBuilderValidation.safeParse({ ...result, checks: result.checks.map((row) => row.id === 'stock' ? { ...row, status: 'passed' } : row) }).success).toBe(false);
  });
});

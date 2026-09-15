import { describe, expect, it } from 'vitest';
import { campaignCreationExecutorAvailable, CampaignBuilderCheck, CampaignBuilderRecipe } from './campaign-builder.js';

describe('campaign builder boundary', () => {
  it('requires both an environment gate and a registered executor', () => {
    expect(campaignCreationExecutorAvailable({})).toBe(false);
    expect(campaignCreationExecutorAvailable({ CAMPAIGN_CREATION_EXECUTOR_ENABLED: 'true' })).toBe(false);
    expect(campaignCreationExecutorAvailable({}, true)).toBe(false);
    expect(campaignCreationExecutorAvailable({ CAMPAIGN_CREATION_EXECUTOR_ENABLED: 'true' }, true)).toBe(true);
  });
  it('does not accept write authority or validation in a recipe', () => {
    expect(CampaignBuilderRecipe.safeParse({ approved: true }).success).toBe(false);
  });
  it('cannot call a blocking check passed', () => {
    expect(CampaignBuilderCheck.safeParse({ id: 'budget', label: 'Budget', source: 'Marketplace', status: 'passed', blocking: true, currentValue: '', requiredAction: '' }).success).toBe(false);
  });
});

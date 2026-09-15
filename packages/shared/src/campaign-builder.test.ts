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

describe('campaign display snapshot and queue registration', () => {
  it('covers all four ad types with sourced guidance without granting execution', async () => {
    const { CAMPAIGN_AD_TYPE_SNAPSHOT } = await import('./campaign-builder.js');
    expect(CAMPAIGN_AD_TYPE_SNAPSHOT.version).toBe('campaign-ad-types.2026-09-15.v1');
    expect(CAMPAIGN_AD_TYPE_SNAPSHOT.entries.map((entry) => [entry.adType, entry.rows.filter((row) => row.supported).length, entry.rows.filter((row) => !row.supported).length])).toEqual([['SP',4,1],['SB',3,2],['SBV',3,1],['SD',2,2]]);
    for (const entry of CAMPAIGN_AD_TYPE_SNAPSHOT.entries) expect(entry.source).toContain('95:2');
    expect(campaignCreationExecutorAvailable({})).toBe(false);
  });
  it('parses the read-only asset job through the actual queue union', async () => {
    const { JobPayload, JobType } = await import('./jobs.js');
    const job = { type: 'asset-library.search', orgId: '27000000-0000-4000-8000-000000000001', profileId: '27000000-0000-4000-8000-000000000002' };
    expect(JobType.options).toContain(job.type); expect(JobPayload.parse(job)).toEqual(job);
    expect(JobPayload.safeParse({ ...job, upload: true }).success).toBe(false);
  });
});

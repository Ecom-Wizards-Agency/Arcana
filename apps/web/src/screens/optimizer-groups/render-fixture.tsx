import { context, profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "profile": profile, "workspace": { "groups": [], "campaigns": [], "profileTimezone": '', "reviewHour": 0, "assignedCampaigns": 0, "unassignedCampaigns": 0 }, "context": context, "previewReadiness": { "ready": true, "mode": "fenced" } } } satisfies ScreenData;

export const populated = { ...ready, props: { ...ready.props, workspace: {
  groups: [{ group: { version: 2 as const, id: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222', profileId: profile.id,
    name: 'Synthetic efficiency group', role: 'profit' as const, targetAcos: .27, bidFloor: .12, bidCeiling: 2.4, bidIncreaseCap: .18, bidDecreaseCap: .31,
    placementIncreaseCap: .21, placementDecreaseCap: .33, exclusions: [], reviewSchedule: { version: 2 as const, weekdays: ['monday', 'thursday'] as ('monday' | 'thursday')[] }, prioritization: 'balanced' as const, enabled: true }, campaignIds: ['synthetic-campaign'], nextRunAt: null, lastRun: null }],
  campaigns: [{ campaignId: 'synthetic-campaign', name: 'Synthetic campaign', adProduct: 'SP' as const, state: 'enabled', dailyBudget: null, groupId: '11111111-1111-4111-8111-111111111111' }],
  profileTimezone: 'UTC', reviewHour: 4, assignedCampaigns: 1, unassignedCampaigns: 0,
} } } satisfies ScreenData;

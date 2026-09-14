import { context, profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "profile": profile, "workspace": { "groups": [], "campaigns": [], "profileTimezone": '', "reviewHour": 0, "assignedCampaigns": 0, "unassignedCampaigns": 0 }, "context": context, "previewReadiness": { "ready": true, "mode": "fenced" } } } satisfies ScreenData;

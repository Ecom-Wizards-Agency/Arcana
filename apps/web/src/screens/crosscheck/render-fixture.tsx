import type { CrosscheckPanelModel } from '@wizard-ads/crosscheck-cli/pure';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "data": { "profiles": [], "selected": null, "model": null, "ranAt": null } } } satisfies ScreenData;

const figures = [
  { metric: 'ad_spend', ours: 120.5, theirs: 121, deltaPct: -0.004, verdict: 'verified' },
  { metric: 'ad_sales', ours: 480, theirs: 482.25, deltaPct: -0.005, verdict: 'verified' },
] as const satisfies CrosscheckPanelModel['days'][number]['figures'];
const model: CrosscheckPanelModel = {
  profileId: '10000000-0000-4000-8000-000000000050',
  chip: { verdict: 'verified', label: 'Verified', tone: 'good', asOf: '2026-09-13', verifiedStreak: 2 },
  days: [
    { date: '2026-09-14', verdict: 'skipped_provisional', figures: [] },
    { date: '2026-09-13', verdict: 'verified', figures: [...figures] },
    { date: '2026-09-12', verdict: 'verified', figures: [...figures] },
  ],
  mismatchingCampaigns: [], campaignsCompared: 4, tolerance: 0.07, sources: ['synthetic-export.csv'],
};
export const compared = { "view": "ready", "props": { "data": {
  "profiles": [{ profileId: model.profileId!, label: 'Synthetic profile', region: 'EU' }], "selected": model.profileId, model, "ranAt": '2026-09-15T06:10:00Z' } } } satisfies ScreenData;

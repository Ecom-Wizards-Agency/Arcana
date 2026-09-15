import { kpiTiles } from '../../optimizer/view';
import { period, profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "run": null, "summary": { "targetAcos": null, "objective": null, "uniform": false }, "profile": profile, "period": period, "today": '2026-08-29', "params": {}, "freshness": { "tone": "good", "headline": '', "details": [], "staleTypes": [], "lossyTypes": [], "coversThrough": null }, "runs": [], "cockpitDays": [], "tiles": kpiTiles(null, null), "settled": { "current": null, "comparison": null, "settling": { "start": '2026-08-29', "end": '2026-08-29' } }, "coverageStart": null, "campaignRows": [], "savedMethods": {}, "mayRunOptimizer": false, "previewReadiness": { "ready": true, "mode": "fenced" }, "coverage": [], "proposals": [], "campaignGroups": [] } } satisfies ScreenData;

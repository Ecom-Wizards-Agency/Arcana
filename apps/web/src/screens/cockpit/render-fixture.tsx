import { kpiTiles } from '../../optimizer/view';
import { period, profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "profile": profile, "period": period, "today": '2026-08-29', "currentWindow": null, "settled": { "current": null, "comparison": null, "settling": { "start": '2026-08-29', "end": '2026-08-29' } }, "coverageClamped": false, "freshness": { "tone": "good", "headline": '', "details": [], "staleTypes": [], "lossyTypes": [], "coversThrough": null }, "slot1": <span>Streamed evidence</span>, "cockpitDays": [], "tiles": kpiTiles(null, null), "settlingWindow": { "label": 'Synthetic account', "start": '2026-08-29', "end": '2026-08-29' }, "accountRows": [], "pacing": null, "context": { "currencyCode": 'USD' }, "slot2": <span>Streamed evidence</span>, "slot3": <span>Streamed evidence</span> } } satisfies ScreenData;

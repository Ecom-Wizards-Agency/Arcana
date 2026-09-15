import { period, profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "negativeOptions": null, "profile": profile, "period": period, "payload": { "rows": [], "truncated": false }, "scopes": { "campaigns": [], "tags": [] } } } satisfies ScreenData;

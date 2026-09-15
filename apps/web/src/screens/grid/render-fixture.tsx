import { period, profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "entity": "campaigns", "catalogue": null, "profile": profile, "period": period, "comparison": period, "params": {}, "slot1": <span>Streamed evidence</span>, "actor": { "orgId": 'synthetic-identity', "userId": 'synthetic-identity' }, "freshness": <span>Streamed freshness evidence</span> } } satisfies ScreenData;

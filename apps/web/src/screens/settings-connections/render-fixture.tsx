import { context, org } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "context": context, "query": {}, "operation": null, "spApiOperation": null, "spApiEnabled": false, "spApi": {"connections": [], "profiles": [], "bindings": []}, "mayConnect": false, "enabled": false, "connections": [], "inProgress": false, "org": org, "connected": false, "roster": { "rows": [], "total": 0, "countries": [], "regionCounts": {} } } } satisfies ScreenData;

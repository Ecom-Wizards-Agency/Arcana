import { context, org } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "context": context, "countLabel": '', "roster": { "rows": [], "total": 0, "countries": [], "regionCounts": {} }, "filtered": false, "org": org, "query": {}, "sort": "name", "mayEditTargets": false, "mayToggleSync": false, "rowIds": [], "visibleRows": [], "pageCount": 0, "currentPage": 0, "pageHref": () => ('') } } satisfies ScreenData;

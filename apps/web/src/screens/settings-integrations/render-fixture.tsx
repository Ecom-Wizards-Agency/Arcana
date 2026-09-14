import { context } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "context": context, "mayManage": false, "connections": [], "competitorLinks": [], "profiles": [], "mayEditCompetitors": false } } satisfies ScreenData;

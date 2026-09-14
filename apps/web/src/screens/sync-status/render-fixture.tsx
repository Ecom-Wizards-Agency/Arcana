import { context } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "context": context, "status": { "deadLetters": [], "lifecycle": [], "freshness": [], "jobs": [], "reports": [] } } } satisfies ScreenData;

import { profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "run": null, "proposals": [], "profile": profile, "runs": [], "role": "owner" } } satisfies ScreenData;

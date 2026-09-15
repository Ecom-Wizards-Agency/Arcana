import { context, org } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "context": context, "active": org, "members": [], "invitations": [] } } satisfies ScreenData;

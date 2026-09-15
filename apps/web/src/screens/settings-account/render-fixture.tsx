import { context } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "context": context, "totp": { "status": "ok", "factors": [] }, "next": '', "config": { "passwordLogin": false, "passwordRecovery": false, "googleLogin": false, "totpPolicy": "off", "passkeyPolicy": "off" } } } satisfies ScreenData;

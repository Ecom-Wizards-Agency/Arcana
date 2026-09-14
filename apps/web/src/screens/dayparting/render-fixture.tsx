import { profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "profile": profile, "summary": { "firstLocalDate": null, "lastLocalDate": null, "timeZone": null, "settledHours": 0, "settlingHours": 0, "revisedHours": 0, "cappedHours": 0, "campaigns": [] }, "workspace": { "facts": [], "proposals": [], "coverage": { "ledgerMessages": 0, "latestReceivedAt": null }, "maturityPolicyConfigured": false }, "campaignId": null, "campaignChoices": [], "metric": "roas", "showAllEvidence": false, "from": '2026-08-29', "to": '2026-08-29', "selectedFacts": [], "evidence": [], "cellMap": new Map(), "proposals": [] } } satisfies ScreenData;

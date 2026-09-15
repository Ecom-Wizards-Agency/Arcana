import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "profiles": [], "selectedProfileId": null, "query": {}, "scope": { "campaignIds": [], "adGroupIds": [], "targetIds": [], "asins": [], "searchTerms": [] }, "scopeOptions": { "campaigns": [], "products": [] } } } satisfies ScreenData;

import { profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "profiles": [], "profile": profile, "reversionBatches": [], "selectedBatch": null, "reversionPreview": null, "role": "owner", "hasAnyHistory": false, "entityType": null, "facets": { "entityTypes": [], "fields": [] }, "field": null, "source": null, "from": null, "toParam": null, "filtersActive": false, "base": () => (''), "cursor": null, "pageHref": () => (''), "entries": [], "days": [], "hasOlder": false } } satisfies ScreenData;

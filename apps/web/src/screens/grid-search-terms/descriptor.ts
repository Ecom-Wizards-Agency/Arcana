import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "grid-search-terms",
  "path": "/grid?entity=search_terms",
  "route": "preset",
  "nav": {
    "group": "performance",
    "label": "Search terms",
    "icon": "search",
    "order": 3
  },
  "guard": null,
  "prefetch": "expensive",
  "rollout": {
    "enabled": true
  },
  "states": [
    "gated"
  ],
  "entry": "redirect",
  "specs": [],
  load: (_actor, params) => import('../virtual-screen').then((module) => module.loadPreset("/grid?entity=search_terms", params)),
  client: () => import('../virtual-screen-view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

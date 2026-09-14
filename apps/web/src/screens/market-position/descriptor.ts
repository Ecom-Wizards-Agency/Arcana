import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "market-position",
  "path": "/market-position",
  "route": "planned",
  "nav": {
    "group": "performance",
    "label": "Market position",
    "icon": "gauge",
    "order": 5
  },
  "guard": null,
  "prefetch": "expensive",
  "rollout": {
    "enabled": false
  },
  "states": [
    "gated"
  ],
  "entry": "redirect",
  "specs": [],
  load: () => import('../virtual-screen').then((module) => module.loadPlanned()),
  client: () => import('../virtual-screen-view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "grid-placements",
  "path": "/grid?entity=placements",
  "route": "preset",
  "nav": {
    "group": "performance",
    "label": "Placements",
    "icon": "icon/placements",
    "order": 6
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
  load: (_actor, params) => import('../virtual-screen').then((module) => module.loadPreset("/grid?entity=placements", params)),
  client: () => import('../virtual-screen-view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

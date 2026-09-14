import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "grid-campaigns",
  "path": "/grid?entity=campaigns",
  "route": "preset",
  "nav": {
    "group": "performance",
    "label": "Campaigns",
    "icon": "icon/campaigns",
    "order": 0
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
  load: (_actor, params) => import('../virtual-screen').then((module) => module.loadPreset("/grid?entity=campaigns", params)),
  client: () => import('../virtual-screen-view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

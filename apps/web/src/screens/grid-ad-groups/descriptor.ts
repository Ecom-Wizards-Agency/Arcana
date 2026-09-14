import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "grid-ad-groups",
  "path": "/grid?entity=ad_groups",
  "route": "preset",
  "nav": {
    "group": "performance",
    "label": "Ad groups",
    "icon": "layers",
    "order": 1
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
  load: (_actor, params) => import('../virtual-screen').then((module) => module.loadPreset("/grid?entity=ad_groups", params)),
  client: () => import('../virtual-screen-view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

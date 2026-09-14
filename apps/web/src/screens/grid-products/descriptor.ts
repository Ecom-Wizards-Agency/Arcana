import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "grid-products",
  "path": "/grid?entity=products",
  "route": "preset",
  "nav": {
    "group": "performance",
    "label": "Products",
    "icon": "tag",
    "order": 4
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
  load: (_actor, params) => import('../virtual-screen').then((module) => module.loadPreset("/grid?entity=products", params)),
  client: () => import('../virtual-screen-view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

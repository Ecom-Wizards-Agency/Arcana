import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "grid-targets",
  "path": "/grid?entity=targets",
  "route": "preset",
  "nav": {
    "group": "performance",
    "label": "Targets",
    "icon": "check",
    "order": 2
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
  load: (_actor, params) => import('../virtual-screen').then((module) => module.loadPreset("/grid?entity=targets", params)),
  client: () => import('../virtual-screen-view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

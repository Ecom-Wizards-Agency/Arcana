import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "creators-sample-shipments",
  "path": "/creators/sample-shipments",
  "route": "planned",
  "nav": {
    "group": "creators",
    "label": "Sample shipments",
    "icon": "layers",
    "order": 2
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

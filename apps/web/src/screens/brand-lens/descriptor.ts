import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "brand-lens",
  "path": "/brand-lens",
  "route": "planned",
  "nav": {
    "group": "research",
    "label": "Brand lens",
    "icon": "icon/brand-lens",
    "order": 3
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

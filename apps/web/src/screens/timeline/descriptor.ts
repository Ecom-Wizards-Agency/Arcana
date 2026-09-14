import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "timeline",
  "path": "/timeline",
  "route": "planned",
  "nav": {
    "group": "timeline",
    "label": "Timeline",
    "icon": "history",
    "order": 0,
    "badgeSource": "timeline"
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

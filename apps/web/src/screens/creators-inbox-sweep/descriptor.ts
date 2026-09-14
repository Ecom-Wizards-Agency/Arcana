import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "creators-inbox-sweep",
  "path": "/creators/inbox-sweep",
  "route": "planned",
  "nav": {
    "group": "creators",
    "label": "Inbox sweep",
    "icon": "icon/search-terms",
    "order": 1
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

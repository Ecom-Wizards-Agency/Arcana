import type { ScreenDescriptor } from '../types';

export const descriptor = {
  "id": "sponsored-prompts",
  "path": "/sponsored-prompts",
  "route": "planned",
  "nav": {
    "group": "performance",
    "label": "Sponsored prompts",
    "icon": "icon/sponsored-prompts",
    "order": 8
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

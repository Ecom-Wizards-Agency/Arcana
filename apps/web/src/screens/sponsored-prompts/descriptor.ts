import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  "id": "sponsored-prompts",
  "path": "/prompts",
  "route": "page",
  "nav": {
    "group": "performance",
    "label": "Sponsored prompts",
    "icon": "icon/sponsored-prompts",
    "order": 8
  },
  "guard": { "kind": "requested", "canonicalProfile": true },
  "prefetch": "expensive",
  "rollout": {
    "enabled": false,
    "envFlag": "WIZARD_ADS_PROMPTS_ENABLED"
  },
  "states": [
    "gated", "loading", "error", "empty", "not-measured"
  ],
  "entry": "gate-message",
  "specs": [{ "file": "sponsored-prompts.spec.ts", "suite": "route-acceptance" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

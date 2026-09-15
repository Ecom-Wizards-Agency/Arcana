import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "strategy",
  path: "/strategy",
  route: "redirect",
  nav: null,
  guard: { "kind": "redirect", "pathname": "/settings/strategy", "hash": "", "canonicalProfile": true, "artifact": "#identifiers", "heading": "Optimization methods" },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error"],
  entry: "gate-message",
  specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

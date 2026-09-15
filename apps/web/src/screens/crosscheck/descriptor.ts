import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "crosscheck",
  title: "Crosscheck",
  path: "/crosscheck",
  route: "page",
  nav: { "group": "utility", "label": "Crosscheck", "icon": "icon/change-queue", "order": 2 },
  guard: { "kind": "requested", "heading": "Crosscheck" },
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated", "empty"],
  entry: "gate-message",
  specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

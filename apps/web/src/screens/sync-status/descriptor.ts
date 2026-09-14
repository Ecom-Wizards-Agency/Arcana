import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "sync-status",
  path: "/sync-status",
  route: "page",
  nav: { "group": "utility", "label": "Sync status", "icon": "clock", "order": 3 },
  guard: { "kind": "requested" },
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated", "empty"],
  entry: "gate-message",
  specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

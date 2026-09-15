import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "bugs",
  title: "Bugs",
  path: "/bugs",
  route: "page",
  nav: { "group": "utility", "label": "Bugs", "icon": "icon/inbox", "order": 5 },
  guard: { "kind": "requested" },
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error", "empty"],
  entry: "request-message",
  specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

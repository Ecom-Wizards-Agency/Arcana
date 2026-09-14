import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "time-machine",
  path: "/time-machine",
  route: "page",
  nav: { "group": "act", "label": "Change queue", "icon": "history", "order": 2, "badgeSource": "change-queue" },
  guard: { "kind": "requested" },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error", "empty"],
  entry: "request-message",
  specs: [{ "file": "time-machine.spec.ts", "suite": "tags-goto" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

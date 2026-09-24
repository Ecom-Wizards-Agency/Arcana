import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "time-machine",
  path: "/change-queue",
  route: "page",
  nav: { "group": "act", "label": "Change queue", "icon": "icon/change-queue", "order": 2, "badgeSource": "change-queue" },
  guard: { "kind": "requested" },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error", "empty", "not-measured", "stale", "refused"],
  entry: "request-message",
  specs: [{ "file": "time-machine.spec.ts", "suite": "tags-goto" }, { "file": "change-queue.spec.ts", "suite": "auth" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

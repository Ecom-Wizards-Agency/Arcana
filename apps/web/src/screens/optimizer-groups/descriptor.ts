import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "optimizer-groups",
  path: "/optimizer/groups",
  route: "page",
  nav: null,
  guard: { "kind": "requested", "canonicalProfile": true },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated", "empty"],
  entry: "gate-message",
  specs: [{ "file": "optimization-groups.spec.ts", "suite": "optimization-groups" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

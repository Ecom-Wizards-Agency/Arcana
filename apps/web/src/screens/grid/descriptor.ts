import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "grid",
  path: "/grid",
  route: "page",
  nav: null,
  guard: { "kind": "requested", "canonicalProfile": true },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated", "empty", "not-measured"],
  entry: "gate-message",
  specs: [{ "file": "grid-performance.spec.ts", "suite": "grid-performance" }, { "file": "grid.spec.ts", "suite": "auth" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

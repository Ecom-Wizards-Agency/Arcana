import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "recommendations",
  path: "/recommendations",
  route: "page",
  nav: null,
  guard: { "kind": "requested", "canonicalProfile": true },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error", "empty", "not-measured"],
  entry: "request-message",
  specs: [{ "file": "recommendations.spec.ts", "suite": "tags-goto" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "query-intelligence",
  path: "/queries",
  route: "page",
  nav: { "group": "research", "label": "Queries", "icon": "icon/queries", "order": 1 },
  guard: { "kind": "requested", "heading": "Query Intelligence" },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error", "empty", "not-measured"],
  entry: "request-message",
  specs: [{file:'research-queries.spec.ts',suite:'route-acceptance'}],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

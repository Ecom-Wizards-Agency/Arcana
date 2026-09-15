import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "dayparting",
  path: "/dayparting",
  route: "page",
  nav: { "group": "research", "label": "Dayparting", "icon": "icon/dayparting", "order": 2 },
  guard: { "kind": "requested", "heading": "Dayparting" },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated", "empty", "not-measured", "draft", "reviewed", "enabled", "paused"],
  entry: "gate-message",
  specs: [{file:'research-dayparting.spec.ts',suite:'route-acceptance'}],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

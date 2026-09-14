import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "settings",
  path: "/settings",
  route: "redirect",
  nav: { "group": "utility", "label": "Settings", "icon": "cog", "order": 0 },
  guard: null,
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error"],
  entry: "redirect",
  specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

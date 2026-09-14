import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "dashboard",
  path: "/dashboard",
  route: "redirect",
  redirectTo: "/",
  nav: null,
  guard: null,
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error"],
  entry: "redirect",
  specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

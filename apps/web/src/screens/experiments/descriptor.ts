import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "experiments",
  title: "Experiments",
  path: "/experiments",
  route: "page",
  nav: null,
  guard: { "kind": "requested" },
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error", "empty"],
  entry: "request-message",
  specs: [{ "file": "experiments.spec.ts", "suite": "tags-goto" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

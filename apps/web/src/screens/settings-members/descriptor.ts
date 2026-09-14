import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "settings-members",
  path: "/settings/members",
  route: "page",
  nav: null,
  guard: { "kind": "requested" },
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated"],
  entry: "gate-message",
  specs: [{ "file": "members.spec.ts", "suite": "auth-members" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "settings-profiles",
  title: "Profiles",
  path: "/settings/profiles",
  route: "page",
  nav: null,
  guard: { "kind": "requested" },
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated", "empty"],
  entry: "gate-message",
  preferredOrg: "query",
  specs: [{ "file": "roles.spec.ts", "suite": "auth-roles" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

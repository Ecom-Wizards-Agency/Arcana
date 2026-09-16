import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "cockpit",
  path: "/",
  route: "page",
  nav: { "group": "home", "label": "Home", "icon": "icon/home", "order": 0 },
  guard: { "kind": "requested", "canonicalProfile": true, "heading": "Dashboard" },
  prefetch: "expensive",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated", "empty", "not-measured"],
  entry: "gate-message",
  specs: [{ "file": "profile-context.spec.ts", "suite": "profile-context" }, { "file": "sidebar-layout.spec.ts", "suite": "profile-context" }, { "file": "guards-anonymous-a.spec.ts", "suite": "auth-guards-anonymous-a" }, { "file": "guards-anonymous-b.spec.ts", "suite": "auth-guards-anonymous-b" }, { "file": "guards-signed-in-a.spec.ts", "suite": "auth-guards-signed-in-a" }, { "file": "guards-signed-in-b.spec.ts", "suite": "auth-guards-signed-in-b" }, { "file": "dashboard.spec.ts", "suite": "auth" }, { "file": "route-acceptance.dashboard.spec.ts", "suite": "route-acceptance" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

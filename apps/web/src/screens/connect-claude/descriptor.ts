import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "connect-claude",
  title: "Connect AI (MCP)",
  path: "/connect-claude",
  route: "page",
  nav: { "group": "utility", "label": "Connect AI", "icon": "icon/sponsored-prompts", "order": 4 },
  guard: { "kind": "requested", "heading": "Connect AI (MCP)" },
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error", "gated", "empty"],
  entry: "gate-message",
  specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

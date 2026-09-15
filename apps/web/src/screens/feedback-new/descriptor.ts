import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: "feedback-new",
  title: "New feedback",
  path: "/feedback/new",
  route: "page",
  nav: { "group": "utility", "label": "Feedback", "icon": "icon/queries", "order": 7 },
  guard: { "kind": "requested" },
  prefetch: "cheap",
  rollout: { "enabled": true },
  states: ["loading", "error"],
  entry: "request-message",
  specs: [{ "file": "feedback.spec.ts", "suite": "tags-goto" }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

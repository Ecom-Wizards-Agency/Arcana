import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';
export const descriptor = {
  id: 'creative-eligibility', path: '/creative/eligibility', title: 'Asset eligibility', route: 'page', nav: null,
  guard: { kind: 'requested' }, prefetch: 'expensive', rollout: { enabled: true },
  states: ['loading', 'error', 'gated', 'empty', 'not-measured'], entry: 'gate-message', specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

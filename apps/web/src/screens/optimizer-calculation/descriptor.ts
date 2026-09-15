import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';
export const descriptor = {
  id: 'optimizer-calculation', path: '/optimizer/review/[batchId]/calculation/[rowId]', title: 'Calculation details', route: 'page', nav: null,
  guard: { kind: 'requested', canonicalProfile: true, heading: 'Calculation details' },
  prefetch: 'expensive', rollout: { enabled: true },
  states: ['loading', 'error', 'gated', 'empty', 'not-measured'], entry: 'gate-message', specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

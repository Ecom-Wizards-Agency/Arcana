import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';
export const descriptor = {
  id: 'optimizer-run', path: '/optimizer/run/[batchId]', title: 'Run results', route: 'page', nav: null,
  guard: { kind: 'requested', canonicalProfile: true, heading: 'Run results' },
  prefetch: 'expensive', rollout: { enabled: true },
  states: ['loading', 'error', 'gated', 'empty', 'not-measured', 'stale', 'refused'], entry: 'gate-message', specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

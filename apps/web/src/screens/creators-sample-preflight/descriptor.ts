import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: 'creators-sample-preflight',
  title: 'Sample pre-flight',
  path: '/creators/samples/[id]/preflight',
  route: 'page',
  nav: null,
  guard: { kind: 'requested' },
  prefetch: 'expensive',
  rollout: { enabled: true },
  states: ['loading', 'error', 'empty', 'not-measured', 'stale', 'refused', 'gated'],
  entry: 'request-message',
  specs: [{ file: 'creators-sample-preflight.spec.ts', suite: 'route-acceptance' }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

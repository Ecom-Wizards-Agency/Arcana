import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: 'creators-conflict',
  title: 'Creator record conflict',
  path: '/creators/conflicts/[id]',
  route: 'page',
  nav: null,
  guard: { kind: 'requested' },
  prefetch: 'expensive',
  rollout: { enabled: true },
  states: ['loading', 'error', 'empty', 'not-measured', 'refused', 'gated'],
  entry: 'request-message',
  specs: [{ file: 'creators-conflict.spec.ts', suite: 'route-acceptance' }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

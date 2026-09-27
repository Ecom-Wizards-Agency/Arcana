import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: 'creators-sample-shipments',
  title: 'Sample shipments',
  path: '/creators/samples',
  route: 'page',
  nav: { group: 'creators', label: 'Sample shipments', icon: 'icon/dayparting', order: 2 },
  guard: { kind: 'requested' },
  prefetch: 'expensive',
  rollout: { enabled: true },
  states: ['loading', 'error', 'empty', 'not-measured', 'refused', 'gated'],
  entry: 'request-message',
  specs: [{ file: 'creators-sample-shipments.spec.ts', suite: 'route-acceptance' }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

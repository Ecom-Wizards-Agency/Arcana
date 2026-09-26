import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: 'creators-daily-queue',
  title: 'Creator queue',
  path: '/creators',
  route: 'page',
  nav: { group: 'creators', label: 'Daily queue', icon: 'icon/inbox', order: 0 },
  guard: { kind: 'requested' },
  prefetch: 'expensive',
  rollout: { enabled: true },
  states: ['loading', 'error', 'empty', 'not-measured', 'refused', 'gated'],
  entry: 'request-message',
  specs: [{ file: 'creators-daily-queue.spec.ts', suite: 'route-acceptance' }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

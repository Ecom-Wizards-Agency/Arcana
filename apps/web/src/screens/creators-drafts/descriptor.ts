import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: 'creators-drafts',
  title: 'Creator replies',
  path: '/creators/drafts',
  route: 'page',
  nav: null,
  guard: { kind: 'requested' },
  prefetch: 'expensive',
  rollout: { enabled: true },
  states: ['loading', 'error', 'empty', 'not-measured', 'refused', 'gated'],
  entry: 'request-message',
  specs: [{ file: 'creators-drafts.spec.ts', suite: 'route-acceptance' }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

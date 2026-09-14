import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';

export const descriptor = {
  id: 'market-position', path: '/market-position', route: 'page',
  nav: { group: 'performance', label: 'Market position', icon: 'icon/market-position', order: 5 },
  guard: { kind: 'requested', canonicalProfile: true }, prefetch: 'expensive',
  rollout: { enabled: true }, states: ['loading', 'error', 'gated', 'empty', 'not-measured'],
  entry: 'gate-message', specs: [{ file: 'market-position.spec.ts', suite: 'route-acceptance' }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

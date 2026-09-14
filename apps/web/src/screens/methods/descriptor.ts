import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type Screen from './view';
export const descriptor = { id: 'methods', path: '/settings/strategy', title: 'Optimization methods', route: 'page', nav: null,
  guard: { kind: 'requested', canonicalProfile: true }, prefetch: 'cheap', rollout: { enabled: true }, states: ['loading', 'error', 'gated', 'empty'], entry: 'gate-message',
  specs: [{ file: 'optimizer-methods.spec.ts', suite: 'route-acceptance' }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof Screen> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

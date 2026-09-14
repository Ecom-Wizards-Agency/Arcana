import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type ScreenView from './view';
export const descriptor = {
  id: 'timeline', path: '/timeline', route: 'page',
  nav: { group: 'timeline', label: 'Timeline', icon: 'icon/timeline', order: 0, badgeSource: 'timeline' },
  guard: { kind: 'requested', canonicalProfile: true }, prefetch: 'expensive', rollout: { enabled: true },
  states: ['loading', 'error', 'gated', 'empty', 'not-measured'], entry: 'gate-message',
  specs: [{ file: 'timeline.spec.ts', suite: 'route-acceptance' }],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof ScreenView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

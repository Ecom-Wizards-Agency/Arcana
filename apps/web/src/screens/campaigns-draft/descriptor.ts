import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type Screen from './view';
export const descriptor = {
  id: 'campaigns-draft', path: '/campaigns/draft', title: 'Review campaign draft', route: 'page', nav: null,
  guard: { kind: 'requested', canonicalProfile: true }, prefetch: 'cheap', rollout: { enabled: true },
  states: ['loading', 'error', 'empty', 'gated', 'not-measured'], entry: 'request-message',
  specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof Screen> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

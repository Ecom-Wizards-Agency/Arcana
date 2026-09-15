import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type Screen from './view';
export const descriptor = {
  id: 'campaigns-new', path: '/campaigns/new', route: 'redirect', redirectTo: '/campaigns', nav: null,
  guard: null, prefetch: 'cheap', rollout: { enabled: true }, states: ['loading', 'error'], entry: 'redirect', specs: [],
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof Screen> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

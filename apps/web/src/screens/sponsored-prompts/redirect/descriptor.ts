import type { ScreenDescriptor } from '../../types';
export const descriptor = {
  id: 'sponsored-prompts-redirect', path: '/sponsored-prompts', route: 'redirect', nav: null, guard: null,
  prefetch: 'cheap', rollout: { enabled: true }, states: [], entry: 'redirect', specs: [],
  load: (_actor, params) => import('./load').then((module) => module.load(params)),
  client: () => import('../../virtual-screen-view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

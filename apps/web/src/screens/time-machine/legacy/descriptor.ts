import type RedirectView from './view';
import type { ScreenDescriptor } from '../../types';
export const descriptor = {
  id: 'time-machine-legacy', path: '/time-machine', route: 'redirect', redirectTo: '/change-queue',
  nav: null, guard: null, prefetch: 'expensive', rollout: { enabled: true }, states: ['loading','error'], entry: 'redirect', specs: [],
  load: async (_actor, params): Promise<never> => {
    const { redirect } = await import('next/navigation');
    const { queryString } = await import('../../types');
    const query = queryString(params.searchParams);
    return redirect('/change-queue' + (query ? `?${query}` : ''));
  },
  client: (): Promise<typeof RedirectView> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<never>;

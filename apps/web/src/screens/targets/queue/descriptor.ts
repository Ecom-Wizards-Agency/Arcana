import type { ScreenDescriptor } from '../../types';
import type { load } from './load';
import type Screen from './view';
export const descriptor = {
  id: 'targets-queue', path: '/targets/[id]/queue/[changeId]', route: 'page', nav: null,
  guard: null, prefetch: 'expensive', rollout: { enabled: true },
  states: ['loading','error','gated','not-measured'], entry: 'gate-message',
  specs: [{ file: 'targets-queue.spec.ts', suite: 'auth' }],
  load: (actor, params) => import('./load').then((m) => m.load(actor,params)),
  client: (): Promise<typeof Screen> => import('./view').then((m) => m.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

import { descriptor as cockpit } from '../cockpit/descriptor';
import type { ScreenDescriptor } from '../types';
import type { load } from './load';
import type HomeScreen from './view';

/** Home keeps the registered route identity and policies while replacing its implementation. */
export const descriptor = {
  ...cockpit,
  load: (actor, params) => import('./load').then((module) => module.load(actor, params)),
  client: (): Promise<typeof HomeScreen> => import('./view').then((module) => module.default),
} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;

export { default as HomeLoading } from './loading';

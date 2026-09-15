import { SCREEN_REGISTRY } from '../screens/registry-metadata';

/** Query presets share their physical page's prefetch budget. */
export const EXPENSIVE_ROUTE_PATHNAMES = new Set(
  SCREEN_REGISTRY.filter((screen) => screen.prefetch === 'expensive')
    .map((screen) => screen.path.split('?')[0] as string),
);

export function shouldPrefetchRoute(href: string): boolean {
  return !EXPENSIVE_ROUTE_PATHNAMES.has(href.split('?')[0] as string);
}

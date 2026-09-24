import { SCREEN_REGISTRY } from './screens/registry-metadata';
import { screenEnabled, type ScreenGuard } from './screens/types';

export type SignedInExpectation = ScreenGuard;
export interface GuardedRoute {
  readonly path: string;
  readonly signedIn: SignedInExpectation;
}

/** Both browser sweeps use the exact expectation declared by each screen. */
export const GUARDED_ROUTES: readonly GuardedRoute[] = SCREEN_REGISTRY.flatMap((screen) =>
  screen.guard === null || !screenEnabled(screen) ? [] : [{ path: screen.path, signedIn: screen.guard }],
);

/** Contiguous index halves retain route order and cover odd-length lists too. */
export function partitionGuardedRoutes(routes: readonly GuardedRoute[]): {
  a: readonly GuardedRoute[];
  b: readonly GuardedRoute[];
} {
  const midpoint = Math.ceil(routes.length / 2);
  return { a: routes.slice(0, midpoint), b: routes.slice(midpoint) };
}

export const GUARDED_ROUTE_HALVES = partitionGuardedRoutes(GUARDED_ROUTES);

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

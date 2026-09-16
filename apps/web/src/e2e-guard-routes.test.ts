import { describe, expect, it } from 'vitest';
import { GUARDED_ROUTES, GUARDED_ROUTE_HALVES, partitionGuardedRoutes } from './e2e-guard-routes';
import { SCREEN_REGISTRY } from './screens/registry';
import { screenEnabled } from './screens/types';

describe('authenticated guard route contract', () => {
  const guarded = SCREEN_REGISTRY.filter((screen) => screen.guard !== null && screenEnabled(screen));
  it('derives every guarded path and its complete signed-in expectation', () => {
    expect(GUARDED_ROUTES).toEqual(guarded.map((screen) => ({ path: screen.path, signedIn: screen.guard })));
    expect(new Set(GUARDED_ROUTES.map((route) => route.path)).size).toBe(guarded.length);
  });
  it('derives canonical profiles, headings and redirects without parallel route lists', () => {
    for (const kind of ['requested', 'redirect'] as const) {
      expect(GUARDED_ROUTES.filter((route) => route.signedIn.kind === kind)).toEqual(
        guarded.filter((screen) => screen.guard?.kind === kind).map((screen) => ({ path: screen.path, signedIn: screen.guard })),
      );
    }
    expect(GUARDED_ROUTES.filter((route) => route.signedIn.canonicalProfile)).toHaveLength(
      guarded.filter((screen) => screen.guard?.canonicalProfile).length,
    );
    expect(GUARDED_ROUTES.filter((route) => route.signedIn.heading)).toHaveLength(
      guarded.filter((screen) => screen.guard?.heading).length,
    );
  });
});

describe('guard route process partitions', () => {
  it('visits every current route exactly once across the two ordered halves', () => {
    const { a, b } = GUARDED_ROUTE_HALVES;
    expect([...a, ...b]).toEqual(GUARDED_ROUTES);
    expect(a.every((route) => !b.includes(route))).toBe(true);
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
  });

  it.each([0, 1, 2, 3, 4, 5, 10, 11])('conserves an input list of %i routes without mutation', (length) => {
    const routes = Object.freeze(Array.from({ length }, (_, index) => Object.freeze({
      path: `/synthetic-${index}`,
      signedIn: { kind: 'requested' as const },
    })));
    const { a, b } = partitionGuardedRoutes(routes);
    expect([...a, ...b]).toEqual(routes);
    expect(new Set([...a, ...b]).size).toBe(length);
    expect(a.length).toBe(Math.ceil(length / 2));
    expect(b.length).toBe(Math.floor(length / 2));
    expect(partitionGuardedRoutes(routes)).toEqual({ a, b });
  });
});

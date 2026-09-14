import { describe, expect, it } from 'vitest';
import { GUARDED_ROUTES } from './e2e-guard-routes';
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

import { describe, expect, it } from 'vitest';
import { rootDashboardPath } from './root-route.js';

describe('root dashboard route', () => {
  it('sends a bare entry to the dashboard', () => {
    expect(rootDashboardPath(undefined)).toBe('/');
    expect(rootDashboardPath('')).toBe('/');
  });

  it('preserves one explicit profile without allowing it to alter the destination', () => {
    expect(rootDashboardPath('profile / one')).toBe('/?profile=profile+%2F+one');
  });

  it('drops an ambiguous repeated profile so the dashboard resolves the active profile', () => {
    expect(rootDashboardPath(['profile-one', 'profile-two'])).toBe('/');
  });
});

import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';
import { descriptor as cockpit } from '../screens/cockpit/descriptor';
import { descriptor as dashboard } from '../screens/dashboard/descriptor';
import { SCREEN_REGISTRY } from '../screens/registry';
import { screenEnabled } from '../screens/types';

describe('Home entry and compatibility redirect', () => {
  it('lets the Home page render without a configuration redirect cycle', async () => {
    const redirects = await nextConfig.redirects?.() ?? [];
    expect(redirects.some((entry) => entry.source === '/')).toBe(false);
    const aliases = SCREEN_REGISTRY.filter((screen) => screen.redirectTo !== undefined && screenEnabled(screen));
    expect(redirects).toHaveLength(aliases.length);
    for (const alias of aliases) {
      expect(redirects).toContainEqual({ source: alias.path, destination: alias.redirectTo, permanent: false });
    }
    expect(cockpit).toMatchObject({ path: '/', route: 'page' });
    expect(dashboard).toMatchObject({ path: '/dashboard', route: 'redirect' });
  });
});

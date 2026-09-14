import { describe, expect, it } from 'vitest';
import { SCREEN_GROUPS, SCREEN_REGISTRY } from '../screens/registry';
import { navigationFor } from './nav-links';
import { isCurrent, withProfile } from './sidebar';

describe('Figma navigation contract', () => {
  it('keeps the specified group order, placements and complete destination order', () => {
    expect(SCREEN_GROUPS.map((group) => group.id)).toEqual(['home', 'performance', 'research', 'act', 'creators', 'timeline', 'utility']);
    const all = navigationFor(SCREEN_REGISTRY.map((screen) => ({ ...screen, rollout: { enabled: true } })), {});
    expect(all.map((group) => group.links.map((link) => link.label))).toEqual([
      ['Home'],
      ['Campaigns', 'Ad groups', 'Targets', 'Search terms', 'Products', 'Market position', 'Placements', 'Creatives', 'Sponsored prompts'],
      ['N-grams', 'Queries', 'Dayparting', 'Brand lens'],
      ['Optimize Now', 'Create campaigns', 'Change queue'],
      ['Daily queue', 'Inbox sweep', 'Sample shipments'],
      ['Timeline'],
      ['Settings', 'Tags', 'Crosscheck', 'Sync status', 'Connect AI', 'Bugs', 'Roadmap', 'Feedback'],
    ]);
    expect(all.flatMap((group) => group.links).filter((link) => link.badgeSource).map((link) => link.label)).toEqual(['Change queue', 'Timeline']);
  });
  it('merges entity presets and highlights only the selected entity', () => {
    expect(withProfile('/grid?entity=campaigns', 'synthetic profile')).toBe('/grid?entity=campaigns&profile=synthetic+profile');
    expect(isCurrent('/grid?entity=campaigns', '/grid', 'campaigns')).toBe(true);
    expect(isCurrent('/grid?entity=targets', '/grid', 'campaigns')).toBe(false);
    expect(isCurrent('/grid?entity=search_terms', '/grid')).toBe(true);
    expect(isCurrent('/', '/grid')).toBe(false);
    expect(isCurrent('/settings', '/settings/profiles')).toBe(true);
    expect(isCurrent('/grid?entity=campaigns', '/gridiron', 'campaigns')).toBe(false);
  });
});

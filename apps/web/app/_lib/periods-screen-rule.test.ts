import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCREEN_REGISTRY } from '../../src/screens/registry-metadata';
import {
  addDays,
  DATE_WINDOW_SCREEN_IDS,
  DEFAULT_WINDOW_DAYS,
  type DateWindowScreenId,
  SCREEN_DATE_EXCEPTIONS,
  STANDARD_SCREEN_DATE_RULE,
  screenDateRule,
  screenPeriod,
  screenToday,
} from './periods';

const screensDir = fileURLToPath(new URL('../../src/screens/', import.meta.url));
const TODAY = '2026-08-29';
/** Nav groups whose screens show date-windowed performance. */
const PERFORMANCE_GROUPS = new Set(['home', 'performance', 'research', 'timeline']);
/** Screens in those groups that read no date window at all. */
const NOT_DATE_WINDOWED: Readonly<Record<string, string>> = {
  'sponsored-prompts': 'Lists prompt evidence without a date window.',
};

function loadSource(id: string): { file: string; source: string } | null {
  for (const extension of ['ts', 'tsx']) {
    const file = `${screensDir}${id}/load.${extension}`;
    if (existsSync(file)) return { file, source: readFileSync(file, 'utf8') };
  }
  return null;
}

/** Follow a load that delegates to another screen's load (re-export or wrapper). */
function resolveLoad(id: string): { owner: string; source: string } | null {
  const own = loadSource(id);
  if (own === null) return null;
  const delegate = /from '\.\.\/([a-z-]+)\/load'/.exec(own.source)?.[1];
  if (delegate !== undefined && !own.source.includes('_lib/periods')) {
    const target = loadSource(delegate);
    if (target !== null) return { owner: delegate, source: target.source };
  }
  return { owner: id, source: own.source };
}

function screenLoad(screen: (typeof SCREEN_REGISTRY)[number]): { owner: string; source: string } | null {
  if (screen.route === 'redirect') return null;
  if (screen.route === 'preset') {
    const base = SCREEN_REGISTRY.find((candidate) => candidate.path === screen.path.split('?')[0] && candidate.route === 'page');
    return base === undefined ? null : resolveLoad(base.id);
  }
  return resolveLoad(screen.id);
}

const dated = SCREEN_REGISTRY.flatMap((screen) => {
  const load = screenLoad(screen);
  if (load === null || !load.source.includes('_lib/periods')) return [];
  const key = /screenPeriod\('([a-z-]+)'/.exec(load.source)?.[1] ?? null;
  return [{ id: screen.id, owner: load.owner, source: load.source, key }];
});

describe('one default-date rule for every screen', () => {
  it('finds every registered date-windowed screen and each reads its window from screenPeriod', () => {
    // 16 page screens (12 window owners) plus the six grid presets, which share the grid load.
    expect(dated.map((screen) => screen.id).sort()).toEqual([
      'brand-lens', 'cockpit', 'creative', 'creative-campaign', 'creative-detail', 'creative-eligibility',
      'dayparting', 'grid', 'grid-ad-groups', 'grid-campaigns', 'grid-placements', 'grid-products',
      'grid-search-terms', 'grid-targets', 'market-position', 'ngrams', 'optimizer', 'optimizer-group',
      'optimizer-settings', 'query-intelligence', 'targets', 'timeline',
    ].sort());
    expect(dated).toHaveLength(22);
    for (const screen of dated) {
      expect(screen.key, `${screen.id} reads its window from screenPeriod`).toBe(screen.owner);
      for (const bypass of ['periodFromParamsThroughToday(', 'defaultPeriod(', 'periodThroughToday(', 'todayIsoInTimeZone(']) {
        expect(screen.source.includes(bypass), `${screen.id} does not call ${bypass}`).toBe(false);
      }
      // periodFromParams survives only to read an explicit comparison range.
      const calls = [...screen.source.matchAll(/periodFromParams\(/g)];
      for (const call of calls) {
        expect(screen.source.slice(Math.max(0, call.index - 200), call.index), `${screen.id} uses periodFromParams only for a comparison`).toMatch(/compar/i);
      }
    }
  });

  it('types the rule by registered screen ids: every id exists in the registry and owns a load that uses it', () => {
    const registered = new Set(SCREEN_REGISTRY.map((screen) => screen.id));
    expect(DATE_WINDOW_SCREEN_IDS).toHaveLength(12);
    for (const id of DATE_WINDOW_SCREEN_IDS) expect(registered.has(id), `${id} is a registered screen`).toBe(true);
    expect([...new Set(dated.map((screen) => screen.key))].sort()).toEqual([...DATE_WINDOW_SCREEN_IDS].sort());
    for (const key of Object.keys(SCREEN_DATE_EXCEPTIONS)) expect((DATE_WINDOW_SCREEN_IDS as readonly string[]).includes(key), key).toBe(true);
    // Every call site names a known id; screenToday calls are checked the same way.
    for (const screen of dated) for (const call of screen.source.matchAll(/screen(?:Period|Today)\('([a-z-]+)'/g)) {
      expect(registered.has(call[1]!), `${screen.id}: ${call[1]}`).toBe(true);
    }
  });

  it('covers every performance, research, home and timeline screen', () => {
    const grouped = SCREEN_REGISTRY.filter((screen) => screen.nav !== null && PERFORMANCE_GROUPS.has(screen.nav.group));
    const datedIds = new Set(dated.map((screen) => screen.id));
    const unaccounted = grouped.filter((screen) => !datedIds.has(screen.id) && NOT_DATE_WINDOWED[screen.id] === undefined);
    expect(unaccounted.map((screen) => screen.id)).toEqual([]);
    expect(grouped.filter((screen) => NOT_DATE_WINDOWED[screen.id] !== undefined)).toHaveLength(Object.keys(NOT_DATE_WINDOWED).length);
  });

  it('resolves the same default window for every screen without a documented exception', () => {
    const standard = { start: addDays(TODAY, -DEFAULT_WINDOW_DAYS), end: addDays(TODAY, -1) };
    expect(standard).toEqual({ start: '2026-07-30', end: '2026-08-28' });
    const keys = [...new Set(dated.map((screen) => screen.key as DateWindowScreenId))].sort();
    expect(keys).toHaveLength(12);
    const exceptions = keys.filter((key) => key in SCREEN_DATE_EXCEPTIONS);
    expect(exceptions).toEqual(['creative', 'dayparting']);
    for (const key of keys.filter((candidate) => !exceptions.includes(candidate))) {
      expect(screenDateRule(key), key).toBe(STANDARD_SCREEN_DATE_RULE);
      expect(screenPeriod(key, {}, TODAY), key).toEqual(standard);
    }
    expect(screenPeriod('creative', {}, TODAY)).toEqual({ start: '2026-07-31', end: TODAY });
    expect(screenPeriod('dayparting', {}, TODAY)).toEqual({ start: '2026-07-05', end: TODAY });
    for (const rule of Object.values(SCREEN_DATE_EXCEPTIONS)) expect(rule.reason.length).toBeGreaterThan(40);
  });

  it('keeps a valid explicit from/to exactly as given on every screen and repairs an invalid one to the default', () => {
    const keys = [...new Set(dated.map((screen) => screen.key as DateWindowScreenId))];
    for (const key of keys) {
      expect(screenPeriod(key, { from: '2026-06-01', to: '2026-06-14' }, TODAY), key).toEqual({ start: '2026-06-01', end: '2026-06-14' });
      expect(screenPeriod(key, { from: '2026-06-14', to: '2026-06-01' }, TODAY), key).toEqual(screenPeriod(key, {}, TODAY));
      expect(screenPeriod(key, { from: '2026-06-01' }, TODAY), key).toEqual(screenPeriod(key, {}, TODAY));
    }
  });

  it('reads today on the calendar the rule names', () => {
    const now = new Date('2026-08-29T18:30:00.000Z');
    expect(screenToday('creative', 'Asia/Bangkok', now)).toBe('2026-08-30');
    expect(screenToday('grid', 'Asia/Bangkok', now)).toBe('2026-08-29');
    expect(screenToday('dayparting', 'Asia/Bangkok', now)).toBe('2026-08-29');
  });

  it('leaves no other screen load computing a default window by hand', () => {
    const loads = readdirSync(screensDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .flatMap((entry) => { const load = loadSource(entry.name); return load === null ? [] : [{ id: entry.name, ...load }]; })
      .filter((load) => load.source.includes('_lib/periods'));
    expect(loads.length).toBe(13);
    for (const load of loads) {
      const ownsWindow = load.source.includes('screenPeriod(');
      // Home reads its window from the cockpit load it wraps.
      const delegates = /import \{ load as loadPerformance \} from '\.\.\/cockpit\/load'/.test(load.source);
      expect(ownsWindow || delegates, `${load.id} uses screenPeriod or delegates to a load that does`).toBe(true);
      expect(/addDays\(today, -\d+\)/.test(load.source) && !delegates, `${load.id} has no hand-built default window`).toBe(false);
    }
  });
});

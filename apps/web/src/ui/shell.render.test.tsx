// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { assessFreshness } from '@wizard-ads/ui';
import { FIGMA_ICON_IDS, NavIcon } from './nav-icons';
import { SCREEN_REGISTRY, SCREEN_GROUPS } from '../screens/registry-metadata';
import { ShellDateControls, ShellStatusChips, ScreenTopbar, resolveShellPeriod } from './topbar-controls';
import { ShellEvidenceProvider, useShellEvidence, type ShellEvidence } from './shell-evidence';

const navigation = vi.hoisted(() => ({ query: '', pathname: '/grid', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => ({ push: navigation.push }),
}));

beforeEach(() => {
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => window.setTimeout(callback, 0));
  vi.stubGlobal('cancelIdleCallback', (id: number) => window.clearTimeout(id));
});
afterEach(() => vi.unstubAllGlobals());

const period = { start: '2026-07-30', end: '2026-08-28' };
const comparison = { start: '2026-06-30', end: '2026-07-29' };
const unavailable = assessFreshness([], { now: new Date('2026-08-29T12:00:00Z') });

describe('Figma shell', () => {
  it('renders all 20 exported glyphs and refuses unknown icon ids', () => {
    expect(FIGMA_ICON_IDS).toHaveLength(20);
    expect(new Set(FIGMA_ICON_IDS).size).toBe(20);
    for (const icon of FIGMA_ICON_IDS) {
      const markup = renderToStaticMarkup(<NavIcon icon={icon} />);
      expect(markup).toContain('viewBox="0 0 16 16"');
      expect(markup).toContain('stroke="currentColor"');
      expect(markup).toContain('stroke-width="1.4"');
    }
    const references = [...SCREEN_GROUPS.map((group) => group.icon), ...SCREEN_REGISTRY.flatMap((entry) => entry.nav === null ? [] : [entry.nav.icon])];
    expect(references.every((icon) => FIGMA_ICON_IDS.includes(icon))).toBe(true);
    expect(() => renderToStaticMarkup(<NavIcon icon="unknown" />)).toThrow('Unknown navigation icon: unknown');
  });

  it('writes resolved windows and lengths on both closed controls, with a mismatch warning', () => {
    const view = render(<ShellDateControls path="/grid" today="2026-08-29" period={period} comparison={comparison} />);
    expect(view.container.querySelectorAll('details')).toHaveLength(2);
    expect(view.container.querySelectorAll('details[open]')).toHaveLength(0);
    expect(view.container.querySelectorAll('summary')[0]?.textContent).toContain('30 Jul 2026 – 28 Aug 2026');
    expect(view.container.querySelectorAll('summary')[1]?.textContent).toContain('vs 30 Jun 2026 – 29 Jul 2026');
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<ShellDateControls path="/grid" today="2026-08-29" period={period} comparison={{ ...comparison, start: '2026-07-01' }} />);
    expect(screen.getByRole('status').textContent).toBe('Date ranges differ: 30 days compared with 29 days.');
    fireEvent.click(screen.getByText('Apply comparison'));
    expect(navigation.push).toHaveBeenCalledWith('/grid?compareFrom=2026-06-30&compareTo=2026-07-29');
  });

  it('renders both status chips as fresh, stale and unavailable without inventing coverage', () => {
    navigation.query = 'profile=synthetic-profile';
    const view = render(<ShellStatusChips freshness={{ ...unavailable, tone: 'good', coversThrough: '2026-08-28' }}
      crosscheck={{ verdict: 'verified', tone: 'good', label: 'Verified', asOf: '2026-08-28', verifiedStreak: 1 }} />);
    expect(view.container.querySelectorAll('.wa-shell-chip')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Data freshness: Facts to 28 Aug 2026' }).getAttribute('href')).toBe('/sync-status?profile=synthetic-profile');
    expect(screen.getByRole('link', { name: 'Crosscheck OK' })).toBeTruthy();
    view.rerender(<ShellStatusChips freshness={{ ...unavailable, tone: 'warn', coversThrough: '2026-08-20' }}
      crosscheck={{ verdict: 'missing_theirs', tone: 'warn', label: 'Missing comparison', asOf: '2026-08-20', verifiedStreak: 0 }} />);
    expect(view.container.querySelectorAll('[data-tone="warn"]')).toHaveLength(2);
    expect(view.container.textContent).toContain('Data delayed · 20 Aug 2026');
    expect(view.container.textContent).toContain('Crosscheck missing comparison');
    view.rerender(<ShellStatusChips freshness={null} crosscheck={null} />);
    expect(view.container.querySelectorAll('[data-tone="muted"]')).toHaveLength(2);
    expect(view.container.textContent).toBe('Freshness unavailableCrosscheck unavailable');
  });

  it('matches complete-day, creative and dayparting window defaults', () => {
    expect(resolveShellPeriod('/grid', {}, '2026-08-29')).toEqual({ period: { start: '2026-07-30', end: '2026-08-28' }, includeToday: false });
    expect(resolveShellPeriod('/creative', {}, '2026-08-29')).toEqual({ period: { start: '2026-07-31', end: '2026-08-29' }, includeToday: true });
    expect(resolveShellPeriod('/dayparting', {}, '2026-08-29')).toEqual({ period: { start: '2026-07-05', end: '2026-08-29' }, includeToday: true });
    expect(resolveShellPeriod('/grid', { from: '2026-99-99', to: '2026-99-99' }, '2026-08-29').period).toEqual(period);
  });

  it('selects the registry entity title and responds to query navigation', () => {
    navigation.query = 'entity=targets';
    const screens = SCREEN_REGISTRY.flatMap((entry) => entry.nav === null ? [] : [{ path: entry.path, title: entry.nav.label }]);
    const view = render(<ScreenTopbar screens={screens} today="2026-08-29" />);
    expect(screen.getByTestId('shell-title').textContent).toBe('Targets');
    navigation.query = 'entity=campaigns';
    view.rerender(<ScreenTopbar screens={screens} today="2026-08-29" />);
    expect(screen.getByTestId('shell-title').textContent).toBe('Campaigns');
  });

  it('owns the only freshness load in the shell transaction, with no screen loader calls', () => {
    const shell = readFileSync('src/ui/shell-evidence-server.ts', 'utf8');
    expect(shell.match(/loadFreshness\(/g)).toHaveLength(1);
    for (const name of ['cockpit', 'grid', 'optimizer']) {
      expect(readFileSync(`src/screens/${name}/load.tsx`, 'utf8')).not.toContain('loadFreshness');
    }
  });

  it('reuses the shell read when a canonical redirect adds the resolved profile', async () => {
    let resolve!: (value: ShellEvidence) => void;
    const read = vi.fn(() => new Promise<ShellEvidence>((done) => { resolve = done; }));
    function CanonicalProbe() { return <span>{useShellEvidence()?.profileId ?? 'Waiting'}</span>; }
    navigation.query = '';
    const view = render(<ShellEvidenceProvider read={read} enabled><CanonicalProbe /></ShellEvidenceProvider>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    navigation.query = 'profile=canonical';
    view.rerender(<ShellEvidenceProvider read={read} enabled><CanonicalProbe /></ShellEvidenceProvider>);
    resolve({ profileId: 'canonical', freshness: null, crosscheck: null, badges: { 'change-queue': null, timeline: 0 } });
    await screen.findByText('canonical');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads once for a selected profile and discards an earlier profile response', async () => {
    const results = new Map<string, (value: ShellEvidence) => void>();
    const read = vi.fn((id: string | null) => new Promise<ShellEvidence>((resolve) => { results.set(id!, resolve); }));
    function Probe() { return <span data-testid="profile-evidence">{useShellEvidence()?.profileId ?? 'unavailable'}</span>; }
    navigation.query = 'profile=first';
    const view = render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    view.rerender(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
    expect(read).toHaveBeenCalledTimes(1);
    navigation.query = 'profile=second';
    view.rerender(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const value = (profileId: string): ShellEvidence => ({ profileId, freshness: null, crosscheck: null, badges: { 'change-queue': null, timeline: 0 } });
    results.get('second')!(value('second'));
    await waitFor(() => expect(screen.getByTestId('profile-evidence').textContent).toBe('second'));
    results.get('first')!(value('first'));
    await waitFor(() => expect(screen.getByTestId('profile-evidence').textContent).toBe('second'));
  });
});

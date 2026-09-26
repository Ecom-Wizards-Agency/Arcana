// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HomeContent } from './view';
import { withBudget, withoutBudget } from './fixtures';
import { homeSectionStorageKey, parseHomeSectionPreferences, HOME_SECTION_IDS } from './preferences';
import type { HomeReady } from './view';

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      clear: () => stored.clear(),
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() { return stored.size; },
    } satisfies Storage,
  });
});
afterEach(() => cleanup());

const profileId = withoutBudget.profile.id;

function groupHeaders(groupName: string): string[] {
  const group = screen.getByRole('group', { name: groupName });
  return within(group).getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent ?? '');
}

describe('Home flags by issue', () => {
  it('groups raised flags by issue, most severe first, and counts each group', () => {
    render(<HomeContent {...withoutBudget} />);
    expect(screen.getByText('Raised (4)')).toBeTruthy();
    expect(groupHeaders('Raised flags')).toEqual([
      'Spend with no sales (2)',
      'Spend rising sharply (1)',
      'Discovery taking too much spend (1)',
    ]);
    const noSales = screen.getByRole('list', { name: 'Spend with no sales flags' });
    expect(within(noSales).getAllByRole('listitem')).toHaveLength(2);
    expect(groupHeaders('Noted flags')).toEqual(['ACOS swinging against the trailing week (1)']);
  });

  it('filters by severity, issue and entity type and recounts the headers', () => {
    render(<HomeContent {...withoutBudget} />);
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'alert' } });
    expect(screen.getByText('Raised (1 of 4)')).toBeTruthy();
    expect(groupHeaders('Raised flags')).toEqual(['Spend with no sales (1)']);
    expect(screen.getByText('Noted, not flagged (0 of 1)')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Issue'), { target: { value: 'spend_without_sales' } });
    expect(groupHeaders('Raised flags')).toEqual(['Spend with no sales (2)']);
    const issueOptions = within(screen.getByLabelText('Issue')).getAllByRole('option').map((option) => option.textContent);
    expect(issueOptions).toEqual([
      'All issues', 'Spend with no sales', 'Spend rising sharply', 'Discovery taking too much spend',
      'ACOS swinging against the trailing week',
    ]);

    fireEvent.change(screen.getByLabelText('Issue'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'account' } });
    expect(groupHeaders('Raised flags')).toEqual(['Discovery taking too much spend (1)']);
    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'campaign' } });
    expect(screen.getByText('Raised (3 of 4)')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Raised flags' })).getAllByRole('listitem')).toHaveLength(3);
  });

  it('names the campaign on each row, links through to it and shows the evidence window', () => {
    render(<HomeContent {...withoutBudget} />);
    const campaign = screen.getByRole('link', { name: 'Sample campaign' });
    const href = new URL(campaign.getAttribute('href')!, 'https://example.test');
    expect(href.pathname).toBe('/grid');
    expect(Object.fromEntries(href.searchParams)).toEqual({
      profile: profileId, entity: 'campaigns', campaign: '301', from: withoutBudget.period.start, to: withoutBudget.period.end,
    });
    const row = campaign.closest('li')!;
    expect(row.textContent).toContain('Campaign · Alert');
    expect(row.textContent).toContain('~$24.00/day trailing-7 avg spend with 0 orders');
    expect(row.textContent).toContain('Rule: >= $20 trailing-7 avg spend with 0 orders · 2026-06-07 to 2026-06-14 · 4,200 impressions · 8 days of data');

    const account = screen.getByRole('link', { name: withoutBudget.profile.label });
    const accountHref = new URL(account.getAttribute('href')!, 'https://example.test');
    expect(accountHref.searchParams.get('entity')).toBe('campaigns');
    expect(accountHref.searchParams.has('campaign')).toBe(false);
    expect(account.closest('li')!.textContent).toContain('Account · Warn');
    const flagsCard = screen.getByLabelText('Flags', { exact: true, selector: 'section' });
    expect(within(flagsCard).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Sample campaign', 'Third campaign', 'Second campaign', withoutBudget.profile.label, 'Rank campaign',
    ]);
  });

  it('keeps an unreported impression count unknown rather than zero', () => {
    const [first] = withoutBudget.home.flags.active;
    const pacing = { ...first!, family: 'pacing' as const, campaignId: null,
      evidence: { impressions: null, days: 14, window: { start: '2026-06-01', end: '2026-06-14' }, source: 'rows' as const } };
    render(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, flags: { ...withoutBudget.home.flags, active: [pacing] } }} />);
    const row = screen.getByRole('link', { name: withoutBudget.profile.label }).closest('li')!;
    expect(row.textContent).toContain('2026-06-01 to 2026-06-14 · impressions not reported · 14 days with spend');
    expect(row.textContent).not.toContain('0 impressions');
    expect(groupHeaders('Raised flags')).toEqual(['Monthly budget off pace (1)']);
  });

  it('states how many signals sit below the evidence floor, and nothing when none do', () => {
    const { rerender } = render(<HomeContent {...withoutBudget} />);
    expect(screen.getByTestId('flags-floored').textContent).toContain('2 signals below the evidence floor.');
    rerender(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, flags: { ...withoutBudget.home.flags, flooredCount: 1 } }} />);
    expect(screen.getByTestId('flags-floored').textContent).toContain('1 signal below the evidence floor.');
    rerender(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, flags: { ...withoutBudget.home.flags, flooredCount: 0 } }} />);
    expect(screen.queryByTestId('flags-floored')).toBeNull();
  });
});

describe('collapsible Home sections', () => {
  const sections = [
    ['Flags', 'flags', '4 raised flags'],
    ['Proposals', 'proposals', '2 proposals'],
    ['Events this week', 'events', '2 events'],
    ['Rank watch', 'ranks', '1 keyword'],
    ['Pacing', 'pacing', '1 budget'],
    ['Market position', 'market', '1 product'],
  ] as const;

  it('collapses every section, keeps its count in the header and hides its body', () => {
    render(<HomeContent {...withBudget} />);
    expect(screen.getAllByRole('button', { name: /^Hide / })).toHaveLength(sections.length);
    for (const [title, id, count] of sections) {
      const card = screen.getByLabelText(title, { exact: true, selector: 'section' });
      const toggle = within(card).getByRole('button', { name: `Hide ${title}` });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(toggle);
      expect(within(card).getByRole('button', { name: `Show ${title}` }).getAttribute('aria-expanded')).toBe('false');
      expect(card.getAttribute('data-collapsed')).toBe('true');
      expect(card.querySelector('.wa-home-card-body')?.hasAttribute('hidden')).toBe(true);
      expect(within(card).getByTestId(`home-count-${id}`).textContent).toBe(count);
    }
  });

  it('persists the collapsed sections per user and restores them on the next visit', () => {
    const first = render(<HomeContent {...withBudget} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Flags' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide Rank watch' }));
    const key = homeSectionStorageKey(withBudget.home.preferenceKey);
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ version: 1, collapsed: ['flags', 'ranks'] });
    first.unmount();

    render(<HomeContent {...withBudget} />);
    expect(screen.getByRole('button', { name: 'Show Flags' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show Rank watch' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Hide / })).toHaveLength(sections.length - 2);
    cleanup();

    render(<HomeContent {...withBudget} home={{ ...withBudget.home, preferenceKey: 'another-user' }} />);
    expect(screen.getAllByRole('button', { name: /^Hide / })).toHaveLength(sections.length);
  });

  it('parses saved preferences defensively', () => {
    expect(parseHomeSectionPreferences(JSON.stringify({ version: 1, collapsed: ['ranks', 'nope', 'flags', 'ranks', 7] })))
      .toEqual({ version: 1, collapsed: ['flags', 'ranks'] });
    expect(parseHomeSectionPreferences(JSON.stringify({ version: 2, collapsed: ['flags'] }))).toBeNull();
    expect(parseHomeSectionPreferences(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseHomeSectionPreferences('not json')).toBeNull();
    expect(parseHomeSectionPreferences(null)).toBeNull();
    expect(HOME_SECTION_IDS).toHaveLength(6);
  });
});

describe('rank watch', () => {
  const ranks: HomeReady['home']['ranks'] = Array.from({ length: 7 }, (_, index) => ({
    asin: `B0TEST000${index + 1}`, keyword: `keyword ${index + 1}`, currentRank: 10 + index,
    previousRank: 20 + index * 2, movement: 10 + index, spend: null, currentDate: '2026-06-14', previousDate: '2026-06-07',
  }));

  it('shows the top five by movement, expands to the full list and links each row to its product', () => {
    render(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, ranks }} />);
    const list = () => screen.getByRole('list', { name: 'Rank movements' });
    expect(within(list()).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list()).getAllByRole('listitem').map((row) => row.querySelector('strong')?.textContent))
      .toEqual(['keyword 1', 'keyword 2', 'keyword 3', 'keyword 4', 'keyword 5']);
    const more = screen.getByRole('button', { name: 'View more (2)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(list()).getAllByRole('listitem')).toHaveLength(7);
    const links = within(list()).getAllByRole('link');
    expect(links).toHaveLength(7);
    expect(links[6]?.getAttribute('aria-label')).toBe('Open product B0TEST0007');
    const href = new URL(links[6]!.getAttribute('href')!, 'https://example.test');
    expect(Object.fromEntries(href.searchParams)).toEqual({ profile: profileId, entity: 'products', asin: 'B0TEST0007' });
    fireEvent.click(screen.getByRole('button', { name: 'Show top 5' }));
    expect(within(list()).getAllByRole('listitem')).toHaveLength(5);
  });

  it('offers no expansion when five or fewer rows exist', () => {
    render(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, ranks: ranks.slice(0, 5) }} />);
    expect(within(screen.getByRole('list', { name: 'Rank movements' })).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /View more/ })).toBeNull();
  });
});

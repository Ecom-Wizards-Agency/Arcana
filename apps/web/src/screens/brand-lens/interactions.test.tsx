// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrandLens } from './view';
import { brandReady } from './render-fixture';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('computes the insight from the same bucket totals and keeps undefined ACOS absent', () => {
  render(<BrandLens data={brandReady} initialTab="overview" />);
  const insight = screen.getByTestId('brand-insight');
  expect(insight.textContent).toContain('54.5%');
  expect(insight.textContent).toContain('27.8%');
  expect(insight.textContent).toContain('61.1%');
  expect(insight.querySelector('strong')?.textContent).toContain('with no attributed sales in this window');
  expect(insight.textContent).not.toContain('at — ACOS');
  expect(screen.getByRole('table').textContent).toContain('—');
});
it('reveals the inline token form and colors measured ACOS against the profile target', () => {
  const { rerender } = render(<BrandLens data={brandReady} />);
  expect(screen.queryByRole('textbox', { name: 'Add to Brand tokens' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add to Brand tokens' }));
  expect(screen.getByRole('textbox', { name: 'Add to Brand tokens' })).toBeDefined();
  expect(screen.getByRole('combobox', { name: 'Brand token kind' })).toBeDefined();
  rerender(<BrandLens key="overview-good" data={{ ...brandReady, profile: { ...brandReady.profile, targetAcos: 0.37 } }} initialTab="overview" />);
  expect(screen.getByText('27.8%').className).toBe('research-good-text');
  rerender(<BrandLens key="overview-bad" data={{ ...brandReady, profile: { ...brandReady.profile, targetAcos: 0.17 } }} initialTab="overview" />);
  expect(screen.getByText('27.8%').className).toBe('research-bad-text');
});
it('opens the quiet classification menu, navigates it by keyboard and returns focus on Escape', () => {
  render(<BrandLens data={brandReady} initialTab="review" />);
  const change = screen.getAllByRole('button', { name: /change classification for/ })[0]!;
  change.focus();
  fireEvent.keyDown(change, { key: 'ArrowDown' });
  expect(screen.getByRole('menu')).toBeDefined();
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Keep proposed' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Confirm Branded' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(change);
});
it('persists a grouped exclusion and reflects the confirmed switch state', async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      groupId: brandReady.profile.id,
      exclusions: ['synthetic-campaign-one']
    })
  });
  vi.stubGlobal('fetch', fetcher);
  render(<BrandLens data={brandReady} initialTab="exclusions" />);
  const toggle = screen.getByRole('switch');
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
    profileId: brandReady.profile.id,
    campaignId: 'synthetic-campaign-one',
    excluded: true
  });
});

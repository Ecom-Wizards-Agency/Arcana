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
  expect(screen.getByRole('table').textContent).toContain('—');
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

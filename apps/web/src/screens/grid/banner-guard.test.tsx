// @vitest-environment jsdom
/**
 * WP-316 item 8: the product assignment banner outside the app router.
 *
 * Deliberately no `next/navigation` mock: this is the real hook with no router
 * context, where it returns null. The banner used to call `.entries()` on that
 * and throw, taking the performance summary down with it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { periodFromParams, todayIso } from '../../../app/_lib/periods';
import { ProductAssignmentBanner } from './performance-chrome';

const profileId = '00000000-0000-4000-8000-000000000001';
afterEach(() => vi.unstubAllGlobals());

it('renders outside the app router and reads the default period', async () => {
  const period = periodFromParams({}, todayIso());
  const list = { profileId, start: period.start, end: period.end, days: 1, canAssign: true, items: [], count: 0, unassignedCount: 0, unassignedSpend: 0 };
  const fetcher = vi.fn().mockResolvedValue(Response.json(list));
  vi.stubGlobal('fetch', fetcher);
  expect(() => render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />)).not.toThrow();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const url = new URL(String(fetcher.mock.calls[0]![0]), 'https://arcana.invalid');
  expect(url.pathname).toBe('/targets/product-assignments');
  expect(Object.fromEntries(url.searchParams)).toEqual({ profileId, start: period.start, end: period.end });
  await waitFor(() => expect(screen.queryByText('Checking product assignments')).toBeNull());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByTestId('grid-unattributed')).toBeNull();
});

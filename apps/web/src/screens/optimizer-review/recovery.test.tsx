// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { spWriteApprovalFixtures } from '../../writes/approval-fixtures';
import { ready } from './render-fixture';
import Screen from './view';

const fixtures = await spWriteApprovalFixtures();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('recovers the exact saved preview with a read-only link after a lost staging response', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  render(<Screen data={{ ...ready, props: { ...ready.props, savedPreviews: [fixtures.stale] } }} />);
  const link = screen.getByRole('link', { name: 'Review saved preview · 1 change' });
  const url = new URL(link.getAttribute('href')!, 'https://synthetic.invalid');
  expect(url.pathname).toBe('/optimizer/confirm/' + ready.props.review.batchId);
  expect(Object.fromEntries(url.searchParams)).toEqual({ profile: ready.props.profile.id, plan: fixtures.stale.preview.plan.id });
  expect(fetcher).not.toHaveBeenCalled();
});

it('links an already admitted plan to its existing operation without creating a replacement preview', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  render(<Screen data={{ ...ready, props: { ...ready.props, savedPreviews: [fixtures.queued] } }} />);
  const link = screen.getByRole('link', { name: 'View saved results · 1 change' });
  const operation = fixtures.queued.admission!.operation;
  const url = new URL(link.getAttribute('href')!, 'https://synthetic.invalid');
  expect(url.pathname).toBe('/optimizer/run/' + ready.props.review.batchId);
  expect(Object.fromEntries(url.searchParams)).toEqual({ profile: ready.props.profile.id, execution: operation.executionId, plan: operation.planId });
  expect(screen.queryByRole('link', { name: /Review saved preview/ })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BidHistoryPayload } from '../../app/_lib/bid-corridor';
import { targetFixture } from '../screens/targets/fixtures';
import { BidHistoryModal } from './bid-history-modal';

const payload: BidHistoryPayload = {
  target: {
    targetId: 'target-1',
    targeting: 'widget exact',
    matchType: 'exact',
    adProduct: 'SP',
    targetKind: 'keyword',
    campaignId: 'campaign-1',
    campaignName: 'SP | Rank | Widget',
  },
  window: { from: '2026-08-01', to: '2026-08-14' },
  totals: { impressions: 1_000, clicks: 50, spend: 40, sales: 100, orders: 5, units: 5 },
  points: [],
};

describe('BidHistoryModal', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const renderModal = (onClose = vi.fn()): void => {
    act(() => {
      root.render(
        createElement(BidHistoryModal, {
          profileId: '00000000-0000-4000-8000-000000000001',
          targetId: 'target-1',
          window: { start: '2026-08-01', end: '2026-08-14' },
          currencyCode: 'USD',
          onClose,
        }),
      );
    });
  };

  it('announces loading, traps the initial focus, and closes on Escape', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const onClose = vi.fn();
    renderModal(onClose);

    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.textContent).toContain('Loading bid history…');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close bid history');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders target identity, the shared empty corridor, five tabs and full-page navigation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ...targetFixture, payload }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await act(async () => { renderModal(); });

    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('widget exact'));
    expect(host.textContent).toContain('SP | Rank | Widget');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close target');
    expect(host.textContent).toContain('Daily spend');
    expect(host.textContent).toContain('ACOS');
    expect(host.textContent).toContain('No bid corridor has been synced for this target yet.');
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(5);
    expect(host.querySelector('a[href^="/targets/"]')?.textContent).toContain('Open full');
  });
});

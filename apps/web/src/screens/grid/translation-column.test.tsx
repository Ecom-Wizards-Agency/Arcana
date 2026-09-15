// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetTranslation } from '@wizard-ads/shared';
import type { GridRow } from '@wizard-ads/ui';
import { useTranslationColumn } from './translation-column';
import StatusScreen from '../translation-status/view';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const waiting: TargetTranslation = { id: uuid(1), orgId: uuid(2), profileId: uuid(3), originalText: 'Synthetic original', language: 'en', providerId: 'not-configured', result: { status: 'waiting', text: null, reason: null }, provenance: { requestId: uuid(4), requestedBy: uuid(5), requestedAt: '2026-09-14T00:00:00Z', completedAt: null } };
const terminal: TargetTranslation = { ...waiting, result: { status: 'unavailable', text: null, reason: 'provider not configured' }, provenance: { ...waiting.provenance, completedAt: '2026-09-14T00:00:01Z' } };
const rows: GridRow[] = [{ id: 'target:one', dimensions: { targeting: waiting.originalText }, currencyCode: 'USD', totals: { spend: 1, sales: 2, clicks: 1, impressions: 10, orders: 1, units: 1 }, comparison: null }];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function Column({ profile = waiting.profileId }: { profile?: string }) {
  const translation = useTranslationColumn(profile, 'en', true, rows);
  return <><button onClick={translation.refresh}>Refresh translations</button>{translation.cell(rows[0]!)}</>;
}
async function mount(view: ReturnType<typeof createElement>) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => { root.render(view); });
  return { host, root };
}
describe('translation status refresh', () => {
  it('refreshes a queued column attempt to the worker terminal result without re-enqueueing', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ rows: [], count: 0 }))
      .mockResolvedValueOnce(Response.json({ row: waiting, count: 1 }))
      .mockResolvedValueOnce(Response.json({ rows: [terminal], count: 1 }));
    vi.stubGlobal('fetch', fetch);
    const { host } = await mount(createElement(Column));
    expect(host.textContent).toContain('Translating…');
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('Translation unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('cancels the old column scope and rejects its late response', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json({ rows: [{ ...terminal, profileId: uuid(6) }], count: 1 }));
    vi.stubGlobal('fetch', fetch);
    const { host, root } = await mount(createElement(Column));
    const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
    await act(async () => root.render(createElement(Column, { profile: uuid(6) })));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(Response.json({ rows: [waiting], count: 1 })));
    expect(host.textContent).toContain('Translation unavailable');
    expect(host.textContent).not.toContain('Translating…');
  });
  it('refreshes the status screen after Retry completes and sends the expected prior attempt', async () => {
    const next = { ...waiting, provenance: { ...waiting.provenance, requestId: uuid(7) } };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ row: next, count: 1 }))
      .mockResolvedValueOnce(Response.json({ rows: [{ ...terminal, provenance: { ...terminal.provenance, requestId: uuid(7) } }], count: 1 }));
    vi.stubGlobal('fetch', fetch);
    const { host } = await mount(createElement(StatusScreen, { data: { view: 'ready', profileId: waiting.profileId, language: 'en', canRetry: true, rows: [terminal] } }));
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click());
    expect(host.textContent).toContain('Waiting');
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ profileId: waiting.profileId, translationId: waiting.id, expectedRequestId: waiting.provenance.requestId });
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh translations')!.click());
    expect(host.textContent).toContain('Translation unavailable');
    expect(host.textContent).not.toContain('Waiting');
  });
});

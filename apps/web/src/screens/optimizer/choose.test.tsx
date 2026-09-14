// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChooseCampaigns, queueSuggestions } from './choose';
import { chooserRows } from './choose-fixture';
import { optimizerAdmissionRequest, readOptimizerDraft, savedConfiguration } from './draft';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
it('selects the complete filtered population and preserves hidden selection until cleared', () => {
  render(<ChooseCampaigns rows={chooserRows} profileId="33333333-3333-4333-8333-333333333333" currencyCode="USD" period={{ start: '2026-07-01', end: '2026-07-28' }} today="2026-08-01" mayRun readiness={{ ready: true }} />);
  fireEvent.click(screen.getByTestId('optimizer-select-filtered'));
  expect(screen.getByTestId('optimizer-selection-count').textContent).toContain('2 campaigns selected');
  fireEvent.change(screen.getByLabelText('Find campaign'), { target: { value: 'campaign 2' } });
  expect((screen.getByRole('checkbox', { name: 'Select Synthetic campaign 2 for this preview' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Clear selected' }));
  expect(readOptimizerDraft('33333333-3333-4333-8333-333333333333').campaignIds).toEqual([]);
  expect(screen.getByTestId('optimizer-selection-count').textContent).toBe('No campaigns selected.');
});
it('keeps unavailable readiness explicit and disables preview admission', () => {
  render(<ChooseCampaigns rows={chooserRows} profileId="synthetic-profile" currencyCode="USD" period={{ start: '2026-07-01', end: '2026-07-28' }} today="2026-08-01" mayRun readiness={{ ready: false, message: 'The recommendation worker is unavailable.' }} />);
  expect((screen.getByTestId('optimizer-run-preview') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('The recommendation worker is unavailable.')).toBeTruthy();
});
it('reuses the byte-identical request after an interrupted admission response', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('response interrupted')).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'The recommendation worker is unavailable.' }), { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const body = JSON.stringify({ clientRequestId: 'synthetic-request' });
  await expect(queueSuggestions(body)).rejects.toThrow('worker is unavailable');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.map((call) => (call[1] as RequestInit).body)).toEqual([body, body]);
});

it('retries an interrupted response body using the same request identity', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{', { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Synthetic unavailable worker.' }), { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const body = JSON.stringify({ clientRequestId: 'synthetic-request' });
  await expect(queueSuggestions(body)).rejects.toThrow('Synthetic unavailable worker');
  expect(fetcher.mock.calls.map((call) => (call[1] as RequestInit).body)).toEqual([body, body]);
});

it('abandons an old profile response while preserving its admission identity for recovery', async () => {
  let respond!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const profileId = '33333333-3333-4333-8333-333333333333';
  const props = { rows: chooserRows, profileId, currencyCode: 'USD', period: { start: '2026-07-01', end: '2026-07-28' }, today: '2026-08-01', mayRun: true, readiness: { ready: true } };
  const rendered = render(<ChooseCampaigns {...props} />);
  fireEvent.click(screen.getByTestId('optimizer-select-filtered'));
  fireEvent.click(screen.getByTestId('optimizer-run-preview'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const request = fetcher.mock.calls[0]![1] as RequestInit;
  const saved = JSON.parse(request.body as string) as { clientRequestId: string };
  const earlierUrl = window.location.href;
  rendered.rerender(<ChooseCampaigns {...props} profileId="44444444-4444-4444-8444-444444444444" />);
  expect(request.signal?.aborted).toBe(true);
  await act(async () => {
    respond(new Response(JSON.stringify({ batchId: '55555555-5555-4555-8555-555555555555', status: 'queued',
      scope: { mode: 'selected', campaignCount: 2, fingerprint: 'a'.repeat(64) }, childCount: 1 }), { status: 202 }));
  });
  expect(window.location.href).toBe(earlierUrl);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('optimizer-selection-count').textContent).toBe('No campaigns selected.');
  const recovered = optimizerAdmissionRequest(profileId, chooserRows.map((row) => row.campaignId),
    savedConfiguration(chooserRows, props.period, props.today)!);
  expect(recovered.clientRequestId).toBe(saved.clientRequestId);
});

// @vitest-environment jsdom
/**
 * The guarded cancel in a live React tree (WP-338i): "Cancel in Amazon" asks
 * for a read, "Cancel 1 order in Amazon" sends exactly the five approval keys
 * with one request id per cancel preview, the section supplies the real cancel
 * server actions when the page passed none, and the page re-reads itself while
 * a read or a cancel is in flight. A refused cancel read or press is put in the
 * cancel flow's own words (WP-338p).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendActionFailure, SendActionResult } from './send-actions';

const hoisted = vi.hoisted(() => ({ refresh: vi.fn(), serverRead: vi.fn(), serverApprove: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: hoisted.refresh }),
}));
vi.mock('./cancel-actions', () => ({ requestMcfCancelPreview: hoisted.serverRead, approveMcfCancel: hoisted.serverApprove }));

const { CANCEL_GATE, LATEST_CANCEL_PREVIEW, OPEN_CANCEL, PLACED, SEND, withSend } = await import('./render-fixture');
const { default: Screen } = await import('./view');
const { CancelControls } = await import('./cancel');
const { REFUSAL_WORDS } = await import('./send-model');
const { CANCEL_REFUSAL_WORDS } = await import('./cancel-model');
type Actions = NonNullable<Parameters<typeof Screen>[0]['actions']>;

const refused = async (): Promise<SendActionResult> => ({ ok: false, reason: 'unavailable' });
const pageActions = (): Actions => ({ seal: refused, approve: refused, withdraw: refused, refresh: refused, settleRead: refused, release: refused,
  resolveConflict: refused });

afterEach(() => { cleanup(); vi.useRealTimers(); for (const fn of Object.values(hoisted)) fn.mockReset(); });

describe('the cancel press', () => {
  it('sends exactly the five keys, replays one request id for one preview and mints a new one for a new preview', async () => {
    const approvals: Record<string, unknown>[] = [];
    const approveCancel = vi.fn(async (approval: unknown): Promise<SendActionResult> => {
      approvals.push(approval as Record<string, unknown>);
      return { ok: false, reason: 'unavailable' };
    });
    const actions: Actions = { ...pageActions(), requestCancelPreview: vi.fn(refused), approveCancel };
    const data = (preview = LATEST_CANCEL_PREVIEW) => withSend({ ...PLACED, latestCancelPreview: preview }, { data: { gate: CANCEL_GATE } });
    const view = render(<Screen data={data()} actions={actions} />);
    expect(screen.getByTestId('cancel-button').textContent).toBe('Cancel 1 order in Amazon');
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-button')); });
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-button')); });
    const fresh = { ...LATEST_CANCEL_PREVIEW, previewId: '33800000-0000-4000-8000-0000000000c3', fingerprint: 'c5'.repeat(32) };
    view.rerender(<Screen data={data(fresh)} actions={actions} />);
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-button')); });
    expect(approvals).toHaveLength(3);
    for (const approval of approvals) {
      expect(Object.keys(approval).sort()).toEqual(['confirmation', 'previewFingerprint', 'previewId', 'requestId', 'sendId']);
      expect(approval['confirmation']).toBe('Cancel 1 order in Amazon');
      expect(approval['sendId']).toBe(SEND.sendId);
    }
    expect(approvals.map((approval) => approval['previewId'])).toEqual([LATEST_CANCEL_PREVIEW.previewId, LATEST_CANCEL_PREVIEW.previewId, fresh.previewId]);
    expect(approvals.map((approval) => approval['previewFingerprint'])).toEqual(['c4'.repeat(32), 'c4'.repeat(32), 'c5'.repeat(32)]);
    expect(approvals[0]!['requestId']).toBe(approvals[1]!['requestId']);
    expect(approvals[2]!['requestId']).not.toBe(approvals[0]!['requestId']);
    expect(actions.requestCancelPreview).not.toHaveBeenCalled();
    expect(screen.getByTestId('command-refused').textContent).toContain('The request did not complete.');
  });

  it('"Cancel in Amazon" and "Read again" ask for one read of this send, and a refusal is shown in words', async () => {
    const requestCancelPreview = vi.fn(async (): Promise<SendActionResult> => ({ ok: false, reason: 'cancel_grant_inactive' }));
    const actions: Actions = { ...pageActions(), requestCancelPreview, approveCancel: vi.fn(refused) };
    const view = render(<Screen data={withSend({ ...PLACED }, { data: { gate: CANCEL_GATE } })} actions={actions} />);
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-in-amazon')); });
    expect(screen.getByTestId('command-refused').textContent).toBe('No active grant carries the cancel action for this connection and marketplace.');
    view.rerender(<Screen data={withSend({ ...PLACED, cancelPreviewRefusal: { reason: 'order_not_found', codes: [], at: '2026-09-09T06:39:00.000Z' } },
      { data: { gate: CANCEL_GATE } })} actions={actions} />);
    requestCancelPreview.mockResolvedValueOnce({ ok: true, sendId: SEND.sendId, state: 'placed' });
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-read-again')); });
    expect(requestCancelPreview.mock.calls).toEqual([[SEND.sendId], [SEND.sendId]]);
    expect(screen.getByTestId('command-done').textContent).toBe('The MCF worker will read this order from Amazon before a cancel.');
    expect(hoisted.refresh).toHaveBeenCalledTimes(2);
  });

  it('uses the real cancel server actions when the page passed none', async () => {
    hoisted.serverRead.mockResolvedValue({ ok: true, sendId: SEND.sendId, state: 'placed' });
    hoisted.serverApprove.mockResolvedValue({ ok: true, sendId: SEND.sendId, state: 'placed', claimDeadline: OPEN_CANCEL.claimDeadline });
    const view = render(<Screen data={withSend({ ...PLACED }, { data: { gate: CANCEL_GATE } })} actions={pageActions()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-in-amazon')); });
    expect(hoisted.serverRead.mock.calls).toEqual([[SEND.sendId]]);
    view.rerender(<Screen data={withSend({ ...PLACED, latestCancelPreview: LATEST_CANCEL_PREVIEW }, { data: { gate: CANCEL_GATE } })} actions={pageActions()} />);
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-button')); });
    expect(hoisted.serverApprove).toHaveBeenCalledTimes(1);
    expect((hoisted.serverApprove.mock.calls[0]![0] as Record<string, unknown>)['confirmation']).toBe('Cancel 1 order in Amazon');
  });
});

describe('refused cancel words', () => {
  it('on the real screen, a cancel press refused as preview_not_latest shows the cancel flow\'s words, not the send flow\'s', async () => {
    const approveCancel = vi.fn(async (): Promise<SendActionResult> => ({ ok: false, reason: 'preview_not_latest' }));
    const actions: Actions = { ...pageActions(), requestCancelPreview: vi.fn(refused), approveCancel };
    render(<Screen data={withSend({ ...PLACED, latestCancelPreview: LATEST_CANCEL_PREVIEW }, { data: { gate: CANCEL_GATE } })} actions={actions} />);
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-button')); });
    expect(approveCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('command-refused').textContent).toBe(CANCEL_REFUSAL_WORDS.preview_not_latest);
    expect(screen.getByTestId('command-refused').textContent).not.toBe(REFUSAL_WORDS.preview_not_latest);
  });

  /** A runner like the send card's: it shows `words(reason)` for a refusal, the send flow's words when the control passes none. */
  function Harness({ actions, preview = true }: { actions: Parameters<typeof CancelControls>[0]['actions']; preview?: boolean }) {
    const [note, setNote] = useState<string | null>(null);
    const { props } = withSend({ ...PLACED, ...(preview ? { latestCancelPreview: LATEST_CANCEL_PREVIEW } : {}) }, { data: { gate: CANCEL_GATE } });
    const fixture = props.send;
    const command = {
      pending: null,
      async run(_name: string, call: (() => Promise<SendActionResult>) | undefined, done?: string, words?: (reason: SendActionFailure) => string) {
        const result = call === undefined ? { ok: false as const, reason: 'unavailable' as const } : await call();
        setNote(result.ok ? done ?? null : (words ?? ((reason: SendActionFailure) => REFUSAL_WORDS[reason]))(result.reason));
      },
    };
    return <><CancelControls send={fixture.mcf!.send!} view={fixture.mcf!} data={fixture} actions={actions} command={command} now={props.now} />
      <p data-testid="note">{note}</p></>;
  }

  it('names the cancel preview and its one order when the ledger refuses the press or the read with a code the send flow shares', async () => {
    const shown: string[] = [];
    for (const reason of ['confirmation_mismatch', 'preview_not_latest', 'fingerprint_mismatch'] as const) {
      const actions = { requestCancelPreview: vi.fn(refused), approveCancel: vi.fn(async (): Promise<SendActionResult> => ({ ok: false, reason })) };
      const view = render(<Harness actions={actions} />);
      await act(async () => { fireEvent.click(screen.getByTestId('cancel-button')); });
      expect(actions.approveCancel).toHaveBeenCalledTimes(1);
      shown.push(screen.getByTestId('note').textContent ?? '');
      view.unmount();
    }
    expect(shown).toEqual([CANCEL_REFUSAL_WORDS.confirmation_mismatch, CANCEL_REFUSAL_WORDS.preview_not_latest, CANCEL_REFUSAL_WORDS.fingerprint_mismatch]);
    for (const [index, reason] of (['confirmation_mismatch', 'preview_not_latest', 'fingerprint_mismatch'] as const).entries()) {
      expect(shown[index]).not.toBe(REFUSAL_WORDS[reason]);
    }
    // The read, with a refusal only cancel has, keeps the words every command uses.
    const actions = { requestCancelPreview: vi.fn(async (): Promise<SendActionResult> => ({ ok: false, reason: 'cancel_grant_inactive' })),
      approveCancel: vi.fn(refused) };
    render(<Harness actions={actions} preview={false} />);
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-in-amazon')); });
    expect(actions.requestCancelPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('note').textContent).toBe(REFUSAL_WORDS.cancel_grant_inactive);
  });
});

describe('refresh while a cancel moves', () => {
  it('re-reads every 5 seconds while a read is queued or a cancel is open, every 30 while a cancel preview is current, and not otherwise', async () => {
    vi.useFakeTimers();
    const stale = '2026-09-09T06:44:00.000Z';
    const cases = [
      [{ ...PLACED, cancelPreviewPending: true }, undefined, 7],
      [{ ...PLACED, cancel: OPEN_CANCEL }, undefined, 7],
      [{ ...PLACED, state: 'cancel_dispatching' as const, cancel: { ...OPEN_CANCEL, reservedAt: '2026-09-09T06:40:30.000Z' } }, undefined, 7],
      [{ ...PLACED, latestCancelPreview: LATEST_CANCEL_PREVIEW }, undefined, 1],
      [{ ...PLACED, latestCancelPreview: LATEST_CANCEL_PREVIEW }, stale, 0],
      [{ ...PLACED }, undefined, 0],
    ] as const;
    const counts: number[] = [];
    for (const [send, now] of cases) {
      hoisted.refresh.mockReset();
      const view = render(<Screen data={withSend(send, { data: { gate: CANCEL_GATE }, ...(now === undefined ? {} : { now }) })} actions={pageActions()} />);
      await act(async () => { vi.advanceTimersByTime(35_000); });
      counts.push(hoisted.refresh.mock.calls.length);
      view.unmount();
    }
    expect(counts).toEqual(cases.map(([, , expected]) => expected));
  });
});

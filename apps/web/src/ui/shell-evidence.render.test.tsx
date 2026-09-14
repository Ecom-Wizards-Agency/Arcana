// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShellEvidenceProvider, useShellEvidence, useRefreshShellEvidence, type ShellEvidence } from './shell-evidence';
import { readShellAction, SHELL_EVIDENCE_TTL_MS } from './shell-evidence-client';
import { ScreenTopbar } from './topbar-controls';

const navigation = vi.hoisted(() => ({ query: 'profile=first', pathname: '/grid' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
const value = (profileId: string): ShellEvidence => ({ profileId, freshness: null, crosscheck: null,
  badges: { 'change-queue': null, timeline: 0 } });
let idleCallbacks: Map<number, IdleRequestCallback>;
let idleId: number;
beforeEach(() => {
  navigation.query = 'profile=first';
  navigation.pathname = '/grid';
  vi.useFakeTimers();
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  idleCallbacks = new Map();
  idleId = 0;
  vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
    idleCallbacks.set(++idleId, callback);
    return idleId;
  }));
  vi.stubGlobal('cancelIdleCallback', vi.fn((id: number) => idleCallbacks.delete(id)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function idle() {
  await act(async () => {
    const callbacks = [...idleCallbacks.values()];
    idleCallbacks.clear();
    callbacks.forEach((callback) => callback({ didTimeout: false, timeRemaining: () => 50 }));
  });
}
function Probe() {
  const evidence = useShellEvidence();
  const refresh = useRefreshShellEvidence();
  return <><output>{evidence?.profileId ?? 'Waiting'}</output><button onClick={refresh}>Refresh evidence</button>
    <ScreenTopbar screens={[{ path: '/grid', title: 'Grid' }]} today="2026-08-29" /></>;
}

it('paints loading chips, waits for load, then waits for idle before reading', async () => {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const read = vi.fn(async () => value('first'));
  render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  expect(screen.getByText('Loading freshness…')).toBeTruthy();
  expect(screen.getByText('Loading crosscheck…')).toBeTruthy();
  expect(document.querySelector('.wa-shell-chips')?.getAttribute('aria-busy')).toBe('true');
  await idle();
  expect(read).not.toHaveBeenCalled();
  fireEvent(window, new Event('load'));
  expect(window.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
  expect(read).not.toHaveBeenCalled();
  await idle();
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Freshness unavailable')).toBeTruthy();
  expect(document.querySelector('.wa-shell-chips')?.getAttribute('aria-busy')).toBe('false');
});

it('uses the timeout fallback only after load and cancels it on unmount', async () => {
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const read = vi.fn(async () => value('first'));
  const view = render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(read).not.toHaveBeenCalled();
  fireEvent(window, new Event('load'));
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(read).not.toHaveBeenCalled();
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(read).not.toHaveBeenCalled();
  render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  fireEvent(window, new Event('load'));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(read).toHaveBeenCalledTimes(1);
});

it('keeps a 60-second per-profile cache across query navigation and refreshes on stale focus or explicit refresh', async () => {
  const read = vi.fn(async (id: string | null) => value(id!));
  const view = render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  await idle();
  navigation.query = 'profile=first&entity=campaigns&from=2026-08-01';
  view.rerender(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  fireEvent.focus(window);
  await idle();
  expect(read).toHaveBeenCalledTimes(1);
  navigation.query = 'profile=second';
  view.rerender(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  expect(screen.getByText('Waiting')).toBeTruthy();
  await idle();
  expect(read).toHaveBeenCalledTimes(2);
  navigation.query = 'profile=first';
  view.rerender(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  expect(screen.getByText('first')).toBeTruthy();
  await idle();
  expect(read).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(SHELL_EVIDENCE_TTL_MS - 1));
  fireEvent.focus(window);
  await idle();
  expect(read).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(1));
  fireEvent.focus(window);
  expect(read).toHaveBeenCalledTimes(2);
  await idle();
  expect(read).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByText('Refresh evidence'));
  await idle();
  expect(read).toHaveBeenCalledTimes(4);
});

it('aborts an in-flight read on unmount and handles a late rejection', async () => {
  let signal!: AbortSignal;
  let reject!: (error: Error) => void;
  const read = vi.fn((_id: string | null, abort: AbortSignal) => {
    signal = abort;
    return new Promise<ShellEvidence>((_resolve, fail) => { reject = fail; });
  });
  const view = render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  await idle();
  expect(signal.aborted).toBe(false);
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => reject(new Error('Connection closed')));
});

it('cancels obsolete profile reads and pagehide work without publishing late evidence', async () => {
  const pending: { signal: AbortSignal; resolve: (value: ShellEvidence) => void }[] = [];
  const read = vi.fn((_id: string | null, signal: AbortSignal) => new Promise<ShellEvidence>((resolve) => {
    pending.push({ signal, resolve });
  }));
  const view = render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  await idle();
  navigation.query = 'profile=second';
  view.rerender(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  expect(pending[0]?.signal.aborted).toBe(true);
  await idle();
  await act(async () => pending[0]!.resolve(value('first')));
  expect(screen.getByText('Waiting')).toBeTruthy();
  fireEvent(window, new Event('pagehide'));
  expect(pending[1]?.signal.aborted).toBe(true);
  await act(async () => pending[1]!.resolve(value('second')));
  expect(screen.getByText('Waiting')).toBeTruthy();
  fireEvent.focus(window);
  await idle();
  expect(read).toHaveBeenCalledTimes(3);
});

it('cancels load and idle subscriptions on unmount, including Strict Mode replay', async () => {
  const read = vi.fn(async () => value('first'));
  const view = render(<StrictMode><ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider></StrictMode>);
  expect(idleCallbacks.size).toBe(1);
  await idle();
  expect(read).toHaveBeenCalledTimes(1);
  view.unmount();
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const waiting = render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  waiting.unmount();
  fireEvent(window, new Event('load'));
  await idle();
  expect(read).toHaveBeenCalledTimes(1);
});

it('isolates read failures and makes no shell request in the anonymous frame', async () => {
  const read = vi.fn(async () => { throw new Error('Not authorized'); });
  const view = render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  await idle();
  expect(screen.getByText('Freshness unavailable')).toBeTruthy();
  view.rerender(<ShellEvidenceProvider read={read} enabled={false}><Probe /></ShellEvidenceProvider>);
  fireEvent.focus(window);
  await idle();
  expect(read).toHaveBeenCalledTimes(1);
});

it('cancels an active read on navigation to an unregistered not-found path', async () => {
  let signal!: AbortSignal;
  const read = vi.fn((_id: string | null, abort: AbortSignal) => {
    signal = abort;
    return new Promise<ShellEvidence>(() => {});
  });
  const paths = ['/grid', '/experiments/[experimentId]'];
  const view = render(<ShellEvidenceProvider read={read} enabled paths={paths}><Probe /></ShellEvidenceProvider>);
  await idle();
  navigation.pathname = '/no-such-screen';
  view.rerender(<ShellEvidenceProvider read={read} enabled paths={paths}><span>Not found</span></ShellEvidenceProvider>);
  expect(signal.aborted).toBe(true);
  fireEvent.focus(window);
  await idle();
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Not found')).toBeTruthy();
  navigation.pathname = '/experiments/synthetic-id';
  view.rerender(<ShellEvidenceProvider read={read} enabled paths={paths}><Probe /></ShellEvidenceProvider>);
  await idle();
  expect(read).toHaveBeenCalledTimes(2);
});

it('keeps cancellation signals out of Server Action arguments and consumes late transport failures', async () => {
  let reject!: (error: Error) => void;
  const action = vi.fn(() => new Promise<ShellEvidence>((_resolve, fail) => { reject = fail; }));
  const controller = new AbortController();
  const result = readShellAction(action, 'first', controller.signal);
  const cancelled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await act(async () => {});
  expect(action).toHaveBeenCalledExactlyOnceWith('first');
  controller.abort();
  await cancelled;
  await act(async () => reject(new Error('Transport closed after navigation')));
});

it('retains cached evidence when the layout receives a new reader reference', async () => {
  const read = vi.fn(async () => value('first'));
  const replacement = vi.fn(async () => value('first'));
  const view = render(<ShellEvidenceProvider read={read} enabled><Probe /></ShellEvidenceProvider>);
  await idle();
  navigation.query = 'profile=first&entity=targets';
  view.rerender(<ShellEvidenceProvider read={replacement} enabled><Probe /></ShellEvidenceProvider>);
  await idle();
  expect(read).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Refresh evidence'));
  await idle();
  expect(replacement).toHaveBeenCalledTimes(1);
});

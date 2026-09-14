// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { afterLoadAndIdle } from './shell-evidence-client';
import { installShellFetchActivity, shellFetchActivity, SHELL_FETCH_ACTIVITY_SCRIPT } from './shell-fetch-activity';

afterEach(() => {
  shellFetchActivity()?.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('installs the serialized bootstrap before hydration and installs only once', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  new Function(SHELL_FETCH_ACTIVITY_SCRIPT)();
  const wrapped = window.fetch;
  expect(shellFetchActivity()).toBeDefined();
  expect(installShellFetchActivity()).toBe(shellFetchActivity());
  expect(window.fetch).toBe(wrapped);
  shellFetchActivity()!.dispose();
  expect(window.fetch).toBe(fetch);
});

it('waits for headers, body parsing, and a fresh 500 ms quiet period after each page fetch', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  vi.stubGlobal('requestIdleCallback', undefined);
  let headers!: (response: Response) => void;
  let body!: (value: object) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { headers = resolve; })));
  const activity = installShellFetchActivity();
  const request = window.fetch('/api/grid/rows');
  const run = vi.fn();
  const controller = new AbortController();
  afterLoadAndIdle(run, controller.signal);
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).not.toHaveBeenCalled();
  headers({ body: null, json: () => new Promise<object>((resolve) => { body = resolve; }),
    arrayBuffer() {}, blob() {}, formData() {}, text() {} } as unknown as Response);
  // Use a null body here: parsing itself must still be counted after headers settle.
  // Real stream completion is tested separately below.
  const response = await request.catch(() => null);
  expect(response).not.toBeNull();
  const parsed = response!.json();
  await vi.advanceTimersByTimeAsync(1000);
  expect(activity.pending).toBeGreaterThan(0);
  expect(run).not.toHaveBeenCalled();
  body({ rows: [] });
  await parsed;
  await vi.advanceTimersByTimeAsync(499);
  expect(run).not.toHaveBeenCalled();
  const next = window.fetch('/api/grid/views');
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).not.toHaveBeenCalled();
  headers(new Response(null));
  await next;
  await vi.advanceTimersByTimeAsync(501);
  expect(run).toHaveBeenCalledTimes(1);
  expect(activity.pending).toBe(0);
});

it('keeps streamed bodies pending until EOF or cancellation and preserves their bytes', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }))));
  const activity = installShellFetchActivity();
  const reader = (await window.fetch('/stream')).body!.getReader();
  stream.enqueue(new Uint8Array([1, 2, 3]));
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
  expect(activity.pending).toBeGreaterThan(0);
  stream.close();
  expect((await reader.read()).done).toBe(true);
  expect(activity.pending).toBe(0);
  const cancelled = (await window.fetch('/stream')).body!.getReader();
  await cancelled.cancel();
  expect(activity.pending).toBe(0);
});

it('releases failed requests and cancels scheduled work when its owner unmounts', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Cancelled', 'AbortError'); }));
  const activity = installShellFetchActivity();
  await expect(window.fetch('/cancelled')).rejects.toMatchObject({ name: 'AbortError' });
  expect(activity.pending).toBe(0);
  const run = vi.fn();
  const controller = new AbortController();
  afterLoadAndIdle(run, controller.signal);
  controller.abort();
  await vi.advanceTimersByTimeAsync(5000);
  expect(run).not.toHaveBeenCalled();
});

it('keeps a headers-only read pending until the browser reports the complete resource', async () => {
  let delivered!: PerformanceObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('PerformanceObserver', class {
    constructor(callback: PerformanceObserverCallback) { delivered = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('payload')));
  const activity = installShellFetchActivity();
  const start = performance.now();
  await window.fetch('/headers-only');
  expect(activity.pending).toBe(1);
  delivered({ getEntries: () => [{ initiatorType: 'fetch', name: new URL('/headers-only', document.baseURI).href,
    startTime: start + 1 }] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver);
  expect(activity.pending).toBe(0);
  activity.dispose();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('withdraws an idle callback if another page read starts before it runs', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  let idle!: IdleRequestCallback;
  vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => { idle = callback; return 1; }));
  vi.stubGlobal('cancelIdleCallback', vi.fn());
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  installShellFetchActivity();
  const run = vi.fn();
  afterLoadAndIdle(run, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(500);
  expect(window.requestIdleCallback).toHaveBeenCalledOnce();
  const request = window.fetch('/api/grid/views');
  expect(window.cancelIdleCallback).toHaveBeenCalledWith(1);
  idle({ didTimeout: true, timeRemaining: () => 0 });
  expect(run).not.toHaveBeenCalled();
  resolve(new Response(null));
  await request;
  await vi.advanceTimersByTimeAsync(500);
  idle({ didTimeout: false, timeRemaining: () => 50 });
  expect(run).toHaveBeenCalledOnce();
});

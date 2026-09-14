/** Document-owned request activity, installed before any client island hydrates. */
export interface ShellFetchActivity {
  pending: number;
  lastSettledAt: number;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

type ActivityWindow = Window & { __arcanaShellFetchActivity?: ShellFetchActivity };
export function shellFetchActivity(): ShellFetchActivity | undefined {
  return (window as ActivityWindow).__arcanaShellFetchActivity;
}

/** Self-contained because the layout serializes this function into its early script. */
export function installShellFetchActivity(): ShellFetchActivity {
  const target = window as ActivityWindow;
  if (target.__arcanaShellFetchActivity) return target.__arcanaShellFetchActivity;
  const originalFetch = window.fetch;
  const listeners = new Set<() => void>();
  const records: { url: string; start: number; finish: () => void }[] = [];
  const activity: ShellFetchActivity = {
    pending: 0,
    lastSettledAt: performance.now(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      window.fetch = originalFetch;
      observer?.disconnect();
      listeners.clear();
      delete target.__arcanaShellFetchActivity;
    },
  };
  const notify = () => listeners.forEach((listener) => listener());
  const begin = () => {
    activity.pending++;
    notify();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      activity.pending--;
      activity.lastSettledAt = performance.now();
      notify();
    };
  };
  // Resource completion also releases requests whose callers only inspect headers.
  // Body consumers remain counted separately until parsing or stream reads finish.
  const observer = typeof PerformanceObserver === 'undefined' ? undefined : new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if ((entry as PerformanceResourceTiming).initiatorType !== 'fetch') continue;
      const candidates = records.filter((record) => record.url === entry.name && record.start <= entry.startTime + 1);
      const closest = candidates.sort((a, b) => Math.abs(a.start - entry.startTime) - Math.abs(b.start - entry.startTime))[0];
      if (closest !== undefined) {
        records.splice(records.indexOf(closest), 1);
        closest.finish();
      }
    }
  });
  observer?.observe({ type: 'resource' });
  window.fetch = function (...args: Parameters<typeof fetch>) {
    const input = args[0];
    let url: string;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, document.baseURI).href; }
    catch { return originalFetch.apply(this, args); }
    const settled = begin();
    const finish = () => {
      const index = records.indexOf(record);
      if (index !== -1) records.splice(index, 1);
      settled();
    };
    const record = { url, start: performance.now(), finish };
    records.push(record);
    const failed = (error: unknown): never => { finish(); throw error; };
    try {
      return originalFetch.apply(this, args).then((response) => {
        for (const method of ['arrayBuffer', 'blob', 'formData', 'json', 'text'] as const) {
          const read = response[method].bind(response);
          Object.defineProperty(response, method, { configurable: true, value: async () => {
            const consumed = begin();
            try { return await read(); } finally { consumed(); finish(); }
          } });
        }
        const body = response.body;
        if (body !== null) {
          const getReader = body.getReader.bind(body);
          Object.defineProperty(body, 'getReader', { configurable: true, value: (...options: Parameters<typeof getReader>) => {
            const reader = getReader(...options);
            const consumed = begin();
            const complete = () => { consumed(); finish(); };
            const read = reader.read.bind(reader);
            const cancel = reader.cancel.bind(reader);
            const release = reader.releaseLock.bind(reader);
            Object.defineProperty(reader, 'read', { value: async (...options: Parameters<typeof read>) => {
              try { const result = await Reflect.apply(read, reader, options) as ReadableStreamReadResult<unknown>; if (result.done) complete(); return result; }
              catch (error) { complete(); throw error; }
            } });
            Object.defineProperty(reader, 'cancel', { value: async (reason?: unknown) => {
              try { return await cancel(reason); } finally { complete(); }
            } });
            Object.defineProperty(reader, 'releaseLock', { value: () => { try { release(); } finally { complete(); } } });
            return reader;
          } });
        }
        if (body === null || observer === undefined) finish();
        return response;
      }, failed);
    } catch (error) { return Promise.reject(error).catch(failed); }
  };
  target.__arcanaShellFetchActivity = activity;
  return activity;
}

export const SHELL_FETCH_ACTIVITY_SCRIPT = `(${installShellFetchActivity.toString()})();`;

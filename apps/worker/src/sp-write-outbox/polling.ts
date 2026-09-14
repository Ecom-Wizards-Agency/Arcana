import type { createSpWriteOutboxLoop } from './loop.js';

/** Owns the active tick so shutdown finishes custody work before closing SQL. */
export function startSpWritePolling(loop: ReturnType<typeof createSpWriteOutboxLoop>, intervalMs: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const run = () => {
    active = loop.tick().then((result) => {
      if (result.kind === 'fault') console.error('SP write outbox pass failed', { attemptedCalls: result.attemptedCalls });
    }).catch(() => { console.error('SP write outbox pass unavailable'); }).finally(() => {
      if (!stopped) timer = setTimeout(run, intervalMs);
    });
  };
  run();
  return { async stop(): Promise<void> {
    stopped = true;
    if (timer) clearTimeout(timer);
    loop.stop();
    await active;
  } };
}

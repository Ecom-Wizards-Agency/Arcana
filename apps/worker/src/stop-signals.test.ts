import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { installStopSignalHandlers, STOP_SIGNALS, type StopSignal } from './stop-signals.js';

function harness(options: { stopping?: () => boolean } = {}) {
  const target = new EventEmitter();
  const lines: { event: string; signal: string }[] = [];
  const onStop = vi.fn<(signal: StopSignal) => void>();
  installStopSignalHandlers(onStop, { target: target as never, log: (line) => lines.push(JSON.parse(line) as { event: string; signal: string }), ...options });
  return { target, lines, onStop };
}

describe('persistent stop-signal handlers', () => {
  it('stops once on the first signal and logs every repeat without stopping again or removing itself', () => {
    const { target, lines, onStop } = harness();
    expect(STOP_SIGNALS).toEqual(['SIGINT', 'SIGTERM']);
    for (const signal of STOP_SIGNALS) expect(target.listenerCount(signal), signal).toBe(1);
    target.emit('SIGTERM');
    target.emit('SIGTERM');
    target.emit('SIGINT');
    target.emit('SIGTERM');
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('SIGTERM');
    expect(lines.map((line) => `${line.event}:${line.signal}`)).toEqual([
      'stop_requested:SIGTERM', 'signal_repeated:SIGTERM', 'signal_repeated:SIGINT', 'signal_repeated:SIGTERM',
    ]);
    // Still installed after every signal, so no later signal falls through to the default exit.
    for (const signal of STOP_SIGNALS) expect(target.listenerCount(signal), signal).toBe(1);
  });

  it('treats a stop already under way as a repeat', () => {
    const controller = new AbortController();
    controller.abort();
    const { target, lines, onStop } = harness({ stopping: () => controller.signal.aborted });
    target.emit('SIGINT');
    expect(onStop).not.toHaveBeenCalled();
    expect(lines.map((line) => line.event)).toEqual(['signal_repeated']);
  });

  it('is what the worker and the SP-API connections command install, with no one-shot handler left', () => {
    for (const file of ['./main.ts', './spapi-connections-cli.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toContain('installStopSignalHandlers(');
      expect(source, file).not.toMatch(/process\.once\('SIG(INT|TERM)'/);
      expect(source, file).not.toMatch(/process\.on\('SIG(INT|TERM)'/);
    }
  });
});

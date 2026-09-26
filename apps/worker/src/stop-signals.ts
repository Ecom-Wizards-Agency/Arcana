/**
 * Persistent SIGINT/SIGTERM handling for worker processes.
 *
 * The first signal starts the stop. Later ones are logged and ignored, so a
 * second Ctrl-C or a repeated SIGTERM cannot kill a process while it still
 * holds job or connection custody. A one-shot `process.once` handler would
 * leave the default action (exit) in place for the second signal.
 */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

/** The part of `process` the handlers need; tests pass an emitter. */
export interface StopSignalTarget {
  on(signal: StopSignal, listener: () => void): unknown;
}

export interface StopSignalOptions {
  log?: (line: string) => void;
  /** Whether a stop is already under way; defaults to "a signal was already seen". */
  stopping?: () => boolean;
  target?: StopSignalTarget;
}

export function installStopSignalHandlers(onStop: (signal: StopSignal) => void, options: StopSignalOptions = {}): void {
  const log = options.log ?? ((line: string) => console.info(line));
  const target = options.target ?? process;
  let seen = false;
  const stopping = options.stopping ?? (() => seen);
  for (const signal of STOP_SIGNALS) {
    target.on(signal, () => {
      const repeated = stopping() || seen;
      log(JSON.stringify({ at: new Date().toISOString(), event: repeated ? 'signal_repeated' : 'stop_requested', signal }));
      seen = true;
      if (!repeated) onStop(signal);
    });
  }
}

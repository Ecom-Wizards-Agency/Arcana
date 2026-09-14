import { shellFetchActivity } from './shell-fetch-activity';
import type { ReadShellEvidence, ShellEvidence } from './shell-evidence';

export const SHELL_EVIDENCE_TTL_MS = 60_000;
const IDLE_TIMEOUT_MS = 1_000;

export const SHELL_NETWORK_IDLE_MS = 500;

/** Wait for load, completed data reads and parsing, then a quiet 500 ms and an idle turn. */
export function afterLoadAndIdle(run: () => void, signal: AbortSignal): void {
  let idle: number | undefined;
  let timer: number | undefined;
  let unsubscribe: (() => void) | undefined;
  let loadedAt = 0;
  const activity = shellFetchActivity();
  const clearScheduled = () => {
    if (idle !== undefined) { window.cancelIdleCallback(idle); idle = undefined; }
    if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
  };
  const cancel = () => {
    clearScheduled();
    unsubscribe?.();
    window.removeEventListener('load', loaded);
    signal.removeEventListener('abort', cancel);
  };
  const quietFor = () => performance.now() - Math.max(loadedAt, activity?.lastSettledAt ?? 0);
  const start = () => {
    idle = undefined;
    timer = undefined;
    if (signal.aborted) return;
    // A new fetch may have started since the idle callback was queued.
    if ((activity?.pending ?? 0) > 0 || quietFor() < SHELL_NETWORK_IDLE_MS) { schedule(); return; }
    cancel();
    run();
  };
  const schedule = () => {
    clearScheduled();
    if (signal.aborted || (activity?.pending ?? 0) > 0) return;
    const remaining = SHELL_NETWORK_IDLE_MS - quietFor();
    if (remaining > 0) timer = window.setTimeout(schedule, remaining);
    else if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(start, { timeout: IDLE_TIMEOUT_MS });
    } else timer = window.setTimeout(start, 0);
  };
  const loaded = () => {
    window.removeEventListener('load', loaded);
    loadedAt = performance.now();
    unsubscribe = activity?.subscribe(schedule);
    schedule();
  };
  if (signal.aborted) return;
  signal.addEventListener('abort', cancel, { once: true });
  if (document.readyState === 'complete') loaded();
  else window.addEventListener('load', loaded, { once: true });
}

/** Next owns Server Action transport. Cancel our subscription without serializing a signal. */
export function readShellAction(
  action: (profileId: string | null) => Promise<ShellEvidence | null>,
  profileId: string | null,
  signal: AbortSignal,
): Promise<ShellEvidence | null> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('Shell read cancelled', 'AbortError'));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return action(profileId);
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export interface ShellEvidenceSnapshot {
  key: string | null;
  value: ShellEvidence | null;
  loading: boolean;
}
export const INITIAL_SHELL_EVIDENCE: ShellEvidenceSnapshot = { key: null, value: null, loading: true };
type CachedEvidence = { value: ShellEvidence | null; at: number };

/** Provider-owned cache: never shared between sessions, tabs or server requests. */
export class ShellEvidenceStore {
  private readonly cache = new Map<string | null, CachedEvidence>();
  private readonly listeners = new Set<() => void>();
  private pending: { key: string | null; controller: AbortController } | null = null;
  private selected: string | null = null;
  private snapshot = INITIAL_SHELL_EVIDENCE;

  constructor(private read: ReadShellEvidence) {}
  setRead(read: ReadShellEvidence) { this.read = read; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  private publish(value: ShellEvidence | null, loading: boolean) {
    if (this.snapshot.key === this.selected && this.snapshot.value === value && this.snapshot.loading === loading) return;
    this.snapshot = { key: this.selected, value, loading };
    this.listeners.forEach((listener) => listener());
  }
  select(key: string | null) {
    this.selected = key;
    this.refresh();
  }
  refresh = (force = false) => {
    if (this.pending !== null && this.pending.key === this.selected) {
      this.publish(null, true);
      return;
    }
    const cached = this.cache.get(this.selected);
    if (!force && cached !== undefined && Date.now() - cached.at < SHELL_EVIDENCE_TTL_MS) {
      this.cancel();
      this.publish(cached.value, false);
      return;
    }
    if (this.pending !== null && this.pending.key === null) {
      // A canonical redirect may add the id while the default-profile read is pending.
      this.publish(null, true);
      return;
    }
    this.cancel();
    this.publish(null, true);
    const pending = { key: this.selected, controller: new AbortController() };
    this.pending = pending;
    afterLoadAndIdle(() => {
      void Promise.resolve().then(() => {
        pending.controller.signal.throwIfAborted();
        return this.read(pending.key, pending.controller.signal);
      }).catch(() => null).then((value) => {
        if (pending.controller.signal.aborted) return;
        const cached = { value, at: Date.now() };
        this.cache.set(pending.key, cached);
        if (value !== null) this.cache.set(value.profileId, cached);
        this.pending = null;
        if (this.selected === pending.key || value?.profileId === this.selected) this.publish(value, false);
        else this.refresh();
      });
    }, pending.controller.signal);
  };
  cancel = () => {
    this.pending?.controller.abort();
    this.pending = null;
  };
  dispose = () => {
    this.cancel();
    this.cache.clear();
  };
}

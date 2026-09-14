/** One serial consumer; stop aborts its provider request and waits for custody. */
export class ProviderConnectionLoop {
  private readonly controller = new AbortController();
  private task: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private active = false;
  private running = false;
  private failures = 0;
  private lastSuccessAt: string | null = null;

  constructor(
    private readonly runPass: (signal: AbortSignal) => Promise<{ outcome: 'idle' | 'observed' | 'unavailable' | 'uncertain' }>,
    private readonly pollIntervalMs = 1_000,
  ) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error('Invalid connection poll interval');
  }

  start(): void {
    if (this.task !== null || this.controller.signal.aborted) return;
    this.active = true;
    this.task = this.run().finally(() => { this.active = false; });
  }

  private async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      this.running = true;
      const result = await this.runPass(this.controller.signal);
      this.running = false;
      if (result.outcome === 'idle' || result.outcome === 'observed') {
        this.failures = 0;
        this.lastSuccessAt = new Date().toISOString();
      } else this.failures += 1;
      if (this.controller.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); this.wake = null; resolve(); };
        const timer = setTimeout(done, this.pollIntervalMs);
        timer.unref();
        this.wake = done;
      });
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.wake?.();
    await this.task;
  }

  status(): { enabled: true; running: boolean; stopping: boolean; inFlight: 0 | 1;
    consecutiveFailures: number; lastSuccessAt: string | null } {
    return { enabled: true, running: this.active, stopping: this.controller.signal.aborted,
      inFlight: this.running ? 1 : 0, consecutiveFailures: this.failures, lastSuccessAt: this.lastSuccessAt };
  }
}

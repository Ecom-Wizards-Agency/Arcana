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

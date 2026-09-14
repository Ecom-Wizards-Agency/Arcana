import { cleanup } from '@testing-library/react/pure';
import { act } from 'react';
import type * as ReactDOMClient from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

const mounted = vi.hoisted(() => new Set<{ unmount(): void }>());

// Existing web tests use createRoot directly. RTL cleanup alone cannot see
// those roots, so register them as well without replacing React's renderer.
vi.mock('react-dom/client', async (importOriginal) => {
  const original = await importOriginal<typeof ReactDOMClient>();
  const track = <T extends ReactDOMClient.Root>(root: T): T => {
    const unmount = root.unmount.bind(root);
    root.unmount = () => {
      mounted.delete(root);
      unmount();
    };
    mounted.add(root);
    return root;
  };
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => track(original.createRoot(...args)),
    hydrateRoot: (...args: Parameters<typeof original.hydrateRoot>) => track(original.hydrateRoot(...args)),
  };
});

beforeEach(() => {
  if (typeof window !== 'undefined') {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  }
});

afterEach(async () => {
  if (typeof window === 'undefined') return;
  await act(async () => {
    cleanup();
    for (const root of mounted) root.unmount();
    // Unmount first so effect cleanup removes observers and cancels recurring
    // work. Drain queued callbacks while jsdom and React's act scope still live.
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.clearAllTimers();
      vi.useRealTimers();
    } else {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
      });
    }
  });
  document.body.replaceChildren();
});

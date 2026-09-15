import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ScreenMetadata, ScreenState } from './types';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

export function rendered(view: ReactNode): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(view);
  return host;
}

export interface RenderCase {
  state: ScreenState | 'ready';
  name: string;
  render: () => ReactNode;
  text: string;
  absent?: readonly string[];
}

/** Counted state coverage; each case renders the screen's actual view with synthetic props. */
export function verifyScreen(descriptor: ScreenMetadata, cases: readonly RenderCase[]): void {
  describe(`${descriptor.id} screen`, () => {
    it('covers every declared state', () => {
      expect([...new Set(cases.map((test) => test.state).filter((state) => state !== 'ready'))].sort())
        .toEqual([...descriptor.states].sort());
    });
    for (const test of cases) {
      it(test.name, () => {
        const host = rendered(test.render());
        expect(host.textContent).toContain(test.text);
        for (const selector of test.absent ?? []) expect(host.querySelector(selector)).toBeNull();
        if (test.state === 'loading') expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
      });
    }
  });
}

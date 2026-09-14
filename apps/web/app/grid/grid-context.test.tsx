// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { GridOperatorContext } from './grid-context';
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ view: '1.latest' }),
  useRouter: () => ({ push: vi.fn() }),
}));
it('carries the current URL view into every date preset and the custom form', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<GridOperatorContext account="Synthetic" marketplace="US" currencyCode="USD" timezone="UTC" path="/grid" period={{ start: '2026-08-01', end: '2026-08-30' }} today="2026-09-01" preserved={{ entity: 'targets', view: '1.stale' }} />);
  const links = [...host.querySelectorAll<HTMLAnchorElement>('nav a')];
  expect(links.length).toBeGreaterThan(0);
  expect(links.filter((link) => new URL(link.href).searchParams.get('view') === '1.latest')).toHaveLength(links.length);
  expect(host.querySelector<HTMLInputElement>('input[name="view"]')?.value).toBe('1.latest');
});

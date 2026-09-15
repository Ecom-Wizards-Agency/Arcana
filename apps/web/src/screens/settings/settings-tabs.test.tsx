// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { context } from '../synthetic-render-fixtures';
import { Shell } from './frame';
import { load } from './load';
const navigation = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: navigation.redirect }));
it('renders exactly five settings tabs in shell order and identifies the current tab', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<Shell context={context} current="profiles"><h1>Profiles</h1></Shell>);
  const links = [...host.querySelectorAll('nav[aria-label="Settings"] a')];
  expect(links).toHaveLength(5);
  expect(links.map((link) => link.textContent)).toEqual(['Account','Profiles','Connections','Members','Integrations']);
  expect(links.filter((link) => link.getAttribute('aria-current')==='page').map((link) => link.getAttribute('href'))).toEqual(['/settings/profiles']);
});
it('redirects the settings entry to the first tab', async () => {
  await load(undefined as never,{ searchParams:{},params:{} });
  expect(navigation.redirect).toHaveBeenCalledWith('/settings/account');
});

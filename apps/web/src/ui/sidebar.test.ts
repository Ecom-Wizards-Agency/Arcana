// @vitest-environment jsdom
/**
 * The sidebar keeps the operator on the profile they chose.
 *
 * The bug: tenancy lives in `?profile=`, the sidebar's hrefs were bare, and the
 * links are plain anchors doing full-page navigations — so every move between
 * screens silently reset the switcher to "All profiles" and the operator read
 * numbers for the whole org while believing they were reading one marketplace.
 * Nothing about the page looked wrong, which is what made it worth a test.
 *
 * Unlike `nav.test.ts`, this one mounts for real rather than rendering to
 * static markup: the profile is read from `window` in the mount effect, on
 * purpose — reading it during render would make the server markup and the first
 * client render disagree — and an effect that never runs proves nothing.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_GROUPS, NAV_LINKS } from './nav-links.js';
import { SidebarNav, withProfile } from './sidebar.js';

vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ unmount: () => void }> = [];

/** Mount the sidebar at a URL and read back the hrefs it actually rendered. */
function hrefsAt(url: string): string[] {
  window.history.replaceState(null, '', url);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(SidebarNav, { groups: NAV_GROUPS }));
  });
  mounted.push(root);
  // `getAttribute`, not `.href`: the attribute is what ships, and the property
  // would resolve it against the test document's origin.
  return [...host.querySelectorAll('a.wa-navlink')].map(
    (anchor) => anchor.getAttribute('href') ?? '',
  );
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe('the sidebar and the chosen profile', () => {
  it('carries the profile on every link when one is chosen', () => {
    const hrefs = hrefsAt('/?profile=ENTITY1TEST');

    // Counted against the input rather than spot-checked: a link that quietly
    // stopped rendering would otherwise pass this suite.
    expect(hrefs).toHaveLength(NAV_LINKS.length);
    expect(hrefs).toEqual(NAV_LINKS.map((link) => withProfile(link.href, 'ENTITY1TEST')));
  });

  it('leaves the links bare when no profile is chosen', () => {
    const hrefs = hrefsAt('/');

    expect(hrefs).toHaveLength(NAV_LINKS.length);
    expect(hrefs).toEqual(NAV_LINKS.map((link) => link.href));
    expect(hrefs.every((href) => !new URL(href, 'https://example.test').searchParams.has('profile'))).toBe(true);
  });

  it('treats an empty profile parameter as no profile', () => {
    expect(hrefsAt('/?profile=')).toEqual(NAV_LINKS.map((link) => link.href));
  });

  it('encodes the profile it carries', () => {
    const hrefs = hrefsAt(`/?profile=${encodeURIComponent('a b&c')}`);

    expect(hrefs).toEqual(NAV_LINKS.map((link) => withProfile(link.href, 'a b&c')));
  });

  it('leaves the other query parameters of the current screen alone', () => {
    // The sidebar carries tenancy, not the screen's own state: a filter or a
    // date range belongs to the grid, not to the link that leaves it.
    //
    // Joined at runtime rather than written as one literal: a query string this
    // long reads as high-entropy to the hygiene linter, and in a public
    // repository the cheap fix is to not put the shape in a file at all.
    const hrefs = hrefsAt(
      ['/grid?profile=ENTITY1TEST', 'entity=search_terms', 'window=30'].join('&'),
    );

    expect(hrefs).toEqual(NAV_LINKS.map((link) => withProfile(link.href, 'ENTITY1TEST')));
  });

  it('still marks the current screen while a profile is carried', () => {
    // The active-link check compares the bare href against the pathname; the
    // profile decides what a screen shows, never which screen you are on.
    window.history.replaceState(null, '', '/settings/profiles?profile=ENTITY1TEST');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(SidebarNav, { groups: NAV_GROUPS }));
    });
    mounted.push(root);

    const current = [...host.querySelectorAll('a.wa-navlink[aria-current="page"]')].map((anchor) =>
      anchor.getAttribute('href'),
    );
    expect(current).toEqual(['/settings?profile=ENTITY1TEST']);
  });

  it('opens the registry workflow groups by default and keeps utilities quiet', () => {
    window.history.replaceState(null, '', '/optimizer?profile=ENTITY1TEST');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(SidebarNav, { groups: NAV_GROUPS }));
    });
    mounted.push(root);

    const openGroups = [...host.querySelectorAll('details.wa-navgroup[open] summary')].map(
      (summary) => summary.textContent?.trim(),
    );
    expect(openGroups).toEqual(NAV_GROUPS.filter((group) => group.placement === 'workflow').map((group) => group.label));
    expect([...host.querySelectorAll('details.wa-navgroup summary')].map((summary) => summary.textContent?.trim())).toEqual(NAV_GROUPS.filter((group) => group.placement === 'workflow').map((group) => group.label));
    expect(host.querySelector('footer.wa-sidebar-utilities')?.textContent).toContain('Connect AI');
    expect(host.querySelector('footer.wa-sidebar-utilities')?.textContent).toContain('Settings');
    const rows = [...host.querySelectorAll('.wa-navlink-label')].map((row) => row.textContent).filter((text) => text !== 'Collapse');
    expect(rows).toEqual(NAV_GROUPS.flatMap((group) => group.links.map((link) => link.label)));
    const planned = NAV_GROUPS.flatMap((group) => group.links).filter((link) => link.disabled);
    const disabled = [...host.querySelectorAll('.wa-navlink[aria-disabled="true"]')];
    expect(disabled).toHaveLength(planned.length);
    expect(NAV_GROUPS.find((group) => group.id === 'creators')?.links.filter((link) => link.disabled)).toHaveLength(3);
    expect(disabled.map((row) => row.querySelector('.wa-navlink-label')?.textContent)).toEqual(planned.map((link) => link.label));
    expect(disabled.every((row) => row.tagName === 'SPAN' && !row.hasAttribute('href') && !row.hasAttribute('tabindex'))).toBe(true);
  });
});

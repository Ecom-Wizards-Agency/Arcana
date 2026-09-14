'use client';

/** Renders the server's registry projection and remembers disclosure state. */
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { NavGroup, NavLink } from './nav-links';
import { useShellEvidence } from './shell-evidence';
import { NavIcon } from './nav-icons';

const CLOSED_KEY = 'openspell.nav.closed.v2';
const COLLAPSED_KEY = 'wizard-ads.nav.collapsed';
export function SidebarNav({ groups }: { groups: readonly NavGroup[] }): ReactNode {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const profile = searchParams.get('profile');
  const entity = searchParams.get('entity') ?? 'search_terms';
  const primaryLinks = groups.filter((group) => group.placement === 'primary').flatMap((group) => group.links);
  const workflowGroups = groups.filter((group) => group.placement === 'workflow');
  const afterWorkflowLinks = groups.filter((group) => group.placement === 'after-workflow').flatMap((group) => group.links);
  const utilityLinks = groups.filter((group) => group.placement === 'utility').flatMap((group) => group.links);
  const defaultClosed: readonly string[] = [];
  const [closed, setClosed] = useState<readonly string[]>(defaultClosed);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(CLOSED_KEY);
      if (stored !== null) setClosed(JSON.parse(stored) as string[]);
      applyCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === 'true', setCollapsed);
    } catch {
      // A corrupt or unavailable store is not a reason to lose the nav.
    }
  }, []);

  const remember = (id: string, open: boolean): void => {
    setClosed((current) => {
      const next = open ? current.filter((entry) => entry !== id) : [...new Set([...current, id])];
      try {
        window.localStorage.setItem(CLOSED_KEY, JSON.stringify(next));
      } catch {
        // Persistence is a courtesy; the session still works without it.
      }
      return next;
    });
  };

  const toggleCollapsed = (): void => {
    const next = !collapsed;
    applyCollapsed(next, setCollapsed);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // Same courtesy as above.
    }
  };

  return (
    <>
      <nav aria-label="Primary" className="wa-sidebar-main">
        <ul className="wa-navlist wa-navlist--direct">
          {primaryLinks.map((link) => (
            <NavLinkRow key={link.href} link={link} pathname={pathname} profile={profile} entity={entity} />
          ))}
        </ul>

        {workflowGroups.map((group) => {
          const holdsCurrent =
            pathname !== null && group.links.some((link) => isCurrent(link.href, pathname, entity));
          return (
            <details
              key={group.id}
              className="wa-navgroup"
              open={collapsed || holdsCurrent || !closed.includes(group.id)}
              onToggle={(event) => {
                // The rail forces groups open; that toggle is ours, not the
                // operator's, and must not overwrite their stored closed set.
                if (!collapsed) remember(group.id, event.currentTarget.open);
              }}
            >
              <summary title={group.label}>
                <svg aria-hidden="true" className="wa-navgroup-caret" viewBox="0 0 8 8">
                  <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                <span aria-hidden="true" className="wa-navgroup-icon">
                  <NavIcon icon={group.icon} />
                </span>
                <span className="wa-navgroup-label">{group.label}</span>
              </summary>
              <ul className="wa-navlist">
                {group.links.map((link) => (
                  <NavLinkRow key={link.href} link={link} pathname={pathname} profile={profile} entity={entity} />
                ))}
              </ul>
            </details>
          );
        })}
        <ul className="wa-navlist wa-navlist--direct">
          {afterWorkflowLinks.map((link) => (
            <NavLinkRow key={link.href} link={link} pathname={pathname} profile={profile} entity={entity} />
          ))}
        </ul>
      </nav>

      <footer className="wa-sidebar-utilities">
        <nav aria-label="Product and account">
          <ul className="wa-navlist">
            {utilityLinks.slice(0, 1).map((link) => (
              <NavLinkRow key={link.href} link={link} pathname={pathname} profile={profile} entity={entity} />
            ))}
          </ul>
        </nav>
        <details className="wa-shell-more" open={collapsed}>
          <summary>More</summary>
          <nav aria-label="More destinations"><ul className="wa-navlist">
            {utilityLinks.slice(1).map((link) => <NavLinkRow key={link.href} link={link} pathname={pathname} profile={profile} entity={entity} />)}
          </ul></nav>
        </details>

        <button
          type="button"
          className="wa-nav-collapse"
          data-testid="nav-collapse"
          aria-pressed={collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          onClick={toggleCollapsed}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="wa-nav-collapse-icon">
            <path
              d="M10 3.5 5.5 8l4.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="wa-navlink-label">Collapse</span>
        </button>
      </footer>
    </>
  );
}

function NavLinkRow({
  link,
  pathname,
  profile,
  entity,
}: {
  link: NavLink;
  pathname: string | null;
  profile: string | null;
  entity: string;
}): ReactNode {
  const current = !link.disabled && pathname !== null && isCurrent(link.href, pathname, entity);
  const content = <>
    <span aria-hidden="true" className="wa-navlink-icon"><NavIcon icon={link.icon} /></span>
    <span className="wa-navlink-label">{link.label}</span>
    {link.tag === undefined ? null : <span className="wa-navlink-tag">{link.tag}</span>}
    {link.badgeSource === undefined ? null : <NavBadge source={link.badgeSource} />}
  </>;
  return <li>
    {link.disabled ? <span className="wa-navlink" aria-disabled="true" title="Planned">{content}</span> :
      <Link href={withProfile(link.href, profile)} prefetch={link.prefetch ? null : false}
        className="wa-navlink" title={link.label} aria-current={current ? 'page' : undefined}>{content}</Link>}
  </li>;
}

function NavBadge({ source }: { source: 'change-queue' | 'timeline' }) {
  const count = useShellEvidence()?.badges[source];
  return <span className="wa-shell-badge" data-badge-source={source}
    aria-label={count == null ? 'Count unavailable' : `${count} ${source === 'timeline' ? 'active experiments' : 'pending review'}`}>
    {count ?? '—'}
  </span>;
}

/** Reflect the collapse state onto the root so CSS can resize the whole frame. */
function applyCollapsed(value: boolean, set: (value: boolean) => void): void {
  set(value);
  if (value) document.documentElement.setAttribute('data-nav-collapsed', 'true');
  else document.documentElement.removeAttribute('data-nav-collapsed');
}

/** Merge profile context with a preset's existing query. */
export function withProfile(href: string, profile: string | null): string {
  if (profile === null || profile === '') return href;
  const [path, search = ''] = href.split('?');
  const query = new URLSearchParams(search);
  query.set('profile', profile);
  return `${path}?${query.toString()}`;
}

/** Grid presets match their entity; ordinary routes match whole path segments. */
export function isCurrent(href: string, pathname: string, entity = 'search_terms'): boolean {
  const [path = href, search = ''] = href.split('?');
  const preset = new URLSearchParams(search).get('entity');
  if (preset !== null) return pathname === path && entity === preset;
  return pathname === path || (path !== '/' && pathname.startsWith(`${path}/`));
}

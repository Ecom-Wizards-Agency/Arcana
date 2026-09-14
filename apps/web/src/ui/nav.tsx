/** Server-owned roster and registry projection for the application shell. */
import { SCREEN_REGISTRY } from '../screens/registry-metadata';
import { todayIso } from '../../app/_lib/periods';
import type { ReactNode } from 'react';
import type { SessionUser } from '../auth/session';
import { NAV_GROUPS, NAV_LINKS, navigationFor } from './nav-links';
import type { NavGroup, NavLink } from './nav-links';
import { ProfileAwareBrand } from './profile-aware-brand';
import { SidebarNav } from './sidebar';
import { IdentityMenu, ProfileSwitcher, ThemeToggle, ScreenTopbar } from './topbar-controls';
import type { NavProfile } from './topbar-controls';

export { NAV_GROUPS, NAV_LINKS };
export type { NavGroup, NavLink, NavProfile };

export interface NavUser {
  id: string;
  email: string | null;
}

export interface NavBarProps {
  user: NavUser | null;
  /** The org's advertising profiles, for the sidebar switcher. */
  profiles?: readonly NavProfile[];
  /** The active organisation's name, when one could be resolved. */
  orgName?: string | null;
  groups?: readonly NavGroup[];
}

export function NavBar({ user, profiles = [], groups = NAV_GROUPS }: NavBarProps): ReactNode {
  if (user === null) {
    return (
      <div data-testid="app-nav" data-auth-state="anonymous">
        <a className="wa-skip" href="#wa-main">
          Skip to content
        </a>

        <header className="wa-public-topbar">
          <ProfileAwareBrand />
          <span className="wa-topbar-spacer" />
          <ThemeToggle />
          <a href="/login" className="wa-btn wa-btn--sm" data-testid="nav-signin">
            Sign in
          </a>
        </header>
      </div>
    );
  }

  return (
    <div data-testid="app-nav" data-auth-state="authenticated">
      <a className="wa-skip" href="#wa-main">
        Skip to content
      </a>

      <aside className="wa-sidebar">
        <ProfileSwitcher profiles={profiles} />
        <SidebarNav groups={groups} />
        <div className="wa-shell-account"><ProfileAwareBrand /><ThemeToggle /><IdentityMenu email={user.email} /></div>

      </aside>

      <header className="wa-topbar">
        <ScreenTopbar today={todayIso()} profiles={profiles} now={new Date().toISOString()} screens={SCREEN_REGISTRY.filter((screen) => screen.route !== 'redirect' && screen.route !== 'planned').map((screen) => ({
          path: screen.path, title: screen.nav?.label ?? screen.guard?.heading ?? screen.id.split('-').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' '),
        }))} />
      </header>
    </div>
  );
}

/**
 * The root layout's frame: the same chrome, with the real session behind it.
 *
 * The root layout resolves the session once and shares it with the navigation
 * and authenticated-only frame controls. The roster read is best-effort on
 * purpose. The switcher is a convenience in the chrome, and chrome must never
 * be the reason a screen fails to render — an unreachable database already has
 * a page that says so, and it is not this one's job to say it a second time in
 * a stack trace.
 */
export async function AppNav({ user }: { user: SessionUser | null }): Promise<ReactNode> {
  if (user === null) return <NavBar user={null} />;

  const { navContext } = await import('./nav-context');
  const context = await navContext(user);
  return <NavBar user={user} profiles={context.profiles} orgName={context.orgName} groups={navigationFor(SCREEN_REGISTRY, process.env, true)} />;
}

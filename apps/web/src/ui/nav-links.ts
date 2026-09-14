import { SCREEN_GROUPS, SCREEN_REGISTRY } from '../screens/registry-metadata';
import { screenEnabled, type ScreenMetadata } from '../screens/types';

export interface NavLink {
  href: string;
  label: string;
  icon: string;
  tag?: string;
  badgeSource?: 'change-queue' | 'timeline';
  prefetch: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: string;
  placement: 'primary' | 'workflow' | 'after-workflow' | 'utility';
  links: readonly NavLink[];
}

/** Server projection: the browser receives no descriptors, loaders or environment. */
export function navigationFor(
  screens: readonly ScreenMetadata[] = SCREEN_REGISTRY,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly NavGroup[] {
  return SCREEN_GROUPS.map((group) => ({
    ...group,
    links: screens.filter((screen) => screen.nav?.group === group.id && screenEnabled(screen, env))
      .sort((left, right) => (left.nav?.order ?? 0) - (right.nav?.order ?? 0))
      .flatMap((screen): NavLink[] => screen.nav === null ? [] : [{
        href: screen.path,
        label: screen.nav.label,
        icon: screen.nav.icon,
        prefetch: screen.prefetch === 'cheap',
        ...(screen.nav.tag === undefined ? {} : { tag: screen.nav.tag }),
        ...(screen.nav.badgeSource === undefined ? {} : { badgeSource: screen.nav.badgeSource }),
      }]),
  })).filter((group) => group.links.length > 0);
}

export const NAV_GROUPS = navigationFor();
export const NAV_LINKS: readonly NavLink[] = NAV_GROUPS.flatMap((group) => group.links);

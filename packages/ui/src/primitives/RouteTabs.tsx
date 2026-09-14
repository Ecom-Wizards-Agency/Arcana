import type { ReactNode } from 'react';

export interface TabItem {
  href: string;
  label: string;
}

export function RouteTabs({
  items,
  current,
  ariaLabel,
}: {
  items: readonly TabItem[];
  current: string;
  ariaLabel: string;
}): ReactNode {
  return (
    <nav aria-label={ariaLabel} className="wa-tabs">
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          className="wa-tab"
          {...(item.href === current ? { 'aria-current': 'page' as const } : {})}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}


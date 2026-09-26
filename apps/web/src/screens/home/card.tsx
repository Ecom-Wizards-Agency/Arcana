'use client';
import { createContext, useCallback, useContext, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  parseHomeSectionPreferences, readHomeSectionPreferences, readHomeSectionSnapshot, subscribeHomeSectionPreferences,
  writeHomeSectionPreferences, type HomeSectionId,
} from './preferences';

interface SectionsState {
  isCollapsed: (id: HomeSectionId) => boolean;
  toggle: (id: HomeSectionId) => void;
}

const SectionsContext = createContext<SectionsState | null>(null);

/** The server cannot see this browser's preference; hydration starts from the same expanded markup. */
const serverSnapshot = (): string | null => null;

/**
 * Owns the collapsed state of every Home section for one signed-in user.
 *
 * The saved state is read synchronously through `useSyncExternalStore`, so a
 * client render (every client navigation to Home) applies it on its first
 * render and a collapsed section never paints open first. The server render
 * and the hydration pass use the expanded server snapshot so both markups
 * agree; React switches to the saved state right after hydrating.
 */
export function HomeSections({ preferenceKey, children }: { preferenceKey: string; children: ReactNode }) {
  const serialized = useSyncExternalStore(
    subscribeHomeSectionPreferences,
    () => readHomeSectionSnapshot(preferenceKey),
    serverSnapshot,
  );
  const collapsed = useMemo<ReadonlySet<HomeSectionId>>(
    () => new Set(parseHomeSectionPreferences(serialized)?.collapsed ?? []),
    [serialized],
  );
  const toggle = useCallback((id: HomeSectionId) => {
    const next = new Set(readHomeSectionPreferences(preferenceKey)?.collapsed ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeHomeSectionPreferences(preferenceKey, next);
  }, [preferenceKey]);
  const value = useMemo(() => ({ isCollapsed: (id: HomeSectionId) => collapsed.has(id), toggle }), [collapsed, toggle]);
  return <SectionsContext.Provider value={value}>{children}</SectionsContext.Provider>;
}

export interface HomeSectionControl {
  id: HomeSectionId;
  /** Rows the section holds; shown in the header whether open or collapsed. */
  count: number;
  noun: readonly [singular: string, plural: string];
}

export function HomeCard({ title, subtitle, children, className = '', section }: {
  title: string; subtitle: string; children: ReactNode; className?: string; section?: HomeSectionControl;
}) {
  const shared = useContext(SectionsContext);
  const [local, setLocal] = useState(false);
  const bodyId = useId();
  if (section === undefined) {
    return <section className={`wa-home-card ${className}`} aria-label={title}>
      <header><h2>{title}</h2><p>{subtitle}</p></header>{children}
    </section>;
  }
  const collapsed = shared === null ? local : shared.isCollapsed(section.id);
  const toggle = () => (shared === null ? setLocal((value) => !value) : shared.toggle(section.id));
  const countText = `${section.count.toLocaleString('en-US')} ${section.count === 1 ? section.noun[0] : section.noun[1]}`;
  return <section className={`wa-home-card ${className}`} aria-label={title} data-section={section.id} data-collapsed={collapsed ? 'true' : 'false'}>
    <header>
      <div className="wa-home-card-head">
        <h2>{title}</h2>
        <span className="wa-home-count" data-testid={`home-count-${section.id}`}>{countText}</span>
        <button className="wa-home-toggle" type="button" aria-expanded={!collapsed} aria-controls={bodyId}
          aria-label={`${collapsed ? 'Show' : 'Hide'} ${title}`} onClick={toggle}>{collapsed ? 'Show' : 'Hide'}</button>
      </div>
      {collapsed ? null : <p>{subtitle}</p>}
    </header>
    <div className="wa-home-card-body" id={bodyId} hidden={collapsed}>{children}</div>
  </section>;
}

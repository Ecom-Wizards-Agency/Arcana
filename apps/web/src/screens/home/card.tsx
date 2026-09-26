'use client';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { readHomeSectionPreferences, writeHomeSectionPreferences, type HomeSectionId } from './preferences';

interface SectionsState {
  isCollapsed: (id: HomeSectionId) => boolean;
  toggle: (id: HomeSectionId) => void;
}

const SectionsContext = createContext<SectionsState | null>(null);

/**
 * Owns the collapsed state of every Home section for one signed-in user.
 * The first render expands everything, so server and client markup agree;
 * the saved state is restored after mount and written back on each change.
 */
export function HomeSections({ preferenceKey, children }: { preferenceKey: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<HomeSectionId>>(() => new Set());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setCollapsed(new Set(readHomeSectionPreferences(preferenceKey)?.collapsed ?? []));
    setReady(true);
  }, [preferenceKey]);
  useEffect(() => {
    if (ready) writeHomeSectionPreferences(preferenceKey, collapsed);
  }, [ready, preferenceKey, collapsed]);
  const toggle = useCallback((id: HomeSectionId) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
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

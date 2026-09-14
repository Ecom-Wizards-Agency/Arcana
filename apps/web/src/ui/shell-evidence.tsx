'use client';

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { FreshnessBanner, type FreshnessAssessment } from '@wizard-ads/ui';
import { INITIAL_SHELL_EVIDENCE, ShellEvidenceStore, readShellAction } from './shell-evidence-client';
import type { VerdictChip } from '@wizard-ads/crosscheck-cli/pure';

export interface ShellEvidence {
  profileId: string;
  freshness: FreshnessAssessment | null;
  crosscheck: VerdictChip | null;
  badges: { 'change-queue': number | null; timeline: number | null };
}
export type ReadShellEvidence = (profileId: string | null, signal: AbortSignal) => Promise<ShellEvidence | null>;
const Evidence = createContext<{ store: ShellEvidenceStore; key: string | null } | null>(null);
const Refresh = createContext<() => void>(() => {});
const subscribeEmpty = () => () => {};
const emptySnapshot = () => INITIAL_SHELL_EVIDENCE;
function useEvidenceSnapshot() {
  const context = useContext(Evidence);
  const snapshot = useSyncExternalStore(context?.store.subscribe ?? subscribeEmpty,
    context?.store.getSnapshot ?? emptySnapshot, emptySnapshot);
  return { context, snapshot };
}
export function useShellEvidenceLoading() {
  const { context, snapshot } = useEvidenceSnapshot();
  return context !== null && (snapshot.key !== context.key || snapshot.loading);
}
export const useRefreshShellEvidence = () => useContext(Refresh);
export function useShellEvidence(): ShellEvidence | null {
  const { context, snapshot } = useEvidenceSnapshot();
  return context !== null && snapshot.key === context.key ? snapshot.value : null;
}

/** One shell read per profile selection. A late response can never label another profile. */
interface ShellEvidenceProviderProps {
  children: ReactNode;
  read: ReadShellEvidence;
  enabled: boolean;
  paths?: readonly string[];
}
export function ShellEvidenceProvider(props: ShellEvidenceProviderProps) {
  return props.enabled ? <RoutedShellEvidenceProvider {...props} /> : props.children;
}
/** Keeps AbortSignal on the client when the transport is a Next Server Action. */
export function ShellEvidenceActionProvider({ read, ...props }: Omit<ShellEvidenceProviderProps, 'read'> & {
  read: (profileId: string | null) => Promise<ShellEvidence | null>;
}) {
  const clientRead = useMemo<ReadShellEvidence>(() => (profileId, signal) => readShellAction(read, profileId, signal), [read]);
  return <ShellEvidenceProvider {...props} read={clientRead} />;
}
function RoutedShellEvidenceProvider(props: ShellEvidenceProviderProps) {
  const pathname = usePathname();
  const segments = pathname?.split('/');
  const known = props.paths === undefined || props.paths.some((path) => {
    const pattern = path.split('/');
    return pattern.length === segments?.length && pattern.every((part, index) =>
      part === segments[index] || (part.startsWith('[') && part.endsWith(']') && segments[index] !== ''));
  });
  return known ? <ActiveShellEvidenceProvider {...props} /> : props.children;
}

function ActiveShellEvidenceProvider({ children, read }: {
  children: ReactNode; read: ReadShellEvidence; enabled: boolean;
}) {
  const search = useSearchParams();
  const requested = search.get('profile');
  const query = search.toString();
  const [store] = useState(() => new ShellEvidenceStore(read));
  useEffect(() => { store.setRead(read); }, [store, read]);
  useEffect(() => { store.select(requested); }, [store, requested, query]);
  useEffect(() => {
    const focus = () => store.refresh();
    window.addEventListener('focus', focus);
    window.addEventListener('pagehide', store.cancel);
    return () => {
      window.removeEventListener('focus', focus);
      window.removeEventListener('pagehide', store.cancel);
      store.dispose();
    };
  }, [store]);
  const refresh = useMemo(() => () => store.refresh(true), [store]);
  // Only evidence consumers subscribe to changes; the page tree keeps a stable context.
  const context = useMemo(() => ({ store, key: requested }), [store, requested]);
  return <Refresh.Provider value={refresh}>
    <Evidence.Provider value={context}>{children}</Evidence.Provider>
  </Refresh.Provider>;
}

export function ShellFreshnessBanner({ children }: { children?: ReactNode }) {
  const evidence = useShellEvidence();
  const loading = useShellEvidenceLoading();
  // The shell read deliberately arrives after the grid is usable. Reserve the
  // compact banner's space so that arrival cannot move a header during a drag.
  return <div style={{ minHeight: '3rem' }}>
    {evidence?.freshness == null
      ? <p role="status" aria-busy={loading} style={{ margin: 0, padding: '0.5rem 0.75rem', color: 'var(--wa-text-muted)' }}>
        {loading ? 'Loading data freshness…' : 'Data freshness unavailable'}
      </p>
      : <FreshnessBanner assessment={evidence.freshness}>{children}</FreshnessBanner>}
  </div>;
}

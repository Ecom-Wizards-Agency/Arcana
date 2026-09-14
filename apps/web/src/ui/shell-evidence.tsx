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
const Evidence = createContext<ShellEvidence | null>(null);
const Loading = createContext<boolean | null>(null);
const Refresh = createContext<() => void>(() => {});
export function useShellEvidenceLoading() {
  const loading = useContext(Loading);
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  return loading !== null && (!hydrated || loading);
}
export const useRefreshShellEvidence = () => useContext(Refresh);
const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
export function useShellEvidence(): ShellEvidence | null {
  const evidence = useContext(Evidence);
  // A streamed island may hydrate after the shell read has completed. Its first
  // client render must still agree with the unavailable server snapshot.
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  return hydrated ? evidence : null;
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
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => INITIAL_SHELL_EVIDENCE);
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
  const matches = snapshot.key === requested;
  return <Refresh.Provider value={refresh}><Loading.Provider value={!matches || snapshot.loading}>
    <Evidence.Provider value={matches ? snapshot.value : null}>{children}</Evidence.Provider>
  </Loading.Provider></Refresh.Provider>;
}

export function ShellFreshnessBanner({ children }: { children?: ReactNode }) {
  const evidence = useShellEvidence();
  return evidence?.freshness == null ? null : <FreshnessBanner assessment={evidence.freshness}>{children}</FreshnessBanner>;
}

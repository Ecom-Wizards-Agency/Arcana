/**
 * Which Home sections an operator has collapsed, kept per signed-in user in
 * this browser. Same shape as the cockpit chart preferences: a versioned JSON
 * document, parsed defensively, with unknown or repeated values dropped and
 * any unreadable document treated as absent.
 */

export const HOME_SECTION_IDS = ['flags', 'proposals', 'events', 'ranks', 'pacing', 'market'] as const;
export type HomeSectionId = (typeof HOME_SECTION_IDS)[number];

export interface HomeSectionPreferences {
  version: 1;
  collapsed: HomeSectionId[];
}

const PREFERENCE_VERSION = 1;
const PREFERENCE_PREFIX = 'openspell:home-sections:v1';

function isSectionId(value: unknown): value is HomeSectionId {
  return typeof value === 'string' && (HOME_SECTION_IDS as readonly string[]).includes(value);
}

export function parseHomeSectionPreferences(serialized: string | null): HomeSectionPreferences | null {
  if (serialized === null) return null;
  try {
    const parsed = JSON.parse(serialized) as { version?: unknown; collapsed?: unknown };
    if (parsed.version !== PREFERENCE_VERSION || !Array.isArray(parsed.collapsed)) return null;
    const collapsed = HOME_SECTION_IDS.filter((id) => (parsed.collapsed as unknown[]).some((value) => isSectionId(value) && value === id));
    return { version: PREFERENCE_VERSION, collapsed };
  } catch {
    return null;
  }
}

export function homeSectionStorageKey(userKey: string): string {
  return `${PREFERENCE_PREFIX}:${userKey}`;
}

/** Documents this visit could not store; they still apply until the page unloads. */
const unstored = new Map<string, string>();
const listeners = new Set<() => void>();

/**
 * The saved document as a string, read synchronously. A string compares by
 * value, so `useSyncExternalStore` sees no change until the document changes.
 */
export function readHomeSectionSnapshot(userKey: string): string | null {
  const key = homeSectionStorageKey(userKey);
  const pending = unstored.get(key);
  if (pending !== undefined) return pending;
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function readHomeSectionPreferences(userKey: string): HomeSectionPreferences | null {
  return parseHomeSectionPreferences(readHomeSectionSnapshot(userKey));
}

/** Notified on every write here and on storage changes from other tabs. */
export function subscribeHomeSectionPreferences(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function writeHomeSectionPreferences(userKey: string, collapsed: ReadonlySet<HomeSectionId>): void {
  const preferences: HomeSectionPreferences = {
    version: PREFERENCE_VERSION,
    collapsed: HOME_SECTION_IDS.filter((id) => collapsed.has(id)),
  };
  const key = homeSectionStorageKey(userKey);
  const serialized = JSON.stringify(preferences);
  try {
    window.localStorage?.setItem(key, serialized);
    unstored.delete(key);
  } catch {
    // Storage may be disabled. Sections still collapse for this visit.
    unstored.set(key, serialized);
  }
  for (const listener of listeners) listener();
}

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

export function readHomeSectionPreferences(userKey: string): HomeSectionPreferences | null {
  try {
    return parseHomeSectionPreferences(window.localStorage?.getItem(homeSectionStorageKey(userKey)) ?? null);
  } catch {
    return null;
  }
}

export function writeHomeSectionPreferences(userKey: string, collapsed: ReadonlySet<HomeSectionId>): void {
  const preferences: HomeSectionPreferences = {
    version: PREFERENCE_VERSION,
    collapsed: HOME_SECTION_IDS.filter((id) => collapsed.has(id)),
  };
  try {
    window.localStorage?.setItem(homeSectionStorageKey(userKey), JSON.stringify(preferences));
  } catch {
    // Storage may be disabled. Sections still collapse for this visit.
  }
}

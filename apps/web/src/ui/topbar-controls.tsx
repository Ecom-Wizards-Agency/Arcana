'use client';

/** Profile and date navigation preserve the current route's query state. */
import type { FreshnessAssessment } from '@wizard-ads/ui';
import type { VerdictChip } from '@wizard-ads/crosscheck-cli/pure';
import { addDays, periodFromParams, periodFromParamsThroughToday, precedingPeriod, todayIsoInTimeZone, type Period } from '../../app/_lib/periods';
import { comparisonLengthState, dateRangeHref } from './date-range';
import { DateRangePicker } from './date-range-picker';
import { useShellEvidence, useShellEvidenceLoading } from './shell-evidence';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PROFILE_COOKIE } from '../cookies';
import { resolveActiveProfile } from '../data/active-profile';
import { THEME_KEY } from './theme-script';

export interface NavProfile {
  id: string;
  label: string;
  countryCode: string;
  syncEnabled: boolean;
  currencyCode?: string;
  syncLabel?: string;
  timezone?: string;
}

/** Two stable initials from an address, with a product fallback for address-less sessions. */
export function userInitials(email: string | null): string {
  if (email === null) return 'WA';
  const local = email.split('@')[0]?.trim() ?? '';
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return local.slice(0, 2).toUpperCase() || 'WA';
}

export function filterNavProfiles(
  profiles: readonly NavProfile[],
  showAll: boolean,
  query: string,
): NavProfile[] {
  const needle = query.trim().toLowerCase();
  return profiles.filter(
    (profile) =>
      (showAll || profile.syncEnabled) &&
      (needle === '' ||
        profile.label.toLowerCase().includes(needle) ||
        profile.countryCode.toLowerCase().includes(needle)),
  );
}

export function ProfileSwitcher({ profiles }: { profiles: readonly NavProfile[] }): ReactNode {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [selected, setSelected] = useState(
    () => resolveActiveProfile(profiles, undefined)?.id ?? '',
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const requested = searchParams.get('profile') ?? undefined;
    setSelected(resolveActiveProfile(profiles, requested)?.id ?? '');
  }, [profiles, searchParams]);

  // Close on an outside click or Escape — a popover that only closes by
  // re-clicking the trigger is a popover an operator fights.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery('');
  }, [open]);

  if (profiles.length === 0) return null;

  const go = (profileId: string): void => {
    const next = new URLSearchParams(searchParams.toString());
    next.set('profile', profileId);
    // Preview batches are profile-scoped. Carrying one across the profile
    // switch would make the new workspace poll a foreign batch.
    next.delete('batch');
    document.cookie = `${PROFILE_COOKIE}=${encodeURIComponent(profileId)}; path=/; max-age=31536000; SameSite=Lax`;
    setSelected(profileId);
    setOpen(false);
    router.push(`${pathname}?${next.toString()}`);
  };

  const active = profiles.find((profile) => profile.id === selected) ?? null;
  const matches = filterNavProfiles(profiles, showAll, query);
  const syncOffCount = profiles.filter((profile) => !profile.syncEnabled).length;

  return (
    <div className="wa-profile" ref={rootRef}>
      <button
        type="button"
        className="wa-profile-trigger"
        data-testid="profile-switcher"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Advertising profile"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="wa-profile-trigger-label">
          <strong>{active?.label ?? 'Advertising profile'}</strong>
          <small>{active?.countryCode}{active?.currencyCode ? ` · ${active.currencyCode}` : ''} · {active?.syncEnabled ? active.syncLabel ?? 'Sync enabled' : 'Sync off'}</small>
        </span>
        <ProfileSyncStatus />
        <svg aria-hidden="true" viewBox="0 0 10 10" className="wa-profile-caret">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>

      {open ? (
        <div className="wa-profile-menu" role="dialog" aria-label="Choose advertising profile">
          <input
            ref={searchRef}
            type="text"
            className="wa-input wa-input--sm wa-profile-search"
            placeholder="Search profiles…"
            aria-label="Search profiles"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="wa-profile-list" role="listbox" aria-label="Advertising profiles">
            {matches.map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  className={`wa-profile-option${profile.syncEnabled ? '' : ' wa-profile-option--sync-off'}`}
                  aria-selected={profile.id === selected}
                  role="option"
                  onClick={() => go(profile.id)}
                >
                  <span>
                    {profile.label} <span className="wa-hint">· {profile.countryCode}</span>
                    {profile.syncEnabled ? null : <span className="wa-hint"> · sync off</span>}
                  </span>
                  {profile.id === selected ? <span aria-hidden="true">✓</span> : null}
                </button>
              </li>
            ))}
            {matches.length === 0 ? (
              <li className="wa-profile-empty">No profile matches “{query}”.</li>
            ) : null}
            {syncOffCount > 0 ? (
              <li>
                <button
                  type="button"
                  className="wa-profile-option wa-profile-show-all"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll ? 'Show syncing profiles only' : `Show all profiles (${profiles.length})`}
                </button>
              </li>
            ) : null}
          </ul>
          {/* Leaves the popover for another screen; it should not also leave
              the profile behind. */}
          <Link
            href={`/settings/profiles?profile=${encodeURIComponent(selected)}`}
            prefetch={false}
            className="wa-profile-manage"
          >
            Manage Profiles
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function ProfileSyncStatus() {
  const evidence = useShellEvidence();
  return <span className="wa-profile-sync" data-tone={evidence?.freshness?.tone ?? 'muted'} title={evidence?.freshness?.headline ?? 'Freshness unavailable'}><StatusDot /></span>;
}

/**
 * Light or dark, chosen and remembered.
 *
 * Rendered as "follows the system" until the effect runs, because the honest
 * answer before mount is that we do not yet know what the document is set to.
 * The stamp itself is applied by the inline script in the root layout, which
 * runs before first paint so the page never flashes the wrong theme.
 */
export function ThemeToggle(): ReactNode {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const stamped = document.documentElement.getAttribute('data-theme');
    setTheme(stamped === 'dark' ? 'dark' : 'light');
  }, []);

  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      aria-label={`Switch to ${next} mode`}
      className="wa-btn wa-theme-toggle"
      data-testid="theme-toggle"
      onClick={() => {
        document.documentElement.setAttribute('data-theme', next);
        try {
          window.localStorage.setItem(THEME_KEY, next);
        } catch {
          // A blocked store means the choice lasts one session. Still worth it.
        }
        setTheme(next);
      }}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
      <span>{theme === null ? 'Theme' : theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  );
}

/** Compact identity in the bar; the address and sign-out action live inside the menu. */
export function IdentityMenu({ email }: { email: string | null }): ReactNode {
  const label = email ?? 'your account';
  return (
    <details className="wa-identity" data-testid="nav-identity">
      <summary className="wa-identity-trigger" aria-label={`Account menu for ${label}`}>
        <span className="wa-avatar" aria-hidden="true">
          {userInitials(email)}
        </span>
        <svg aria-hidden="true" viewBox="0 0 10 10" className="wa-profile-caret">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </summary>
      <div className="wa-identity-menu">
        <span className="wa-identity-email" title={label}>
          {label}
        </span>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="wa-btn wa-btn--ghost wa-btn--sm"
            data-testid="nav-signout"
          >
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}

/** Registry title and resolved windows follow App Router query changes. */
export function ScreenTopbar({ screens, today, profiles = [], now }: {
  screens: readonly { path: string; title: string }[]; today: string; profiles?: readonly NavProfile[]; now?: string;
}) {
  const pathname = usePathname() ?? '/';
  const search = useSearchParams();
  const entity = search.get('entity') ?? 'search_terms';
  const screen = screens.find((candidate) => candidate.path === `${pathname}?entity=${entity}`)
    ?? screens.find((candidate) => candidate.path === pathname)
    ?? [...screens].sort((a, b) => b.path.length - a.path.length)
      .find((candidate) => candidate.path !== '/' && pathname.startsWith(`${candidate.path}/`));
  const preserved = Object.fromEntries(search.entries());
  const active = resolveActiveProfile(profiles, search.get('profile') ?? undefined);
  const profileToday = pathname === '/creative' && active?.timezone && now ? todayIsoInTimeZone(active.timezone, new Date(now)) : today;
  const { period, includeToday } = resolveShellPeriod(pathname, preserved, profileToday);
  const comparison = validShellDate(search.get('compareFrom') ?? undefined) && validShellDate(search.get('compareTo') ?? undefined) && search.get('compareFrom')! <= search.get('compareTo')!
    ? periodFromParams({ from: search.get('compareFrom')!, to: search.get('compareTo')! }, today)
    : precedingPeriod(period);
  return <>
    <span className="wa-shell-title" data-testid="shell-title">{screen?.title ?? 'Arcana'}</span>
    <ShellDateControls path={pathname} period={period} comparison={comparison} today={profileToday} preserved={preserved} includeToday={includeToday} />
    <EvidenceStatusChips />
  </>;
}

function EvidenceStatusChips() {
  const evidence = useShellEvidence();
  const loading = useShellEvidenceLoading();
  return <ShellStatusChips freshness={evidence?.freshness ?? null} crosscheck={evidence?.crosscheck ?? null} loading={loading} />;
}

function validShellDate(value: string | undefined): value is string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** Match the existing screen loaders' complete-day and current-day windows. */
export function resolveShellPeriod(path: string, params: Readonly<Record<string, string | undefined>>, today: string) {
  const from = validShellDate(params['from']) ? params['from'] : undefined;
  const to = validShellDate(params['to']) ? params['to'] : undefined;
  if (path === '/dayparting') {
    const start = from ?? addDays(today, -55);
    const end = to ?? today;
    return { period: start <= end ? { start, end } : { start: addDays(today, -55), end: today }, includeToday: true };
  }
  const input = { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
  const includeToday = path === '/creative';
  return { period: includeToday ? periodFromParamsThroughToday(input, today) : periodFromParams(input, today), includeToday };
}

export function formatShellDate(value: string): string {
  if (!validShellDate(value)) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`));
}
const windowWords = (period: Period): string => `${formatShellDate(period.start)} – ${formatShellDate(period.end)}`;

export function ShellDateControls({ path, period, comparison, today, preserved = {}, includeToday = false }: {
  path: string; period: Period; comparison: Period; today: string; includeToday?: boolean;
  preserved?: Readonly<Record<string, string | undefined>>;
}) {
  const lengths = comparisonLengthState(period, comparison);
  const router = useRouter();
  const comparisonRoot = useRef<HTMLDetailsElement>(null);
  return <div className="wa-shell-dates">
    <DateRangePicker path={path} period={period} today={today} preserved={preserved} includeToday={includeToday}
      {...(preserved['preset'] === undefined ? {} : { selectedPresetId: preserved['preset'] })}
      trigger={<span className="wa-shell-window"><strong>{windowWords(period)}</strong><small>{lengths.currentDays} days</small></span>} />
    <details className="wa-date-range wa-shell-comparison" ref={comparisonRoot}>
      <summary className="wa-date-range__trigger" aria-label={`Comparison: ${windowWords(comparison)}`}>
        <span className="wa-shell-window"><strong>vs {windowWords(comparison)}</strong>
          <small>{preserved['compareFrom'] === undefined ? 'previous period' : 'custom period'} · {lengths.comparisonDays} days</small></span>
        <span aria-hidden="true">▾</span>
      </summary>
      <div className="wa-date-range__popover">
        <Link href={dateRangeHref(path, period, { ...preserved, compareFrom: undefined, compareTo: undefined })}
          prefetch={false} onClick={() => comparisonRoot.current?.removeAttribute('open')}>Previous period</Link>
        <form className="wa-date-range__custom" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const query = new URLSearchParams();
          for (const [key, value] of Object.entries(preserved)) if (value !== undefined) query.set(key, value);
          query.set('compareFrom', String(data.get('compareFrom')));
          query.set('compareTo', String(data.get('compareTo')));
          comparisonRoot.current?.removeAttribute('open');
          router.push(`${path}?${query.toString()}`);
        }}>
          <label>Comparison from<input className="wa-input" type="date" name="compareFrom" defaultValue={comparison.start} required /></label>
          <label>Comparison to<input className="wa-input" type="date" name="compareTo" defaultValue={comparison.end} required /></label>
          <button className="wa-btn wa-btn--sm" type="submit">Apply comparison</button>
        </form>
      </div>
    </details>
    {lengths.mismatch ? <span role="status" className="wa-shell-mismatch">
      Date ranges differ: {lengths.currentDays} days compared with {lengths.comparisonDays} days.
    </span> : null}
  </div>;
}

export function ShellStatusChips({ freshness, crosscheck, loading = false }: {
  freshness: FreshnessAssessment | null; crosscheck: VerdictChip | null; loading?: boolean;
}) {
  const profile = useSearchParams().get('profile');
  const suffix = profile === null ? '' : `?profile=${encodeURIComponent(profile)}`;
  const freshTone = freshness?.coversThrough == null ? 'muted' : freshness.tone;
  const crosscheckBehind = crosscheck?.tone === 'good' && crosscheck.asOf != null && freshness?.coversThrough != null && crosscheck.asOf < freshness.coversThrough;
  const crossTone = crosscheckBehind ? 'warn' : crosscheck?.tone ?? 'muted';
  const freshLabel = loading ? 'Loading freshness…' : freshness?.coversThrough == null ? 'Freshness unavailable'
    : `${freshTone === 'good' ? 'Facts to' : freshTone === 'warn' ? 'Data delayed ·' : 'Data issue ·'} ${formatShellDate(freshness.coversThrough)}`;
  const crossLabel = loading ? 'Loading crosscheck…' : crosscheck == null || crosscheck.verdict === 'no_data' ? 'Crosscheck unavailable'
    : crosscheckBehind ? 'Crosscheck stale' : crosscheck.tone === 'good' ? 'Crosscheck OK' : `Crosscheck ${crosscheck.label.toLowerCase()}`;
  return <div className="wa-shell-chips" aria-busy={loading}>
    <Link href={`/sync-status${suffix}`} prefetch={false} className="wa-shell-chip" data-tone={freshTone}
      aria-label={`Data freshness: ${freshLabel}`} title={freshness?.headline ?? 'Coverage evidence unavailable'}>
      <StatusDot />{freshLabel}
    </Link>
    <Link href={`/crosscheck${suffix}`} prefetch={false} className="wa-shell-chip" data-tone={crossTone}
      aria-label={crossLabel} title={crosscheck?.asOf == null ? 'No comparison evidence' : `Compared through ${formatShellDate(crosscheck.asOf)}`}>
      <StatusDot />{crossLabel}
    </Link>
  </div>;
}

function StatusDot() {
  return <svg aria-hidden="true" viewBox="0 0 7 7" width="7" height="7"><circle cx="3.5" cy="3.5" r="3.5" fill="currentColor" /></svg>;
}

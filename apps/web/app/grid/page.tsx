/**
 * `/grid` — the entity grid.
 *
 * The browser loads the **whole** result set for the selected entity level and
 * period from the authenticated `/api/grid/rows` boundary. Keeping every row
 * client-side is the product decision the recon argues for at length
 * (`https://github.com/Ecom-Wizards-Agency/openspell/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §6): QA-ing an optimization means sorting four thousand
 * rows by spend, filtering to one change reason and scanning. The separate
 * request keeps those rows out of the initial RSC document without introducing
 * server pagination or a second Grid model.
 *
 * Database and raw-response byte caps bound the result. Past either boundary
 * the page says the set is truncated rather than quietly showing a prefix,
 * because a total computed over an unmarked prefix is the kind of wrong number
 * that gets quoted on a client call.
 *
 * Entry goes through `gate()`, the same guard `/settings` uses: anonymous
 * visitors are sent to `/login`, and both the roster and the rows are scoped by
 * the org the gate resolved rather than by a profile id anybody could paste.
 */
import { Suspense, type CSSProperties } from 'react';
import { redirect } from 'next/navigation';
import {
  ENTITY_LABELS,
  ENTITY_LEVELS,
  assessFreshness,
  tokens,
} from '@wizard-ads/ui';
import type { EntityLevel } from '@wizard-ads/ui';
import { withAuthenticatedActor, type DbHandle } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import { gate } from '../../src/auth/guard';
import { canonicalProfilePath } from '../../src/data/active-profile';
import { gateMessage } from '../../src/ui/gate-message';
import { loadProfileDailyRows, loadReportLedger } from '../_lib/dashboard-data';
import { withExistingDatabase } from '../_lib/db';
import {
  periodFromParams,
  precedingPeriod,
  settledComparisonWindows,
  todayIso,
} from '../_lib/periods';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';
import { OperatorContext } from '../../src/ui/operator-context';
import { Cockpit } from '../../src/ui/cockpit';
import { kpiTiles, totalsOf } from '../../src/optimizer/view';
import { GridWorkspace } from './grid-client';
import { CrosscheckChip } from '../crosscheck/panel';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    profile?: string;
    entity?: string;
    campaign?: string;
    from?: string;
    to?: string;
  }>;
}

function parseEntity(value: string | undefined): EntityLevel {
  return ENTITY_LEVELS.includes(value as EntityLevel) ? (value as EntityLevel) : 'search_terms';
}

export default async function GridPage({ searchParams }: PageProps) {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={main}>
        <h1 style={heading}>Grid</h1>
        <p style={muted}>{gateMessage(entry.state)}</p>
      </main>
    );
  }
  const orgId = entry.context.active?.orgId ?? '';
  const actor = { orgId, userId: entry.context.user.id };

  const params = await searchParams;
  const profileId = await requestedProfileId(params.profile);
  const entity = parseEntity(params.entity);
  const today = todayIso();
  const period = periodFromParams(params, today);
  const comparison = precedingPeriod(period);
  const settled = settledComparisonWindows(period, today);

  const data = await withExistingDatabase(entry.handle, actor, async (handle) => {
    const profiles = await listProfiles(handle, orgId);
    const profile = selectProfile(profiles, profileId);
    if (profile === null) return { profiles, profile: null };
    const canonical = canonicalProfilePath('/grid', { ...params }, profile.id);
    if (canonical !== null) redirect(canonical);

    const ledger = await loadReportLedger(handle, orgId, profile.id);

    return { profiles, profile, ledger };
  });

  if (data === null) {
    return (
      <main style={main}>
        <h1 style={heading}>Grid</h1>
        <p style={muted}>{gateMessage('no-database')}</p>
      </main>
    );
  }

  if (data.profile === null) {
    return (
      <main style={main}>
        <h1 style={heading}>Grid</h1>
        <p className="wa-page-sub">
          {data.profiles.length === 0
            ? 'No advertising profiles yet. Connect an account and enable sync on a profile to see one here.'
            : 'Choose an advertising profile from the switcher in the top bar to load the grid.'}
        </p>
      </main>
    );
  }

  const { profile, ledger = [] } = data;
  const freshness = assessFreshness(ledger, { now: new Date() });

  return (
    <main style={main}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(3) }}>
        <div>
          <h1 className="wa-page-title">{ENTITY_LABELS[entity]}</h1>
          <p className="wa-page-sub">
            {profile.label} · {period.start} to {period.end} · compared against {comparison.start} to{' '}
            {comparison.end} · all figures in {profile.currencyCode}
          </p>
        </div>

      </header>

      <OperatorContext
        account={profile.label}
        marketplace={profile.countryCode}
        currencyCode={profile.currencyCode}
        timezone={profile.timezone}
        path="/grid"
        period={period}
        today={todayIso()}
        preserved={{
          profile: profile.id,
          entity,
          ...(params.campaign === undefined ? {} : { campaign: params.campaign }),
        }}
      />

      <Suspense fallback={<CockpitPending />}>
        <GridCockpit
          handle={entry.handle} actor={actor}
          orgId={orgId}
          profile={profile}
          period={period}
          settled={settled}
        />
      </Suspense>

      <GridWorkspace
        key={`${profile.id}:${entity}:${period.start}:${period.end}:${params.campaign ?? ''}`}
        actor={actor}
        entity={entity}
        currencyCode={profile.currencyCode}
        profileId={profile.id}
        period={period}
        comparisonPeriod={comparison}
        freshness={freshness}
        crosscheck={
          <Suspense fallback={<span style={crosscheckPending}>Crosscheck loading…</span>}>
            <GridCrosscheck handle={entry.handle} actor={actor} profileId={profile.id} />
          </Suspense>
        }
        campaignId={entity === 'campaigns' ? params.campaign ?? null : null}
      />

      <p style={muted}>
        {/* The accent token rather than a hex literal: an inline colour does not
            follow the theme, and the literal this replaced rendered at 2.98:1
            against the dark background. */}
        <a href={`/dashboard?profile=${profile.id}`} style={{ color: 'var(--wa-accent)' }}>
          ← Back to the dashboard
        </a>
      </p>
    </main>
  );
}

/**
 * The tile row and the trend chart WP-24 ordered for this page and never got.
 *
 * It is the same `Cockpit` and the same daily loader the dashboard and the
 * optimizer mount — one component, one query, three pages — and it is
 * deliberately inside a `Suspense` boundary rather than awaited in the page
 * body. The rows the operator came for arrive over `/api/grid/rows`, which the
 * browser cannot request until the document has streamed; a profile-daily
 * query awaited above the workspace would put itself in front of that request
 * for no reason. Suspended, the document flushes with the workspace in it and
 * the tiles land when the query does.
 */
async function GridCockpit({
  handle,
  actor,
  orgId,
  profile,
  period,
  settled,
}: {
  handle: DbHandle;
  actor: OrgActor;
  orgId: string;
  profile: { id: string; label: string; currencyCode: string };
  period: { start: string; end: string };
  settled: ReturnType<typeof settledComparisonWindows>;
}) {
  const window = {
    start:
      settled.comparison !== null && settled.comparison.start < period.start
        ? settled.comparison.start
        : period.start,
    end: period.end,
  };
  const rows = await withExistingDatabase(handle, actor, (open) =>
    loadProfileDailyRows(open, orgId, profile.id, profile.label, window),
  ).catch(() => null);
  if (rows === null || rows.length === 0) return null;

  // The dashboard's clamp, for the dashboard's reason: a profile whose facts
  // begin after the settled window opens must not be described as sixteen
  // settled days when four of them exist.
  const coverageStart = rows[0]?.date ?? null;
  const currentWindow =
    settled.current !== null && coverageStart !== null && coverageStart > settled.current.start
      ? { start: coverageStart, end: settled.current.end }
      : settled.current;
  const settledRows =
    currentWindow === null
      ? []
      : rows.filter((row) => row.date >= currentWindow.start && row.date <= currentWindow.end);
  const comparisonRows =
    settled.comparison === null
      ? []
      : rows.filter(
          (row) =>
            row.date >= (settled.comparison as { start: string }).start &&
            row.date <= (settled.comparison as { end: string }).end,
        );
  const inPeriod = rows.filter((row) => row.date >= period.start && row.date <= period.end);

  return (
    <Cockpit
      days={inPeriod.map((row) => ({
        date: row.date,
        impressions: row.impressions,
        clicks: row.clicks,
        spend: row.spend,
        sales: row.sales,
        orders: row.orders,
      }))}
      tiles={kpiTiles(
        settledRows.length === 0 ? null : totalsOf(settledRows),
        comparisonRows.length === 0 ? null : totalsOf(comparisonRows),
      )}
      currencyCode={profile.currencyCode}
      settlingStart={settled.settling.start}
      coverageStart={coverageStart}
      preferenceKey={profile.id}
    />
  );
}

function CockpitPending() {
  return (
    <p aria-busy="true" data-testid="grid-cockpit-pending" style={crosscheckPending}>
      Loading the performance tiles and trend…
    </p>
  );
}

/**
 * Crosscheck evidence is useful context, not a prerequisite for operating the
 * grid. Keep its independent database read outside the critical row-delivery
 * path so a slow or unavailable comparison source cannot delay filtering,
 * grouping, or export.
 */
async function GridCrosscheck({
  handle,
  actor,
  profileId,
}: {
  handle: DbHandle;
  actor: OrgActor;
  profileId: string;
}) {
  const model = await withAuthenticatedActor(handle, actor,
    (sql) => loadCrosscheckPanel({ sql }, { orgId: actor.orgId, profileId })).catch(() => null);
  return model === null ? null : <CrosscheckChip chip={model.chip} />;
}

/**
 * Full width, not a centred column. The operator compared this page against
 * AdLabs and the narrow reading column was the first thing named: a grid with
 * twenty visible columns wants every pixel the frame gives it.
 */
const main: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  gap: tokens.space(4),
  minWidth: 0,
  padding: '1.5rem 0 2rem',
  width: '100%',
};

const heading: CSSProperties = { fontSize: tokens.font.size.xl, margin: '0 0 0.25rem' };
const muted: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.base, margin: 0 };
const crosscheckPending: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.sm,
};

import { ShellFreshnessBanner } from '../../ui/shell-evidence';

import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/grid` — the entity grid.
 *
 * The browser loads the **whole** result set for the selected entity level and
 * period from the authenticated `/api/grid/rows` boundary. Keeping every row
 * client-side is the product decision the recon argues for at length
 * (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §6): QA-ing an optimization means sorting four thousand
 * rows by spend, filtering to one change reason and scanning. The separate
 * request keeps those rows out of the initial RSC document without introducing
 * server pagination or a second Grid model.
 *
 * Database and raw-response byte caps bound the result. Past either boundary
 * the page says the set is truncated rather than quietly showing a prefix,
 * because a total computed over an unmarked prefix is the kind of wrong number
 * that gets quoted on a client call.
 *
 * Entry goes through `pageRead`, the same boundary `/settings` uses: anonymous
 * visitors are sent to `/login`, and both the roster and the rows are scoped by
 * the org the gate resolved rather than by a profile id anybody could paste.
 */

import {
  ENTITY_LEVELS
} from '@wizard-ads/ui';

import type { EntityLevel } from '@wizard-ads/ui';

import { withAuthenticatedActor, type DbHandle } from '@wizard-ads/db';

import type { OrgActor } from '@wizard-ads/shared';

import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';

import { loadProfileDailyRows } from '../../../app/_lib/dashboard-data';

import { withExistingDatabase } from '../../../app/_lib/db';

import {
  periodFromParams,
  precedingPeriod,
  settledComparisonWindows,
  todayIso,
} from '../../../app/_lib/periods';

import { listProfiles } from '../../../app/_lib/profiles';

import { Cockpit } from '../../ui/cockpit';

import { kpiTiles, totalsOf } from '../../optimizer/view';

import { CrosscheckChip } from '../../../app/crosscheck/panel';

interface PageProps {
  searchParams: Promise<{
    profile?: string;
    view?: string;
    entity?: string;
    campaign?: string;
    asin?: string;
    from?: string;
    to?: string;
    compareFrom?: string;
    compareTo?: string;
  }>;
}

function parseEntity(value: string | undefined): EntityLevel {
  return ENTITY_LEVELS.includes(value as EntityLevel) ? (value as EntityLevel) : 'search_terms';
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as PageProps['searchParams'];

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }
  const orgId = entry.context.active?.orgId ?? '';
  const actor = { orgId, userId: entry.context.user.id };

  const params = await searchParams;
  const profileId = await Promise.resolve(access.requestedProfile);
  const entity = parseEntity(params.entity);
  const today = todayIso();
  const period = periodFromParams(params, today);
  const comparison = params.compareFrom && params.compareTo
    ? periodFromParams({ from: params.compareFrom, to: params.compareTo }, today)
    : precedingPeriod(period);
  const settled = settledComparisonWindows(period, today);

  const data = await access.readNullable(async (handle) => {
    const profiles = await listProfiles(handle, orgId);
    const profile = access.selectProfile(profiles, profileId);
    if (profile === null) return { profiles, profile: null };

    return { profiles, profile };
  });

  if (data === null) {
    return { view: 'no-database' as const, props: {} };
  }

  if (data.profile === null) {
    return { view: 'empty' as const, props: { data } };
  }

  const { profile } = data;

  return {
    view: 'ready' as const, props: {
      entity, profile, period, comparison, params, slot1: (<GridCockpit
        handle={entry.handle} actor={actor}
        orgId={orgId}
        profile={profile}
        period={period}
        settled={settled}
      />), actor, freshness: (<GridFreshness handle={entry.handle} actor={actor} profileId={profile.id} />)
    }
  };
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
  profile: { id: string; label: string; currencyCode: string; };
  period: { start: string; end: string; };
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
          row.date >= (settled.comparison as { start: string; }).start &&
          row.date <= (settled.comparison as { end: string; }).end,
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

/** Start secondary evidence together after the workspace can stream and hydrate. */
async function GridFreshness({ handle, actor, profileId }: {
  handle: DbHandle;
  actor: OrgActor;
  profileId: string;
}) {
  const crosscheck = await GridCrosscheck({ handle, actor, profileId });
  return <ShellFreshnessBanner>{crosscheck}</ShellFreshnessBanner>;
}

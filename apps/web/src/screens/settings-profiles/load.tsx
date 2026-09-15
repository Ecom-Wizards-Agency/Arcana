import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/settings/profiles` — the roster, filtered, with the editable things.
 *
 * Filters are a GET form, so a filtered roster is a URL somebody can send to a
 * colleague. Edits are one small form per row rather than one giant form,
 * because a single form over two hundred profiles submits two hundred rows to
 * change one bid target and makes every save a full-table write.
 *
 * Roles show up twice, and the second time is the one that matters: controls a
 * role cannot use are not rendered, and the server actions behind them check the
 * same capability table anyway.
 *
 * Layout follows the recon's admin screens (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/09-settings-and-admin.md`): a
 * result count you can trust above a filter bar, then one table with a sticky
 * header, then an empty state that names the next action rather than shrugging.
 */

import { can } from '../../auth/roles';

import { isRosterSort, loadRoster } from '../../data/profiles';

import type { RosterSort } from '../../data/profiles';

interface Props {
  searchParams: Promise<{
    org?: string;
    region?: string;
    country?: string;
    q?: string;
    sync?: string;
    sort?: string;
    page?: string;
  }>;
}

/**
 * Rows per page.
 *
 * The roster renders one editable row per profile, and a real one runs to a few
 * hundred: unpaged, the page measured 17,614px — about twenty screens — and the
 * filters above it were the only way to reach anything. Fifty keeps the whole
 * page within a few screens while staying above the size of any test fixture,
 * so the counts the end-to-end suite asserts are unaffected.
 */
const ROSTER_PAGE_SIZE = 50;

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as Props['searchParams'];

  const query = await searchParams;
  const result = access.entry;

  if (result.state !== 'ok') {
    return { view: 'gated' as const, props: { result } };
  }

  const { context } = result;
  const org = context.active;
  if (!org) return null;

  const sort: RosterSort = isRosterSort(query.sort) ? query.sort : 'name';
  const roster = await access.readSql((sql) => loadRoster({ sql }, org.orgId, {
    region: query.region ?? null,
    country: query.country ?? null,
    search: query.q ?? null,
    syncEnabled: query.sync === 'on' ? true : query.sync === 'off' ? false : null,
    sort,
  }));

  const mayEditTargets = can(org.role, 'editTargets');
  const mayToggleSync = can(org.role, 'toggleSync');
  const filtered = roster.rows.length !== roster.total;

  const pageCount = Math.max(1, Math.ceil(roster.rows.length / ROSTER_PAGE_SIZE));
  // `Math.trunc` before the clamp: `?page=2.5` otherwise survives it and renders
  // "Page 2.5 of 4" with a Previous link to page 1.5.
  const currentPage = Math.min(Math.max(1, Math.trunc(Number(query.page ?? '1')) || 1), pageCount);
  const firstIndex = (currentPage - 1) * ROSTER_PAGE_SIZE;
  const visibleRows = roster.rows.slice(firstIndex, firstIndex + ROSTER_PAGE_SIZE);

  /** The current filters, minus the page, so a page link keeps the roster it was built from. */
  const pageHref = (target: number): string => {
    const params = new URLSearchParams({ org: org.orgId });
    for (const [key, value] of Object.entries({
      region: query.region,
      country: query.country,
      q: query.q,
      sync: query.sync,
      sort: query.sort,
    })) {
      if (value) params.set(key, value);
    }
    if (target > 1) params.set('page', String(target));
    const search = params.toString();
    return search === '' ? '/settings/profiles' : `/settings/profiles?${search}`;
  };

  // Select-all covers what the operator can see, not the rows a filter left on
  // another page.
  const rowIds = visibleRows.map((profile) => profile.id);

  /**
   * On a single page the count is unchanged: "Showing 6 of 6". Once it pages,
   * the window is what needs naming, and the unfiltered total only earns its
   * place when a filter has actually removed something.
   */
  const countLabel =
    pageCount === 1
      ? `Showing ${roster.rows.length} of ${roster.total}`
      : `Showing ${firstIndex + 1}–${firstIndex + visibleRows.length} of ${roster.rows.length}` +
      (filtered ? ` matching · ${roster.total} total` : '');

  return { view: 'ready' as const, props: { context, countLabel, roster, filtered, org, query, sort, mayEditTargets, mayToggleSync, rowIds, visibleRows, pageCount, currentPage, pageHref } };
}

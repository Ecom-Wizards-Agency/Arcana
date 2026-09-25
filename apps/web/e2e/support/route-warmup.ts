/**
 * Compile a spec's routes in its `beforeAll`, before the first test's clock starts.
 *
 * `next dev` compiles a route on its first request. On the shared four-core CI
 * runner that compile landed inside 15-second expectations: `/grid` spent 7.5
 * to 28.9 s compiling before its document streamed, then `/api/grid/rows` (2.3
 * to 9.2 s) and `/grid/views` (2.1 to 4.8 s) compiled while the layout test
 * waited for `grid-data-ready`; `/api/brand-lens/overrides` compiled for 3.8 to
 * 13.2 s and `/api/brand-lens` for 3.2 to 4.5 s while the Brand lens test
 * waited for its saved override.
 *
 * Compiling in global setup does not survive until these tests run. The dev
 * server disposes an entry that has been idle for 60 s outside its five most
 * recent pages, and its memory cache drops the modules, so a setup warm-up of
 * `/grid` was compiled again 5 minutes later inside the layout test (7.6 s)
 * and a setup warm-up of the override route compiled again inside the Brand
 * lens test (1.9 to 2.5 s, no faster than cold). Warming in the spec's own
 * `beforeAll` leaves the routes built when the test starts, and the hook has
 * its own timeout instead of spending the test's.
 *
 * Every request is a read the page itself makes, or a GET that a POST-only
 * handler answers with 405 after loading its module. None writes. An
 * unexpected status fails the hook, because a route that cannot answer here
 * cannot pass its test either.
 */
import { periodFromParams, precedingPeriod, todayIso } from '../../app/_lib/periods';
import { E2E_USER_COOKIE, E2E_USER_EMAIL_COOKIE } from '../../src/cookies';
import { BASE_URL, EMAILS, USERS } from './fixture';

export interface WarmRoute {
  readonly path: string;
  /** The status the route answers once its module has compiled and run. */
  readonly status: 200 | 405;
}

/** A safety net per request; the calling hook's timeout is the real budget. */
const ROUTE_WARMUP_TIMEOUT_MS = 80_000;

/** `/grid` for targets in its default window, with the two reads its workspace makes. */
export function gridWarmRoutes(profileId: string, today = todayIso()): readonly WarmRoute[] {
  const period = periodFromParams({}, today);
  const comparison = precedingPeriod(period);
  return [
    { path: `/grid?${new URLSearchParams({ entity: 'targets', profile: profileId })}`, status: 200 },
    { path: `/api/grid/rows?${new URLSearchParams({ profile: profileId, entity: 'targets', from: period.start, to: period.end, compareFrom: comparison.start, compareTo: comparison.end })}`, status: 200 },
    { path: `/grid/views?${new URLSearchParams({ entity: 'targets', profile: profileId })}`, status: 200 },
  ];
}

/** `/brand-lens` in the research window, its re-read and its override write handler. */
export function brandLensWarmRoutes(profileId: string, window: { from: string; to: string }): readonly WarmRoute[] {
  return [
    { path: `/brand-lens?${new URLSearchParams({ profile: profileId, ...window })}`, status: 200 },
    { path: `/api/brand-lens?${new URLSearchParams({ profileId, ...window })}`, status: 200 },
    { path: '/api/brand-lens/overrides', status: 405 },
  ];
}

/**
 * Request each route in order as the signed-in admin and read the whole body,
 * so streamed server components finish rendering too.
 */
export async function warmRoutes(routes: readonly WarmRoute[]): Promise<void> {
  const cookie = [`${E2E_USER_COOKIE}=${USERS.admin}`, `${E2E_USER_EMAIL_COOKIE}=${EMAILS.admin}`].join('; ');
  for (const route of routes) {
    const started = performance.now();
    const response = await fetch(`${BASE_URL}${route.path}`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(ROUTE_WARMUP_TIMEOUT_MS),
    });
    await response.arrayBuffer();
    if (response.status !== route.status) {
      throw new Error(`Route warm-up expected ${route.status} from ${route.path}, received ${response.status}`);
    }
    console.log(`[e2e warm-up] ${route.path.split('?')[0]} ${response.status} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
}

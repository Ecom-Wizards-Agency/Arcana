/** Complete Grid rows behind an authenticated, tenant-scoped HTTP boundary. */
import { ENTITY_LEVELS } from '@wizard-ads/ui';
import type { EntityLevel } from '@wizard-ads/ui';
import { loadGridRows } from '../../../_lib/grid-data';
import { precedingPeriod } from '../../../_lib/periods';
import { withAuthenticatedIdentity } from '@wizard-ads/db';
import { enforceGridAssurance, gridRequestSubject, resolveGridReadReceipt } from '../../../../src/grid/request-context';
import { openWebDatabase, RequestAuthError } from '../../../../src/server/request-context';
import { finalizeTimedGridResponse, GridServerTiming } from './server-timing';
import { serializeGridPayloadWithinBudget } from './serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRIVATE_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
} as const;

class GridRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridRequestError';
  }
}

interface GridRowsQuery {
  profileId: string;
  entity: EntityLevel;
  period: { start: string; end: string };
}

interface ParsedGridRowsQuery {
  ok: true;
  query: GridRowsQuery;
  candidateProfileId: string;
}

interface RejectedGridRowsQuery {
  ok: false;
  error: GridRequestError;
  candidateProfileId: string | null;
}

type GridRowsQueryAttempt = ParsedGridRowsQuery | RejectedGridRowsQuery;

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseGridRowsQuery(requestUrl: string): GridRowsQuery {
  const query = new URL(requestUrl).searchParams;
  const profileId = query.get('profile') ?? '';
  const entity = query.get('entity') ?? '';
  const from = query.get('from') ?? '';
  const to = query.get('to') ?? '';

  if (!UUID.test(profileId)) throw new GridRequestError('profile must be a UUID');
  if (!ENTITY_LEVELS.includes(entity as EntityLevel)) {
    throw new GridRequestError(`entity must be one of: ${ENTITY_LEVELS.join(', ')}`);
  }
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    throw new GridRequestError('from and to must be an ordered ISO date window');
  }

  return {
    profileId,
    entity: entity as EntityLevel,
    period: { start: from, end: to },
  };
}

/** Parse without changing the authentication-before-input-refusal contract. */
function attemptGridRowsQuery(requestUrl: string): GridRowsQueryAttempt {
  let candidateProfileId: string | null = null;
  try {
    const rawProfileId = new URL(requestUrl).searchParams.get('profile') ?? '';
    candidateProfileId = UUID.test(rawProfileId) ? rawProfileId : null;
    return {
      ok: true,
      query: parseGridRowsQuery(requestUrl),
      candidateProfileId: rawProfileId,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof GridRequestError
          ? error
          : new GridRequestError('Could not parse Grid request'),
      candidateProfileId,
    };
  }
}

function json(value: unknown, init: { status?: number } = {}): Response {
  return Response.json(value, {
    status: init.status,
    headers: PRIVATE_RESPONSE_HEADERS,
  });
}

function gridPayloadResponse(
  payload: Awaited<ReturnType<typeof loadGridRows>>,
  timing: GridServerTiming,
): Response {
  const serialized = serializeGridPayloadWithinBudget(payload);
  timing.mark('serialize');
  return new Response(serialized.body, {
    headers: {
      ...PRIVATE_RESPONSE_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function gridErrorResponse(error: unknown): Response {
  if (error instanceof RequestAuthError) {
    return json(
      {
        error: error.message,
        ...(error.code === null ? {} : { code: error.code }),
        ...(error.location === null ? {} : { location: error.location }),
      },
      { status: error.status },
    );
  }
  if (error instanceof GridRequestError) {
    return json({ error: error.message }, { status: 400 });
  }
  return json({ error: 'Could not load Grid rows' }, { status: 500 });
}

interface GridRowsRouteRuntime {
  identify: typeof gridRequestSubject;
  openDatabase: typeof openWebDatabase;
  resolveReceipt: typeof resolveGridReadReceipt;
  enforceAssurance: typeof enforceGridAssurance;
  loadRows: typeof loadGridRows;
}

const DEFAULT_RUNTIME: GridRowsRouteRuntime = {
  identify: gridRequestSubject,
  openDatabase: openWebDatabase,
  resolveReceipt: resolveGridReadReceipt,
  enforceAssurance: enforceGridAssurance,
  loadRows: loadGridRows,
};

/** One complete HTTP read owns identity, authenticated SQL, settlement and teardown. */
export function createGridRowsGet(
  runtime: GridRowsRouteRuntime = DEFAULT_RUNTIME,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const timing = new GridServerTiming();
    const queryAttempt = attemptGridRowsQuery(request.url);
    try {
      const subject = await runtime.identify(request.headers);
      timing.mark('actor');
      const database = runtime.openDatabase();
      let response: Response;
      try {
        response = await withAuthenticatedIdentity(database, { userId: subject.userId }, async (sql) => {
          const handle = { sql };
          const receipt = await runtime.resolveReceipt(handle, subject, queryAttempt.candidateProfileId);
          await runtime.enforceAssurance(subject, receipt);
          timing.mark('role');

          // Membership and assurance resolve before a retained input refusal.
          if (!queryAttempt.ok) throw queryAttempt.error;
          timing.mark('profile');
          if (receipt.profileId === null || receipt.currencyCode === null) {
            return json({ error: 'Not found' }, { status: 404 });
          }
          const { entity, period } = queryAttempt.query;
          const payload = await runtime.loadRows(handle, entity, {
            orgId: receipt.orgId,
            profileId: receipt.profileId,
            currencyCode: receipt.currencyCode,
            period,
            comparison: precedingPeriod(period),
          });
          timing.mark('rows');
          return gridPayloadResponse(payload, timing);
        });
      } finally {
        // No response leaves this operation until COMMIT/ROLLBACK and close
        // settle. A teardown failure is caught below and cannot release a 200.
        await database.close();
      }
      if (response.status === 200) finalizeTimedGridResponse(response, timing);
      return response;
    } catch (error) {
      return gridErrorResponse(error);
    }
  };
}

export const GET = createGridRowsGet();

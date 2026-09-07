import { exportDaypartingSchedule } from '@wizard-ads/worker';
import { withAuthenticatedActor, type RequestDatabase } from '@wizard-ads/db';
import { readDaypartingProposal } from '../../../../src/dayparting/data';
import {
  openWebDatabase,
  requestActor,
} from '../../../../src/server/request-context';
import { DownloadRequestError, downloadErrorResponse, downloadResponse } from '../../../../src/server/download-response';

export const runtime = 'nodejs';
export const DAYPARTING_EXPORT_EFFECT = 'export-only' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDaypartingExportFormat(value: string | null): 'csv' | 'json' {
  if (value === null || value === 'csv') return 'csv';
  if (value === 'json') return 'json';
  throw new DownloadRequestError('format must be csv or json');
}

export async function GET(request: Request): Promise<Response> {
  let database: RequestDatabase | null = null;
  try {
    const actor = await requestActor(request.headers);
    database = openWebDatabase();
    const url = new URL(request.url);
    const proposalId = url.searchParams.get('id') ?? '';
    const profileId = url.searchParams.get('profileId') ?? '';
    if (!UUID.test(proposalId)) throw new DownloadRequestError('valid proposal id is required');
    if (!UUID.test(profileId)) throw new DownloadRequestError('valid profile id is required');
    const format = parseDaypartingExportFormat(url.searchParams.get('format'));
    const proposal = await withAuthenticatedActor(database, actor, (sql) => readDaypartingProposal({ sql }, {
      orgId: actor.orgId,
      profileId,
      proposalId,
    }));
    if (!proposal) throw new DownloadRequestError('Not found', 404);
    const artifact = exportDaypartingSchedule(proposal);
    const body = format === 'csv' ? artifact.csv : artifact.json;
    return downloadResponse(new Response(body, {
      status: 200,
      headers: {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="dayparting-schedule-${proposalId}.${format}"`,
        'x-wizard-ads-effect': DAYPARTING_EXPORT_EFFECT,
      },
    }));
  } catch (error) {
    return downloadErrorResponse(error);
  } finally {
    await database?.close();
  }
}

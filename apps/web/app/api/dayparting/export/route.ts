import { listDaypartingSchedules } from '@wizard-ads/db';
import { exportDaypartingSchedule } from '@wizard-ads/worker';
import { readDaypartingProposal } from '../../../../src/dayparting/data';
import { authenticatedRead } from '../../../../src/server/authenticated-read';
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
  return authenticatedRead(request, async (database, actor) => {
    const url = new URL(request.url);
    const scheduleId = url.searchParams.get('scheduleId');
    const proposalId = scheduleId ?? url.searchParams.get('id') ?? '';
    const profileId = url.searchParams.get('profileId') ?? '';
    if (!UUID.test(proposalId)) throw new DownloadRequestError('valid proposal id is required');
    if (!UUID.test(profileId)) throw new DownloadRequestError('valid profile id is required');
    const format = parseDaypartingExportFormat(url.searchParams.get('format'));
    if(scheduleId){
      const schedule=(await listDaypartingSchedules(database,profileId)).find(item=>item.id===scheduleId);
      if(!schedule)throw new DownloadRequestError('Not found',404);
      const rows=schedule.modifiers.flatMap((day,dayOfWeek)=>day.map((modifier,hour)=>({dayOfWeek,hour,modifier})));
      if(rows.length!==168)throw new Error('Schedule export count mismatch');
      const body=format==='json'
        ? JSON.stringify({schedule,hours:rows,count:rows.length})
        : ['day_of_week,hour,adjustment_percent',...rows.map(r=>`${r.dayOfWeek},${r.hour},${r.modifier}`)].join('\n');
      return downloadResponse(new Response(body,{headers:{'content-type':format==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8','content-disposition':`attachment; filename="dayparting-schedule-${scheduleId}.${format}"`,'x-wizard-ads-effect':DAYPARTING_EXPORT_EFFECT}}));
    }
    const proposal = await readDaypartingProposal(database, {
      orgId: actor.orgId,
      profileId,
      proposalId,
    });
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
  }, downloadErrorResponse);
}

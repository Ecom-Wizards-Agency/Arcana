import { authenticatedRead, readUuid, ApiReadError } from '../../../../../src/server/authenticated-read';
import { loadScheduleEvidence } from '../../../../../src/dayparting/review-evidence';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return authenticatedRead(request, async context => {
    const q = new URL(request.url).searchParams, profileId = readUuid(q.get('profileId'), 'profileId'), id = readUuid(q.get('id'), 'id'), start = q.get('from') ?? '', end = q.get('to') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new ApiReadError('Evidence dates required');
    return Response.json({      
evidence: await loadScheduleEvidence(context, {
        profileId,
        id,
        start,
        end
      })    
});
  });
}

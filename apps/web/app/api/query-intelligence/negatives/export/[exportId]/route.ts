import { getContextualNegativeExport, withAuthenticatedActor, type RequestDatabase } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import {
  openWebDatabase,
  requestActor,
} from '../../../../../../src/server/request-context';
import { DownloadRequestError, downloadErrorResponse, downloadResponse } from '../../../../../../src/server/download-response';
import { contextualNegativeReviewErrorResponse } from '../../../../../../src/query-intelligence/review-errors';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ exportId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  let database: RequestDatabase | null = null;
  try {
    const actor = await requestActor(request.headers);
    database = openWebDatabase();
    const { exportId } = await context.params;
    if (!Uuid.safeParse(exportId).success) throw new DownloadRequestError('A valid export id is required');
    const format = new URL(request.url).searchParams.get('format');
    if (format !== 'csv' && format !== 'json') throw new DownloadRequestError('format must be csv or json');
    const artifact = await withAuthenticatedActor(database, actor, (sql) => getContextualNegativeExport({ sql }, {
      orgId: actor.orgId,
      exportId,
      format,
    }));
    if (artifact === null) throw new DownloadRequestError('Not found', 404);

    const date = artifact.createdAt.toISOString().slice(0, 10);
    const filename = `openspell-contextual-negatives-${date}-${artifact.exportId.slice(0, 8)}.${format}`;
    const body = Uint8Array.from(artifact.bytes).buffer;
    return downloadResponse(new Response(body, {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(artifact.bytes.byteLength),
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        etag: `"${artifact.sha256}"`,
        'x-content-type-options': 'nosniff',
        'x-openspell-amazon-updated': 'false',
        'x-openspell-exported-rows': String(artifact.rowCount),
      },
    }));
  } catch (error) {
    return downloadResponse(contextualNegativeReviewErrorResponse(error) ?? downloadErrorResponse(error));
  } finally {
    await database?.close();
  }
}

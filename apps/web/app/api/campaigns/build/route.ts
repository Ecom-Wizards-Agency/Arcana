/**
 * Campaign Builder preflight and XLSX export.
 *
 * This route never calls Amazon and never records an apply. UPDATE mode reads
 * the synced mirror, builds sparse rows, and hands the operator a workbook for
 * manual Bulk Operations upload — the v1 approval boundary.
 */
import { loadCampaignUpdateEntities, withAuthenticatedActor, type RequestDatabase } from '@wizard-ads/db';
import type { EntityRow } from '@wizard-ads/shared';
import {
  openWebDatabase,
  requestActor,
} from '../../../../src/server/request-context';
import { DownloadRequestError, downloadErrorResponse, downloadResponse } from '../../../../src/server/download-response';
import { listOrgProfiles } from '../../../../src/recommendations/data';
import {
  buildCampaignBuilderArtifact,
  type CampaignBuilderMode,
} from '../../../../src/campaigns/artifact';

export const runtime = 'nodejs';
export const CAMPAIGN_BUILD_EFFECT = 'export-only' as const;

export interface CampaignBuildRequest {
  mode: CampaignBuilderMode;
  output: 'preview' | 'xlsx';
  profileId: unknown;
  config: unknown;
}

/** Keep the HTTP surface closed to apply/write-shaped actions. */
export function parseCampaignBuildRequest(value: unknown): CampaignBuildRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DownloadRequestError('request body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (body['mode'] !== 'create' && body['mode'] !== 'update') {
    throw new DownloadRequestError('mode must be create or update');
  }
  const output = body['output'] ?? 'preview';
  if (output !== 'preview' && output !== 'xlsx') {
    throw new DownloadRequestError('output must be preview or xlsx');
  }
  return {
    mode: body['mode'],
    output,
    profileId: body['profileId'],
    config: body['config'],
  };
}

function attachment(filename: string): string {
  return `attachment; filename="${filename.replaceAll('"', '')}"`;
}

export async function POST(request: Request): Promise<Response> {
  let database: RequestDatabase | null = null;
  try {
    const actor = await requestActor(request.headers);
    database = openWebDatabase();
    const body = parseCampaignBuildRequest(await request.json());
    const { mode, output } = body;

    const source = await withAuthenticatedActor(database, actor, async (sql) => {
      if (mode === 'create') return { client: 'campaigns', marketplace: 'US', entities: undefined as EntityRow[] | undefined };
      if (typeof body.profileId !== 'string' || body.profileId.length === 0) {
        throw new DownloadRequestError('profileId is required for UPDATE mode');
      }
      const profiles = await listOrgProfiles({ sql }, actor.orgId);
      const profile = profiles.find((candidate) => candidate.id === body.profileId);
      if (profile === undefined) throw new DownloadRequestError('Not found', 404);
      const entities = (await loadCampaignUpdateEntities({ sql }, {
        orgId: actor.orgId,
        profileId: profile.id,
      })).entities;
      return { client: profile.label, marketplace: profile.countryCode, entities };
    });

    let artifact: ReturnType<typeof buildCampaignBuilderArtifact>;
    try {
      artifact = buildCampaignBuilderArtifact(mode, body.config, {
        ...source,
        today: new Date().toISOString().slice(0, 10),
      });
    } catch {
      throw new DownloadRequestError('Campaign configuration is invalid. Review the JSON and preflight fields.');
    }
    if (output === 'preview') return downloadResponse(Response.json(artifact.preview));
    if (artifact.workbook === null || !artifact.preview.exportable) {
      return downloadResponse(Response.json(
        {
          error: artifact.preview.issues[0] ?? 'The preflight produced zero effective rows',
          preview: artifact.preview,
        },
        { status: 422 },
      ));
    }
    return downloadResponse(new Response(new Uint8Array(artifact.workbook.bytes), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': attachment(artifact.workbook.filename),
        'x-wizard-ads-bulk-rows': String(artifact.preview.rows.length),
      },
    }));
  } catch (error) {
    return downloadErrorResponse(error);
  } finally {
    await database?.close();
  }
}

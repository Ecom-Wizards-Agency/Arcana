import { redirect } from 'next/navigation';
import { readCreatorFulfillmentDetail, readCreatorMcfLane, type CreatorMcfLaneSend } from '@wizard-ads/db';
import type { CreatorFulfillmentDetail, OrgActor } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination, openWebDatabase } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';
import { sampleOrderKeyParam } from '../creators-sample-preflight/order-key';

/** The lane's detail and, when Arcana sent for it, the newest send's outcome. */
export interface FulfillmentProps {
  detail: CreatorFulfillmentDetail;
  /** Absent or null: Arcana sent nothing for this lane, or the ledger was not read. */
  send?: CreatorMcfLaneSend | null;
}

/** `/creators/samples/fulfillment/[id]`: one sample lane, its settlement, and the Amazon reads that made it, under tenant RLS. */
export async function load(access: ScreenActor, input: ScreenParams) {
  const key = sampleOrderKeyParam(input.params['id']);
  try {
    const read = await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return null;
      const detail = key === null ? null : await readCreatorFulfillmentDetail(database, actor.orgId, key);
      return { detail, actor };
    });
    if (read === null) return { view: 'gated' as const, props: {} };
    if (read.detail === null) return { view: 'missing' as const, props: { key: null } };
    const props: FulfillmentProps = { detail: read.detail, send: await readSend(read.detail, read.actor) };
    return { view: 'ready' as const, props };
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The sample order is unavailable') } };
  }
}

/** Only an Arcana-owned lane has a send outcome to show; the ledger's read opens its own authenticated transaction. */
async function readSend(detail: CreatorFulfillmentDetail, actor: OrgActor): Promise<CreatorMcfLaneSend | null> {
  const lane = detail.lane;
  if (lane === null || lane.orderOwner !== 'arcana' || detail.lastImport?.status === 'failed') return null;
  const connection = openWebDatabase();
  try {
    return (await readCreatorMcfLane(connection, actor, lane.creatorRecordId, lane.asin))?.send ?? null;
  } finally {
    await connection.close();
  }
}

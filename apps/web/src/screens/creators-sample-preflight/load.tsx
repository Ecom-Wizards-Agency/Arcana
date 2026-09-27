import { redirect } from 'next/navigation';
import { readCreatorMcfLane, readCreatorMcfSendGate, readCreatorPreflightDetail, type CreatorMcfLaneView, type CreatorMcfSendGate } from '@wizard-ads/db';
import type { CreatorPreflightDetail, OrgActor } from '@wizard-ads/shared';
import { mcfRecipientPublicKey } from '../../env';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination, openWebDatabase } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';
import { sampleOrderKeyParam } from './order-key';
import type { SendData } from './send-model';

/**
 * `/creators/samples/[key]/preflight`: the newest recorded pre-flight for one
 * sample lane, read under tenant RLS, and Arcana's send section for it. `now`
 * is the read time the previews' validity is judged against, so the view stays
 * a pure function of its props.
 */
export async function load(access: ScreenActor, input: ScreenParams) {
  const key = sampleOrderKeyParam(input.params['id']);
  try {
    const read = await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return null;
      const detail = key === null ? null : await readCreatorPreflightDetail(database, actor.orgId, key);
      return { detail, role, actor, now: new Date().toISOString() };
    });
    if (read === null) return { view: 'gated' as const, props: {} };
    if (read.detail === null) return { view: 'missing' as const, props: { key } };
    const send = await readSend(read.detail, read.actor, read.role === 'owner' || read.role === 'admin');
    return { view: 'ready' as const, props: { detail: read.detail, now: read.now, send } };
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The sample pre-flight is unavailable') } };
  }
}

/**
 * The send gate and the lane's newest send. The ledger's reads open their own
 * authenticated transactions, so they run on a request-owned connection after
 * the pre-flight read settles. A failed gate read counts as sending off.
 */
async function readSend(detail: CreatorPreflightDetail, actor: OrgActor, canAct: boolean): Promise<SendData | null> {
  if (detail.lastImport?.status === 'failed' || detail.creatorRecordId === null || detail.asin === null) return null;
  const key = await mcfRecipientPublicKey();
  const connection = openWebDatabase();
  try {
    const gate: CreatorMcfSendGate | null = await readCreatorMcfSendGate(connection, actor).catch(() => null);
    const mcf: CreatorMcfLaneView | null = await readCreatorMcfLane(connection, actor, detail.creatorRecordId, detail.asin);
    return { canAct, orgId: actor.orgId, gate, key, mcf };
  } finally {
    await connection.close();
  }
}

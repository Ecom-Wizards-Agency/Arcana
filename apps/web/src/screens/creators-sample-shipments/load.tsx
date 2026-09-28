import { redirect } from 'next/navigation';
import {
  readCreatorMcfLane, readCreatorMcfSendGate, readCreatorMcfSettlements, readCreatorQueue, readCreatorSampleShipments, type CreatorMcfLaneSend,
  type CreatorMcfSendGate,
} from '@wizard-ads/db';
import type { CreatorSampleShipment, OrgActor } from '@wizard-ads/shared';
import { mcfRecipientPublicKey } from '../../env';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination, openWebDatabase } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';
import { SEND_LANE_STATES, type SendKey } from '../creators-sample-preflight/send-model';
import type { DailyReportData } from './daily-report';

/** What the list shows about Arcana sending: the gate and each open lane's newest send, by derived order key. */
export interface SamplesSending {
  gate: CreatorMcfSendGate | null;
  key: SendKey;
  /** Null: no send for the lane. 'unread': the ledger read for that lane failed, shown as not read, never as no send. */
  sends: Record<string, CreatorMcfLaneSend | null | 'unread'>;
  /** Lanes WP-334 escalated after three not-found reads. */
  escalated: string[];
}

/**
 * `/creators/samples`: every sample lane the runner recorded, with whatever Amazon has been asked.
 * `?report=daily` also reads the queue and each lane's settlement for the daily report; nothing else does.
 */
export async function load(access: ScreenActor, input: ScreenParams) {
  const wantsReport = input.searchParams['report'] === 'daily';
  try {
    const read = await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return null;
      const snapshot = await readCreatorSampleShipments(database, actor.orgId);
      let report: DailyReportData | null = null;
      if (wantsReport) {
        const held = await readCreatorMcfSettlements(database, actor.orgId);
        const settlements: DailyReportData['settlements'] = Object.fromEntries(snapshot.shipments.map((lane) => [lane.derivedOrderKey, held[lane.derivedOrderKey] ?? null]));
        report = { queue: await readCreatorQueue(database, actor.orgId), settlements };
      }
      return { snapshot, report, actor, now: new Date().toISOString() };
    });
    if (read === null) return { view: 'gated' as const, props: {} };
    const sending = read.snapshot.lastImport?.status === 'failed' ? null : await readSending(read.snapshot.shipments, read.actor);
    return { view: 'ready' as const, props: { snapshot: read.snapshot, report: read.report, sending, now: read.now } };
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'Sample shipments are unavailable') } };
  }
}

/** The ledger's reads open their own authenticated transactions, on a request-owned connection. A failed gate read counts as sending off. */
async function readSending(shipments: readonly CreatorSampleShipment[], actor: OrgActor): Promise<SamplesSending> {
  const key = await mcfRecipientPublicKey();
  const connection = openWebDatabase();
  try {
    const gate = await readCreatorMcfSendGate(connection, actor).catch(() => null);
    const sends: SamplesSending['sends'] = {};
    const escalated: string[] = [];
    for (const lane of shipments.filter((item) => SEND_LANE_STATES.includes(item.laneState))) {
      const view = await readCreatorMcfLane(connection, actor, lane.creatorRecordId, lane.asin).catch(() => 'unread' as const);
      if (view === 'unread') { sends[lane.derivedOrderKey] = 'unread'; continue; }
      sends[lane.derivedOrderKey] = view?.send ?? null;
      if (view?.lane.settlement?.settlement === 'escalated') escalated.push(lane.derivedOrderKey);
    }
    return { gate, key, sends, escalated };
  } finally {
    await connection.close();
  }
}

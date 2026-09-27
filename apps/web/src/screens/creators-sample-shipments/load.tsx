import { redirect } from 'next/navigation';
import { readCreatorMcfSettlements, readCreatorQueue, readCreatorSampleShipments } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';
import type { DailyReportData } from './daily-report';

/**
 * `/creators/samples`: every sample lane the runner recorded, with whatever Amazon has been asked.
 * `?report=daily` also reads the queue and each lane's settlement for the daily report; nothing else does.
 */
export async function load(access: ScreenActor, input: ScreenParams) {
  const wantsReport = input.searchParams['report'] === 'daily';
  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return { view: 'gated' as const, props: {} };
      const snapshot = await readCreatorSampleShipments(database, actor.orgId);
      let report: DailyReportData | null = null;
      if (wantsReport) {
        const held = await readCreatorMcfSettlements(database, actor.orgId);
        const settlements: DailyReportData['settlements'] = Object.fromEntries(snapshot.shipments.map((lane) => [lane.derivedOrderKey, held[lane.derivedOrderKey] ?? null]));
        report = { queue: await readCreatorQueue(database, actor.orgId), settlements };
      }
      return { view: 'ready' as const, props: { snapshot, report } };
    });
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'Sample shipments are unavailable') } };
  }
}

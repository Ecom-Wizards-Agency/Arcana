import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/** `/settings/integrations` — generic external API credential custody. */

import { listCompetitorLinks, listIntegrationConnections } from '@wizard-ads/db';

import { can } from '../../auth/roles';

import { listProfiles } from '../../../app/_lib/profiles';

export async function load(access: ScreenActor, _input: ScreenParams) {

  const result = access.entry;

  if (result.state === 'no-database') {
    return { view: 'no-database' as const, props: {} };
  }
  if (result.state === 'no-org') {
    return { view: 'no-org' as const, props: {} };
  }

  const { context } = result;
  const org = context.active;
  if (!org) return null;

  const [connections, competitorLinks, profiles] = await access.readSql((sql) => Promise.all([
    listIntegrationConnections({ sql }, org.orgId),
    listCompetitorLinks({ sql }, org.orgId),
    listProfiles({ sql }, org.orgId),
  ]),
  );
  const mayManage = can(org.role, 'manageConnection');
  const mayEditCompetitors = can(org.role, 'editTargets');

  return { view: 'ready' as const, props: { context, mayManage, connections, competitorLinks, profiles, mayEditCompetitors } };
}

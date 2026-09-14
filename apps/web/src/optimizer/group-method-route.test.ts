import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OptimizationWorkspace, SaveOptimizationGroupResult } from '@wizard-ads/db';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { COORDINATED_METHOD, REFERENCE_METHOD } from '@wizard-ads/shared';
import { GET, POST } from '../../app/api/optimizer/groups/route';

const bridge = 'synthetic-group-method-route';
const coordinatedSettings = {
  exposureCeiling: 1.73,
  minClicksPerPlacement: 19,
  placementEvidenceRequirements: 'single_target',
} as const;
interface Agency { orgId: string; profileId: string; userId: string; groupId: string }
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase('group_method_http');
  vi.stubEnv('DATABASE_URL', database.connectionString);
  vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
  vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
}, 60_000);
afterAll(async () => { vi.unstubAllEnvs(); await database?.drop(); });

async function agency(): Promise<Agency> {
  const userId = randomUUID();
  const [organization] = await database.sql<{ id: string }[]>`
    select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner') as id
  `;
  const orgId = organization!.id;
  const profiles = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
  const groups = await database.sql<{ id: string }[]>`select id from public.optimization_groups where org_id = ${orgId}`;
  expect(profiles).toHaveLength(1);
  expect(groups).toHaveLength(1);
  return { orgId, userId, profileId: profiles[0]!.id, groupId: groups[0]!.id };
}

function headers(actor: Agency): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-wizard-ads-auth-bridge': bridge,
    'x-wizard-ads-user-id': actor.userId,
    'x-wizard-ads-org-id': actor.orgId,
  };
}

function settings(actor: Agency): Record<string, unknown> {
  return {
    id: actor.groupId, profileId: actor.profileId, name: 'Synthetic method group', role: 'profit',
    targetAcosPercent: 29, bidFloor: 0.17, bidCeiling: 3.19,
    bidIncreaseCapPercent: 13, bidDecreaseCapPercent: 31,
    placementIncreaseCapPercent: 11, placementDecreaseCapPercent: 27,
    exclusions: [], reviewWeekdays: ['monday'], prioritization: 'growth_first',
    enabled: true, campaignIds: ['c-1'],
  };
}

async function post(actor: Agency, body: unknown): Promise<Response> {
  const response = await POST(new Request('http://localhost/api/optimizer/groups', {
    method: 'POST', headers: headers(actor), body: JSON.stringify(body),
  }));
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  return response;
}

async function readback(actor: Agency): Promise<OptimizationWorkspace> {
  const response = await GET(new Request(`http://localhost/api/optimizer/groups?profileId=${actor.profileId}`, {
    headers: headers(actor),
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  const workspace = await response.json() as OptimizationWorkspace;
  expect(workspace.groups).toHaveLength(1);
  expect(workspace.assignedCampaigns).toBe(1);
  return workspace;
}

async function stored(actor: Agency) {
  const groups = await database.sql`
    select id, name, method_id, method_version, method_settings
      from public.optimization_groups where org_id = ${actor.orgId}
  `;
  const assignments = await database.sql`
    select campaign_id, group_id from public.campaign_optimization_assignments
      where org_id = ${actor.orgId} order by campaign_id
  `;
  const audits = await database.sql`
    select id from public.audit_log where org_id = ${actor.orgId} order by id
  `;
  return { groups: [...groups], assignments: [...assignments], audits: [...audits] };
}

it.each([REFERENCE_METHOD, COORDINATED_METHOD])('persists $id and returns its settings through GET', async (method) => {
  const actor = await agency();
  const methodSettings = method.id === COORDINATED_METHOD.id ? coordinatedSettings : undefined;
  const response = await post(actor, { ...settings(actor), method, ...(methodSettings === undefined ? {} : { methodSettings }) });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as SaveOptimizationGroupResult;
  expect(result).toMatchObject({ offeredCampaigns: 1, assignedCampaigns: 1, removedCampaigns: 0 });
  expect(result.record.campaignIds).toEqual(['c-1']);
  expect(result.record.group.method).toEqual(method);
  expect(result.record.group.methodSettings).toEqual(methodSettings);
  const workspace = await readback(actor);
  expect(workspace.groups[0]!.group).toEqual(result.record.group);
  expect((await stored(actor)).groups).toEqual([{
    id: actor.groupId, name: 'Synthetic method group', method_id: method.id,
    method_version: method.version, method_settings: methodSettings ?? null,
  }]);
});

it('preserves method and parameters when an existing group update omits them', async () => {
  const actor = await agency();
  const saved = await post(actor, { ...settings(actor), method: COORDINATED_METHOD, methodSettings: coordinatedSettings });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const updated = await post(actor, { ...settings(actor), name: 'Synthetic renamed group' });
  expect(updated.status, await updated.clone().text()).toBe(200);
  const workspace = await readback(actor);
  expect(workspace.groups[0]!.group).toMatchObject({
    name: 'Synthetic renamed group', method: COORDINATED_METHOD, methodSettings: coordinatedSettings,
  });
  expect((await stored(actor)).groups).toEqual([{
    id: actor.groupId, name: 'Synthetic renamed group', method_id: COORDINATED_METHOD.id,
    method_version: COORDINATED_METHOD.version, method_settings: coordinatedSettings,
  }]);
});

it('refuses invalid method pairs and parameters without changing settings, assignments, or audit', async () => {
  const actor = await agency();
  const valid = { ...settings(actor), method: COORDINATED_METHOD, methodSettings: coordinatedSettings };
  const saved = await post(actor, valid);
  expect(saved.status, await saved.clone().text()).toBe(200);
  const before = await stored(actor);
  const invalid = [
    { method: { id: COORDINATED_METHOD.id, version: REFERENCE_METHOD.version } },
    { method: { id: REFERENCE_METHOD.id, version: COORDINATED_METHOD.version } },
    { method: { id: COORDINATED_METHOD.id } },
    { method: { id: 'sp.unregistered', version: COORDINATED_METHOD.version } },
    { method: null },
    { methodSettings: { ...coordinatedSettings, exposureCeiling: 0 } },
    { methodSettings: { ...coordinatedSettings, minClicksPerPlacement: 1.5 } },
    { methodSettings: { ...coordinatedSettings, placementEvidenceRequirements: 'unchecked' } },
  ];
  let refused = 0;
  for (const change of invalid) {
    const response = await post(actor, { ...valid, ...change });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid optimization settings' });
    expect(await stored(actor)).toEqual(before);
    refused++;
  }
  expect(refused).toBe(invalid.length);
});

it('refuses a viewer changing the selected method without persisting anything', async () => {
  const actor = await agency();
  await database.sql`update public.org_members set role = 'viewer' where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
  const before = await stored(actor);
  const response = await post(actor, { ...settings(actor), method: COORDINATED_METHOD, methodSettings: coordinatedSettings });
  expect(response.status).toBe(403);
  expect(await stored(actor)).toEqual(before);
});

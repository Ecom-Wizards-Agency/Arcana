import { expect, test, type Locator } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { OneTimeRpcPreviewRequest, RecommendationPreviewAccepted, type OneTimeRpcConfiguration, type OneTimeRpcSnapshot } from '@wizard-ads/shared';
import { signIn } from './support/auth';
import { readState, type E2EState } from './support/fixture';

test.describe.configure({ mode: 'serial' });

const FILTERED_CAMPAIGN_COUNT = 56;
const FILTERED_CAMPAIGN_PREFIX = 'WP195 Filtered Campaign';
const FILTERED_CAMPAIGN_ID_PREFIX = 'wp195-filtered-campaign';
const WORKER_REVISION = '0'.repeat(40);
const WORKER_ID = 'e2e-recommendation-worker';
const ONE_TIME_ENDPOINT = '/api/optimizer/runs/one-time';
const ONE_TIME_CONFIGURATION: OneTimeRpcConfiguration = {
  version: 1, method: 'rpc', targetAcos: 0.37, bidFloor: 0.11, bidCeiling: 4.3,
  bidIncreaseCap: 0.23, bidDecreaseCap: 0.41,
  window: { start: '2026-08-01', end: '2026-08-26' },
};

test.beforeEach(async () => { await reportRuntime(await readState()); });

interface AssignmentEvidence {
  campaign_id: string;
  group_id: string;
}

interface ApplyEvidence {
  apply_batches: number;
  apply_rows: number;
  apply_changes: number;
}

test('edits a canonical local weekday schedule and still queues a manual preview', async ({ page }) => {
  await signIn(page, 'admin');
  const state = await readState();
  const { fixtureProfileId } = state;
  await page.goto(`/optimizer/groups?profile=${fixtureProfileId}`);

  await expect(page.getByRole('heading', { name: 'Optimization Groups', exact: true })).toBeVisible();
  await expect(page.getByText('UTC · 04:00 local')).toBeVisible();

  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekdayChecks = weekdayNames.map((name) => page.getByRole('checkbox', { name, exact: true }));
  for (const checkbox of weekdayChecks) await expect(checkbox).toBeChecked();

  for (const checkbox of weekdayChecks.slice(1)) await checkbox.uncheck();
  await weekdayChecks[0]?.click();
  await expect(weekdayChecks[0]!).toBeChecked();

  await page.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved 1 campaign assignment');
  await expect(page.getByText(/Target ACOS .* · Mon$/)).toBeVisible();

  // Weekday eligibility belongs only to the default-off scheduler. An
  // operator's manual preview remains available and still creates no Amazon write.
  try {
    await page.getByRole('button', { name: 'Run group preview', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Preview queued');
    await expect(page.getByRole('status')).toContainText('Amazon is unchanged');
  } finally {
    // This is one serial suite. Complete the queued run through the same narrow
    // fenced RPCs as the worker so the campaign-scope test has no queue residue.
    await succeedQueuedRecommendationRuns(state, 1);
  }
});

test('selects filtered campaigns across a filter and polls the exact read-only preview scope', async ({
  page,
}) => {
  const state = await readState();
  const selectedCampaignIds = [1, 26, 51].map(filteredCampaignId);
  await seedFilteredCampaigns(state);

  const before = await readDatabaseEvidence(state);

  await signIn(page, 'admin');
  await page.goto(`/optimizer?profile=${state.fixtureProfileId}`);
  await expect(page.getByRole('heading', { name: 'Campaign Optimizer', exact: true })).toBeVisible();

  const search = page.getByRole('search', { name: 'Filter optimizer campaigns' });
  await search.getByLabel('Find campaign').fill(FILTERED_CAMPAIGN_PREFIX);
  // WP-209 removed the 25-row page slice: the grid holds the whole filtered
  // set and the workspace counts it against the campaigns the loader returned.
  // The tenant fixture's own campaign is the extra one.
  await expect(page.locator('.wa-optimizer-campaigns__shown')).toHaveText(
    `${FILTERED_CAMPAIGN_COUNT} of ${FILTERED_CAMPAIGN_COUNT + 1} campaigns`,
  );

  const selectFiltered = page.getByTestId('optimizer-select-filtered');
  await expect(selectFiltered).toHaveAccessibleName(
    `Select all ${FILTERED_CAMPAIGN_COUNT} eligible campaigns matching current filters`,
  );
  await selectFiltered.check();
  await expect(page.getByTestId('optimizer-selection-count')).toContainText(
    `${FILTERED_CAMPAIGN_COUNT} campaigns selected`,
  );

  // The header owns the complete filtered result, not the rows the virtualizer
  // happens to have rendered. Narrowing to one campaign is how a row far down
  // the set is reached now that there is no page to turn.
  await search.getByLabel('Find campaign').fill(filteredCampaignName(26));
  const distantCampaign = page.getByRole('checkbox', {
    name: `Select ${filteredCampaignName(26)} for this preview`,
  });
  await expect(distantCampaign).toBeChecked();
  await distantCampaign.uncheck();
  await expect(page.getByTestId('optimizer-selection-count')).toContainText('55 campaigns selected');

  // Narrowing the view preserves every hidden selection. Clear selected must
  // then clear that entire transient set, including rows on hidden pages.
  await search.getByLabel('Find campaign').fill(filteredCampaignName(1));
  await expect(page.getByTestId('optimizer-selection-count')).toContainText('55 campaigns selected');
  await expect(page.getByRole('checkbox', {
    name: `Select ${filteredCampaignName(1)} for this preview`,
  })).toBeChecked();
  await page.getByRole('button', { name: 'Clear selected', exact: true }).click();
  await expect(page.getByTestId('optimizer-selection-count')).toHaveText('No campaigns selected.');

  // Build an explicit subset from three widely separated rows after the global
  // clear, each reached by narrowing the filter to it.
  await search.getByLabel('Find campaign').fill(filteredCampaignName(1));
  await page.getByRole('checkbox', {
    name: `Select ${filteredCampaignName(1)} for this preview`,
  }).check();
  await search.getByLabel('Find campaign').fill(FILTERED_CAMPAIGN_PREFIX);
  await expect(selectFiltered).toHaveJSProperty('indeterminate', true);
  for (const index of [26, 51]) {
    await search.getByLabel('Find campaign').fill(filteredCampaignName(index));
    await page.getByRole('checkbox', {
      name: `Select ${filteredCampaignName(index)} for this preview`,
    }).check();
  }

  await expect(page.getByRole('radio', { name: 'Selected campaigns (3)', exact: true }))
    .toBeChecked();
  const run = page.getByTestId('optimizer-run-preview');
  await expect(run).toHaveText('Run preview · 3 selected');

  const requests: OneTimeRpcPreviewRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === ONE_TIME_ENDPOINT) {
      requests.push(OneTimeRpcPreviewRequest.parse(request.postDataJSON()));
    }
  });
  const beforePreview = await readPreviewCounts(state);
  await run.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm one-time preview' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty('open', true);
  await expect(dialog.getByText('3 campaigns · RPC · USD', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Target ACOS (%)', { exact: true })).toHaveValue('');
  await expect(dialog.getByText('Some settings are mixed or missing.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(0);
  expect(await readPreviewCounts(state)).toEqual(beforePreview);

  await run.click();
  await fillOneTimeSettings(dialog);
  expect(requests).toHaveLength(0);
  await reportRuntime(state);

  // Let the real server commit the first request, then lose its response.
  // The browser's retry must reconcile the same saved batch, never a fake acceptance.
  let interruptedAcceptance: ReturnType<typeof RecommendationPreviewAccepted.parse> | undefined;
  let attempts = 0;
  await page.route(`**${ONE_TIME_ENDPOINT}`, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(202);
      interruptedAcceptance = RecommendationPreviewAccepted.parse(await committed.json());
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === ONE_TIME_ENDPOINT;
  });
  await dialog.getByRole('button', { name: 'Run read-only preview', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const accepted = RecommendationPreviewAccepted.parse(await response.json());
  await expect(dialog).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ configuration: ONE_TIME_CONFIGURATION,
    scope: { mode: 'selected', campaignIds: selectedCampaignIds } });
  expect(accepted).toEqual(interruptedAcceptance);
  expect(accepted.scope).toMatchObject({ mode: 'selected', campaignCount: 3 });
  // Group custody remains partitioned even though both children use the same
  // confirmed one-time settings instead of their saved bidding policy.
  expect(accepted.childCount).toBe(2);
  await expect(page.getByText(/Preview queued for 3 campaigns across 2 runs\./)).toBeVisible();

  const stored = await readStoredScope(state, accepted.batchId);
  expect(stored.batch).toEqual({
    selection_mode: 'selected',
    scope_count: 3,
    scope_fingerprint: accepted.scope.fingerprint,
    child_count: 2,
  });
  expect(stored.campaignIds).toEqual(selectedCampaignIds);
  expect(stored.childCounts).toEqual([1, 2]);
  expect(stored.scopeVersions).toEqual([2, 2]);
  expect(stored.executionSnapshot).toMatchObject({ configuration: ONE_TIME_CONFIGURATION, profileTimezone: 'UTC' });
  const afterPreview = await readPreviewCounts(state);
  expect(afterPreview).toEqual({ batches: beforePreview.batches + 1, runs: beforePreview.runs + 2,
    campaigns: beforePreview.campaigns + 3, jobs: beforePreview.jobs + 2 });

  const afterEnqueue = await readDatabaseEvidence(state);
  expect(afterEnqueue.assignments).toEqual(before.assignments);
  expect(afterEnqueue.savedGroups).toEqual(before.savedGroups);
  expect(afterEnqueue.applyEvidence).toEqual(before.applyEvidence);

  await reportRuntime(state, false);
  await expect(page.getByText('Preview saved. The recommendation worker is unavailable.', { exact: false }))
    .toBeVisible({ timeout: 10_000 });
  expect(await readPreviewCounts(state)).toEqual(afterPreview);

  // Emulate worker completion in the queue/run ledgers. The browser must
  // discover this through its bounded polling loop without a manual reload.
  await succeedQueuedRecommendationRuns(state, accepted.childCount);
  await expect(page.getByText('Preview completed. No changes were recommended.', { exact: true }))
    .toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('list', { name: 'Preview runs' })
    .getByRole('link', { name: 'Review 0 recommendations →' }))
    .toHaveCount(accepted.childCount);

  const afterCompletion = await readDatabaseEvidence(state);
  expect(afterCompletion.assignments).toEqual(before.assignments);
  expect(afterCompletion.savedGroups).toEqual(before.savedGroups);
  expect(afterCompletion.applyEvidence).toEqual(before.applyEvidence);

  await page.getByRole('list', { name: 'Preview runs' })
    .getByRole('link', { name: 'Review 0 recommendations →' }).first().click();
  await expect(page.getByRole('heading', { name: 'Recommendations', exact: true })).toBeVisible();
  await expect(page.getByText('This run proposed nothing', { exact: true })).toBeVisible();
  await page.getByText('Run details', { exact: true }).click();
  await expect(page.getByText('Confirmed target ACOS 37%', { exact: false }))
    .toContainText('2026-08-01 to 2026-08-26 (UTC)');
});

test('explains unavailable readiness and refuses a worker lost after settings were opened', async ({ page }) => {
  const state = await readState();
  await signIn(page, 'admin');
  await reportRuntime(state, false);
  await page.goto(`/optimizer?profile=${state.fixtureProfileId}`);
  const run = page.getByTestId('optimizer-run-preview');
  await expect(run).toBeDisabled();
  await expect(page.getByText('The recommendation worker is unavailable.', { exact: false })).toBeVisible();

  await reportRuntime(state);
  await page.reload();
  await page.getByRole('checkbox', { name: `Select ${filteredCampaignName(1)} for this preview` }).check();
  await run.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm one-time preview' });
  await expect(dialog.getByLabel('Target ACOS (%)', { exact: true })).toHaveValue('20');
  await fillOneTimeSettings(dialog);
  await reportRuntime(state, false);
  const before = await readPreviewCounts(state);
  const refused = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === ONE_TIME_ENDPOINT);
  await dialog.getByRole('button', { name: 'Run read-only preview', exact: true }).click();
  const response = await refused;
  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({ reason: 'worker_unavailable' });
  await expect(dialog.getByRole('alert')).toContainText('The recommendation worker is unavailable.');
  await expect(dialog.getByRole('button', { name: 'Run read-only preview', exact: true })).toBeEnabled();
  expect(await readPreviewCounts(state)).toEqual(before);
  await expect(dialog.getByLabel('Target ACOS (%)', { exact: true })).toHaveValue('37');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await reportRuntime(state);
});

async function fillOneTimeSettings(dialog: Locator): Promise<void> {
  for (const [label, value] of [
    ['Target ACOS (%)', '37'], ['Minimum bid (USD)', '0.11'], ['Maximum bid (USD)', '4.3'],
    ['Maximum bid increase (%)', '23'], ['Maximum bid decrease (%)', '41'],
    ['Reporting start', ONE_TIME_CONFIGURATION.window.start], ['Reporting end', ONE_TIME_CONFIGURATION.window.end],
  ] as const) await dialog.getByLabel(label, { exact: true }).fill(value);
}

function filteredCampaignId(index: number): string {
  return `${FILTERED_CAMPAIGN_ID_PREFIX}-${String(index).padStart(2, '0')}`;
}

function filteredCampaignName(index: number): string {
  return `${FILTERED_CAMPAIGN_PREFIX} ${String(index).padStart(2, '0')}`;
}

async function withDatabase<T>(state: E2EState, action: (database: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const database = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    return await action(database);
  } finally {
    await database.close();
  }
}

async function reportRuntime(state: E2EState, ready = true): Promise<void> {
  await withDatabase(state, async (database) => {
    const session = await database.sql.reserve();
    try {
      await session.unsafe('set session authorization openspell_recommendation_worker');
      expect(await session`select session_user`).toEqual([{ session_user: 'openspell_recommendation_worker' }]);
      await session`select public.report_recommendation_runtime(${WORKER_ID}, ${WORKER_REVISION}, array[1,2], ${ready})`;
    } finally {
      await session.unsafe('reset session authorization');
      session.release();
    }
    expect(await database.sql`select ready from public.get_one_time_recommendation_readiness(${WORKER_REVISION})`)
      .toEqual([{ ready }]);
  });
}

async function readPreviewCounts(state: E2EState): Promise<{
  batches: number; runs: number; campaigns: number; jobs: number;
}> {
  return withDatabase(state, async (database) => {
    const rows = await database.sql<{ batches: number; runs: number; campaigns: number; jobs: number }[]>`
      select
        (select count(*)::integer from public.recommendation_preview_batches where org_id = ${state.orgId}::uuid) as batches,
        (select count(*)::integer from public.recommendation_runs where org_id = ${state.orgId}::uuid) as runs,
        (select count(*)::integer from public.recommendation_run_campaigns where org_id = ${state.orgId}::uuid) as campaigns,
        (select count(*)::integer from public.sync_jobs where org_id = ${state.orgId}::uuid and job_type = 'recommendations.run') as jobs
    `;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  });
}

async function succeedQueuedRecommendationRuns(
  state: E2EState,
  expectedChildren: number,
): Promise<void> {
  await reportRuntime(state);
  await withDatabase(state, async (database) => {
    const revision = WORKER_REVISION;
    const workerId = WORKER_ID;
    const reserved = await database.sql.reserve();
    let completed = 0;
    try {
      await reserved.unsafe('set session authorization openspell_recommendation_worker');
      while (true) {
        const claims = await reserved<{
          id: string;
          org_id: string;
          profile_id: string;
          payload: unknown;
          claimed_by: string;
          claim_token: string;
        }[]>`
          select id, org_id, profile_id, payload, claimed_by, claim_token
            from public.claim_recommendation_jobs_fenced(${workerId}, ${revision}, 1)
        `;
        const claim = claims[0];
        if (claim === undefined) break;
        const payload = claim.payload as { runId?: unknown; groupId?: unknown };
        if (typeof payload.runId !== 'string'
            || (payload.groupId !== undefined && typeof payload.groupId !== 'string')) {
          throw new Error('The E2E recommendation claim returned an invalid scope');
        }
        const groupId = payload.groupId ?? null;
        const starts = await reserved<{ decision: string; run_data: unknown }[]>`
          select decision, run_data from public.start_recommendation_run_fenced(
            ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${revision},
            ${claim.org_id}::uuid, ${claim.profile_id}::uuid, ${payload.runId}::uuid,
            ${groupId}::uuid
          )
        `;
        const start = starts[0];
        const runData = start?.run_data as {
          lookbackDays?: unknown;
          strategySnapshot?: unknown;
          scopeVersion?: number;
          executionSnapshot?: OneTimeRpcSnapshot;
        } | undefined;
        const lookbackDays = Number(runData?.lookbackDays);
        if (start?.decision !== 'started' || !Number.isSafeInteger(lookbackDays)
            || lookbackDays < 1 || runData?.strategySnapshot === undefined) {
          throw new Error('The E2E recommendation start returned an invalid run');
        }
        const oneTime = runData.scopeVersion === 2 ? runData.executionSnapshot?.configuration : undefined;
        if (runData.scopeVersion === 2) expect(oneTime).toEqual(ONE_TIME_CONFIGURATION);
        const windowStart = new Date(Date.UTC(2026, 0, 1));
        const windowEnd = new Date(windowStart);
        windowEnd.setUTCDate(windowEnd.getUTCDate() + lookbackDays - 1);
        const completion = {
          proposals: [],
          lookbackDays,
          window: oneTime?.window ?? {
            start: windowStart.toISOString().slice(0, 10),
            end: windowEnd.toISOString().slice(0, 10),
          },
          strategySnapshot: runData.strategySnapshot,
          narrative: { qualitative: [], decisions: [], ...(oneTime === undefined ? {} : { oneTimeConfiguration: oneTime }) },
        };
        const succeeded = await reserved<{ decision: string; proposals_count: number }[]>`
          select decision, proposals_count from public.succeed_recommendation_run_fenced(
            ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${revision},
            ${claim.org_id}::uuid, ${claim.profile_id}::uuid, ${payload.runId}::uuid,
            ${groupId}::uuid, ${JSON.stringify(completion)}::text::jsonb
          )
        `;
        expect(succeeded).toEqual([{ decision: 'succeeded', proposals_count: 0 }]);
        const settled = await reserved<{ decision: string; status: string }[]>`
          select decision, status from public.finish_recommendation_job_fenced(
            ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${revision},
            'succeeded', null, '{}'::jsonb, null
          )
        `;
        expect(settled).toEqual([{ decision: 'settled', status: 'succeeded' }]);
        completed += 1;
      }
    } finally {
      await reserved.unsafe('reset session authorization').catch(() => {});
      reserved.release();
    }
    expect(completed).toBe(expectedChildren);
  });
}

async function seedFilteredCampaigns(state: E2EState): Promise<void> {
  await withDatabase(state, async (database) => {
    const campaigns = Array.from({ length: FILTERED_CAMPAIGN_COUNT }, (_, offset) => ({
      amazon_id: filteredCampaignId(offset + 1),
      name: filteredCampaignName(offset + 1),
    }));
    const inserted = await database.sql<{ amazon_id: string }[]>`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
      select ${state.orgId}, ${state.fixtureProfileId}, offered.amazon_id,
             'SP'::public.ad_product, offered.name, 'enabled'::public.entity_state,
             10.00, 'daily'::public.budget_type
        from jsonb_to_recordset(${JSON.stringify(campaigns)}::jsonb) as offered(
          amazon_id text,
          name text
        )
      returning amazon_id
    `;
    expect(inserted).toHaveLength(FILTERED_CAMPAIGN_COUNT);

    const assigned = await database.sql<{ campaign_id: string }[]>`
      insert into public.campaign_optimization_assignments
        (org_id, profile_id, campaign_id, group_id)
      select ${state.orgId}, ${state.fixtureProfileId}, campaign.amazon_id, optimization_group.id
        from public.campaigns campaign
        cross join lateral (
          select id
            from public.optimization_groups
           where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}
           order by id
           limit 1
        ) optimization_group
       where campaign.org_id = ${state.orgId}
         and campaign.profile_id = ${state.fixtureProfileId}
         and campaign.amazon_id = any (${campaigns.slice(0, 28).map((row) => row.amazon_id)}::text[])
      returning campaign_id
    `;
    expect(assigned).toHaveLength(28);
  });
}

async function readDatabaseEvidence(state: E2EState): Promise<{
  assignments: AssignmentEvidence[];
  applyEvidence: ApplyEvidence;
  savedGroups: unknown[];
}> {
  return withDatabase(state, async (database) => {
    const assignments = await database.sql<AssignmentEvidence[]>`
      select campaign_id, group_id::text as group_id
        from public.campaign_optimization_assignments
       where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}
       order by campaign_id collate "C", group_id
    `;
    const rows = await database.sql<ApplyEvidence[]>`
      select
        (select count(*)::int from public.apply_batches
          where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}) as apply_batches,
        (select count(*)::int from public.apply_rows
          where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}) as apply_rows,
        (select count(*)::int from public.entity_changes
          where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}
            and source = 'apply') as apply_changes
    `;
    const applyEvidence = rows[0];
    if (applyEvidence === undefined) throw new Error('Could not read apply evidence');
    const savedGroups = await database.sql`
      select to_jsonb(optimization_group) as settings from public.optimization_groups optimization_group
       where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId} order by id
    `;
    expect(savedGroups.length).toBeGreaterThan(0);
    return { assignments, applyEvidence, savedGroups };
  });
}

async function readStoredScope(state: E2EState, batchId: string): Promise<{
  batch: {
    selection_mode: string;
    scope_count: number;
    scope_fingerprint: string;
    child_count: number;
  };
  campaignIds: string[];
  childCounts: number[];
  scopeVersions: number[];
  executionSnapshot: OneTimeRpcSnapshot;
}> {
  return withDatabase(state, async (database) => {
    const batches = await database.sql<{
      selection_mode: string;
      scope_count: number;
      scope_fingerprint: string;
      child_count: number;
    }[]>`
      select selection_mode, scope_count, scope_fingerprint, child_count
        from public.recommendation_preview_batches
       where org_id = ${state.orgId}
         and profile_id = ${state.fixtureProfileId}
         and id = ${batchId}
    `;
    const batch = batches[0];
    if (batch === undefined) throw new Error('Preview batch was not stored');

    const members = await database.sql<{ campaign_id: string }[]>`
      select campaign_id
        from public.recommendation_run_campaigns
       where org_id = ${state.orgId}
         and profile_id = ${state.fixtureProfileId}
         and batch_id = ${batchId}
       order by campaign_id collate "C"
    `;
    const children = await database.sql<{
      scope_count: number; persisted_count: number; scope_version: number; execution_snapshot: OneTimeRpcSnapshot;
    }[]>`
      select run.scope_count, run.scope_version, run.execution_snapshot, count(member.campaign_id)::int as persisted_count
        from public.recommendation_runs run
        join public.sync_jobs job
          on job.org_id = run.org_id
         and job.profile_id = run.profile_id
         and job.id = run.job_id
        left join public.recommendation_run_campaigns member
          on member.org_id = run.org_id
         and member.profile_id = run.profile_id
         and member.run_id = run.id
       where run.org_id = ${state.orgId}
         and run.profile_id = ${state.fixtureProfileId}
         and run.batch_id = ${batchId}
         and job.payload ->> 'runId' = run.id::text
       group by run.id, run.scope_count
       order by run.scope_count
    `;
    expect(children).toHaveLength(batch.child_count);
    for (const child of children) expect(child.persisted_count).toBe(child.scope_count);
    const snapshots = await database.sql<{ execution_snapshot: OneTimeRpcSnapshot }[]>`
      select execution_snapshot from public.recommendation_preview_batches
       where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId} and id = ${batchId}
    `;
    expect(snapshots).toHaveLength(1);
    for (const child of children) expect(child.execution_snapshot).toEqual(snapshots[0]!.execution_snapshot);
    return {
      batch,
      campaignIds: members.map((row) => row.campaign_id),
      childCounts: children.map((row) => row.scope_count),
      scopeVersions: children.map((row) => row.scope_version),
      executionSnapshot: snapshots[0]!.execution_snapshot,
    };
  });
}

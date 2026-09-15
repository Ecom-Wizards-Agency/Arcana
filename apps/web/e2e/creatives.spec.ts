import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { reconcileProviderGraph } from '@wizard-ads/core';
import { AssetLibraryObservation, AssetModerationObservation, ProviderGraphScope, ProviderGraphReadResult, StreamExtensionEvent } from '@wizard-ads/shared';
import { persistAssetLibraryEvidence, persistAssetModerationEvidence, appendProviderGraphEvidence, readProviderGraphEvidence, recordProviderGraphResolution, retainStreamExtensionDelivery, projectStreamExtensionEvent, createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { CREATIVE_ASSETS, CREATIVE_CAMPAIGN_ID, CREATIVE_NAMES, seedCreativeWorkspace } from './support/creative-fixture';
import { captureCreativeStates, waitForCreativeShell } from './support/creative-screenshots';

test('creative workspace preserves selection, filters, evidence and detail routes', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const state = await readState();
  const period = await seedCreativeWorkspace(state);
  const db = createDb({ connectionString: state.connectionString });
  const assetProfileId=randomUUID();
  let assetProfileCreated=false;
  try {
    const updated = await db.sql`update public.creative_assets set url='https://example.test/expired-creative-thumbnail.png'
      where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} and amazon_asset_id=${CREATIVE_ASSETS[0]} returning id`;
    expect(updated).toHaveLength(1);
    const [profile]=await db.sql<{amazon_profile_id:string;region:string;country_code:string}[]>`select amazon_profile_id,region,country_code from public.ad_profiles where id=${state.fixtureProfileId}`;
    const scope=ProviderGraphScope.parse({orgId:state.orgId,profileId:state.fixtureProfileId,amazonProfileId:profile!.amazon_profile_id,region:profile!.region});
    const before=`${period.to}T10:00:00.000Z`,start=`${period.to}T11:00:00.000Z`,end=`${period.to}T12:00:00.000Z`;
    const identities=[{adProduct:'SB',kind:'creative',providerId:'stream-creative',version:'1'},
      {adProduct:'SB',kind:'asset',providerId:CREATIVE_ASSETS[0],version:'1'},
      {adProduct:'SB',kind:'campaign',providerId:CREATIVE_CAMPAIGN_ID,version:null}];
    const common={scope,sourceEventAt:before,revision:'1',payloadFingerprint:'f'.repeat(64),operation:'upsert'};
    const graph=ProviderGraphReadResult.parse({sourceRows:3,parsed:3,refusals:[],pages:1,completeness:'partial',
      observations:identities.map(identity=>({...common,identity,observedAt:before,source:'product_api',contractVersion:'fixture.v1',state:'enabled'})),
      associations:[{...common,from:identities[0],to:identities[1],relation:'asset'},{...common,from:identities[0],to:identities[2],relation:'parent'}]});
    expect((await appendProviderGraphEvidence(db,scope,graph)).observations.verified).toBe(3);
    const now=new Date().toISOString();const persisted=await readProviderGraphEvidence(db,scope,now);
    const resolved=reconcileProviderGraph({scope,observations:persisted.observations,associations:persisted.associations});
    expect((await recordProviderGraphResolution(db,scope,resolved.resolved,persisted,now)).verified).toBe(2);
    expect(await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone)
      select ${assetProfileId},org_id,'3130000001',region,country_code,currency_code,timezone from public.ad_profiles
      where id=${state.fixtureProfileId} returning id`).toHaveLength(1);
    assetProfileCreated=true;
    await seedCreativeWorkspace({...state,fixtureProfileId:assetProfileId});
    const owner={orgId:state.orgId,profileId:assetProfileId};
    const assetScope={region:scope.region,amazonProfileId:'3130000001'};
    const assetGraphScope={...scope,profileId:assetProfileId,amazonProfileId:assetScope.amazonProfileId};
    const assetGraph={...graph,observations:graph.observations.map(row=>({...row,scope:assetGraphScope})),
      associations:graph.associations.map(row=>({...row,scope:assetGraphScope}))};
    expect((await appendProviderGraphEvidence(db,assetGraphScope,assetGraph)).observations.verified).toBe(3);
    const assetStored=await readProviderGraphEvidence(db,assetGraphScope,now);
    const assetResolved=reconcileProviderGraph({scope:assetGraphScope,observations:assetStored.observations,associations:assetStored.associations});
    expect((await recordProviderGraphResolution(db,assetGraphScope,assetResolved.resolved,assetStored,now)).verified).toBe(2);
    const assetIdentity={assetId:CREATIVE_ASSETS[0],version:'1'};
    const expiresAt=new Date(Date.parse(now)+86400000).toISOString();
    const asset=AssetLibraryObservation.parse({scope:assetScope,identity:assetIdentity,observedAt:now,assetType:'video',
      name:CREATIVE_NAMES[0],processing:'active',specChecks:{approvedPrograms:['SPONSORED_BRANDS_VIDEO'],failedSpecChecks:[]}});
    expect(await persistAssetLibraryEvidence(db,owner,[{observation:asset,expiresAt}])).toMatchObject({source:1,canonical:1,stored:1,verified:1});
    const moderation=AssetModerationObservation.parse({context:{scope:assetScope,marketplace:profile!.country_code,program:'SB_VIDEO'},
      subject:{kind:'creative',creativeId:'stream-creative',creativeVersion:'1'},assetIdentity,stage:'final',source:'moderation_v4',
      status:'approved',reasons:[],observedAt:now,contractVersion:'wp313.v1'});
    expect(await persistAssetModerationEvidence(db,owner,[{observation:{...moderation,status:'pending',observedAt:new Date(Date.parse(now)-1000).toISOString()},expiresAt},
      {observation:moderation,expiresAt}])).toMatchObject({source:2,canonical:2,stored:2,verified:2,unresolved:0});
    for(const [dataset,measure] of [['sb-clickstream',{clicks:0}],['sb-rich-media',{engagements:7}]] as const) {
      const fingerprint=createHash('sha256').update(dataset+state.orgId).digest('hex');
      const event=StreamExtensionEvent.parse({orgId:state.orgId,profileId:state.fixtureProfileId,identity:fingerprint,payloadFingerprint:fingerprint,receivedAt:now,
        record:{datasetId:dataset,contractVersion:'fixture.v1',subscriptionId:'synthetic-browser',advertiserId:'synthetic',marketplaceId:'synthetic',region:scope.region,
          destinationArn:'arn:aws:sqs:us-east-1:000000000000:synthetic',eventId:dataset,revision:1,eventTime:end,window:{start,end},
          observation:{campaignId:CREATIVE_CAMPAIGN_ID,creativeId:'stream-creative',...measure}}});
      expect((await retainStreamExtensionDelivery(db,{deliveryId:fingerprint,bodyFingerprint:fingerprint,receivedAt:now,decoded:1,event,reason:null})).counts.verifiedStored).toBe(1);
      expect((await projectStreamExtensionEvent(db,{orgId:state.orgId,profileId:state.fixtureProfileId,datasetId:dataset,eventIdentity:fingerprint})).verifiedLoadedRows).toBe(1);
    }
  await page.route('https://example.test/expired-creative-thumbnail.png', (route) => route.fulfill({ status: 403, body: 'Expired synthetic thumbnail' }));
  await signIn(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 1024 });
  const query = new URLSearchParams({ profile: state.fixtureProfileId, ...period });
  await page.goto(`/creative?${query}`);
  await expect(page.getByTestId('creative-screen')).toBeVisible();
  const dateWords = (value: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
  const windowWords = period.from === period.to ? dateWords(period.from) : `${dateWords(period.from)} – ${dateWords(period.to)}`;
  await expect(page.getByTestId('creative-screen')).toContainText(windowWords);
  await expect(page.getByTestId('stream-consumer-evidence')).toContainText('Clicks: 0');
  await expect(page.getByTestId('stream-consumer-evidence')).toContainText('Engagements: 7');
  await expect(page.getByTestId('stream-consumer-evidence')).toContainText('2 measured observations');
  await expect(page.getByRole('button', { name: /Open in-depth/ })).toBeDisabled();
  await expect(page.getByText('Destination not decided', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /View on Amazon/ })).toBeDisabled();
  await expect(page.getByText('No ASIN on this asset', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: `${CREATIVE_NAMES[0]}: Thumbnail expired or unavailable` }).first()).toBeVisible();
  const overflowingFallbacks = await page.getByRole('img', { name: `${CREATIVE_NAMES[0]}: Thumbnail expired or unavailable` }).evaluateAll((tiles) => tiles
    .filter((tile) => tile.scrollWidth > tile.clientWidth + 1 || tile.scrollHeight > tile.clientHeight + 1)
    .map((tile) => ({ text: tile.textContent, width: tile.clientWidth, height: tile.clientHeight })));
  expect(overflowingFallbacks, 'Expired thumbnail labels fit every tile').toEqual([]);
  const expiredScreenshot = testInfo.outputPath('creative-expired-thumbnail-persisted.png');
  await waitForCreativeShell(page);
  await page.screenshot({ path: expiredScreenshot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('Expired creative thumbnail', { path: expiredScreenshot, contentType: 'image/png' });
  await page.getByText('Sync evidence', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sync status →', exact: true })).toHaveAttribute('href', `/sync-status?profile=${state.fixtureProfileId}`);
  await page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[1]) }).click();
  await expect(page).toHaveURL(new RegExp(`asset=${CREATIVE_ASSETS[1]}`));
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[1]) })).toHaveAttribute('aria-pressed', 'true');
  const list = page.getByRole('complementary', { name: 'Creative list' });
  await list.getByLabel('Find creative').fill('no-matching-synthetic-cut');
  await expect(list.getByText('No creative rows match these filters.')).toBeVisible();
  await list.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[0]) })).toBeVisible();
  await list.getByRole('combobox', { name: /^Attribution/ }).selectOption('legacy');
  await expect(page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[0]) })).toHaveCount(0);
  await list.getByRole('combobox', { name: /^Attribution/ }).selectOption('all');
  await list.getByRole('combobox', { name: /^Campaign type/ }).selectOption('SB');
  await list.getByRole('combobox', { name: /^Sort by/ }).selectOption('spend_desc');
  await list.getByText('Attribution key', { exact: true }).click();
  await expect(list.getByText(/historical/i).first()).toBeVisible();
  await page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[0]) }).click();
  for (const tab of ['Keywords', 'Spend', 'Placements', 'Change history']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/creative/${CREATIVE_ASSETS[0]}\\?.*tab=${tab.toLowerCase().replace(' ', '-')}(?:&|$)`));
    expect(new URL(page.url()).searchParams.get('tab')).toBe(tab.toLowerCase().replace(' ', '-'));
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  const listingEvidence = page.getByRole('region', { name: 'Listing observations' });
  await expect(listingEvidence.getByTestId('sp-source-status')).toHaveAttribute('data-state', 'unavailable');
  await expect(listingEvidence).toContainText('No listing fields observed in this period');
  await expect(page.getByRole('heading', { name: 'Listing changes not measured', exact: true })).toBeVisible();
  await expect(page.getByText(/No changed adjacent Product Metadata observations/)).toBeVisible();
  await page.getByRole('link', { name: 'Compare creatives', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/creative/campaign/' + CREATIVE_CAMPAIGN_ID));
  await expect(page.getByText(/1 keyword.*2 ad groups.*2 creatives/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Creative test', exact: true })).toContainText(windowWords);
  await expect(page.getByRole('heading', { name: /floor.*not yet measured|not yet measured.*floor/i })).toBeVisible();
  await expect(page.getByTestId('stream-consumer-evidence')).toContainText('Engagements: 7');
  const measuredPath=testInfo.outputPath('creative-stream-measured.png');
  await page.screenshot({path:measuredPath,fullPage:true,animations:'disabled',style:'nextjs-portal { display: none; }'});
  await testInfo.attach('Measured Stream creative evidence',{path:measuredPath,contentType:'image/png'});
  const eligibilityQuery=new URLSearchParams(query);eligibilityQuery.set('profile',assetProfileId);
  await page.goto(`/creative/eligibility?${eligibilityQuery}`);
  const eligibility=page.getByRole('region',{name:'Asset eligibility and moderation'}).getByRole('table');
  await expect(eligibility.getByRole('row')).toHaveCount(3);
  const approvedRow=eligibility.getByRole('row').filter({hasText:CREATIVE_NAMES[0]});
  const unmeasuredRow=eligibility.getByRole('row').filter({hasText:CREATIVE_NAMES[1]});
  await expect(approvedRow).toContainText('approved');
  await expect(approvedRow).toContainText('Eligible in this context');
  await expect(unmeasuredRow).not.toContainText('Eligible in this context');
  await expect(page.getByText('1 of 2 assets have measured moderation',{exact:false})).toBeVisible();
  await expect(unmeasuredRow.getByRole('cell', { name: 'Not measured: Moderation ingestion has no source', exact: true })).toHaveText('—');
  const path = testInfo.outputPath('creative-eligibility-persisted.png');
  await waitForCreativeShell(page);
  await page.screenshot({ path, fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
  await testInfo.attach('Persisted creative eligibility', { path, contentType: 'image/png' });
  await page.goto(`/sync-status?profile=${state.fixtureProfileId}`);
  await expect(page.getByTestId('stream-extension-row')).toHaveCount(8);
  const streamPath = testInfo.outputPath('stream-bindings-freshness.png');
  await page.screenshot({ path: streamPath, fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
  await testInfo.attach('Stream binding freshness', { path: streamPath, contentType: 'image/png' });
  } finally {
    try {
      if(assetProfileCreated) expect(await db.sql`delete from public.ad_profiles where id=${assetProfileId} returning id`).toHaveLength(1);
    } finally { await db.close(); }
  }
});

test('creative screens capture every declared visual state in the operator shell', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { fixtureProfileId } = await readState();
  await signIn(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(`/creative?${new URLSearchParams({ profile: fixtureProfileId })}`);
  await expect(page.getByTestId('creative-screen')).toBeVisible();
  const markup = JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', 'e2e/support/render-creative-states.ts', 'creative'],
    { encoding: 'utf8' })) as Record<string, string>;
  const paths = await captureCreativeStates(page, testInfo, 'creative', markup, '[data-testid="creative-screen"]');
  expect(paths).toHaveLength(Object.keys(markup).length);
});

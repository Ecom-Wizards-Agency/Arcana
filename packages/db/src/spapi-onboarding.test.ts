import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { fileURLToPath } from 'node:url';
import { asActor, asUser } from './testing/rls.js';
import { createSpApiConnection, createSpApiConnectionLifecycle, getSpApiRefreshToken, listSqpScheduleScopes,
  revokeSpApiRefreshToken, storeSpApiRefreshToken, SpApiConnectionCommandError } from './queries/spapi.js';
import type { DbHandle, QuerySql } from './client.js';
import { settleSpApiConnection } from './queries/spapi.js';

const available = await databaseAvailable();
const refresh = ['synthetic', 'onboarding', 'refresh'].join('-');
const rotationValue = ['synthetic', 'rotation'].join('-');
const rotatedValue = ['synthetic', 'rotated'].join('-');
describe.skipIf(!available)('SP onboarding transaction and authority', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase('spapi_onboarding'); }, 60_000);
  afterAll(async () => { await db?.drop(); });
  async function fixture(count = 2) {
    const userId = randomUUID();
    await db.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name) values (${randomUUID()},'Synthetic seller agency') returning id`;
    const actor = { orgId: org!.id,userId };
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${userId},'owner')`;
    const seller = 'synthetic-seller'; const bindings = [];
    for (let i = 0; i < count; i++) {
      const [p] = await db.sql<{ id: string }[]>`insert into public.ad_profiles
        (org_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,amazon_account_id)
        values (${actor.orgId},${randomUUID()},'NA','US','USD','UTC','seller',${seller}) returning id`;
      bindings.push({ profileId: p!.id, marketplaceId: 'ATVPDKIKX0DER' });
    }
    const input = { requestId: randomUUID(),nonceHash: 'b'.repeat(64),clientId: 'synthetic-client',applicationId: 'synthetic-application',
      redirectUri: 'https://example.test/callback',region: 'NA' as const,label: 'Synthetic seller',bindings };
    const lifecycle = createSpApiConnectionLifecycle(db,() => true);
    return { actor,input,lifecycle,seller };
  }
  async function claimed(input?: Awaited<ReturnType<typeof fixture>>) {
    const f = input ?? await fixture();
    const operation = await f.lifecycle.begin(f.actor,f.input);
    const submission = { operationId: operation.operationId,nonceHash: f.input.nonceHash,code: 'synthetic-consent-' + randomUUID(),sellingPartnerId: f.seller };
    await f.lifecycle.submit(f.actor,submission);
    const claim = await f.lifecycle.custody.claim(randomUUID());
    expect(claim?.operation.operationId).toBe(operation.operationId);
    return { ...f,operation,submission,claim: claim! };
  }
  async function assertNoAttachment(orgId: string) {
    expect(await db.sql`select id from public.spapi_connections where org_id=${orgId}`).toHaveLength(0);
    expect(await db.sql`select id from public.spapi_profile_bindings where org_id=${orgId}`).toHaveLength(0);
    expect(await db.sql`select id from public.ad_profiles where org_id=${orgId} and sync_enabled`).toHaveLength(0);
  }
  it('attaches one connection and exactly two disabled bindings, with no replay effects', async () => {
    const f = await claimed();
    const completed = await f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,refresh);
    expect(completed).toMatchObject({ state: 'completed',requestedBindings: 2,attachedBindings: 2 });
    expect(await f.lifecycle.submit(f.actor,f.submission)).toEqual(completed);
    expect(await f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,'must-not-rotate')).toEqual(completed);
    expect(await f.lifecycle.custody.claim(randomUUID())).toBeNull();
    expect(await db.sql`select id from public.spapi_connections where org_id=${f.actor.orgId}`).toHaveLength(1);
    expect(await db.sql`select enabled from public.spapi_profile_bindings where org_id=${f.actor.orgId}`).toEqual([{ enabled: false },{ enabled: false }]);
    expect(await db.sql`select id from public.ad_profiles where org_id=${f.actor.orgId} and sync_enabled`).toHaveLength(0);
    expect(await getSpApiRefreshToken(db,{ orgId: f.actor.orgId,connectionId: completed.connectionId! })).toBe(refresh);
    const [c] = await db.sql<{ vault_secret_id: string }[]>`select vault_secret_id from public.spapi_connections where id=${completed.connectionId!}`;
    const audit = await db.sql`select payload from public.audit_log where org_id=${f.actor.orgId}`;
    for (const value of [refresh,f.submission.code,c!.vault_secret_id]) expect(JSON.stringify({ completed,audit })).not.toContain(value);
  });
  it('rejects cross-tenant, same-region wrong-country, unknown seller and mismatched callback identity before custody', async () => {
    let denied = 0;
    const f = await fixture(1); const foreign = await fixture(1);
    for (const bindings of [foreign.input.bindings,[{ ...f.input.bindings[0]!,marketplaceId: 'A2EUQ1WTGCTBG2' }]]) {
      await expect(f.lifecycle.begin(f.actor,{ ...f.input,bindings })).rejects.toThrow(); denied++;
    }
    await db.sql`update public.ad_profiles set amazon_account_id=null where id=${f.input.bindings[0]!.profileId}`;
    await expect(f.lifecycle.begin(f.actor,f.input)).rejects.toThrow(); denied++;
    await db.sql`update public.ad_profiles set amazon_account_id=${f.seller} where id=${f.input.bindings[0]!.profileId}`;
    const operation = await f.lifecycle.begin(f.actor,f.input);
    await expect(f.lifecycle.submit(f.actor,{ operationId: operation.operationId,nonceHash: f.input.nonceHash,code: 'synthetic-code',sellingPartnerId: 'other-seller' })).rejects.toBeInstanceOf(SpApiConnectionCommandError); denied++;
    expect(denied).toBe(4);
    expect(await db.sql`select code_secret_id from app.spapi_connection_operations where id=${operation.operationId}`).toEqual([{ code_secret_id: null }]);
    await assertNoAttachment(f.actor.orgId); await f.lifecycle.cancel(f.actor,operation.operationId);
  });
  it.each(['viewer','analyst'] as const)('denies %s mutations while allowing same-org operation reads', async (role) => {
    const f = await fixture(1); const operation = await f.lifecycle.begin(f.actor,f.input);
    await db.sql`update public.org_members set role=${role} where org_id=${f.actor.orgId} and user_id=${f.actor.userId}`;
    expect(await f.lifecycle.operation(f.actor,operation.operationId)).not.toBeNull();
    await expect(f.lifecycle.cancel(f.actor,operation.operationId)).rejects.toThrow();
    await expect(f.lifecycle.submit(f.actor,{ operationId: operation.operationId,nonceHash: f.input.nonceHash,code: 'synthetic-code',sellingPartnerId: f.seller })).rejects.toThrow();
    expect(await f.lifecycle.custody.read(operation.operationId)).toMatchObject({ state: 'reconnect_required',reason: 'authority_changed' });
    await assertNoAttachment(f.actor.orgId);
  });
  it.each(['membership-readded','expired','lease-replaced','cancelled'] as const)('refuses attachment after %s', async (race) => {
    const f = await claimed();
    if (race === 'membership-readded') {
      await db.sql`delete from public.org_members where org_id=${f.actor.orgId} and user_id=${f.actor.userId}`;
      await db.sql`insert into public.org_members(org_id,user_id,role,created_at) values (${f.actor.orgId},${f.actor.userId},'owner',clock_timestamp()+interval '1 second')`;
    } else if (race === 'expired') await db.sql`update app.spapi_connection_operations set expires_at=clock_timestamp()-interval '1 second' where id=${f.operation.operationId}`;
    else if (race === 'lease-replaced') await db.sql`update app.spapi_connection_operations set lease_id=${randomUUID()} where id=${f.operation.operationId}`;
    else await f.lifecycle.cancel(f.actor,f.operation.operationId);
    if (race === 'lease-replaced') await expect(f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,refresh)).rejects.toBeInstanceOf(SpApiConnectionCommandError);
    else expect((await f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,refresh)).state).not.toBe('completed');
    await assertNoAttachment(f.actor.orgId);
    expect(await f.lifecycle.custody.claim(randomUUID())).toBeNull();
    if (race === 'lease-replaced') await f.lifecycle.cancel(f.actor,f.operation.operationId);
  });
  it('rolls back connection and first binding when the second binding fails', async () => {
    const f = await claimed(); let writes = 0;
    const handle = { sql: { begin: (run: (sql: QuerySql) => Promise<unknown>) => db.sql.begin(async (sql) => {
      const proxy = new Proxy(sql, { apply(target,thisArg,args: [TemplateStringsArray,...unknown[]]) {
        if (args[0].join('').includes('insert into public.spapi_profile_bindings') && ++writes === 2) {
          throw Object.assign(new Error(f.submission.code), { parameters: [refresh] });
        }
        return Reflect.apply(target,thisArg,args);
      } });
      return run(proxy);
    }) } } as unknown as Pick<DbHandle,'sql'>;
    const error = await createSpApiConnectionLifecycle(handle,() => true).custody.attach(f.operation.operationId,f.claim.leaseId,refresh).catch((value: unknown) => value);
    expect(writes).toBe(2); expect(error).toBeInstanceOf(SpApiConnectionCommandError);
    for (const value of [refresh,f.submission.code]) expect(JSON.stringify(error) + String(error)).not.toContain(value);
    await assertNoAttachment(f.actor.orgId); await f.lifecycle.cancel(f.actor,f.operation.operationId);
  });
  it('keeps reconnect metadata stable and refuses direct revocation or rotation before attachment', async () => {
    const f = await claimed( await fixture(1) );
    const completed = await f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,refresh);
    const id = completed.connectionId!;
    await expect(createSpApiConnection(db,{ orgId: f.actor.orgId,label: f.input.label,sellingPartnerId: 'changed-seller',marketplaceIds: ['ATVPDKIKX0DER'] })).rejects.toThrow('conflicts');
    for (const action of ['revoke','rotate'] as const) {
      const reconnect = await f.lifecycle.begin(f.actor,{ ...f.input,requestId: randomUUID() });
      await f.lifecycle.submit(f.actor,{ ...f.submission,operationId: reconnect.operationId,code: 'synthetic-reconnect-' + action });
      const claim = (await f.lifecycle.custody.claim(randomUUID()))!;
      expect(await getSpApiRefreshToken(db,{ orgId: f.actor.orgId,connectionId: id })).toBe(action === 'revoke' ? refresh : null);
      if (action === 'revoke') await revokeSpApiRefreshToken(db,{ orgId: f.actor.orgId,connectionId: id });
      else await storeSpApiRefreshToken(db,{ orgId: f.actor.orgId,connectionId: id,refreshToken: rotationValue });
      await expect(f.lifecycle.custody.attach(reconnect.operationId,claim.leaseId,'must-not-attach')).rejects.toBeInstanceOf(SpApiConnectionCommandError);
      await f.lifecycle.cancel(f.actor,reconnect.operationId);
    }
    expect(await db.sql`select selling_partner_id from public.spapi_connections where id=${id}`).toEqual([{ selling_partner_id: f.seller }]);
  });
  it('refuses a reconnect subset and cannot reactivate an unselected reporting scope', async () => {
    const f = await claimed(); const completed = await f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,refresh);
    await db.sql`update public.spapi_profile_bindings set enabled=true where connection_id=${completed.connectionId!}`;
    await db.sql`update public.ad_profiles set sync_enabled=true where org_id=${f.actor.orgId}`;
    await f.lifecycle.revoke(f.actor,completed.connectionId!);
    await expect(f.lifecycle.begin(f.actor,{ ...f.input,requestId: randomUUID(),bindings: f.input.bindings.slice(0,1) })).rejects.toThrow('every existing');
    expect((await listSqpScheduleScopes(db)).filter((scope) => scope.orgId === f.actor.orgId)).toHaveLength(0);
    const reconnect = await f.lifecycle.begin(f.actor,{ ...f.input,requestId: randomUUID() });
    await f.lifecycle.submit(f.actor,{ ...f.submission,operationId: reconnect.operationId,code: 'synthetic-reconnect-all' });
    const claim = (await f.lifecycle.custody.claim(randomUUID()))!;
    expect(await f.lifecycle.custody.attach(reconnect.operationId,claim.leaseId,'synthetic-restored')).toMatchObject({ attachedBindings: 2 });
    expect(await db.sql`select enabled from public.spapi_profile_bindings where connection_id=${completed.connectionId!}`).toEqual([{ enabled: false },{ enabled: false }]);
    expect((await listSqpScheduleScopes(db)).filter((scope) => scope.orgId === f.actor.orgId)).toHaveLength(0);
  });
  it('records a reporting-disabled audit row on reconnect for each binding that had reporting on, and none otherwise', async () => {
    const f = await claimed(await fixture(3)); const completed = await f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,refresh);
    const connectionId = completed.connectionId!;
    const bindings = await db.sql<{ id: string; profile_id: string }[]>`select id::text,profile_id::text from public.spapi_profile_bindings
      where connection_id=${connectionId} order by profile_id`;
    expect(bindings).toHaveLength(3);
    const enabledIds = [bindings[0]!.id,bindings[2]!.id].sort();
    await db.sql`update public.spapi_profile_bindings set enabled=true where id in ${db.sql(enabledIds)}`;
    const disabledAudit = () => db.sql<{ actor_type: string; actor_id: string; target_type: string; target_id: string; source: string; payload: Record<string, unknown> }[]>`
      select actor_type::text,actor_id,target_type,target_id,source,payload from public.audit_log
       where org_id=${f.actor.orgId} and action='spapi.binding_reporting_disabled' order by target_id`;
    expect(await disabledAudit()).toHaveLength(0);
    await f.lifecycle.revoke(f.actor,connectionId);
    const reconnect = await f.lifecycle.begin(f.actor,{ ...f.input,requestId: randomUUID() });
    await f.lifecycle.submit(f.actor,{ ...f.submission,operationId: reconnect.operationId,code: 'synthetic-reconnect-audit' });
    const claim = (await f.lifecycle.custody.claim(randomUUID()))!;
    expect(await f.lifecycle.custody.attach(reconnect.operationId,claim.leaseId,'synthetic-restored')).toMatchObject({ state: 'completed',attachedBindings: 3 });
    expect(await db.sql`select enabled from public.spapi_profile_bindings where connection_id=${connectionId}`).toEqual([{ enabled: false },{ enabled: false },{ enabled: false }]);
    const audit = await disabledAudit();
    expect(audit).toHaveLength(2);
    expect(audit.map((row) => row.target_id)).toEqual(enabledIds);
    for (const row of audit) {
      expect(row).toMatchObject({ actor_type: 'service',actor_id: 'connection-worker',target_type: 'spapi_profile_binding',source: 'worker' });
      expect(row.payload).toEqual({ connectionId,marketplaceId: 'ATVPDKIKX0DER',enabled: false,reason: 'reconnect',operationId: reconnect.operationId });
    }
    // A second reconnect, with every binding already off, writes nothing more.
    await f.lifecycle.revoke(f.actor,connectionId);
    const again = await f.lifecycle.begin(f.actor,{ ...f.input,requestId: randomUUID() });
    await f.lifecycle.submit(f.actor,{ ...f.submission,operationId: again.operationId,code: 'synthetic-reconnect-audit-again' });
    const next = (await f.lifecycle.custody.claim(randomUUID()))!;
    expect(await f.lifecycle.custody.attach(again.operationId,next.leaseId,'synthetic-restored-again')).toMatchObject({ state: 'completed',attachedBindings: 3 });
    expect(await disabledAudit()).toHaveLength(2);
  });
  it('rolls back the reconnect audit rows with the attachment when the attachment fails', async () => {
    const f = await claimed(await fixture(1)); const completed = await f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,refresh);
    const connectionId = completed.connectionId!;
    await db.sql`update public.spapi_profile_bindings set enabled=true where connection_id=${connectionId}`;
    const reconnect = await f.lifecycle.begin(f.actor,{ ...f.input,requestId: randomUUID() });
    await f.lifecycle.submit(f.actor,{ ...f.submission,operationId: reconnect.operationId,code: 'synthetic-reconnect-refused' });
    const claim = (await f.lifecycle.custody.claim(randomUUID()))!;
    // Finish fails after the binding and audit writes; they roll back with it.
    let finishCalls = 0;
    const failFinish = (tx: QuerySql): QuerySql => Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
      if (parts.join('').includes('finish_spapi_attachment')) { finishCalls += 1; return Promise.reject(new Error('synthetic finish failure')); }
      return (tx as unknown as (parts: TemplateStringsArray, ...values: unknown[]) => unknown)(parts,...values);
    },tx) as unknown as QuerySql;
    const failing = { sql: { begin: (run: (sql: QuerySql) => Promise<unknown>) => db.sql.begin((tx) => run(failFinish(tx as unknown as QuerySql))) } } as unknown as Pick<DbHandle, 'sql'>;
    await expect(settleSpApiConnection(failing,reconnect.operationId,claim.leaseId,{ refresh: 'must-not-attach' })).rejects.toBeInstanceOf(SpApiConnectionCommandError);
    expect(finishCalls).toBe(1);
    expect(await f.lifecycle.custody.read(reconnect.operationId)).toMatchObject({ state: 'exchanging' });
    expect(await db.sql`select enabled from public.spapi_profile_bindings where connection_id=${connectionId}`).toEqual([{ enabled: true }]);
    expect(await db.sql`select id from public.audit_log where org_id=${f.actor.orgId} and action='spapi.binding_reporting_disabled'`).toHaveLength(0);
    await f.lifecycle.cancel(f.actor,reconnect.operationId);
  });
  it('preserves a competing binding inserted after the authority snapshot', async () => {
    const f = await claimed(await fixture(1));
    const competing = await createSpApiConnection(db,{ orgId: f.actor.orgId,label: 'Competing',sellingPartnerId: f.seller,marketplaceIds: ['ATVPDKIKX0DER'] });
    let inserted = 0;
    const handle = { sql: { begin: (run: (sql: QuerySql) => Promise<unknown>) => db.sql.begin(async (sql) => {
      const proxy = new Proxy(sql,{ apply(target,thisArg,args: [TemplateStringsArray,...unknown[]]) {
        if (args[0].join('').includes('insert into public.spapi_profile_bindings') && inserted++ === 0) {
          return db.sql`insert into public.spapi_profile_bindings(org_id,profile_id,connection_id,marketplace_id,enabled)
            values (${f.actor.orgId},${f.input.bindings[0]!.profileId},${competing.id},'ATVPDKIKX0DER',false)`
            .then(() => Reflect.apply(target,thisArg,args));
        }
        return Reflect.apply(target,thisArg,args);
      } });
      return run(proxy);
    }) } } as unknown as Pick<DbHandle,'sql'>;
    await expect(createSpApiConnectionLifecycle(handle,() => true).custody.attach(f.operation.operationId,f.claim.leaseId,refresh)).rejects.toBeInstanceOf(SpApiConnectionCommandError);
    expect(inserted).toBe(1);
    expect(await db.sql`select connection_id from public.spapi_profile_bindings where org_id=${f.actor.orgId}`).toEqual([{ connection_id: competing.id }]);
    expect(await db.sql`select id from public.spapi_connections where org_id=${f.actor.orgId} and label=${f.input.label}`).toHaveLength(0);
    await f.lifecycle.cancel(f.actor,f.operation.operationId);
  });
  it('denies authenticated and anonymous Vault access and preserves service rotation/revoke', async () => {
    const f = await claimed(); const completed = await f.lifecycle.custody.attach(f.operation.operationId,f.claim.leaseId,refresh);
    let refused = 0;
    for (const role of ['authenticated','anon'] as const) {
      for (const operation of ['read','store','revoke'] as const) {
        await asActor(db,{ ...(role === 'authenticated' ? { userId: f.actor.userId } : {}),role },async (sql) => {
          const query = operation === 'read' ? sql`select public.get_spapi_refresh_token(${completed.connectionId!})`
            : operation === 'store' ? sql`select public.store_spapi_refresh_token(${completed.connectionId!},${refresh})`
              : sql`select public.revoke_spapi_refresh_token(${completed.connectionId!})`;
          await expect(query).rejects.toMatchObject({ code: '42501' }); refused++;
        });
      }
    }
    expect(refused).toBe(6);
    await asUser(db,f.actor.userId,async (sql) => {
      await expect(sql`select app.finish_spapi_attachment(${f.operation.operationId},${f.claim.leaseId},${completed.connectionId!},${refresh})`).rejects.toMatchObject({ code: '42501' });
    });
    await storeSpApiRefreshToken(db,{ orgId: f.actor.orgId,connectionId: completed.connectionId!,refreshToken: rotatedValue });
    expect(await getSpApiRefreshToken(db,{ orgId: f.actor.orgId,connectionId: completed.connectionId! })).toBe(rotatedValue);
    await f.lifecycle.revoke(f.actor,completed.connectionId!);
    expect(await getSpApiRefreshToken(db,{ orgId: f.actor.orgId,connectionId: completed.connectionId! })).toBeNull();
  });
  it.each(['mismatch','expired','reused','wrong_actor','operation_not_pending','authority_changed'] as const)('returns sanitized %s from the locked submission boundary', async (reason) => {
    const f = await fixture(1);
    const operation = await f.lifecycle.begin(f.actor, f.input);
    const submission = { operationId: operation.operationId, nonceHash: f.input.nonceHash, code: 'synthetic-reason-code', sellingPartnerId: f.seller };
    let actor = f.actor;
    if (reason === 'mismatch') submission.nonceHash = 'c'.repeat(64);
    if (reason === 'expired') await db.sql`update app.spapi_connection_operations set expires_at=clock_timestamp()-interval '1 second' where id=${operation.operationId}`;
    if (reason === 'operation_not_pending') await f.lifecycle.cancel(f.actor, operation.operationId);
    if (reason === 'reused') {
      await f.lifecycle.submit(f.actor, submission);
      submission.code += '-changed';
    }
    if (reason === 'wrong_actor') {
      const userId = randomUUID();
      await db.sql`insert into auth.users(id) values (${userId})`;
      await db.sql`insert into public.org_members(org_id,user_id,role) values (${f.actor.orgId},${userId},'admin')`;
      actor = { ...f.actor, userId };
    }
    if (reason === 'authority_changed') {
      await db.sql`delete from public.org_members where org_id=${f.actor.orgId} and user_id=${f.actor.userId}`;
      await db.sql`insert into public.org_members(org_id,user_id,role,created_at) values (${f.actor.orgId},${f.actor.userId},'owner',clock_timestamp()+interval '1 second')`;
    }
    const error = await f.lifecycle.submit(actor, submission).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SpApiConnectionCommandError);
    expect(error).toMatchObject({ reason });
    expect(JSON.stringify(error) + String(error)).not.toContain(submission.code);
    expect(await db.sql`select id from public.audit_log where org_id=${f.actor.orgId} and action='spapi.consent_submitted'`).toHaveLength(reason === 'reused' ? 1 : 0);
    expect(await db.sql`select id from vault.secrets where name=${'openspell:spapi-consent:' + operation.operationId}`).toHaveLength(reason === 'reused' ? 1 : 0);
    await f.lifecycle.cancel(f.actor, operation.operationId);
  });
  it('upgrades existing custody and binding states without enabling a source', async () => {
    const old = await createTestDatabase('spapi_upgrade', { throughMigration: '20260915260000_ad_group_product_assignments.sql',applyFixture: false });
    try {
      const userId = randomUUID(); const orgId = randomUUID(); const connectionId = randomUUID();
      await old.sql`insert into auth.users(id) values (${userId})`;
      await old.sql`insert into public.orgs(id,slug,name) values (${orgId},${randomUUID()},'Synthetic upgrade seller')`;
      await old.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${userId},'owner')`;
      await old.sql`insert into public.spapi_connections(id,org_id,label,selling_partner_id,marketplace_ids)
        values (${connectionId},${orgId},'Existing','synthetic-seller',array['ATVPDKIKX0DER'])`;
      await storeSpApiRefreshToken(old,{ orgId,connectionId,refreshToken: refresh });
      for (const enabled of [false,true]) {
        const [p] = await old.sql<{ id: string }[]>`insert into public.ad_profiles
          (org_id,amazon_profile_id,region,country_code,currency_code,timezone)
          values (${orgId},${randomUUID()},'NA','US','USD','UTC') returning id`;
        await old.sql`insert into public.spapi_profile_bindings(org_id,profile_id,connection_id,marketplace_id,enabled)
          values (${orgId},${p!.id},${connectionId},'ATVPDKIKX0DER',${enabled})`;
      }
      const before = await old.sql`select id,enabled from public.spapi_profile_bindings where org_id=${orgId} order by id`;
      const installation = { clientId: 'synthetic-client',redirectUri: 'https://example.test/callback',label: 'Existing',
        sellingPartnerId: 'synthetic-seller',marketplaceIds: ['ATVPDKIKX0DER'] };
      const operation = await asUser(old,userId,async (sql) => {
        const [row] = await sql<{ result: { operationId: string } }[]>`select app.begin_spapi_connection(${orgId},${randomUUID()},${'a'.repeat(64)},${JSON.stringify(installation)}::jsonb) as result`;
        await sql`select app.submit_spapi_connection(${orgId},${row!.result.operationId},${'a'.repeat(64)},'synthetic-legacy-consent')`;
        return row!.result.operationId;
      });
      await applySqlFile(old,fileURLToPath(new URL('../../../supabase/migrations/20260915310000_spapi_onboarding.sql',import.meta.url)));
      expect(await old.sql`select id,enabled from public.spapi_profile_bindings where org_id=${orgId} order by id`).toEqual(before);
      expect(await getSpApiRefreshToken(old,{ orgId,connectionId })).toBe(refresh);
      expect(await old.sql`select state,reason,code_secret_id from app.spapi_connection_operations where id=${operation}`)
        .toEqual([{ state: 'reconnect_required',reason: 'not_configured',code_secret_id: null }]);
      expect(await old.sql`select id from vault.secrets where name=${'openspell:spapi-consent:' + operation}`).toHaveLength(0);
      expect(await old.sql`select column_default from information_schema.columns where table_schema='public' and table_name='spapi_profile_bindings' and column_name='enabled'`)
        .toEqual([{ column_default: 'false' }]);
      expect(await old.sql`select id from public.sync_schedules where org_id=${orgId}`).toHaveLength(0);
      expect(await old.sql`select id from public.ad_profiles where org_id=${orgId} and sync_enabled`).toHaveLength(0);
    } finally { await old.drop(); }
  // This test includes a complete historical database build and teardown.
  // Use the same bounded allowance as this suite's migration fixture setup.
  }, 60_000);
});

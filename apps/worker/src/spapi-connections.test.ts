import { describe, expect, it, vi } from 'vitest';
import { NotConfigured, type SpApiConnectionClaim, type SpApiConnectionOperation } from '@wizard-ads/shared';
import type { DbHandle } from '@wizard-ads/db';
import { exchangeSpApiAuthorizationCode, runSpApiConnectionPass, spApiConnectionPass, type SpApiConnectionSettings } from './spapi-connections.js';
import { SpApiCodeExchangeError } from '@wizard-ads/sp-api';
import { ProviderConnectionLoop } from './provider-connection-loop.js';

const leaseId = '33333333-3333-4333-8333-333333333333';
const installation = { clientId: 'synthetic-client', redirectUri: 'https://example.test/callback',
  label: 'Synthetic connection', applicationId: 'synthetic-application', region: 'NA' as const,
  bindings: [{ profileId: '55555555-5555-4555-8555-555555555555', marketplaceId: 'ATVPDKIKX0DER' }] };
function fixture() {
  let consumed = false;
  let operation: SpApiConnectionOperation = { operationId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222', connectionId: null, state: 'queued', reason: null,
    requestedBindings: 1, attachedBindings: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const command = parts.join('?');
    if (command.startsWith('set local')) return [];
    if (command.includes('claim_spapi_connection')) {
      if (consumed) return [{ result: null }];
      consumed = true; operation = { ...operation, state: 'exchanging' };
      const result: SpApiConnectionClaim = { operation, leaseId, installation, sellingPartnerId: 'synthetic-seller', code: 'synthetic-consent' };
      return [{ result }];
    }
    if (command.includes('settle_spapi_connection')) {
      const reason = values[3] as SpApiConnectionOperation['reason'];
      operation = { ...operation, state: reason === null ? 'completed' : 'reconnect_required', reason,
        connectionId: reason === null ? '44444444-4444-4444-8444-444444444444' : null };
      return [{ result: operation }];
    }
    if (command.includes('read_spapi_connection_worker')) return [{ result: operation }];
    if (command.includes('prepare_spapi_attachment')) return [{ result: operation.state !== 'exchanging' ? null : {
      operation, installation, sellingPartnerId: 'synthetic-seller', targetConnectionId: '44444444-4444-4444-8444-444444444444',
    } }];
    if (command.includes('insert into public.spapi_connections')) return [{ id: '44444444-4444-4444-8444-444444444444',
      org_id: operation.orgId,label: installation.label,selling_partner_id: 'synthetic-seller',marketplace_ids: ['ATVPDKIKX0DER'],
      status: 'pending',has_credential: false }];
    if (command.includes('insert into public.spapi_profile_bindings')) return [{ org_id: operation.orgId,
      profile_id: installation.bindings[0]!.profileId,connection_id: '44444444-4444-4444-8444-444444444444',
      marketplace_id: 'ATVPDKIKX0DER',enabled: false,region: 'NA',timezone: 'UTC' }];
    if (command.includes('finish_spapi_attachment')) {
      operation = { ...operation,state: 'completed',connectionId: '44444444-4444-4444-8444-444444444444',attachedBindings: 1 };
      return [{ result: operation }];
    }
    throw new Error('Unexpected synthetic command');
  });
  const transactional = Object.assign(sql, { begin: async (run: (query: typeof sql) => Promise<unknown>) => run(sql) });
  return { handle: { sql: transactional } as unknown as Pick<DbHandle, 'sql'>, sql, operation: () => operation };
}

describe('SP-API provider connection implementation', () => {
  it('fails closed when worker credentials are absent', async () => {
    await expect(exchangeSpApiAuthorizationCode(installation,'synthetic',new AbortController().signal)).rejects.toBeInstanceOf(NotConfigured);
    const f = fixture();
    const result = await runSpApiConnectionPass({ handle: f.handle, enabled: () => true, accepts: () => true },new AbortController().signal,leaseId);
    expect(result).toMatchObject({ outcome: 'observed', operation: { state: 'reconnect_required', reason: 'not_configured' } });
    expect(f.sql).toHaveBeenCalledTimes(6);
    expect(f.sql.mock.calls.filter(([parts]) => parts.join('').includes("lock_timeout = '3s'"))).toHaveLength(2);
  });
  it('runs through attachment with an injected exchange and never repeats consumed consent', async () => {
    const f = fixture(); const exchange = vi.fn(async () => 'synthetic-grant');
    const options = { handle: f.handle, enabled: () => true, accepts: () => true, exchange };
    expect(await runSpApiConnectionPass(options,new AbortController().signal,leaseId)).toMatchObject({ outcome: 'observed',operation: { state: 'completed' } });
    expect(await runSpApiConnectionPass(options,new AbortController().signal,leaseId)).toEqual({ outcome: 'idle',operation: null });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.operation())).not.toContain('synthetic-grant');
  });
  it('does not claim with a closed gate and sanitizes an uncertain exchange', async () => {
    const f = fixture(); const exchange = vi.fn(async () => { throw new Error('sensitive-provider-response'); });
    const options = { handle: f.handle, enabled: () => false, accepts: () => true, exchange };
    expect(await runSpApiConnectionPass(options,new AbortController().signal)).toEqual({ outcome: 'idle',operation: null });
    expect(f.sql).not.toHaveBeenCalled();
    const result = await runSpApiConnectionPass({ ...options, enabled: () => true },new AbortController().signal);
    expect(result).toMatchObject({ operation: { state: 'reconnect_required', reason: 'exchange_uncertain' } });
    expect(JSON.stringify(result)).not.toContain('sensitive-provider-response');
  });
  it('records a definitive refusal once', async () => {
    const f = fixture(); const exchange = vi.fn(async () => { throw new SpApiCodeExchangeError('exchange_refused'); });
    const options = { handle: f.handle,enabled: () => true,accepts: () => true,exchange };
    expect(await runSpApiConnectionPass(options,new AbortController().signal)).toMatchObject({ operation: { state: 'reconnect_required',reason: 'exchange_refused' } });
    await runSpApiConnectionPass(options,new AbortController().signal);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
  it('reconciles a lost successful attachment response without exchanging again', async () => {
    const f = fixture(); const original = f.sql.getMockImplementation()!;
    f.sql.mockImplementation(async (parts, ...values) => {
      const result = await original(parts,...values);
      if (parts.join('').includes('finish_spapi_attachment')) throw new Error('synthetic lost commit response');
      return result;
    });
    const exchange = vi.fn(async () => 'synthetic-grant');
    const options = { handle: f.handle,enabled: () => true,accepts: () => true,exchange };
    expect(await runSpApiConnectionPass(options,new AbortController().signal)).toMatchObject({ operation: { state: 'completed',attachedBindings: 1 } });
    expect(await runSpApiConnectionPass(options,new AbortController().signal)).toMatchObject({ outcome: 'idle' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });
  it('refuses a claimed deployment mismatch without exchange', async () => {
    const f = fixture(); const exchange = vi.fn(async () => 'synthetic-grant');
    expect(await runSpApiConnectionPass({ handle: f.handle, enabled: () => true, accepts: () => false, exchange },new AbortController().signal))
      .toMatchObject({ operation: { reason: 'not_configured' } });
    expect(exchange).not.toHaveBeenCalled();
  });
  it('waits for custody settlement when the loop stops during exchange', async () => {
    const f = fixture(); let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const exchange = vi.fn(async (_installation, _code, signal: AbortSignal): Promise<string> => {
      entered(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('synthetic interruption')), { once: true }); });
    });
    const loop = new ProviderConnectionLoop((signal) => runSpApiConnectionPass({ handle: f.handle,enabled: () => true, accepts: () => true,exchange },signal));
    loop.start(); await started; await loop.stop();
    expect(f.operation()).toMatchObject({ state: 'reconnect_required',reason: 'exchange_uncertain',attachedBindings: 0 });
    expect(loop.status()).toMatchObject({ inFlight: 0,stopping: true,running: false });
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

describe('SP-API connection pass wiring shared by the worker and the command', () => {
  const applicationKey = ['synthetic', 'application', 'key'].join('-');
  const settings: SpApiConnectionSettings = { spApiClientId: installation.clientId, spApiClientSecret: applicationKey,
    spApiApplicationId: installation.applicationId, spApiConsentRegion: installation.region,
    spApiConnectionRedirects: ['https://example.test/other', installation.redirectUri] };
  const gateOpen = (): NodeJS.ProcessEnv => ({ OPENSPELL_SPAPI_CONNECTIONS_ENABLED: '1' });
  const token = () => vi.fn(async (_input: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ refresh_token: 'synthetic-grant' }), { status: 200 }));

  it('exchanges with both deployment credentials when every installation field matches', async () => {
    const f = fixture(); const fetch = token();
    const result = await spApiConnectionPass(f.handle, settings, gateOpen(), fetch)(new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'observed', operation: { state: 'completed', attachedBindings: 1 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(fetch.mock.calls[0]![1]!.body));
    expect({ client: body.get('client_id'), secret: body.get('client_secret'), redirect: body.get('redirect_uri'), code: body.get('code') })
      .toEqual({ client: installation.clientId, secret: applicationKey, redirect: installation.redirectUri, code: 'synthetic-consent' });
  });

  it.each([
    ['client id', { spApiClientId: 'other-client' }],
    ['application id', { spApiApplicationId: 'other-application' }],
    ['region', { spApiConsentRegion: 'EU' as const }],
    ['redirect', { spApiConnectionRedirects: ['https://example.test/other'] }],
  ])('refuses an installation whose %s differs, without an exchange', async (_field, change) => {
    const f = fixture(); const fetch = token();
    const result = await spApiConnectionPass(f.handle, { ...settings, ...change }, gateOpen(), fetch)(new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'observed', operation: { state: 'reconnect_required', reason: 'not_configured' } });
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['secret', { spApiClientSecret: undefined }],
    ['client id', { spApiClientId: undefined }],
  ])('passes no credentials when the %s is absent', async (_field, change) => {
    const f = fixture(); const fetch = token();
    const result = await spApiConnectionPass(f.handle, { ...settings, ...change }, gateOpen(), fetch)(new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'observed', operation: { state: 'reconnect_required', reason: 'not_configured' } });
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it('reads the gate at pass time, not when the pass is built', async () => {
    const f = fixture(); const fetch = token(); const env: NodeJS.ProcessEnv = { OPENSPELL_SPAPI_CONNECTIONS_ENABLED: '0' };
    const pass = spApiConnectionPass(f.handle, settings, env, fetch);
    expect(await pass(new AbortController().signal)).toEqual({ outcome: 'idle', operation: null });
    expect(f.sql).toHaveBeenCalledTimes(0);
    env['OPENSPELL_SPAPI_CONNECTIONS_ENABLED'] = '1';
    expect(await pass(new AbortController().signal)).toMatchObject({ outcome: 'observed', operation: { state: 'completed' } });
    env['OPENSPELL_SPAPI_CONNECTIONS_ENABLED'] = '0';
    const calls = f.sql.mock.calls.length;
    expect(await pass(new AbortController().signal)).toEqual({ outcome: 'idle', operation: null });
    expect(f.sql).toHaveBeenCalledTimes(calls);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

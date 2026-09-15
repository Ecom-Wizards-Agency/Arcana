import { describe, expect, it, vi } from 'vitest';
import { NotConfigured, type SpApiConnectionClaim, type SpApiConnectionOperation } from '@wizard-ads/shared';
import type { DbHandle } from '@wizard-ads/db';
import { exchangeSpApiAuthorizationCode, runSpApiConnectionPass } from './spapi-connections.js';

const leaseId = '33333333-3333-4333-8333-333333333333';
const installation = { clientId: 'synthetic-client', redirectUri: 'https://example.test/callback',
  label: 'Synthetic connection', sellingPartnerId: 'synthetic-seller', marketplaceIds: ['synthetic-marketplace'] };
function fixture() {
  let consumed = false;
  let operation: SpApiConnectionOperation = { operationId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222', connectionId: null, state: 'queued', reason: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const command = parts.join('?');
    if (command.startsWith('set local')) return [];
    if (command.includes('claim_spapi_connection')) {
      if (consumed) return [{ result: null }];
      consumed = true; operation = { ...operation, state: 'exchanging' };
      const result: SpApiConnectionClaim = { operation, leaseId, installation, code: 'synthetic-consent' };
      return [{ result }];
    }
    if (command.includes('settle_spapi_connection')) {
      const reason = values[3] as SpApiConnectionOperation['reason'];
      operation = { ...operation, state: reason === null ? 'completed' : 'reconnect_required', reason,
        connectionId: reason === null ? '44444444-4444-4444-8444-444444444444' : null };
      return [{ result: operation }];
    }
    if (command.includes('read_spapi_connection_worker')) return [{ result: operation }];
    throw new Error('Unexpected synthetic command');
  });
  const transactional = Object.assign(sql, { begin: async (run: (query: typeof sql) => Promise<unknown>) => run(sql) });
  return { handle: { sql: transactional } as unknown as Pick<DbHandle, 'sql'>, sql, operation: () => operation };
}

describe('SP-API provider connection implementation', () => {
  it('leaves exactly the provider exchange unconfigured', async () => {
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
});

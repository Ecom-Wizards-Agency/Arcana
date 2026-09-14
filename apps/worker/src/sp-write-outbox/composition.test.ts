import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DbHandle } from '@wizard-ads/db';
import { PostgresWorkerStore } from '../store.js';
import { createKeywordMirrorCapability, createSpWriteWorker } from './composition.js';
import * as loops from './loop.js';
import * as providers from './providers.js';

const handles: DbHandle[] = [];

/** A lazy local client whose query entry points fail if construction performs I/O. */
function inertDatabase() {
  const original = createDb({ connectionString: 'postgres://postgres:postgres@127.0.0.1:55439/postgres' });
  handles.push(original);
  const access = vi.fn(() => { throw new Error('unexpected database access'); });
  const sql = new Proxy(original.sql, {
    apply: access,
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? new Proxy(value, { apply: access }) : value;
    },
  });
  return { database: { ...original, sql }, access };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe('SP write composition requires the configured entity-sync store', () => {
  it('refuses an unwired store before provider construction or any database access', () => {
    const { database, access } = inertDatabase();
    const prepare = vi.spyOn(providers, 'createSpWriteProviderPreparation');
    const loop = vi.spyOn(loops, 'createSpWriteOutboxLoop');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const policy = vi.fn(() => ({ dispatchEnabled: true, reconcileEnabled: true, profileIds: [] }));
    expect(() => createSpWriteWorker(new PostgresWorkerStore(database), { claimantId: 'synthetic-unwired', policy }, {}))
      .toThrow('requires keyword mirror configuration');
    expect(prepare).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a caller-shaped substitute for the actual Postgres store', () => {
    const { database, access } = inertDatabase();
    const prepare = vi.spyOn(providers, 'createSpWriteProviderPreparation');
    const substitute = {
      handle: database,
      beginEntityRead: vi.fn(),
      assertKeywordMirrorConfigured: vi.fn(),
    };
    expect(() => createSpWriteWorker(substitute as unknown as PostgresWorkerStore, {
      claimantId: 'synthetic-substitute',
      policy: () => ({ dispatchEnabled: true, reconcileEnabled: true, profileIds: [] }),
    }, {})).toThrow('requires its Postgres entity-sync store');
    expect(substitute.assertKeywordMirrorConfigured).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });

  it('uses the store database for provider and ledger composition without starting I/O', async () => {
    const { database, access } = inertDatabase();
    const credentialAccess = vi.fn(() => { throw new Error('unexpected credential access'); });
    const env = new Proxy({}, {
      get(target, property) {
        if (['LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_ID', 'LWA_CLIENT_SECRET', 'AMAZON_LWA_CLIENT_SECRET'].includes(String(property))) {
          return credentialAccess();
        }
        return Reflect.get(target, property);
      },
    });
    const prepare = vi.spyOn(providers, 'createSpWriteProviderPreparation');
    const loop = vi.spyOn(loops, 'createSpWriteOutboxLoop');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const policy = vi.fn(() => ({ dispatchEnabled: false, reconcileEnabled: false, profileIds: [] }));
    const store = new PostgresWorkerStore(database, undefined, { keywordMirror: createKeywordMirrorCapability(database) });
    const worker = createSpWriteWorker(store, { claimantId: 'synthetic-wired', policy }, env);

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toBe(store.handle);
    expect(prepare.mock.calls[0]![1]).toBe(env);
    expect(loop).toHaveBeenCalledOnce();
    expect(loop.mock.calls[0]![0].database).toBe(store.handle);
    expect(store.beginEntityRead).toBeTypeOf('function');
    expect(policy).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(credentialAccess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await worker.tick()).toEqual({ kind: 'disabled', attemptedCalls: 0 });
    expect(policy).toHaveBeenCalledOnce();
    expect(access).not.toHaveBeenCalled();
    expect(credentialAccess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    worker.stop();
  });
});

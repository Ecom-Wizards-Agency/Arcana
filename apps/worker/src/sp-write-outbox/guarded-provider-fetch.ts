import { AsyncLocalStorage } from 'node:async_hooks';
import type { AdsApiClientOptions, FetchLike } from '@wizard-ads/ads-api';
import { createSpWriteAdapter, type SpWriteAdapter, type SpWriteAdapterDependencies } from '@wizard-ads/ads-api/sp-write-adapter';
import { SpWriteObservedAction } from '@wizard-ads/shared/sp-writes';

const UNSUPPORTED_STATE = 'SP write observation refused: unsupported_entity_state';
type PostWriteRead = {
  routeKey: string;
  positions: ReadonlyArray<{ actionId: string; actionFingerprint: string; amazonEntityId: string }>;
  archived: Map<string, SpWriteObservedAction>;
};

/** Predispatch reads require mutable raw state before the codec selects bid/placement fields. */
export function guardSpWriteObservationFetch(fetchImpl: FetchLike): FetchLike {
  return guardedFetch(fetchImpl);
}

function guardedFetch(fetchImpl: FetchLike, postWrite?: AsyncLocalStorage<PostWriteRead>): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const path = new URL(input).pathname;
    const rowsKey = path === '/sp/campaigns/list' ? 'campaigns'
      : path === '/sp/targets/list' ? 'targetingClauses' : null;
    // Authentication and mutation responses retain their existing parsers.
    if (rowsKey === null || !response.ok) return response;
    let body: unknown;
    try { body = await response.clone().json(); }
    catch { throw new Error(UNSUPPORTED_STATE); }
    const source = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown> : null;
    const rows = source?.[rowsKey];
    const context = postWrite?.getStore();
    if (!Array.isArray(rows) || rows.some((row: unknown) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return true;
      const state = (row as Record<string, unknown>)['state'];
      return state !== 'ENABLED' && state !== 'PAUSED' && !(context && state === 'ARCHIVED');
    })) throw new Error(UNSUPPORTED_STATE);
    const archived = rows.filter((row: Record<string, unknown>) => row['state'] === 'ARCHIVED');
    if (archived.length > 0) {
      // Coordinated calls contain one step. An archived entity may omit its former bid or
      // bidding controls; retain its actual state only after this targeted read closes.
      const position = context?.positions[0];
      const idKey = rowsKey === 'campaigns' ? 'campaignId' : 'targetId';
      const routeKey = rowsKey === 'campaigns' ? 'sp.v3.campaigns.update' : 'sp.v3.targets.update';
      if (!context || response.status !== 200 || context.routeKey !== routeKey || context.positions.length !== 1
        || position === undefined || rows.length !== 1 || archived[0]![idKey] !== position.amazonEntityId
        || source!['nextToken'] !== undefined || (source!['totalResults'] !== undefined && source!['totalResults'] !== 1)
        || Object.keys(source!).some((key) => ![rowsKey, 'nextToken', 'totalResults'].includes(key))) {
        throw new Error(UNSUPPORTED_STATE);
      }
      context.archived.set(position.actionId, SpWriteObservedAction.parse({ routeKey,
        actionId: position.actionId, actionFingerprint: position.actionFingerprint,
        amazonEntityId: position.amazonEntityId, values: { state: 'archived' },
      }));
    }
    return response;
  };
}

/** Preserve archived presence for terminal post-write reconciliation without making it writable. */
export function createGuardedSpWriteAdapter(
  options: AdsApiClientOptions, dependencies: SpWriteAdapterDependencies,
): SpWriteAdapter {
  const postWrite = new AsyncLocalStorage<PostWriteRead>();
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const adapter = createSpWriteAdapter({ ...options, fetch: guardedFetch(fetch, postWrite) }, dependencies);
  return {
    preparePlan: (...args) => adapter.preparePlan(...args),
    observeCurrent: (...args) => adapter.observeCurrent(...args),
    executeOneAttempt: (...args) => adapter.executeOneAttempt(...args),
    observeAfterWrite: (input, observeOptions) => postWrite.run({ routeKey: input.call.routeKey,
      positions: input.call.positions, archived: new Map() }, async () => {
      const context = postWrite.getStore()!;
      try {
        const items = await adapter.observeAfterWrite(input, observeOptions);
        return items.map((item) => item === null || !context.archived.has(item.actionId) ? item
          : SpWriteObservedAction.parse({ ...item, values: { ...item.values, state: 'archived' } }));
      } catch (error) {
        // The regular codec can reject omitted former values. A fully closed archived
        // response above remains authoritative presence, never a fabricated missing row.
        if (input.call.positions.length === 1 && context.archived.size === 1) {
          return [context.archived.get(input.call.positions[0]!.actionId)!];
        }
        throw error;
      }
    }),
  };
}

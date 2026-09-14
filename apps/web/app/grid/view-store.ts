import { GridSavedView } from '@wizard-ads/shared';
import { DbViewStore, LocalViewStore, type KeyValueStorage } from '@wizard-ads/ui';
import type { OrgActor } from '@wizard-ads/shared';

async function response(request: Promise<Response>): Promise<Record<string, unknown>> {
  const result = await request;
  if (result.status === 503) throw new TypeError('Saved views are offline');
  if (!result.ok) throw new Error('Saved views could not be saved or loaded');
  return await result.json() as Record<string, unknown>;
}
export function browserViewStore(actor: OrgActor, profileId: string): DbViewStore {
  let storage: KeyValueStorage;
  try { storage = window.localStorage; }
  catch {
    const memory = new Map<string, string>();
    storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); } };
  }
  return new DbViewStore({
    async list(entity) {
      const result = await response(fetch(`/grid/views?${new URLSearchParams({ entity, profile: profileId })}`));
      if (!Array.isArray(result['views']) || result['count'] !== result['views'].length) throw new Error('View count mismatch');
      return result['views'].map((view) => GridSavedView.parse(view));
    },
    async save(views) {
      const result = await response(fetch('/grid/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: null, views }) }));
      if (result['count'] !== views.length) throw new Error('View count mismatch');
      return views.length;
    },
    async remove(id) {
      await response(fetch('/grid/views', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }));
    },
  }, new LocalViewStore(storage, actor));
}

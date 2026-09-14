import { LocalViewStore, type KeyValueStorage } from '@wizard-ads/ui';
import type { OrgActor } from '@wizard-ads/shared';
import { ChangeQueueSource, ChangeQueueState, parseGridView, serializeGridView, type GridSavedView } from '@wizard-ads/shared';

export function resolveQueueViewQuery(query: Record<string,string>): Record<string,string> {
  const state = parseGridView(query['view'])?.changeQueue;
  return state ? { ...state.filters, density: state.density, ...query } : query;
}

/** An explicit URL (including an invalid version) wins over browser storage. */
export function restoreQueueView(query: Record<string,string>, stored: string | null): Record<string,string> {
  if (['view','source','state','type','field','density'].some(key => key in query)) return resolveQueueViewQuery(query);
  return parseGridView(stored)?.changeQueue ? resolveQueueViewQuery({ ...query, view: stored! }) : query;
}

export function saveQueueView(query: Record<string,string>): string {
  const previous = parseGridView(query['view']);
  const density = query['density'];
  const source=ChangeQueueSource.safeParse(query['source']), state=ChangeQueueState.safeParse(query['state']);
  const view: GridSavedView = { id:'change-queue',name:'Change queue',entity:'targets',columns:[],pinned:[],widths:{},
    filter:{groups:[]},sort:[],groupBy:[],dateRange:null,updatedAt:previous?.updatedAt ?? '1970-01-01T00:00:00.000Z',...previous,
    changeQueue:{filters:{...(source.success?{source:source.data}:{}),...(state.success?{state:state.data}:{}),
      ...Object.fromEntries(['type','field'].flatMap(key => query[key] && query[key].length<=200 ? [[key,query[key]]] : []))},
      density: density==='compact'||density==='comfortable' ? density : 'normal' } };
  return serializeGridView(view);
}

/** WP-250 retains signer/agency isolation inside the Change queue namespace. */
export function queueViewStore(storage:KeyValueStorage,actor:OrgActor):LocalViewStore {
  return new LocalViewStore({getItem:key=>storage.getItem(`changeQueue:${key}`),setItem:(key,value)=>storage.setItem(`changeQueue:${key}`,value)},actor);
}

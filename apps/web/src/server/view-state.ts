import { parseGridView, serializeGridView } from '@wizard-ads/shared';
import type { JsonValue } from '@wizard-ads/db';

/** Goto's existing state envelope may carry the same versioned URL value. */
export function restoreGotoView(location: string, state: JsonValue): string {
  const url = new URL(location, 'https://arcana.invalid');
  if (state !== null && typeof state === 'object' && !Array.isArray(state)) {
    const view = typeof state['view'] === 'string' ? parseGridView(state['view']) : null;
    if (view !== null) url.searchParams.set('view', serializeGridView(view));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function gridBackLocation(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/grid?') || /[\\\r\n]/.test(value)) return '/grid';
  const url = new URL(value, 'https://arcana.invalid');
  return url.pathname === '/grid' ? `${url.pathname}${url.search}` : '/grid';
}

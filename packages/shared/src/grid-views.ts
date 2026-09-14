import { z } from 'zod';

const strings = z.array(z.string()).readonly();
export const GridEntity = z.enum(['campaigns', 'ad_groups', 'targets', 'search_terms', 'placements']);
export const GridSavedView = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  entity: GridEntity,
  columns: strings,
  pinned: strings,
  widths: z.record(z.string(), z.number().finite()).readonly(),
  density: z.enum(['compact', 'normal', 'comfortable']).optional(),
  filter: z.object({ groups: z.array(z.object({ filters: z.array(z.object({
    key: z.string(),
    logical_operator: z.enum(['AND', 'OR']).optional(),
    conditions: z.array(z.object({
      operator: z.enum(['>', '<', '>=', '<=', '=', '<>', 'IN', 'NOT_IN', 'LIKE', 'NOT_LIKE', 'IS_NULL', 'IS_NOT_NULL']).optional(),
      values: strings,
    }).strict()).readonly(),
  }).strict()).readonly() }).strict()).readonly() }).strict(),
  sort: z.array(z.object({ columnId: z.string(), direction: z.enum(['asc', 'desc']) }).strict()).readonly(),
  groupBy: strings,
  collapsedGroupIds: strings.optional(),
  dateRange: z.object({ start: z.string(), end: z.string() }).strict().nullable(),
  updatedAt: z.string(),
}).strict();
export type GridSavedView = z.infer<typeof GridSavedView>;

/** Version prefix plus UTF-8 base64url; independent of Node and safe in browsers. */
export function serializeGridView(view: GridSavedView): string {
  const bytes = new TextEncoder().encode(JSON.stringify(GridSavedView.parse(view)));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return `1.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export function parseGridView(value: string | null | undefined): GridSavedView | null {
  if (!value || value.length > 64_000 || !/^1\.[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.slice(2).replaceAll('-', '+').replaceAll('_', '/'));
    const parsed = GridSavedView.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    )));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export const GridViewRecord = z.object({
  orgId: z.uuid(),
  profileId: z.uuid().nullable(),
  ownerId: z.uuid(),
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  view: GridSavedView,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type GridViewRecord = z.infer<typeof GridViewRecord>;

export const GridViewSave = z.object({
  profileId: z.uuid().nullable(),
  views: z.array(GridSavedView).min(1).max(500),
}).strict();

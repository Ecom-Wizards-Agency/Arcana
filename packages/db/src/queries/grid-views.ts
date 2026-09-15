import { GridSavedView, GridViewSave, GridEntity } from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';

export async function listGridViews(snapshot: AuthenticatedReadSnapshot, entity: string, profileId: string | null): Promise<GridSavedView[]> {
  GridEntity.parse(entity);
  const rows = await snapshot.sql<{ view: unknown }[]>`
    select view from public.grid_views
     where org_id = ${snapshot.actor.orgId}
       and (profile_id is null or profile_id = ${profileId}::uuid)
       and view->>'entity' = ${entity}
     order by name, owner_id, id
  `;
  // Parse every row; malformed stored state must not silently shorten the list.
  return rows.map((row) => GridSavedView.parse(row.view));
}

export async function saveGridViews(context: AuthenticatedEditorTransaction, input: unknown): Promise<number> {
  const { views, profileId } = GridViewSave.parse(input);
  if (new Set(views.map((view) => view.id)).size !== views.length) throw new Error('Duplicate view IDs');
  let saved = 0;
  for (const view of views) {
    const rows = await context.sql<{ id: string }[]>`
      insert into public.grid_views (org_id, owner_id, id, profile_id, name, view)
      values (${context.actor.orgId}, ${context.actor.userId}, ${view.id}, ${profileId}::uuid,
              ${view.name}, ${JSON.stringify(view)}::text::jsonb)
      on conflict (org_id, id) do update
        set profile_id = excluded.profile_id, name = excluded.name, view = excluded.view
        where grid_views.owner_id = ${context.actor.userId}
      returning id
    `;
    if (rows.length !== 1 || rows[0]?.id !== view.id) throw new Error('View save could not be confirmed');
    saved += rows.length;
  }
  if (saved !== views.length) throw new Error('View save count mismatch');
  return saved;
}

export async function removeGridView(context: AuthenticatedEditorTransaction, id: string): Promise<number> {
  const rows = await context.sql<{ id: string }[]>`
    delete from public.grid_views where org_id = ${context.actor.orgId}
      and owner_id = ${context.actor.userId} and id = ${id} returning id
  `;
  return rows.length;
}

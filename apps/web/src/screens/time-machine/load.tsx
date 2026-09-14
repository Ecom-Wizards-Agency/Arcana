import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/time-machine` — the account's change history, read only.
 *
 * AdLabs' change log, over data we already keep: `entity_changes` (what a sync
 * noticed drift on) unioned with the operator's own export batches. One
 * reverse-chronological timeline per profile, grouped by day the way the
 * incumbent does, filterable by entity type, field, source and date range.
 *
 * Fully server-rendered: it proposes nothing and writes nothing, so the filters
 * are a plain GET form and every control is a link or a query parameter. No
 * server action, no client island — a page that only reads has no state to hold.
 */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect } from 'next/navigation';

import {
  getReversionBatchPreview,
  listReversionBatches,
  listTimeline,
  listTimelineFacets,
} from '@wizard-ads/db';

import type { ChangeSource, TimelineEntry } from '@wizard-ads/db';

import { authenticationDestination } from '../../server/request-context';

import { listOrgProfiles } from '../../recommendations/data';

import { requireOrgRole } from '../../server/org-role';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TIMELINE_PAGE_SIZE = 50;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDate(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function timelineCursor(query: Record<string, string | string[] | undefined>): {
  observedAt: string;
  id: string;
} | null {
  const observedAt = one(query['before_at']);
  const id = one(query['before_id']);
  if (observedAt === undefined || id === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAt)) return null;
  if (observedAt.startsWith('0000-')) return null;
  if (!/^(?:change|apply):(?:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(id)) return null;
  const parsed = new Date(observedAt);
  const canonical = observedAt.includes('.') ? observedAt : observedAt.replace('Z', '.000Z');
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonical ? null : { observedAt, id };
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface DayGroup {
  key: string;
  label: string;
  entries: TimelineEntry[];
}

function groupByDay(entries: readonly TimelineEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const entry of entries) {
    const key = dayKey(entry.observedAt);
    if (current === null || current.key !== key) {
      current = { key, label: DAY_FORMAT.format(entry.observedAt), entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as { searchParams: SearchParams; }['searchParams'];

  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      const query = await searchParams;

      const profiles = await listOrgProfiles(database, actor.orgId);
      const profile = access.selectProfile(profiles, one(query['profile']));
      if (profile === null) {
        return { view: 'empty' as const, props: {} };
      }

      const facets = await listTimelineFacets(database, {
        orgId: actor.orgId,
        profileId: profile.id,
      });

      const rawEntityType = one(query['type']);
      const entityType = rawEntityType && facets.entityTypes.includes(rawEntityType) ? rawEntityType : null;
      const rawField = one(query['field']);
      const field = rawField && facets.fields.includes(rawField) ? rawField : null;
      const rawSource = one(query['source']);
      const source: ChangeSource | null = rawSource === 'sync' || rawSource === 'apply' ? rawSource : null;
      const requestedFrom = one(query['from']);
      const requestedTo = one(query['to']);
      const from = isDate(requestedFrom) ? requestedFrom : null;
      const toParam = isDate(requestedTo) ? requestedTo : null;
      const cursor = timelineCursor(query);
      // The `to` bound is a whole day: extend an end date to the end of that day.
      const toBound = toParam === null ? null : `${toParam}T23:59:59.999Z`;

      const timelineWindow = await listTimeline(database, {
        orgId: actor.orgId,
        profileId: profile.id,
        entityTypes: entityType ? [entityType] : null,
        field,
        source,
        from: from ?? null,
        to: toBound,
        limit: TIMELINE_PAGE_SIZE + 1,
        before: cursor,
      });
      const hasOlder = timelineWindow.length > TIMELINE_PAGE_SIZE;
      const entries = timelineWindow.slice(0, TIMELINE_PAGE_SIZE);
      const reversionBatches = await listReversionBatches(database, {
        orgId: actor.orgId,
        profileId: profile.id,
      });
      const requestedBatch = one(query['batch']);
      const selectedBatch =
        requestedBatch === undefined
          ? null
          : reversionBatches.find((batch) => batch.batchId === requestedBatch) ?? null;
      const reversionPreview =
        selectedBatch === null
          ? null
          : await getReversionBatchPreview(database, {
            orgId: actor.orgId,
            batchId: selectedBatch.batchId,
          });
      const days = groupByDay(entries);
      const hasAnyHistory = facets.entityTypes.length > 0 || facets.fields.length > 0;
      const filtersActive = entityType !== null || field !== null || source !== null || from !== null || toParam !== null;

      const base = (extra: Record<string, string>): string => {
        const params = new URLSearchParams({ profile: profile.id, ...extra });
        return `/time-machine?${params.toString()}`;
      };
      const pageHref = (before: TimelineEntry | null): string => {
        const params = new URLSearchParams({ profile: profile.id });
        if (entityType !== null) params.set('type', entityType);
        if (field !== null) params.set('field', field);
        if (source !== null) params.set('source', source);
        if (from !== null) params.set('from', from);
        if (toParam !== null) params.set('to', toParam);
        if (selectedBatch !== null) params.set('batch', selectedBatch.batchId);
        if (before !== null) {
          params.set('before_at', before.observedAt.toISOString());
          params.set('before_id', before.id);
        }
        return `/time-machine?${params.toString()}`;
      };

      return { view: 'ready' as const, props: { profiles, profile, reversionBatches, selectedBatch, reversionPreview, role, hasAnyHistory, entityType, facets, field, source, from, toParam, filtersActive, base, cursor, pageHref, entries, days, hasOlder } };
    });
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'The change history is unavailable');
    return { view: 'error' as const, props: { message } };
  }
}

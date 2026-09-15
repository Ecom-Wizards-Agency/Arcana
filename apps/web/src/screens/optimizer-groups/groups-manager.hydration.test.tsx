// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { OPTIMIZATION_WEEKDAYS } from '@wizard-ads/shared';
import { OptimizationGroupsManager } from './groups-manager';
import { populated } from './render-fixture';

it('protects the saved schedule before hydration and enforces its last selected day afterward', async () => {
  const initial = { ...populated.props.workspace, groups: populated.props.workspace.groups.map((record) => ({
    ...record, group: { ...record.group, reviewSchedule: { version: 2 as const, weekdays: [...OPTIMIZATION_WEEKDAYS] } },
  })) };
  const editor = <OptimizationGroupsManager profileId={populated.props.profile.id} initial={initial} canManage previewReady />;
  const host = document.createElement('div');
  document.body.append(host);
  host.innerHTML = renderToString(editor);
  let root: Root | undefined;
  try {
    const weekdays = [...host.querySelectorAll<HTMLInputElement>('.wa-weekday-options input')];
    expect(weekdays).toHaveLength(7);
    // A slow client bundle must not let native toggles silently diverge from the saved draft.
    weekdays.slice(1).forEach((checkbox) => checkbox.click());
    expect(weekdays.map((checkbox) => checkbox.checked)).toEqual(Array(7).fill(true));
    expect(weekdays.every((checkbox) => checkbox.disabled)).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    await act(async () => { root = hydrateRoot(host, editor); });
    expect(weekdays.every((checkbox) => !checkbox.disabled)).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    for (const checkbox of weekdays.slice(1)) await act(async () => { checkbox.click(); });
    expect(weekdays.map((checkbox) => checkbox.checked)).toEqual([true, false, false, false, false, false, false]);
    await act(async () => { weekdays[0]!.click(); });
    expect(weekdays.map((checkbox) => checkbox.checked)).toEqual([true, false, false, false, false, false, false]);
  } finally {
    if (root) await act(async () => root?.unmount());
    host.remove();
  }
});

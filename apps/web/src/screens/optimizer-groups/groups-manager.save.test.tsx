// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OPTIMIZATION_METHOD_CATALOGUE } from '@wizard-ads/core';
import { afterEach, expect, it, vi } from 'vitest';
import { OptimizationGroupsManager } from './groups-manager';
import { populated } from './render-fixture';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const record = populated.props.workspace.groups[0]!;
const acknowledged = { record, assignedCampaigns: 1, movedCampaigns: 0, removedCampaigns: 0 };

it('uses catalogue names and shadow availability for the two registered group methods', () => {
  render(<OptimizationGroupsManager profileId={populated.props.profile.id} initial={populated.props.workspace} canManage previewReady />);
  const options = [...screen.getByLabelText('Method').querySelectorAll('option')];
  expect(options).toHaveLength(2);
  expect(options.map((option) => option.textContent)).toEqual(OPTIMIZATION_METHOD_CATALOGUE.slice(0, 2).map((method) => method.displayName + (method.releaseState === 'shadow' ? ' · Shadow preview only' : '')));
});

it.each([
  ['missing assignment count', { ...acknowledged, assignedCampaigns: undefined }],
  ['null assignment count', { ...acknowledged, assignedCampaigns: null }],
  ['wrong count', { ...acknowledged, assignedCampaigns: 0 }],
  ['different campaign identity', { ...acknowledged, record: { ...record, campaignIds: ['another-synthetic-campaign'] } }],
  ['missing removal count', { ...acknowledged, removedCampaigns: undefined }],
])('refuses a save acknowledgment with %s', async (_name, response) => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
  vi.stubGlobal('fetch', fetcher);
  const host = render(<OptimizationGroupsManager profileId={populated.props.profile.id} initial={populated.props.workspace} canManage previewReady />);
  fireEvent.submit(host.container.querySelector('form')!);
  expect((await screen.findByRole('alert')).textContent).toContain('The saved campaign assignments do not match your selection.');
  expect(host.container.textContent).not.toContain('Saved 0 campaign assignments');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('reports the exact acknowledged count after matching the saved identities and reloading', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => acknowledged })
    .mockResolvedValueOnce({ ok: true, json: async () => populated.props.workspace });
  vi.stubGlobal('fetch', fetcher);
  const host = render(<OptimizationGroupsManager profileId={populated.props.profile.id} initial={populated.props.workspace} canManage previewReady />);
  fireEvent.submit(host.container.querySelector('form')!);
  expect((await screen.findByText('Saved 1 campaign assignments.')).textContent).toBe('Saved 1 campaign assignments.');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).campaignIds).toEqual(record.campaignIds);
});

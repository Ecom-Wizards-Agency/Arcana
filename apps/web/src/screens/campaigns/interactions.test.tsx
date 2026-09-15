// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Builder } from './builder';
import { AssetPicker } from '../campaigns-assets/picker';
import AssetsScreen from '../campaigns-assets/view';
import { NamingReady } from '../campaigns-naming/view';
import { builderContext, builderRecipe, savedDraft, fixtureId, assetSnapshot } from './render-fixture';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('builder source and naming interactions', () => {
  it('searches mirrored products and keeps the rail, preview and plan counts across all steps', () => {
    render(<Builder context={builderContext} initialRecipe={builderRecipe} />);
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'absent' } }); expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'lantern' } }); expect(screen.getByRole('checkbox')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '2 Play & targets' }));
    for (const source of ['From search terms', 'From n-grams', 'From Rank Radar', 'Saved keyword set', 'Paste']) { fireEvent.click(screen.getByRole('tab', { name: source })); expect(screen.getByRole('tab', { name: source }).getAttribute('aria-selected')).toBe('true'); }
    fireEvent.change(screen.getByLabelText('Keywords'), { target: { value: 'synthetic one\nsynthetic two' } });
    expect(screen.getByText('2 keywords × 1 products = 2 campaigns, 1 keyword each')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Campaign structure'), { target: { value: 'set-product' } });
    expect(screen.getByText('2 keywords × 1 products = 1 campaigns, the keyword set in each')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '3 Review & create' }));
    expect(screen.getByLabelText('Settings')).toBeTruthy(); expect(screen.getByLabelText('Plan so far')).toBeTruthy();
    expect(screen.getByTestId('campaign-name-preview').textContent).toContain('QA');
  });
  it('reads reverse-name chips and submits a same-profile convention copy through the guarded route', async () => {
    const fetch = vi.fn(async () => Response.json({ copied: true })); vi.stubGlobal('fetch', fetch);
    const preset = { id: fixtureId(7), name: 'Synthetic convention', naming: builderContext.naming!, createdBy: fixtureId(4), usageCount: 1 };
    render(<NamingReady data={{ view: 'ready', profileId: fixtureId(2), profiles: [builderContext.profile], naming: builderContext.naming, canEdit: true, presets: [preset] }} />);
    const name = savedDraft.plan.nodes.find((node) => node.kind === 'campaign.create')!.payload.name;
    fireEvent.change(screen.getByLabelText('Existing campaign name'), { target: { value: name } }); fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
    expect(screen.getByText('Keyword · synthetic lantern')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Existing campaign name'), { target: { value: 'unparseable' } }); fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
    expect(screen.getByText('This name does not match the selected naming convention.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use for this profile' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit]; expect(call[0]).toBe('/api/campaigns/naming');
    expect(JSON.parse(String(call[1].body))).toEqual({ action: 'copy', id: preset.id, profileId: fixtureId(2) });
  });
});
describe('asset snapshot presentation', () => {
  it('applies search and video filters to creatives used in the account', () => {
    render(<AssetPicker snapshot={assetSnapshot} used={[
      { id: fixtureId(21), amazonAssetId: 'synthetic-video', name: 'Synthetic video', kind: 'video', usedInCampaignIds: ['synthetic-campaign'] },
      { id: fixtureId(22), amazonAssetId: 'synthetic-image', name: 'Synthetic image', kind: 'image', usedInCampaignIds: ['synthetic-campaign'] },
    ]} canRefresh={false} onRefresh={async () => {}} initialTab="used" />);
    fireEvent.click(screen.getByRole('button', { name: 'Video only' }));
    expect(screen.getByText('Synthetic video')).toBeTruthy(); expect(screen.queryByText('Synthetic image')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search creative assets'), { target: { value: 'absent' } });
    expect(screen.getByText('No mirrored creatives match these filters.')).toBeTruthy();
  });
  it('reads stored observations without fetching and retains selected asset identity and version', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const selected = vi.fn();
    render(<AssetPicker snapshot={assetSnapshot} used={[]} canRefresh={false} onRefresh={async () => {}} onSelect={selected} />);
    expect(fetch).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Select asset' }));
    expect(selected).toHaveBeenCalledWith(assetSnapshot.assets[0]); expect(screen.getByText(/Selected for review: synthetic-asset · version 1/)).toBeTruthy();
    expect((screen.getByRole('tab', { name: 'Upload new' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Refresh from Amazon' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('surfaces refused refresh instead of claiming the missing job was queued', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'Asset-library refresh is unavailable until its ingestion job is registered.' }, { status: 503 })); vi.stubGlobal('fetch', fetch);
    render(<AssetsScreen data={{ view: 'ready', profileId: fixtureId(2), snapshot: null, used: [], canRefresh: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh from Amazon' }));
    await waitFor(() => expect(screen.getByText('Asset-library refresh is unavailable until its ingestion job is registered.')).toBeTruthy());
    expect(screen.queryByText(/refresh queued/)).toBeNull();
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit]; expect(call[0]).toBe('/api/campaigns/assets'); expect(JSON.parse(String(call[1].body))).toEqual({ profileId: fixtureId(2) });
  });
});

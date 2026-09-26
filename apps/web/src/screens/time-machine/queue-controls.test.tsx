// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { ChangeQueueSource, ChangeQueueState, type ChangeQueueEntry } from '@wizard-ads/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gridLink, OWNER_DEFINITION, restorable, sourceWords } from './model';
import { entries, ready, restore } from './render-fixture';
import { amazonEntryFixtures } from '../grid/catalogue-fixtures';
import Screen from './view';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
beforeEach(() => { router.push.mockReset(); router.refresh.mockReset(); router.replace.mockReset(); });

const withData = (props: Partial<typeof ready.props>) => ({ ...ready, props: { ...ready.props, ...props } });
const mixed: ChangeQueueEntry[] = entries.map((row, index) => ({ ...row, entityType: index % 2 ? 'campaign' : 'keyword', field: index % 2 ? 'budget' : 'bid' }));
const optionValues = (testId: string) => [...(screen.getByTestId(testId) as HTMLSelectElement).options].map((option) => option.value);
const optionLabels = (testId: string) => [...(screen.getByTestId(testId) as HTMLSelectElement).options].map((option) => option.textContent);
const menuNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('change queue filters', () => {
  it('populates entity type and field dropdowns from the rows in scope and applies a change without a submit', () => {
    render(<Screen data={withData({ entries: mixed, filterOptions: { types: [...new Set(mixed.map((row) => row.entityType))], fields: [...new Set(mixed.map((row) => row.field))] } })} />);
    expect(optionValues('filter-type')).toEqual(['', 'campaign', 'keyword']);
    expect(optionValues('filter-field')).toEqual(['', 'bid', 'budget']);
    expect(screen.getByTestId('filter-type').tagName).toBe('SELECT');
    expect(screen.getByTestId('filter-field').tagName).toBe('SELECT');
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(screen.getByTestId('timeline-filters').closest('details')).toBeNull();
    fireEvent.change(screen.getByTestId('filter-type'), { target: { value: 'campaign' } });
    expect(router.push).toHaveBeenCalledTimes(1);
    const typed = new URL(router.push.mock.calls[0]![0] as string, 'https://example.test');
    expect(typed.searchParams.get('type')).toBe('campaign');
    fireEvent.change(screen.getByTestId('filter-field'), { target: { value: 'budget' } });
    fireEvent.change(screen.getByTestId('filter-source'), { target: { value: 'sync' } });
    fireEvent.change(screen.getByTestId('filter-state'), { target: { value: 'observed' } });
    expect(router.push).toHaveBeenCalledTimes(4);
    expect(router.push.mock.calls.map(([url]) => new URL(url as string, 'https://example.test').searchParams)
      .map((params) => [params.get('field'), params.get('source'), params.get('state')])).toEqual([
      [null, null, null], ['budget', null, null], [null, 'sync', null], [null, null, 'observed'],
    ]);
  });

  it('keeps the active entity type and field in their dropdowns and uses the row words for source and state', () => {
    render(<Screen data={withData({ entries: [], filterOptions: { types: ['keyword'], fields: ['bid'] }, query: { type: 'ad_group', field: 'default_bid' } })} />);
    expect(optionValues('filter-type')).toEqual(['', 'ad_group', 'keyword']);
    expect(optionLabels('filter-type')).toEqual(['All entity types', 'ad group', 'keyword']);
    expect(optionValues('filter-field')).toEqual(['', 'bid', 'default_bid']);
    expect((screen.getByTestId('filter-type') as HTMLSelectElement).value).toBe('ad_group');
    expect((screen.getByTestId('filter-field') as HTMLSelectElement).value).toBe('default_bid');
    expect(optionLabels('filter-source')).toEqual(['All sources', 'Arcana · Batch', 'Ads console', 'Other · Provider history',
      'Arcana · Queued proposal', 'Arcana · Restore', 'Arcana · Campaign creation', 'Arcana · Campaign creation retry']);
    expect(optionLabels('filter-state')).toHaveLength(ChangeQueueState.options.length + 1);
    expect(optionLabels('filter-state')).toContain('partial failed');
  });

  it('shows one removable chip per applied filter and ignores values the server does not apply', () => {
    render(<Screen data={withData({ query: { source: 'sync', type: 'keyword', state: 'guessed' } })} />);
    const chips = screen.getAllByTestId('filter-chip');
    expect(chips).toHaveLength(2);
    expect(chips.map((chip) => chip.textContent)).toEqual(['Source: Ads console ×', 'Entity type: keyword ×']);
    const removed = chips.map((chip) => new URL(chip.getAttribute('href')!, 'https://example.test').searchParams);
    expect(removed.map((params) => [params.get('source'), params.get('type')])).toEqual([[null, 'keyword'], ['sync', null]]);
    expect(screen.getByTestId('filter-clear').getAttribute('href')).not.toContain('source=');
  });

  it('shows no chips or clear link without an applied filter', () => {
    render(<Screen data={ready} />);
    expect(screen.queryAllByTestId('filter-chip')).toHaveLength(0);
    expect(screen.queryByTestId('filter-clear')).toBeNull();
  });

  it('names the filter that emptied the list', () => {
    const { unmount } = render(<Screen data={withData({ entries: [], query: { field: 'budget' } })} />);
    expect(screen.getByTestId('timeline-empty-filtered').textContent).toBe('No changes match this filter: Field is budget. Remove it to see more changes.');
    unmount();
    render(<Screen data={withData({ entries: [], query: { source: 'apply', field: 'budget', from: '2026-09-01' } })} />);
    expect(screen.getByTestId('timeline-empty-filtered').textContent).toBe('No changes match these filters: Source is Arcana · Batch, Field is budget in this date range. Remove one to see more changes.');
  });

  it('keeps the range message when only dates narrow the list', () => {
    render(<Screen data={withData({ entries: [], query: { from: '2000-01-01', to: '2000-12-31' } })} />);
    expect(screen.getByTestId('timeline-empty-filtered').textContent).toBe('No changes recorded in this range');
  });
});

describe('change queue columns', () => {
  it('gives the old and new values room for a long currency amount and wraps rather than truncating', () => {
    const long = { ...entries[0]!, oldValue: 12345678.9, newValue: 23456789.01 };
    const { container } = render(<Screen data={withData({ entries: [long] })} />);
    expect(screen.getByTestId('entry-was').textContent).toBe('$12,345,678.90');
    expect(screen.getByTestId('entry-became').textContent).toBe('$23,456,789.01');
    expect(screen.getByTestId('entry-was').className).toBe('cq-value');
    expect(screen.getByTestId('entry-became').className).toBe('cq-value');
    const widths = [...container.querySelectorAll('col')].map((col) => col.style.width);
    expect(widths[3]).toBe('140px');
    expect(widths[4]).toBe('140px');
    const css = readFileSync('src/screens/time-machine/view.css', 'utf8');
    const rule = css.split('\n').find((line) => line.startsWith('.cq td.cq-value'));
    expect(rule).toBe('.cq td.cq-value { white-space:normal; overflow-wrap:anywhere; text-overflow:clip; }');
    expect(css).toContain('.cq-history { width:1364px; }');
  });

  it('gives the restore preview value columns the same room', () => {
    const { container } = render(<Screen data={restore} />);
    expect([...container.querySelectorAll('col')].map((col) => col.style.width)).toEqual(['250px', '82px', '120px', '120px', '120px', '130px', '']);
    expect(container.querySelectorAll('.cq-restore td.cq-value')).toHaveLength(21);
  });

  it('labels the attribution column Owner with its definition on hover and in a help line', () => {
    render(<Screen data={ready} />);
    const owner = screen.getByRole('columnheader', { name: 'OWNER' });
    expect(owner.getAttribute('title')).toBe(OWNER_DEFINITION);
    expect(owner.getAttribute('title')).toBe(screen.getByTestId('owner-definition').textContent);
    expect(screen.queryByRole('columnheader', { name: 'ATTRIBUTED TO' })).toBeNull();
    expect(screen.getByTestId('owner-definition').textContent).toBe('Owner is the person or system that made the change: an Arcana operator by name, Arcana automation, an Ads console user when known, otherwise Unknown.');
  });

  it('shows the owner name, or the owner kind in words, in every Owner cell', () => {
    render(<Screen data={ready} />);
    const owners = screen.getAllByTestId('entry-owner');
    expect(owners).toHaveLength(6);
    expect(owners.map((cell) => cell.textContent)).toEqual(['Synthetic operator', 'Ads console user', 'Ads console user', 'Arcana automation', 'Arcana operator', 'Arcana operator']);
    expect(owners[0]!.parentElement!.textContent).toBe('Synthetic operator · Batch 1000 · 7 changes');
    expect(owners[0]!.parentElement!.getAttribute('title')).toBe('Synthetic operator · Batch 1000 · 7 changes');
    expect(owners[1]!.parentElement!.textContent).toBe('Ads console user');
  });

  it('shows Unknown for provider history with its evidence after it', () => {
    const provider = amazonEntryFixtures()[0]!;
    render(<Screen data={withData({ entries: [provider] })} />);
    expect(screen.getAllByTestId('entry-owner').map((cell) => cell.textContent)).toEqual(['Unknown']);
    expect(screen.getByTestId('entry-owner').parentElement!.textContent).toMatch(/^Unknown · Provider history · no local actor · /);
  });

  it('shows the source in words on every row', () => {
    render(<Screen data={ready} />);
    const sources = screen.getAllByTestId('entry-source');
    expect(sources).toHaveLength(6);
    expect(sources.map((cell) => cell.textContent)).toEqual(['Arcana · Batch', 'Ads console', 'Ads console', 'Arcana · Batch', 'Arcana · Queued proposal', 'Arcana · Queued proposal']);
    expect(ChangeQueueSource.options.map(sourceWords)).toEqual(['Arcana · Batch', 'Ads console', 'Other · Provider history', 'Arcana · Queued proposal',
      'Arcana · Restore', 'Arcana · Campaign creation', 'Arcana · Campaign creation retry']);
    expect(ChangeQueueSource.options.map(sourceWords).every((label) => /^(Arcana|Ads console|Other)( · |$)/.test(label))).toBe(true);
  });
});

describe('change queue row menu', () => {
  it('offers restore preview, copy and grid for a restorable batch row and opens from the pointer', () => {
    render(<Screen data={ready} />);
    const row = screen.getAllByTestId('timeline-entry')[0]!;
    const trigger = within(row).getByRole('button', { name: 'Actions for Synthetic change 1' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(menuNames()).toEqual(['Start restore preview', 'Copy change ID', 'Open targets grid']);
    const [restoreLink, , gridLink] = screen.getAllByRole('menuitem');
    const restoreUrl = new URL(restoreLink!.getAttribute('href')!, 'https://example.test');
    expect(restoreUrl.pathname).toBe('/change-queue');
    expect(restoreUrl.searchParams.get('batch')).toBe(entries[0]!.batchId);
    expect(gridLink!.getAttribute('href')).toBe(`/grid?profile=${ready.props.profileId}&entity=targets`);
    expect(document.activeElement).toBe(restoreLink);
    expect(screen.getByRole('menu', { name: 'Actions for Synthetic change 1' }).id).toBe(trigger.getAttribute('aria-controls'));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('opens the review for a queued proposal and acknowledges an observed change from the menu', () => {
    render(<Screen data={ready} />);
    const rows = screen.getAllByTestId('timeline-entry');
    fireEvent.click(within(rows[4]!).getByRole('button', { name: 'Actions for Synthetic change 5' }));
    expect(menuNames()).toEqual(['Open review', 'Copy change ID', 'Open targets grid']);
    expect(screen.getAllByRole('menuitem')[0]!.getAttribute('href')).toBe(entries[4]!.reviewHref);
    const second = within(rows[1]!).getByRole('button', { name: 'Actions for Synthetic change 2' });
    fireEvent.mouseDown(second); fireEvent.click(second);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(menuNames()).toEqual(['Copy change ID', 'Open targets grid', 'Acknowledge']);
  });

  it('never offers a dead item', () => {
    render(<Screen data={ready} />);
    let items = 0;
    for (const row of screen.getAllByTestId('timeline-entry')) {
      fireEvent.click(within(row).getByRole('button', { name: /^Actions for / }));
      for (const item of screen.getAllByRole('menuitem')) {
        items += 1;
        if (item.tagName === 'A') expect(item.getAttribute('href')).toMatch(/^\/(change-queue|grid|targets)\?|^\/targets\//);
        else expect((item as HTMLButtonElement).disabled).toBe(false);
      }
      fireEvent.keyDown(document, { key: 'Escape' });
    }
    expect(items).toBe(18);
  });

  it('moves through items with the keyboard, closes on Escape and returns focus to the button', () => {
    render(<Screen data={ready} />);
    const trigger = screen.getByRole('button', { name: 'Actions for Synthetic change 1' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'Escape' });
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click but not on a click inside the menu', () => {
    render(<Screen data={ready} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Synthetic change 1' }));
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.mouseDown(document.body);
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
  });

  it('stays open while the table scrolls and leaves focus alone for an Escape pressed elsewhere', () => {
    const { container } = render(<Screen data={ready} />);
    const trigger = screen.getByRole('button', { name: 'Actions for Synthetic change 1' });
    fireEvent.click(trigger);
    fireEvent.scroll(container.querySelector('.cq-table-wrap')!);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    const density = screen.getByLabelText('Density');
    density.focus();
    fireEvent.keyDown(density, { key: 'Escape' });
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    expect(document.activeElement).toBe(density);
  });

  it('copies the change id and confirms it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Screen data={ready} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Synthetic change 1' }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy change ID' })); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('apply:1');
    expect(screen.getByTestId('row-menu-notice').textContent).toBe('Copied change ID apply:1.');
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
  });

  it('says where the id is when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    render(<Screen data={ready} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Synthetic change 2' }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy change ID' })); });
    expect(screen.getByRole('alert').textContent).toBe('The change ID could not be copied. It is sync:2.');
  });

  it('links campaigns to their own grid row, restores only unambiguous batch changes and skips entities the grid has no level for', () => {
    expect(gridLink({ ...entries[0]!, entityType: 'campaign', entityId: 'campaign-7' }, 'p-1')).toEqual({ href: '/grid?profile=p-1&entity=campaigns&campaign=campaign-7', label: 'Open campaign in grid' });
    expect(gridLink({ ...entries[0]!, entityType: 'ad_group' }, 'p-1')).toEqual({ href: '/grid?profile=p-1&entity=ad_groups', label: 'Open ad groups grid' });
    expect(gridLink({ ...entries[0]!, entityType: 'portfolio' }, 'p-1')).toBeNull();
    expect(entries.map(restorable)).toEqual([true, false, false, true, false, false]);
    expect(restorable({ ...entries[1]!, state: 'confirmed', batchId: entries[0]!.batchId })).toBe(true);
    expect(restorable({ ...entries[1]!, state: 'acknowledged', batchId: entries[0]!.batchId })).toBe(true);
    expect(restorable({ ...entries[4]!, batchId: entries[0]!.batchId })).toBe(false);
  });
});

// @vitest-environment jsdom
/**
 * The toolbar's direct-manipulation surfaces: the group bar as a drop target
 * for column headers and its own chips, the entity search box as filter
 * arithmetic, chips that reopen the builder, view deletion, the grouped and
 * searchable column picker, and the density and fullscreen controls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { GridToolbar } from './GridToolbar.js';
import type { GridToolbarProps } from './GridToolbar.js';
import { columnsFor, defaultVisibleColumns } from './columns.js';
import type { FilterSet } from './filter.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { COLUMN_DRAG_TYPE, DIMENSION_DRAG_TYPE, GROUP_LEVEL_DRAG_TYPE } from './grouping.js';
import { buildGridModel } from './pipeline.js';
import type { SavedView } from './views.js';

const available = columnsFor('search_terms');
const model = buildGridModel(syntheticSearchTermRows(20, { seed: 2 }));

function transfer(entries: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(entries));
  return {
    types: [...data.keys()],
    getData: (format: string) => data.get(format) ?? '',
    setData: (format: string, value: string) => {
      data.set(format, value);
    },
    dropEffect: 'none',
  };
}

/** What `GridHeader` writes for a dimension header: the column type and the dimension type. */
function dimensionDrag(id: string) {
  return transfer({ [COLUMN_DRAG_TYPE]: id, [DIMENSION_DRAG_TYPE]: id });
}

/** What `GridHeader` writes for a metric header: the column type only. */
function metricDrag(id: string) {
  return transfer({ [COLUMN_DRAG_TYPE]: id });
}

function chipDrag(id: string) {
  return transfer({ [GROUP_LEVEL_DRAG_TYPE]: id });
}

function renderToolbar(overrides: Partial<GridToolbarProps> = {}) {
  const onFilterChange = vi.fn();
  const onGroupByChange = vi.fn();
  render(
    <GridToolbar
      entity="search_terms"
      available={available}
      visible={defaultVisibleColumns('search_terms')}
      onVisibleChange={() => {}}
      filter={{ groups: [] }}
      onFilterChange={onFilterChange}
      groupBy={[]}
      onGroupByChange={onGroupByChange}
      model={model}
      optionRows={model.rows}
      {...overrides}
    />,
  );
  return { onFilterChange, onGroupByChange };
}

afterEach(cleanup);

describe('group bar', () => {
  it('groups by a dimension header dropped on it and refuses a metric', () => {
    const { onGroupByChange } = renderToolbar();
    const bar = screen.getByTestId('grid-group-bar');
    expect(bar.textContent).toContain('Drag a column header here');

    const dimension = dimensionDrag('campaign_name');
    fireEvent.dragOver(bar, { dataTransfer: dimension });
    expect(bar.getAttribute('data-drop-active')).toBe('true');
    expect(dimension.dropEffect).toBe('move');
    fireEvent.drop(bar, { dataTransfer: dimensionDrag('campaign_name') });
    expect(onGroupByChange).toHaveBeenCalledWith(['campaign_name']);
    expect(bar.getAttribute('data-drop-active')).toBe('false');

    // A metric is refused before release, not after: the bar must not light
    // up during dragover, since the browser hides the id until the drop.
    const metric = metricDrag('spend');
    fireEvent.dragOver(bar, { dataTransfer: metric });
    expect(bar.getAttribute('data-drop-active')).toBe('false');
    expect(metric.dropEffect).toBe('none');
    fireEvent.drop(bar, { dataTransfer: metricDrag('spend') });
    expect(onGroupByChange).toHaveBeenCalledTimes(1);
  });

  it('refuses a dimension of another entity even when it is marked as one', () => {
    const { onGroupByChange } = renderToolbar();
    const bar = screen.getByTestId('grid-group-bar');
    fireEvent.drop(bar, { dataTransfer: dimensionDrag('portfolio_name') });
    expect(onGroupByChange).not.toHaveBeenCalled();
  });

  it('nests a second header at the end, or before the chip it is dropped on', () => {
    const { onGroupByChange } = renderToolbar({ groupBy: ['search_term', 'match_type'] });
    const bar = screen.getByTestId('grid-group-bar');
    fireEvent.drop(bar, { dataTransfer: dimensionDrag('targeting') });
    expect(onGroupByChange).toHaveBeenLastCalledWith(['search_term', 'match_type', 'targeting']);

    const chips = screen.getByRole('list', { name: 'Ordered grouping levels' });
    const matchChip = within(chips).getAllByRole('listitem')[1] as HTMLElement;
    fireEvent.dragOver(matchChip, { dataTransfer: dimensionDrag('targeting') });
    fireEvent.drop(matchChip, { dataTransfer: dimensionDrag('targeting') });
    expect(onGroupByChange).toHaveBeenLastCalledWith(['search_term', 'targeting', 'match_type']);

    const metricOverChip = metricDrag('spend');
    fireEvent.dragOver(matchChip, { dataTransfer: metricOverChip });
    expect(metricOverChip.dropEffect).toBe('none');
  });

  it('toggles the drop highlight on the bar and a chip without a React style warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderToolbar({ groupBy: ['search_term'] });
      const bar = screen.getByTestId('grid-group-bar');
      const chip = within(screen.getByRole('list', { name: 'Ordered grouping levels' })).getByRole('listitem');

      fireEvent.dragOver(bar, { dataTransfer: dimensionDrag('campaign_name') });
      expect(bar.getAttribute('data-drop-active')).toBe('true');
      fireEvent.dragLeave(bar, { relatedTarget: document.body });
      expect(bar.getAttribute('data-drop-active')).toBe('false');

      fireEvent.dragOver(chip, { dataTransfer: dimensionDrag('campaign_name') });
      fireEvent.dragLeave(chip, { relatedTarget: document.body });

      const styleWarnings = errors.mock.calls.filter((call) =>
        call.some((argument) => typeof argument === 'string' && argument.includes('style property')),
      );
      expect(styleWarnings).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('reorders chips by dragging one onto another and keeps the keyboard path', () => {
    const { onGroupByChange } = renderToolbar({
      groupBy: ['search_term', 'targeting', 'match_type'],
    });
    const chips = within(screen.getByRole('list', { name: 'Ordered grouping levels' })).getAllByRole('listitem');
    expect(chips).toHaveLength(3);
    expect(chips[2]?.getAttribute('draggable')).toBe('true');

    const setData = vi.fn();
    fireEvent.dragStart(chips[2] as HTMLElement, { dataTransfer: { setData, types: [] } });
    expect(setData).toHaveBeenCalledWith(GROUP_LEVEL_DRAG_TYPE, 'match_type');

    fireEvent.drop(chips[0] as HTMLElement, { dataTransfer: chipDrag('match_type') });
    expect(onGroupByChange).toHaveBeenLastCalledWith(['match_type', 'search_term', 'targeting']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove grouping level Match' }));
    expect(onGroupByChange).toHaveBeenLastCalledWith(['search_term', 'targeting']);
    fireEvent.change(screen.getByLabelText('Add grouping level'), { target: { value: 'campaign_name' } });
    expect(onGroupByChange).toHaveBeenLastCalledWith([
      'search_term',
      'targeting',
      'match_type',
      'campaign_name',
    ]);
  });
});

describe('entity search', () => {
  it('compiles typed text to a LIKE filter on the pinned dimension and reads it back', () => {
    const { onFilterChange } = renderToolbar();
    const box = screen.getByLabelText('Entity search') as HTMLInputElement;
    expect(box.placeholder).toBe('Search search term…');
    fireEvent.change(box, { target: { value: 'widget' } });
    expect(onFilterChange).toHaveBeenLastCalledWith({
      groups: [{ filters: [{ key: 'SEARCH_TERM', conditions: [{ operator: 'LIKE', values: ['widget'] }] }] }],
    });

    cleanup();
    const applied: FilterSet = {
      groups: [{ filters: [{ key: 'SEARCH_TERM', conditions: [{ operator: 'LIKE', values: ['gadget'] }] }] }],
    };
    const second = renderToolbar({ filter: applied });
    const shown = screen.getByLabelText('Entity search') as HTMLInputElement;
    expect(shown.value).toBe('gadget');
    fireEvent.change(shown, { target: { value: '' } });
    expect(second.onFilterChange).toHaveBeenLastCalledWith({ groups: [] });
  });
});

describe('filter chips', () => {
  it('reopens the builder prefilled from a chip and replaces that filter on update', () => {
    const applied: FilterSet = {
      groups: [
        {
          filters: [
            { key: 'ACOS', conditions: [{ operator: '>', values: ['30'] }] },
            { key: 'SEARCH_TERM', conditions: [{ operator: 'LIKE', values: ['widget'] }] },
          ],
        },
      ],
    };
    const { onFilterChange } = renderToolbar({ filter: applied });
    fireEvent.click(screen.getByRole('button', { name: 'Edit filter SEARCH_TERM' }));

    const column = screen.getByLabelText('Filter column') as HTMLSelectElement;
    const operator = screen.getByLabelText('Filter operator') as HTMLSelectElement;
    const value = screen.getByLabelText('Filter value') as HTMLInputElement;
    expect(column.value).toBe('SEARCH_TERM');
    expect(operator.value).toBe('LIKE');
    expect(value.value).toBe('widget');

    fireEvent.change(operator, { target: { value: 'NOT_LIKE' } });
    fireEvent.change(value, { target: { value: 'gadget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(onFilterChange).toHaveBeenLastCalledWith({
      groups: [
        {
          filters: [
            { key: 'ACOS', conditions: [{ operator: '>', values: ['30'] }] },
            { key: 'SEARCH_TERM', conditions: [{ operator: 'NOT_LIKE', values: ['gadget'] }] },
          ],
        },
      ],
    });
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });

  it('prefills a categorical chip with its selected values', () => {
    const applied: FilterSet = {
      groups: [{ filters: [{ key: 'MATCH_TYPE', conditions: [{ operator: 'IN', values: ['exact', 'phrase'] }] }] }],
    };
    renderToolbar({ filter: applied });
    fireEvent.click(screen.getByRole('button', { name: 'Edit filter MATCH_TYPE' }));
    expect((screen.getByLabelText('Filter column') as HTMLSelectElement).value).toBe('MATCH_TYPE');
    expect(screen.getByLabelText('Filter values').textContent).toContain('2 selected');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    expect((screen.getByLabelText('Filter column') as HTMLSelectElement).value).toBe('');
  });
});

describe('saved views', () => {
  const view: SavedView = {
    id: 'view-1',
    name: 'Monday pacing',
    entity: 'search_terms',
    columns: ['search_term', 'spend'],
    pinned: ['search_term'],
    widths: {},
    filter: { groups: [] },
    sort: [],
    groupBy: [],
    dateRange: null,
    updatedAt: '2026-09-05T00:00:00.000Z',
  };

  it('offers deletion for the view just applied and only when a remover exists', () => {
    const onApplyView = vi.fn();
    const onRemoveView = vi.fn();
    renderToolbar({ views: [view], onApplyView, onRemoveView });
    expect(screen.queryByRole('button', { name: /Delete view/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Saved view'), { target: { value: 'view-1' } });
    expect(onApplyView).toHaveBeenCalledWith(view);
    fireEvent.click(screen.getByRole('button', { name: 'Delete view Monday pacing' }));
    expect(onRemoveView).toHaveBeenCalledWith(view);

    cleanup();
    renderToolbar({ views: [view], onApplyView });
    fireEvent.change(screen.getByLabelText('Saved view'), { target: { value: 'view-1' } });
    expect(screen.queryByRole('button', { name: /Delete view/ })).toBeNull();
  });
});

describe('column picker', () => {
  it('groups columns by family and narrows every group with one search box', () => {
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: /^Columns \(/ }));
    const picker = screen.getByRole('region', { name: 'Column picker' });
    expect(within(picker).getByRole('group', { name: 'Attributes' })).toBeTruthy();
    expect(within(picker).getByRole('group', { name: 'Metrics, selected period' })).toBeTruthy();
    expect(within(picker).getByRole('group', { name: 'Change (Δ%)' })).toBeTruthy();

    fireEvent.change(within(picker).getByLabelText('Search columns'), { target: { value: 'acos prev' } });
    const boxes = within(picker).getAllByRole('checkbox');
    expect(boxes).toHaveLength(1);
    expect(within(picker).getByLabelText('ACOS (prev)')).toBeTruthy();
    expect(within(picker).queryByRole('group', { name: 'Attributes' })).toBeNull();

    fireEvent.change(within(picker).getByLabelText('Search columns'), { target: { value: 'zzz' } });
    expect(within(picker).getByText('No columns match this search.')).toBeTruthy();
  });
});

describe('density and fullscreen controls', () => {
  it('exposes the three densities and the fullscreen toggle when the host wires them', () => {
    const onDensityChange = vi.fn();
    const onFullscreenChange = vi.fn();
    renderToolbar({ density: 'normal', onDensityChange, fullscreen: false, onFullscreenChange });
    const density = screen.getByLabelText('Row density') as HTMLSelectElement;
    expect([...density.options].map((option) => option.value)).toEqual(['compact', 'normal', 'comfortable']);
    fireEvent.change(density, { target: { value: 'compact' } });
    expect(onDensityChange).toHaveBeenCalledWith('compact');

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    expect(onFullscreenChange).toHaveBeenCalledWith(true);

    cleanup();
    renderToolbar({ fullscreen: true, onFullscreenChange });
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeTruthy();
    cleanup();
    renderToolbar();
    expect(screen.queryByLabelText('Row density')).toBeNull();
    expect(screen.queryByRole('button', { name: /fullscreen/ })).toBeNull();
  });
});

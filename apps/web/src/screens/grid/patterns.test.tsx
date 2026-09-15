// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PerformanceVerdict } from '@wizard-ads/shared';
import { buildGridModel, columnsFor, type GridRow, type SavedView } from '@wizard-ads/ui';
import { PerformanceToolbar } from './performance-chrome';

const rows: GridRow[] = ['Efficient', 'Insufficient evidence'].map((verdict, index) => ({
  id: `synthetic-${index}`, currencyCode: 'USD', dimensions: { targeting: `Synthetic ${index}`, verdict },
  totals: { impressions: 100, clicks: 2, spend: 1, sales: 2, orders: 1, units: 1 }, comparison: null,
}));
function Toolbar() {
  const [view, setView] = useState<SavedView>({ id: 'synthetic', name: 'Synthetic', entity: 'targets', columns: ['targeting', 'verdict'], widths: {}, pinned: ['targeting'], filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '2026-08-29' });
  return <PerformanceToolbar entity="targets" view={view} available={columnsFor('targets')} visible={view.columns} filter={view.filter} groupBy={view.groupBy}
    model={buildGridModel(rows, { filter: view.filter, groupBy: view.groupBy })} optionRows={rows} profileId="synthetic"
    onVisibleChange={(columns) => setView({ ...view, columns })} onFilterChange={(filter) => setView({ ...view, filter })}
    onGroupByChange={(groupBy) => setView({ ...view, groupBy })} update={(patch) => setView({ ...view, ...patch })}
    onSaveColumnPreset={async () => {}} onTranslation={() => {}} onRefreshTranslation={() => {}} />;
}
it('shows every quick condition with a live count, adds/removes its ordinary chip, and opens the condition builder', () => {
  const { container } = render(<Toolbar />);
  expect(container.querySelectorAll('[data-quick-verdict]')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Filter (0)' }));
  const menu = screen.getByRole('region', { name: 'Quick filters' });
  expect(menu.querySelectorAll('[data-quick-verdict]')).toHaveLength(PerformanceVerdict.shape.diagnosis.options.length);
  expect(menu.querySelector('[data-quick-verdict="Efficient"] [data-quick-count]')?.textContent).toBe('1');
  expect(menu.querySelector('[data-quick-verdict="Insufficient evidence"] [data-quick-count]')?.textContent).toBe('1');
  fireEvent.click(within(menu).getByRole('button', { name: /Efficient/ }));
  expect(screen.getByText('VERDICT equals Efficient')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter VERDICT' }));
  expect(screen.queryByText('VERDICT equals Efficient')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Filter (0)' }));
  fireEvent.click(screen.getByRole('button', { name: '+ Add a condition on any column' }));
  expect(screen.getByLabelText('Filter column')).toBeTruthy();
  expect(screen.getAllByLabelText('Add grouping level')).toHaveLength(1);
  fireEvent.click(within(screen.getByRole('region', { name: 'Grid controls' })).getByRole('button', { name: 'Columns (2)' }));
  expect(screen.getByRole('dialog', { name: 'Adjust columns' })).toBeTruthy();
});

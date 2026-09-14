// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Tabs, tabFromSearchParams } from './Tabs.js';
import { EmptyState } from './EmptyState.js';
import { StatusChip, type StatusChipState } from './StatusChip.js';

afterEach(cleanup);
it('controls tab panels and updates only the tab query parameter with keyboard navigation', () => {
  const items = [{ value: 'overview', label: 'Overview', panel: 'Overview content' },
    { value: 'evidence', label: 'Evidence', panel: 'Evidence content' }];
  function Host() {
    const [query, setQuery] = useState('profile=synthetic&tab=evidence');
    const [value, setValue] = useState(tabFromSearchParams(query, 'overview'));
    return <><Tabs items={items} value={value} onValueChange={setValue} ariaLabel="Views"
      searchParams={query} onSearchParamsChange={setQuery} /><output>{query}</output></>;
  }
  render(<Host />);
  expect(screen.getAllByRole('tab')).toHaveLength(items.length);
  expect(screen.getByRole('tabpanel').textContent).toBe('Evidence content');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Evidence' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tabpanel').textContent).toBe('Overview content');
  expect(screen.getByRole('status').textContent).toBe('profile=synthetic&tab=overview');
});
it('names each status and keeps missing measurement distinct from access gates', () => {
  const states: StatusChipState[] = ['working', 'needs-data', 'idea'];
  const { container } = render(<>{states.map((status) => <StatusChip key={status} status={status} />)}
    <EmptyState variant="not-measured" title="Not measured" body="Awaiting a report" />
    <EmptyState variant="gated" title="Access required" body="Ask an owner for access" /></>);
  expect(container.querySelectorAll('[data-status]')).toHaveLength(states.length);
  expect(container.querySelector('[data-status="needs-data"]')?.getAttribute('style')).toContain('--wa-warn-text');
  expect(container.querySelector('[data-state="not-measured"]')?.textContent).toContain('Awaiting a report');
  expect(container.querySelector('[data-state="gated"]')?.textContent).toContain('Ask an owner');
});

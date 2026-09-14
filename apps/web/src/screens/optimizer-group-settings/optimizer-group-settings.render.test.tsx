// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { populated } from '../optimizer-groups/render-fixture';
import { GroupMembers } from './members';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import Screen from './view';
import { descriptor } from './descriptor';
const mounted: Array<ReturnType<typeof createRoot>> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { act(() => mounted.splice(0).forEach((root) => root.unmount())); document.body.replaceChildren(); vi.unstubAllGlobals(); });
verifyScreen(descriptor, [
  { state: 'loading', name: 'loading settings', render: () => <p aria-busy="true">Loading settings…</p>, text: 'Loading' },
  { state: 'error', name: 'settings error', render: () => <SharedError error={new Error('Synthetic error')} reset={() => {}} />, text: 'Try again' },
  { state: 'gated', name: 'settings gate', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'empty profile settings', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles' },
  { state: 'ready', name: 'group settings and weekday editor', render: () => <Screen data={{ view: 'ready', props: { ...populated.props, record: populated.props.workspace.groups[0]!, editing: true } }} />, text: 'Review weekdays' },
  { state: 'ready', name: 'missing group preserves profile boundary', render: () => <Screen data={{ view: 'missing', props: { profileId: '33333333-3333-4333-8333-333333333333' } }} />, text: 'Group unavailable' },
]);
it('shows loaded members and a failed member reload explicitly', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); mounted.push(root);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  act(() => root.render(<GroupMembers profileId="33333333-3333-4333-8333-333333333333" groupId="11111111-1111-4111-8111-111111111111" initial={{ groups: [], campaigns: [{ campaignId: 'synthetic-campaign', name: 'Synthetic campaign', adProduct: 'SP', state: 'enabled', dailyBudget: null, groupId: '11111111-1111-4111-8111-111111111111' }], profileTimezone: 'UTC', reviewHour: 4, assignedCampaigns: 1, unassignedCampaigns: 0 }} />));
  act(() => host.querySelector('button')!.click()); expect(host.textContent).toContain('Synthetic campaign');
  await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reload members')!.click(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Members could not be loaded. Try again.');
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { COORDINATED_METHOD, REFERENCE_METHOD } from '@wizard-ads/shared';
import { OPTIMIZATION_METHOD_CATALOGUE } from '@wizard-ads/core';
import SharedError from '../shared-error';
import { verifyScreen } from '../render-test-support';
import { descriptor } from './descriptor';
import Screen from './view';
import { MethodPicker, MethodIdentifiers } from './picker';
import { Info } from './info';
const mounted: Array<ReturnType<typeof createRoot>> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { act(() => { mounted.splice(0).forEach((root) => root.unmount()); }); document.body.replaceChildren(); });
verifyScreen(descriptor, [
  { state: 'loading', name: 'shows loading', render: () => <p aria-busy="true">Loading methods…</p>, text: 'Loading methods' },
  { state: 'error', name: 'shows a recoverable error', render: () => <SharedError error={new Error('Synthetic method error')} reset={() => {}} />, text: 'Try again' },
  { state: 'gated', name: 'explains a missing database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'shows an empty profile roster', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles' },
  { state: 'ready', name: 'renders catalogue and goals', render: () => <Screen data={{ view: 'ready', props: { profileId: '33333333-3333-4333-8333-333333333333', groups: [] } }} />, text: 'Campaign goals' },
]);
it('renders all nine identifiers with exact release states from core', () => {
  const markup = renderToStaticMarkup(<MethodIdentifiers />);
  OPTIMIZATION_METHOD_CATALOGUE.forEach((entry) => { expect(markup).toContain(entry.id); expect(markup).toContain(entry.version); });
  expect((markup.match(/<tr>/g) ?? []).length).toBe(10);
});
it('keeps drafts disabled and selects the shadow method for preview only', () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); mounted.push(root);
  const onSelect = vi.fn(); act(() => root.render(<MethodPicker selection={REFERENCE_METHOD} onSelect={onSelect} />));
  const buttons = () => [...host.querySelectorAll('button')];
  expect(buttons().filter((button) => button.disabled)).toHaveLength(7);
  act(() => buttons().find((button) => button.textContent === 'SP placement efficiency')!.click());
  expect(host.textContent).toContain('Shadow preview only. This method cannot send changes to Amazon.');
  act(() => buttons().find((button) => button.textContent === 'Use SP placement efficiency')!.click());
  expect(onSelect).toHaveBeenCalledWith(COORDINATED_METHOD);
});
it('opens information on hover and click, persists between trigger and content, and returns focus on Escape', () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); mounted.push(root);
  act(() => root.render(<Info label="Method information"><a href="#method">Recorded method identity</a></Info>));
  const button = host.querySelector('button')!;
  act(() => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  act(() => host.querySelector('a')!.focus());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  act(() => host.querySelector('a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(button);
  act(() => button.click()); expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});

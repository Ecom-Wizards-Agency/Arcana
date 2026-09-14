// @vitest-environment jsdom
import { expect, it } from 'vitest';
import Loading from '../../../app/optimizer/help/loading';
import { rendered, verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import Screen, { OptimizationHelp } from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders loading help', render: () => <Loading />, text: 'Loading optimization help' },
  { state: 'error', name: 'renders the shared error reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-help' })} reset={() => {}} />, text: 'synthetic-help' },
  { state: 'gated', name: 'explains unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'renders absent profiles', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles yet' },
  { state: 'ready', name: 'renders all four help sections', render: () => <OptimizationHelp profileId="synthetic-profile" />, text: 'live parity has not been established' },
  { state: 'ready', name: 'renders the recorded worked example', render: () => <OptimizationHelp profileId="synthetic-profile" example />, text: '9. Rounding and exposure recheck' },
]);

it('keeps four help sections and profile-scoped links', () => {
  const host = rendered(<OptimizationHelp profileId="synthetic-profile" />);
  expect([...host.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['Review what changes', 'Understand a suggestion', 'Changes that depend on each other', 'Method availability']);
  expect([...host.querySelectorAll('a')].every((link) => link.getAttribute('href')?.includes('profile=synthetic-profile'))).toBe(true);
});

it('keeps worked-example navigation on the canonical profile instead of its synthetic row profile', () => {
  const host = rendered(<OptimizationHelp profileId="synthetic-canonical-profile" example />);
  const links = [...host.querySelectorAll('a')];
  expect(links).toHaveLength(3);
  expect(links.every((link) => link.getAttribute('href')?.includes('profile=synthetic-canonical-profile'))).toBe(true);
});

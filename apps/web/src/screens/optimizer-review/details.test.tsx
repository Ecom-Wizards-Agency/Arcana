// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { OneTimeRpcSnapshot } from '@wizard-ads/shared';
import { populated } from '../optimizer-groups/render-fixture';
import { rendered } from '../render-test-support';
import { RunDetails } from './details';
import { review } from './render-fixture';

const executionSnapshot = OneTimeRpcSnapshot.parse({ version: 1, methodId: 'sp.reference-efficiency', methodVersion: 'reference.1',
  profileTimezone: 'UTC', admittedAt: '2026-07-30T00:00:00.000Z', profileToday: '2026-07-30',
  configuration: { version: 1, method: 'sp.reference-efficiency', targetAcos: 0.36, bidFloor: 0.09, bidCeiling: 0.91, bidIncreaseCap: 0.19, bidDecreaseCap: 0.58, window: { start: '2026-07-01', end: '2026-07-28' } },
});

it('distinguishes requested dates from unrecorded completed-report coverage', () => {
  const host = rendered(<RunDetails review={{ ...review, executionSnapshot }} currencyCode="USD" marketplace="US" />);
  const rows = [...host.querySelectorAll('tr')];
  const requested = rows.find((row) => row.firstElementChild?.textContent === 'Requested calendar days');
  const completed = rows.find((row) => row.firstElementChild?.textContent === 'Completed report days');
  expect(requested?.children[1]?.textContent).toBe('28');
  expect(completed?.children[1]?.textContent).toBe('Unavailable');
  expect(completed?.children[2]?.textContent).toContain('coverage was not recorded');
  for (const field of ['Currency', 'Marketplace']) expect(rows.find((row) => row.firstElementChild?.textContent === field)?.children[2]?.textContent).toBe('Current profile metadata; not recorded in the run snapshot');
});
it('labels the requested run field separately from the group ACOS', () => {
  const group = populated.props.workspace.groups[0]!.group;
  const data = { ...review, executionSnapshot, children: review.children.map((child) => ({ ...child, run: { ...child.run, groupSnapshot: { ...group, profileId: review.profileId } } })) };
  const host = rendered(<RunDetails review={data} currencyCode="USD" marketplace="US" />);
  expect(host.textContent).toContain(`Target ACOS ${group.targetAcos * 100}% · assigned group`);
  expect(host.textContent).toContain('Requested run-field target ACOS: 36%. Assigned group values take precedence.');
  expect(host.textContent).not.toContain('Confirmed target ACOS');
});
it('does not attach a percent sign or empty date range to missing settings', () => {
  const host = rendered(<RunDetails review={review} currencyCode="USD" marketplace="US" />);
  expect(host.textContent).toContain('Requested run-field target ACOS: Unavailable.');
  expect(host.textContent).toContain('Requested reporting window: Unavailable · Timezone: Unavailable');
  expect(host.textContent).not.toContain('Unavailable%');
});

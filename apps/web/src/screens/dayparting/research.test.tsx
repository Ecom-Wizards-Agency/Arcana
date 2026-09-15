// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { DaypartingWorkspaceView, DaypartingResultsView, ScheduleExecutionStatus } from './workspace';
import { daypartingFixture, dayEvidence, syntheticSchedule } from './render-fixture';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
for (const state of ['draft', 'reviewed', 'enabled', 'paused'] as const) it(`renders the ${state} schedule with all 168 original modifiers`, () => {
  const { container } = render(<DaypartingWorkspaceView data={daypartingFixture(state)} measurement={<p>Existing hourly measurement</p>} />);
  expect(screen.getAllByRole('gridcell')).toHaveLength(168);
  expect(container.querySelector('[data-schedule-state]')?.getAttribute('data-schedule-state')).toBe(state);
  expect(screen.getByRole('gridcell', { name: 'Mon 17:00 37%' })).toBeDefined();
  if (state === 'enabled') expect(screen.getByText(/Next run at 2026-06-08T11:07:00Z/)).toBeDefined();
});
it('reviews and exports while enable stays disabled with its truthful reason', () => {
  render(<DaypartingWorkspaceView data={daypartingFixture('reviewed')} initialSurface="review" initialEvidence={dayEvidence} measurement={null} />);
  const enable = screen.getByRole('button', { name: 'Yes, enable this schedule for 1 campaign(s)' });
  expect(enable.hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Scheduled writes are not available yet. The reviewed schedule can be exported.')).toBeDefined();
  expect(screen.getByRole('link', { name: 'Export CSV' })).toBeDefined();
});
it('requires evidence review and never treats an empty report as a completed review', () => {
  render(<DaypartingWorkspaceView data={daypartingFixture()} initialSurface="review" measurement={null} />);
  expect(screen.getByRole('button', { name: 'Enable after evidence review' }).hasAttribute('disabled')).toBe(true);
});
it('renders insufficient suggestions and preserves the route to the hourly measurement', () => {
  render(<DaypartingWorkspaceView data={daypartingFixture()} initialTab="suggestions" measurement={<p>Existing hourly measurement</p>} />);
  expect(screen.getByText('Not enough hourly data to suggest a schedule')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'View hourly evidence' }));
  expect(screen.getByText('Existing hourly measurement')).toBeDefined();
  expect(screen.getByText('Unavailable in this report')).toBeDefined();
});
it('shows available, mature evidence for exactly the selected campaign', () => {
  render(<DaypartingWorkspaceView data={daypartingFixture()} initialSurface="evidence" initialEvidence={dayEvidence} measurement={null} />);
  expect(screen.getByText('Available in this report')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Record evidence review' }).hasAttribute('disabled')).toBe(false);
});
it('renders proposal rows without changing the saved schedule', () => {
  const data = daypartingFixture();
  data.proposals = [{
    id: syntheticSchedule().id,
    profileId: data.profile.id,
    campaignId: 'synthetic-campaign',
    baselineLabel: 'Synthetic alternative',
    evidenceStart: '2026-06-01',
    evidenceEnd: '2026-06-07',
    settledHours: 168,
    blocks: [{
      dayOfWeek: 1,
      startHour: 17,
      endHour: 21,
      adjustmentPercent: 37,
      confidence: 0.8
    }],
    status: 'proposed'
  }];
  render(<DaypartingWorkspaceView data={data} initialTab="suggestions" measurement={null} />);
  expect(screen.getByText('Mon 17:00–21:00 +37%')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByText('Save this draft before reviewing evidence')).toBeDefined();
  expect(data.research.schedules[0]!.name).toBe('Synthetic schedule');
});
it('renders pending before maturity and observed results afterwards', () => {
  const result = {
    before: {
      start: '2026-06-01',
      end: '2026-06-07',
      spend: 137,
      sales: 411,
      orders: 9,
      acos: 137 / 411,
      complete: true
    },
    after: {
      start: '2026-06-09',
      end: '2026-06-15',
      spend: 149,
      sales: 447,
      orders: 11,
      acos: 149 / 447,
      complete: true
    },
    mature: false,
    events: []
  };
  const { rerender } = render(<DaypartingResultsView schedule={syntheticSchedule('enabled')} results={result} currencyCode="USD" />);
  expect(screen.getAllByText('Pending')).toHaveLength(4);
  rerender(<DaypartingResultsView schedule={syntheticSchedule('enabled')} results={{
    ...result,
    mature: true
  }} currencyCode="USD" />);
  expect(screen.queryByText('Pending')).toBeNull();
  expect(screen.getByText(/They do not establish that dayparting caused/)).toBeDefined();
});
it('opens the stop popover by keyboard and returns focus on Escape without a mutation', () => {
  render(<ScheduleExecutionStatus schedule={syntheticSchedule('enabled')} onReview={() => { }} onResults={() => { }} />);
  const trigger = screen.getByRole('button', { name: 'Stop all scheduled writes' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog').textContent).toContain('Requests already sent to Amazon may still finish');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('keeps the web schedule mutation surface limited to save draft and record review', () => {
  const save = readFileSync('app/api/dayparting/schedules/route.ts', 'utf8');
  const review = readFileSync('app/api/dayparting/schedules/review/route.ts', 'utf8');
  expect(save).toContain('DaypartingDraftInput.safeParse');
  expect(review).toContain('DaypartingReviewInput.safeParse');
  expect(save + review).not.toMatch(/status\s*:\s*['"](?:enabled|paused)['"]/);
});

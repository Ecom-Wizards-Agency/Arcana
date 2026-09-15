// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecommendationRecord } from '@wizard-ads/db';
import { CalculationTrace, DependencySet, type Hold } from '@wizard-ads/shared';
import { CalculationContent, InfoPopover, ReviewContent } from './components';
import { changedPercent, recordedDependencyExposures, reviewUnits, selectedChangeCount } from './model';
import { workedDependencySet, workedPeakExposures, workedPlacementInputs, workedPlacementRow, workedPlacementTrace } from './worked-example';

afterEach(cleanup);
const { trace: _trace, dependencySet: _dependency, ...referenceInputs } = workedPlacementRow.inputs;
const first: RecommendationRecord = { ...workedPlacementRow, id: 'synthetic-first', entityName: 'Synthetic target A', inputs: { ...referenceInputs, methodId: 'sp.reference-efficiency', methodVersion: 'reference.1' } };
const second: RecommendationRecord = { ...first, id: 'synthetic-second', entityName: 'Synthetic target B', currentValue: 0.87, proposedValue: 0.69 };
const hold: Hold = { reason: 'NO_FEASIBLE_CONTROL_SET', prose: 'The recorded exposure ceiling and bid reduction limit conflict.', affectedScope: [workedDependencySet.changes[0]!.entityRef], reconsiderWhen: 'Review the saved group limits.' };

function ReviewHost({ initial = [], shadow = false }: { initial?: string[]; shadow?: boolean }) {
  const [selected, setSelected] = useState(new Set(initial));
  const rows = shadow ? [workedPlacementRow] : [first, second];
  return <ReviewContent rows={rows} selected={selected} onToggle={(ids) => setSelected((old) => {
    const next = new Set(old); const remove = ids.every((id) => old.has(id));
    for (const id of ids) { if (remove) next.delete(id); else next.add(id); } return next;
  })} onClear={() => setSelected(new Set())} onContinue={() => {}} profileId="synthetic-profile" batchId="synthetic-batch" currencyCode="USD" holds={[hold]} evaluatedTargets={4}
    unchanged={[{ id: 'synthetic-unchanged', name: 'Synthetic unchanged target', campaignName: null, currentValue: 0.82, proposedValue: 0.82, reason: 'Recorded rank gate' }]}
    details={<p>Saved snapshot version synthetic-v1</p>} />;
}

describe('review state rendering', () => {
  it.each([
    { initial: [], label: 'Select changes to continue', disabled: true },
    { initial: [first.id], label: 'Review 1 selected change', disabled: false },
    { initial: [first.id, second.id], label: 'Review 2 selected changes', disabled: false },
  ])('renders $label from the selected saved rows', ({ initial, label, disabled }) => {
    render(<ReviewHost initial={initial} />);
    expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(disabled);
    expect(screen.getByTestId('optimizer-evaluation-totals').textContent).toBe('4 targets evaluated: 2 suggestions, 1 unchanged, 1 blocked.');
  });
  it('selects both rows, clears them and preserves full recorded detail', () => {
    render(<ReviewHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Select both changes' }));
    expect(screen.getByRole('button', { name: 'Review 2 selected changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect((screen.getByRole('checkbox', { name: 'Select Synthetic target A' }) as HTMLInputElement).checked).toBe(false);
    const details = screen.getAllByRole('table', { name: 'Full preview details', hidden: true })[0]!;
    for (const label of ['Rank group', 'Evidence window', 'Clicks', 'Orders', 'CVR', 'RPC', 'Change %', 'Bounds hit', 'Method · version']) expect(within(details).getByText(label)).toBeTruthy();
  });
  it('renders retained unchanged rows without selectable controls', () => {
    render(<ReviewHost />); fireEvent.click(screen.getByRole('tab', { name: 'Unchanged 1' }));
    expect(screen.getByText('Recorded rank gate')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText(/They cannot be selected for sending/)).toBeTruthy();
  });
  it('renders the complete hold and immutable run details in separate tabs', () => {
    render(<ReviewHost />); fireEvent.click(screen.getByRole('tab', { name: 'Blocked 1' }));
    expect(screen.getByText(hold.prose)).toBeTruthy(); expect(screen.getByText(hold.reconsiderWhen)).toBeTruthy();
    expect(screen.getByText('NO_FEASIBLE_CONTROL_SET')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Run details' }));
    expect(screen.getByText('Saved snapshot version synthetic-v1')).toBeTruthy();
  });
  it('opens tabs through the keyboard and keeps focus on the active tab', () => {
    render(<ReviewHost />); const tab = screen.getByRole('tab', { name: 'Suggestions 2' }); tab.focus();
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Unchanged 1' }));
    expect(screen.getByText('Recorded rank gate')).toBeTruthy();
  });
  it('selects a dependency as one unit and never enables shadow confirmation', () => {
    render(<ReviewHost shadow />);
    fireEvent.click(screen.getByRole('checkbox', { name: /and its dependent changes/ }));
    expect((screen.getByRole('button', { name: 'Send to Amazon unavailable in shadow' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
    const units = reviewUnits([workedPlacementRow, { ...workedPlacementRow, id: 'other-dependency-row' }]);
    expect(units).toHaveLength(1);
    expect(selectedChangeCount(units, new Set([workedPlacementRow.id, 'other-dependency-row']))).toBe(3);
  });
  it('names successful exclusions in the refreshed retry preview', () => {
    const toggle = vi.fn(); render(<ReviewContent rows={[second]} selected={new Set([second.id])} onToggle={toggle} onContinue={() => {}} profileId="synthetic-profile" batchId="synthetic-retry" currencyCode="USD" retry={{ excludedSuccessfulNames: ['Synthetic target A'] }} />);
    expect(screen.getByText(/earlier successful changes are excluded: Synthetic target A/)).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Suggested changes' }).querySelectorAll(':scope > tbody > tr')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Review 1 selected change' })).toBeTruthy();
    expect(screen.getByText(/Evaluated target total unavailable/)).toBeTruthy();
  });
  it('preserves unknown historical partition counts and refuses mismatched known counts', () => {
    const props = { rows: [first], selected: new Set([first.id]), onToggle: () => {}, onContinue: () => {}, profileId: 'synthetic-profile', batchId: 'synthetic-batch', currencyCode: 'USD' };
    const view = render(<ReviewContent {...props} population={{ suggestions: null, unchanged: null, blocked: null }} />);
    expect(screen.getByRole('tab', { name: 'Unchanged Unavailable' })).toBeTruthy();
    expect(screen.getByTestId('optimizer-evaluation-totals').textContent).toContain('Unavailable unchanged');
    view.rerender(<ReviewContent {...props} evaluatedTargets={3} population={{ suggestions: 1, unchanged: 0, blocked: 0 }} />);
    expect(screen.getByRole('alert').textContent).toContain('do not reconcile');
    expect((screen.getByRole('button', { name: 'Review 1 selected change' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('recorded calculation rendering', () => {
  it('shows unavailable calculation without inventing a reference trace', () => {
    render(<CalculationContent row={first} currencyCode="USD" backHref="/optimizer/review/synthetic" />);
    expect(screen.getByRole('heading', { name: 'Recorded calculation unavailable' })).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Recorded calculation steps' })).toBeNull();
    expect(screen.getByText(/Change:.*− old/)).toBeTruthy();
    expect(changedPercent(null, 0.7)).toBeNull(); expect(changedPercent(0, 0.7)).toBeNull();
  });
  it('renders a saved reference trace whenever it exists', () => {
    render(<CalculationContent row={{ ...first, inputs: { ...first.inputs, trace: workedPlacementTrace } }} currencyCode="USD" backHref="/optimizer/review/synthetic" />);
    expect(screen.queryByRole('heading', { name: 'Recorded calculation unavailable' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Recorded calculation steps' }).querySelectorAll('tbody tr')).toHaveLength(workedPlacementTrace.steps.length);
    for (const step of workedPlacementTrace.steps) expect(screen.getByText(step.formula)).toBeTruthy();
  });
  it('keeps all nine worked steps, inputs, limits, ordering and three controls', () => {
    expect(CalculationTrace.parse(workedPlacementTrace)).toEqual(workedPlacementTrace);
    expect(DependencySet.parse(workedDependencySet)).toEqual(workedDependencySet);
    render(<CalculationContent row={workedPlacementRow} currencyCode="USD" backHref="/optimizer/help" peakExposureByStep={workedPeakExposures} placementInputs={workedPlacementInputs} workedExample />);
    expect(screen.getByRole('table', { name: 'Recorded calculation steps' }).querySelectorAll('tbody tr')).toHaveLength(9);
    expect(screen.getByRole('table', { name: 'Ordered dependent writes' }).querySelectorAll('tbody tr')).toHaveLength(3);
    expect(screen.getByRole('table', { name: 'Placement report inputs' }).querySelectorAll('tbody tr')).toHaveLength(4);
    expect(screen.getByText(/Partial-failure rule:/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send to Amazon unavailable in shadow' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('reads intermediate exposure from the saved trace and leaves absent steps unrecorded', () => {
    const values = [0.43, 0.91, 1.07];
    const steps = values.map((result, index) => ({ index, label: `Intermediate exposure: step ${index + 1}`,
      formula: 'Recorded exposure check', inputs: [], intermediateValue: null, boundApplied: null, result }));
    const trace = CalculationTrace.parse({ steps, finalResult: values[2], roundingStep: steps[2] });
    const row = { ...workedPlacementRow, inputs: { ...workedPlacementRow.inputs, trace } };
    render(<CalculationContent row={row} currencyCode="USD" backHref="/optimizer" />);
    const rows = screen.getByRole('table', { name: 'Ordered dependent writes' }).querySelectorAll('tbody tr');
    expect([...rows].map((row) => row.lastElementChild?.textContent)).toEqual(['$0.43', '$0.91', '$1.07']);
    expect(recordedDependencyExposures(workedPlacementRow)).toEqual([null, null, null]);
  });
  it('keeps missing dependency evidence unavailable while blocking shadow sending', () => {
    const { dependencySet: _missing, ...inputs } = workedPlacementRow.inputs;
    render(<CalculationContent row={{ ...workedPlacementRow, inputs }} currencyCode="USD" backHref="/optimizer" />);
    expect(screen.getByText('Shadow preview · Dependent change count unavailable.')).toBeTruthy();
    expect(screen.getByText('Recorded dependency evidence is unavailable for this preview.')).toBeTruthy();
    expect(screen.queryByText(/0 changes reviewed together/)).toBeNull();
    expect(screen.queryByRole('table', { name: 'Ordered dependent writes' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Send to Amazon unavailable in shadow' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('opens info on hover, click and Enter; persists within content and returns focus on Escape', () => {
    render(<InfoPopover label="Exposure information">Configured exposure is not a CPC forecast.</InfoPopover>);
    const trigger = screen.getByRole('button', { name: 'Exposure information' });
    fireEvent.mouseEnter(trigger); expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole('tooltip')); expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('tooltip')).toBeNull(); expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger); expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(trigger, { key: 'Enter' }); expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(document.activeElement).toBe(trigger);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultsContent } from './components';
import { observationAnswers, operationCounts } from './model';
import { resultFixture as fixture } from './render-fixture';

afterEach(cleanup);
describe('saved operation results', () => {
  it('shows a gate-off approval waiting for the worker without an applied outcome', () => {
    const data = fixture(2, 'queued'); render(<ResultsContent {...data} executionGate={{ enabled: false, name: 'SYNTHETIC_WORKER_GATE' }} />);
    expect(screen.getByRole('heading', { name: 'Approved · waiting for the worker' })).toBeTruthy();
    expect(screen.getByText('SYNTHETIC_WORKER_GATE')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /applied/i })).toBeNull();
    expect(screen.getAllByText('Not yet answerable')).toHaveLength(3);
    expect(screen.getByText(/You can leave this page/)).toBeTruthy();
  });
  it('renders sending and accepted rows while the operation is in flight', () => {
    const data = fixture(2, 'running', { pendingDispatch: 1, intentCommitted: 1, providerAccepted: 1, pendingObservation: 1, providerCallsCommitted: 1, providerCallsCompleted: 1 });
    data.rows[0]!.status = 'accepted'; data.rows[1]!.status = 'sending'; render(<ResultsContent {...data} />);
    expect(screen.getByText('Accepted by Amazon · Waiting for sync')).toBeTruthy(); expect(screen.getByText('Sending')).toBeTruthy();
    expect(screen.getByText(/not yet marked applied/)).toBeTruthy();
    expect(screen.getByTestId('optimizer-result-counts').textContent).toBe('Requested 2 · Attempted 1 · Accepted 1 · Failed 0 · Confirmed in sync 0');
  });
  it('renders a single acceptance awaiting sync, preserving unknown observations', () => {
    const data = fixture(1, 'awaiting_observation', { pendingDispatch: 0, intentCommitted: 1, providerAccepted: 1, pendingObservation: 1, providerCallsCommitted: 1, providerCallsCompleted: 1 });
    data.rows[0]!.status = 'accepted'; render(<ResultsContent {...data} executionVerdict="applied_as_intended" objectiveVerdict="supported_lift" calculationVerdict="yes" />);
    expect(screen.getByRole('heading', { name: '1 change accepted by Amazon · Waiting for the updated bid to appear in sync.' })).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getAllByText('Not yet answerable')).toHaveLength(3);
  });
  it('reads partial-result counts from operation detail and reconciles them', () => {
    const data = fixture(2, 'partial', { pendingDispatch: 0, intentCommitted: 2, providerAccepted: 1, providerRejected: 1, observedRequested: 1, providerCallsCommitted: 1, providerCallsCompleted: 1 });
    data.rows[0] = { ...data.rows[0]!, status: 'observed', observed: '0.69' }; data.rows[1] = { ...data.rows[1]!, status: 'failed', retryEligible: true };
    const retry = vi.fn(); render(<ResultsContent {...data} onRetry={retry} executionVerdict="synchronization_conflict" objectiveVerdict="evidence_insufficient" calculationVerdict="yes" />);
    expect(screen.getByRole('heading', { name: '1 change applied. 1 needs attention.' })).toBeTruthy();
    expect(screen.getByTestId('optimizer-result-counts').textContent).toBe('Requested 2 · Attempted 2 · Accepted 1 · Failed 1 · Confirmed in sync 1');
    const table = screen.getByRole('table', { name: 'Reconciliation counts' });
    expect([...table.querySelectorAll('tbody tr')].map((row) => row.textContent)).toEqual(['Requested2', 'Admitted2', 'Attempted2', 'Succeeded1', 'Failed or refused1', 'Observed in sync1']);
    const c = operationCounts(data.detail); expect(c.requested).toBe(c.attempted + c.refused); expect(c.attempted).toBe(c.succeeded + c.failed); expect(c.observed).toBeLessThanOrEqual(c.succeeded);
    expect(observationAnswers(data.detail, 'synchronization_conflict', 'evidence_insufficient', 'yes')).toEqual({ calculation: 'Yes', execution: 'Partly', objective: 'Not yet answerable' });
    expect(observationAnswers(data.detail, 'not_synchronized', 'evidence_insufficient').execution).toBe('Partly');
    fireEvent.click(screen.getByRole('button', { name: 'Review failed change' })); expect(retry).toHaveBeenCalledOnce();
  });
  it('renders retry results with their own count and excluded successful name', () => {
    const data = fixture(1, 'succeeded', { pendingDispatch: 0, intentCommitted: 1, providerAccepted: 1, observedRequested: 1, providerCallsCommitted: 1, providerCallsCompleted: 1 });
    data.rows[0] = { ...data.rows[0]!, status: 'observed', observed: '0.69' };
    render(<ResultsContent {...data} retry={{ excludedSuccessfulNames: ['Synthetic earlier success'] }} />);
    expect(screen.getByText(/Synthetic earlier success was not sent again/)).toBeTruthy();
    expect(screen.getByTestId('optimizer-result-counts').textContent).toContain('Requested 1 · Attempted 1');
  });
  it('keeps ambiguous provider outcomes distinct from failures and refuses blind retry', () => {
    const data = fixture(1, 'ambiguous', { pendingDispatch: 0, intentCommitted: 1, providerAmbiguous: 1, pendingObservation: 1, providerCallsCommitted: 1 });
    data.rows[0]!.status = 'ambiguous'; render(<ResultsContent {...data} onRetry={() => {}} />);
    expect(screen.getByTestId('optimizer-result-counts').textContent).toContain('Accepted 0 · Failed 0');
    expect(screen.getByText(/cannot be retried blindly/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Review failed/ })).toBeNull();
  });
  it('names missing row evidence while preserving saved counts and immutable details', () => {
    const data = fixture(2, 'queued'); render(<ResultsContent {...data} rows={[]} details={<p>Completed report days: unavailable</p>} />);
    expect(screen.getByRole('alert').textContent).toContain('0 of 2 approved rows loaded');
    expect(within(screen.getByRole('table', { name: 'Run change results' })).queryAllByRole('row')).toHaveLength(1);
    expect(screen.getByTestId('optimizer-result-counts').textContent).toContain('Requested 2');
    expect(screen.getByText('Completed report days: unavailable')).toBeTruthy();
  });
});

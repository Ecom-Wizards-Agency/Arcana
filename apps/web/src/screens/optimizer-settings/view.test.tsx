// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { OneTimeRpcConfiguration } from '@wizard-ads/shared';
import { chooserReady } from '../optimizer/choose-fixture';
import { readOptimizerDraft } from '../optimizer/draft';
import { RunSettings } from './view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => { cleanup(); sessionStorage.clear(); });
const configuration: OneTimeRpcConfiguration = { version: 2, method: 'sp.coordinated-efficiency', targetAcos: 0.37,
  bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41,
  window: { start: '2026-07-01', end: '2026-07-28' }, exposureCeiling: 2.3,
  minClicksPerPlacement: 17, placementEvidenceRequirements: 'validated_homogeneous' };
const campaignIds = chooserReady.props.campaignRows.map((row) => row.campaignId);

it('preserves a saved shadow default and its settings when reopening and saving the draft', () => {
  render(<RunSettings data={chooserReady} initialDraft={{ campaignIds, configuration }} />);
  expect((screen.getByLabelText('Exposure ceiling (USD)') as HTMLInputElement).value).toBe('2.3');
  expect((screen.getByLabelText('Minimum clicks per placement') as HTMLInputElement).value).toBe('17');
  expect((screen.getByLabelText('Placement evidence') as HTMLSelectElement).value).toBe('validated_homogeneous');
  const submit = screen.getByRole('button', { name: 'Save settings and continue' });
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  fireEvent.submit(submit.closest('form')!);
  expect(readOptimizerDraft(chooserReady.props.profile.id).configuration).toEqual(configuration);
});

it('retains edited limits and dates when selecting a different method', () => {
  const initial = { campaignIds, configuration: { ...configuration, version: 1 as const, method: 'sp.reference-efficiency' as const } };
  render(<RunSettings data={chooserReady} initialDraft={initial} />);
  fireEvent.change(screen.getByLabelText('Target ACOS (%)'), { target: { value: '41' } });
  fireEvent.change(screen.getByLabelText('Reporting start'), { target: { value: '2026-07-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change method' }));
  fireEvent.click(screen.getByRole('button', { name: 'SP placement efficiency' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use SP placement efficiency' }));
  expect((screen.getByLabelText('Target ACOS (%)') as HTMLInputElement).value).toBe('41');
  expect((screen.getByLabelText('Reporting start') as HTMLInputElement).value).toBe('2026-07-02');
  fireEvent.change(screen.getByLabelText('Exposure ceiling (USD)'), { target: { value: '2.7' } });
  fireEvent.change(screen.getByLabelText('Minimum clicks per placement'), { target: { value: '19' } });
  const submit = screen.getByRole('button', { name: 'Save settings and continue' });
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  fireEvent.submit(submit.closest('form')!);
  const saved = readOptimizerDraft(chooserReady.props.profile.id);
  expect(saved.configuration).toMatchObject({ version: 2, method: 'sp.coordinated-efficiency', targetAcos: 0.41,
    window: { start: '2026-07-02', end: '2026-07-28' }, exposureCeiling: 2.7, minClicksPerPlacement: 19 });
  expect(Object.keys(saved.campaignMethods ?? {}).sort()).toEqual([...campaignIds].sort());
});

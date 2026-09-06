import { afterEach, expect, it, vi } from 'vitest';
import { startRecommendationRuntimeReporting } from './runtime-report.js';
import type { RecommendationClaimantStatus } from './claimant.js';

const healthy: RecommendationClaimantStatus = { phase: 'executing', ready: true, inFlight: 1,
  resumeComplete: true, settlementFailure: null };
afterEach(() => { vi.useRealTimers(); });

it('reports compiled support while busy and withdraws it on failure and shutdown', async () => {
  vi.useFakeTimers();
  let state = healthy;
  const reportRuntime = vi.fn(async () => {});
  const reports = startRecommendationRuntimeReporting({ reportRuntime }, { status: () => state });
  await vi.advanceTimersByTimeAsync(0);
  expect(reportRuntime).toHaveBeenLastCalledWith([1, 2], true);
  state = { ...healthy, ready: false, settlementFailure: 'settlement_ambiguous' };
  await vi.advanceTimersByTimeAsync(15_000);
  expect(reportRuntime).toHaveBeenLastCalledWith([1, 2], false);
  await reports.stop();
  expect(reportRuntime).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reportRuntime).toHaveBeenCalledTimes(3);
});

it('serializes pending reports before shutdown so a late ready response cannot overwrite withdrawal', async () => {
  vi.useFakeTimers();
  let finish = () => {};
  const reportRuntime = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
    .mockResolvedValue(undefined);
  const reports = startRecommendationRuntimeReporting({ reportRuntime }, { status: () => healthy });
  await vi.advanceTimersByTimeAsync(45_000);
  expect(reportRuntime).toHaveBeenCalledTimes(1);
  const stopped = reports.stop();
  finish();
  await stopped;
  expect(reportRuntime).toHaveBeenCalledTimes(2);
  expect(reportRuntime).toHaveBeenLastCalledWith([1, 2], false);
});

import { expect, it } from 'vitest';
import { nextDependencyAction } from './artifacts.js';

it('keeps an independent group eligible after the failed group is durably refused', () => {
  const ids = [1, 2, 3, 4].map((id) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`);
  const progress: Parameters<typeof nextDependencyAction>[0] = {
    plan: {
      actions: ids.map((actionId) => ({ actionId })),
      dependencySets: [ids.slice(0, 2), ids.slice(2)].map((actionIds, index) => ({
        dependencySetId: `synthetic-campaign-${index}`, recommendationId: ids[index]!,
        dependencySetSha256: String(index).repeat(64), actionIds,
        precedenceReasons: ['Observe this campaign control before the next one.'],
      })),
    },
    predispatchDispositions: ids.slice(0, 2).map((actionId) => ({ actionId })),
    providerCallIntents: [], observations: [],
  };
  expect(nextDependencyAction(progress)).toBe(ids[2]);
  progress.providerCallIntents = [{ positions: [{ actionId: ids[2]! }] }];
  expect(nextDependencyAction(progress)).toBeNull();
  progress.observations = [{ actionId: ids[2]!, outcome: 'observed_requested' }];
  expect(nextDependencyAction(progress)).toBe(ids[3]);
  expect(progress.predispatchDispositions.map((row) => row.actionId)).toEqual(ids.slice(0, 2));
});

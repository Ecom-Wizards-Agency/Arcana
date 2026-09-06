import { expect, it } from 'vitest';
import { commonOneTimeSettings, completedPreviewWindow } from './one-time-settings';

it('prefills only unanimous configured fields and preserves an explicit zero', () => {
  expect(commonOneTimeSettings([{ targetAcos: 0.37, bidFloor: 0 }, { targetAcos: 0.37, bidFloor: 0 }]))
    .toEqual({ targetAcos: 0.37, bidFloor: 0 });
  expect(commonOneTimeSettings([{ targetAcos: 0.37, bidFloor: 0 }, { targetAcos: 0.39 }])).toEqual({});
  expect(commonOneTimeSettings([{ targetAcos: 0.37 }, null])).toEqual({});
  expect(commonOneTimeSettings([])).toEqual({});
});

it('excludes the current profile day and requires a start choice if no selected day is complete', () => {
  expect(completedPreviewWindow({ start: '2024-02-01', end: '2024-03-01' }, '2024-03-01'))
    .toEqual({ start: '2024-02-01', end: '2024-02-29', lastComplete: '2024-02-29' });
  expect(completedPreviewWindow({ start: '2024-03-01', end: '2024-03-01' }, '2024-03-01').start).toBe('');
});

import { expect, it } from 'vitest';
import { positionModel } from './model';
import { visualFixture } from './render-fixture';

it('counts badge runs only through adjacent observations carrying the same state', () => {
  const data = visualFixture('badge-held');
  const own = data.series[0]!;
  own.points[18]!.bestSellerBadge = null;
  expect(positionModel(data, own.category, 15).badgeDays).toBe(2);
  own.points.at(-1)!.bestSellerBadge = false;
  expect(positionModel(data, own.category, 15).badgeDays).toBe(1);
});
it('derives firing time from both observations and never invents a time', () => {
  const data = visualFixture('both');
  const category = data.series[0]!.category;
  data.series[1]!.points.at(-1)!.observedAt = '2026-09-07T07:12:00.000Z';
  expect(positionModel(data, category, 15).firedAt).toBe('2026-09-07T07:12:00.000Z');
  delete data.series[1]!.points.at(-1)!.observedAt;
  expect(positionModel(data, category, 15).firedAt).toBeUndefined();
});
it('keeps signed gaps null with no tracked measurement and threshold gaps aligned to own ranks', () => {
  const data = visualFixture('untracked');
  const category = data.series[0]!.category;
  expect(positionModel(data, category, 15).gap).toBeNull();
  data.series[0]!.points[10]!.bsr = null;
  const model = positionModel(data, category, 15);
  expect(model.chart[0]!.points[10]!.value).toBeNull();
  expect(model.chart.at(-1)!.points[10]!.value).toBeNull();
});
it('does not call the nearest distance safe when its adjacent observation is missing', () => {
  const data = visualFixture('both');
  data.series[1]!.points.at(-2)!.bsr = null;
  data.series[2]!.points.at(-1)!.bsr = 500;
  const model = positionModel(data, data.series[0]!.category, 15);
  expect(model.alerts).toHaveLength(0);
  expect(model.nearest?.bsr).toBe(1136);
  expect(model.gap).toBe(-542);
  expect(model.missing).toContain('an adjacent day is missing');
});

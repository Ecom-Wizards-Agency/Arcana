import { expect, it } from 'vitest';
import { computePacing, remainingBudget } from './pacing.js';

it('subtracts month-to-date spend without changing the pacing verdict', () => {
  const pacing = computePacing([{ date: '2026-06-01', spend: 100 }], '2026-06-01', 3000)!;
  const before = structuredClone(pacing);
  expect(remainingBudget(pacing.monthlyBudget, pacing.mtdSpend)).toBe(2900);
  expect(pacing).toEqual(before);
  expect(pacing.status).toBe('on_pace');
});
it('preserves overspend and genuine zero balances', () => {
  expect(remainingBudget(100, 120)).toBe(-20);
  expect(remainingBudget(100, 100)).toBe(0);
});
it('never turns unknown or non-finite inputs into a balance', () => {
  for (const missing of [null, undefined, NaN, Infinity]) {
    expect(remainingBudget(missing, 100)).toBeNull();
    expect(remainingBudget(100, missing)).toBeNull();
  }
});

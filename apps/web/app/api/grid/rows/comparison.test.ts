import { expect, it } from 'vitest';
import { parseGridRowsQuery } from './route';
const base = 'https://example.test/api/grid/rows?profile=50505050-5050-4050-8050-505050505050&entity=targets&from=2026-07-01&to=2026-07-14';
it('accepts a chosen comparison without changing the selected window', () => {
  expect(parseGridRowsQuery(`${base}&compareFrom=2026-06-01&compareTo=2026-06-14`)).toMatchObject({ period: { start: '2026-07-01', end: '2026-07-14' }, comparison: { start: '2026-06-01', end: '2026-06-14' } });
});
it('refuses partial, inverted and impossible comparison dates', () => {
  for (const query of ['compareFrom=2026-06-01', 'compareFrom=2026-06-15&compareTo=2026-06-01', 'compareFrom=2026-02-30&compareTo=2026-03-14']) expect(() => parseGridRowsQuery(`${base}&${query}`)).toThrow('compareFrom and compareTo');
});

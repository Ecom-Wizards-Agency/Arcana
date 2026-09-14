import { expect, it } from 'vitest';
import { QueuedBidRequest } from './queued-changes.js';
const request = {requestId:'00000000-0000-4000-8000-000000000001',profileId:'00000000-0000-4000-8000-000000000002',targetId:'synthetic',expectedBid:{amount:'5',currencyCode:'USD'},expectedReadAt:'2026-08-13T12:00:00Z',newBid:{amount:'8.4',currencyCode:'USD'},overrideReason:null};
it('uses canonical WP-280 money and requires the synchronized read time',()=>{
  expect(QueuedBidRequest.parse(request)).toEqual(request);
  expect(QueuedBidRequest.safeParse({...request,newBid:request.expectedBid}).success).toBe(false);
  expect(QueuedBidRequest.safeParse({...request,newBid:{amount:'8.4',currencyCode:'EUR'}}).success).toBe(false);
  expect(QueuedBidRequest.safeParse({...request,newBid:{amount:'8.40',currencyCode:'USD'}}).success).toBe(false);
  expect(QueuedBidRequest.safeParse({...request,expectedReadAt:''}).success).toBe(false);
  expect(QueuedBidRequest.safeParse({...request,checks:[{passed:true}]}).success).toBe(false);
});

const whitespace = '\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF\u200B';
it('rejects every Unicode whitespace-only override, including zero-width space', () => {
  for (const overrideReason of [...whitespace, '\n\t', whitespace]) {
    expect(QueuedBidRequest.safeParse({ ...request, overrideReason }).success).toBe(false);
  }
  expect(QueuedBidRequest.parse({ ...request, overrideReason: whitespace + 'Reviewed reason' + whitespace }).overrideReason).toBe('Reviewed reason');
});
it('requires string money and marketplace precision for both sides of the preview', () => {
  for (const field of ['expectedBid', 'newBid']) {
    for (const amount of [6, null, false, [], {}, '6.001']) {
      expect(QueuedBidRequest.safeParse({ ...request, [field]: { amount, currencyCode: 'USD' } }).success).toBe(false);
    }
  }
  expect(QueuedBidRequest.safeParse({ ...request, expectedBid: { amount: '5', currencyCode: 'JPY' }, newBid: { amount: '6.1', currencyCode: 'JPY' } }).success).toBe(false);
  expect(QueuedBidRequest.safeParse({ ...request, expectedBid: { amount: '5', currencyCode: 'JPY' }, newBid: { amount: '6', currencyCode: 'JPY' } }).success).toBe(true);
});

it('requires an explicit complete placement observation set, never an arithmetic inference', async () => {
  const { ObservedPlacementModifiers } = await import('./queued-changes.js');
  const observed = ['top_of_search', 'rest_of_search', 'product_pages'].map((name) => ({ name, pct: 0, fullyObserved: true }));
  expect(ObservedPlacementModifiers.safeParse(observed).success).toBe(true);
  expect(ObservedPlacementModifiers.safeParse([{ ...observed[0], pct: 100 }, ...observed.slice(1)]).success).toBe(true);
  for (const unknown of [null, [], observed.slice(0, 2), observed.map(({ name, pct }) => ({ name, pct })),
    observed.map((c) => ({ ...c, fullyObserved: false })), [observed[0], observed[0], observed[2]]]) {
    expect(ObservedPlacementModifiers.safeParse(unknown).success).toBe(false);
  }
});

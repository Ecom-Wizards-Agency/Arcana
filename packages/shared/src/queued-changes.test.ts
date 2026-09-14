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

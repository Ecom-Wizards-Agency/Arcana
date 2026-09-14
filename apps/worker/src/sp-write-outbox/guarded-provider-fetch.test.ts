import { describe, expect, it } from 'vitest';
import { guardSpWriteObservationFetch } from './guarded-provider-fetch.js';

describe('raw Sponsored Products observation state guard', () => {
  it.each([
    ['/sp/campaigns/list', 'campaigns'],
    ['/sp/targets/list', 'targetingClauses'],
  ])('checks every raw row from %s before selected-field parsing', async (path, key) => {
    for (const state of ['ARCHIVED', 'UNKNOWN', undefined]) {
      const fetch = guardSpWriteObservationFetch(async () => Response.json({
        [key]: [{ state: 'ENABLED' }, state === undefined ? {} : { state }],
      }));
      await expect(fetch(`https://synthetic.invalid${path}`)).rejects.toThrow(
        'SP write observation refused: unsupported_entity_state');
    }
    const response = Response.json({ [key]: [{ state: 'ENABLED' }, { state: 'PAUSED' }] });
    const fetch = guardSpWriteObservationFetch(async () => response);
    expect(await fetch(`https://synthetic.invalid${path}`)).toBe(response);
    expect(await response.json()).toEqual({ [key]: [{ state: 'ENABLED' }, { state: 'PAUSED' }] });
  });

  it('leaves authentication, mutation and unsuccessful observation bodies untouched', async () => {
    for (const [path, status] of [['/auth/o2/token', 200], ['/sp/campaigns', 207], ['/sp/targets/list', 429]] as const) {
      const response = new Response('synthetic unparsed body', { status });
      const fetch = guardSpWriteObservationFetch(async () => response);
      expect(await fetch(`https://synthetic.invalid${path}`)).toBe(response);
      expect(response.bodyUsed).toBe(false);
    }
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgencyAccessDenied } from '@wizard-ads/db';
import { RequestAuthError } from './request-context';
import { DownloadRequestError, downloadErrorResponse } from './download-response';

describe('artifact failure responses', () => {
  it('never returns unexpected SQL messages, tenant identifiers or bound parameters', async () => {
    const marker = 'synthetic-private-' + randomUUID();
    const error = Object.assign(new Error('query failed: ' + marker), { code: 'XX000', detail: marker, parameters: [marker] });
    const response = downloadErrorResponse(error);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'The file could not be prepared. Try again.' });
    expect([...response.headers.values()].join(' ')).not.toContain(marker);
  });

  it('keeps validation, missing resources and authentication responses non-cacheable', async () => {
    const cases = [
      [new DownloadRequestError('A valid batch id is required'), 400],
      [new DownloadRequestError('Not found', 404), 404],
      [new AgencyAccessDenied(), 403],
      [new RequestAuthError('Authentication required', 401), 401],
      [new RequestAuthError('Database is not configured', 503), 503],
      [new SyntaxError('private parsing detail'), 400],
    ] as const;
    for (const [error, status] of cases) {
      const response = downloadErrorResponse(error);
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(response.headers.get('vary')).toBe('Cookie, Authorization');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.text()).not.toContain('private parsing detail');
    }
  });
});

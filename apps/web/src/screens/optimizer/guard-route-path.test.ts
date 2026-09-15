import { expect, it } from 'vitest';
import { Uuid } from '@wizard-ads/shared';
import { GUARDED_ROUTES } from '../../e2e-guard-routes';
import { guardRoutePath } from '../../../e2e/support/guard-route-path';

it('materializes every guarded descriptor without losing, combining or reordering routes', () => {
  const concrete = GUARDED_ROUTES.map(({ path }) => guardRoutePath(path));
  expect(concrete).toHaveLength(GUARDED_ROUTES.length);
  expect(new Set(concrete).size).toBe(GUARDED_ROUTES.length);
  for (const [index, { path }] of GUARDED_ROUTES.entries()) {
    const requested = concrete[index]!;
    expect(requested).not.toContain('[');
    expect(requested).not.toContain(']');
    if (!path.includes('[')) expect(requested).toBe(path);
    const templateSegments = path.split('/');
    const requestedSegments = requested.split('/');
    expect(requestedSegments).toHaveLength(templateSegments.length);
    templateSegments.forEach((segment, part) => {
      if (segment.startsWith('[')) expect(Uuid.safeParse(requestedSegments[part]).success).toBe(true);
      else expect(requestedSegments[part]).toBe(segment);
    });
  }
});

it('uses a distinct stable UUID for each resource identity and preserves query and fragment', () => {
  const template = '/[batchId]/[rowId]/[groupId]';
  const query = new URLSearchParams({ profile: 'synthetic-profile' });
  const result = new URL(guardRoutePath(`${template}?${query}#details`), 'https://example.test');
  const identities = result.pathname.split('/').filter(Boolean);
  expect(new Set(identities).size).toBe(3);
  identities.forEach((id) => expect(Uuid.safeParse(id).success).toBe(true));
  expect(result.searchParams.get('profile')).toBe('synthetic-profile');
  expect(result.hash).toBe('#details');
});

it('refuses an unrepresented descriptor parameter rather than visiting a bracketed address', () => {
  expect(() => guardRoutePath('/[unknownResourceId]')).toThrow('requires a synthetic value');
});

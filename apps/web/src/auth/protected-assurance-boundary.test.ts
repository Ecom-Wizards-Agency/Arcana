import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), 'utf8');
}

describe('protected assurance boundary', () => {
  it('keeps route actors, Grid, and both Amazon OAuth endpoints on the shared role-aware gate', async () => {
    const files = await Promise.all([
      source('src/server/request-context.ts'),
      source('src/grid/request-context.ts'),
      source('app/api/amazon/oauth/start/route.ts'),
      source('src/oauth/ads-callback.ts'),
      source('src/oauth/spapi-routes.ts'),
    ]);
    for (const contents of files) {
      expect(contents).toContain('currentOperatorIdentity');
      expect(contents).toContain('authorizeOperatorRole');
    }
    const callback = await source('app/api/amazon/oauth/callback/route.ts');
    expect(callback).toContain("import { receiveAmazonConsent } from '../../../../../src/oauth/ads-callback'");
    expect(callback).toContain("return receiveAmazonConsent(request, consumeOAuthQuery('/api/amazon/oauth/callback'))");
    const sellerCallback = await source('app/api/amazon/spapi/oauth/callback/route.ts');
    expect(sellerCallback).toContain("return receiveSpApiConsent(request, consumeOAuthQuery('/api/amazon/spapi/oauth/callback'))");
    expect(await source('app/api/grid/rows/route.ts')).toContain('enforceAssurance: enforceGridAssurance');
  });

  it('keeps screen adapters on the shared structured auth continuation', async () => {
    const files = await readdir(resolve(process.cwd(), 'app'), { recursive: true });
    const pages = files.filter((file) => file.endsWith('/page.tsx'))
      .filter((file) => !/^(auth|login|forgot-password|recover-password|invite|agency-invite|go)\//.test(file));
    const { SCREEN_REGISTRY } = await import('../screens/registry');
    const physical = SCREEN_REGISTRY.filter((screen) => screen.route === 'page' || screen.route === 'redirect');
    expect(pages).toHaveLength(physical.length);
    for (const path of pages) {
      expect(await source(`app/${path}`)).toContain('pageRead(descriptor, searchParams, params)');
    }
    const boundary = await source('src/server/page-read.ts');
    expect(boundary).toContain('await requestActor(await headers())');
    expect(boundary).toContain('authenticationDestination(error)');
    expect(boundary).toContain('authorizeOperatorRole(identity, context.active.role');
    expect(await source('src/server/authenticated-page-read.ts')).toContain('await requestActor(headers)');
  });
});

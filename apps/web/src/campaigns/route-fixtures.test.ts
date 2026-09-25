import { describe, expect, it } from 'vitest';
import { AssetsRouteData, BuilderRouteData, DraftRouteData, NamingRouteData, UpdateRouteData } from '@wizard-ads/shared';
import { campaignRouteFixturesEnabled } from './route-fixtures';
import { campaignRouteCases } from '../../e2e/support/campaign-route-cases';
import { campaignVisualCases } from '../screens/campaigns/visual-cases';

describe('persisted campaign route fixtures', () => {
  it('is unavailable in production, without test auth, or outside the disposable local database', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', WIZARD_ADS_E2E_AUTH: '1', DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5529/wizard_ads_e2e' };
    expect(campaignRouteFixturesEnabled(env)).toBe(true);
    expect(campaignRouteFixturesEnabled({ ...env, NODE_ENV: 'production' })).toBe(false);
    expect(campaignRouteFixturesEnabled({ ...env, WIZARD_ADS_E2E_AUTH: '0' })).toBe(false);
    expect(campaignRouteFixturesEnabled({ ...env, DATABASE_URL: env.DATABASE_URL!.replace('wizard_ads_e2e', 'postgres') })).toBe(false);
    expect(campaignRouteFixturesEnabled({ ...env, DATABASE_URL: env.DATABASE_URL!.replace('127.0.0.1', 'example.test') })).toBe(false);
  });
  it('persists schema-valid data for every visual case and maps every state to a real route', () => {
    const cases = campaignRouteCases({ orgId: '27000000-0000-4000-8000-000000000001', fixtureProfileId: '27000000-0000-4000-8000-000000000002', otherOrgId: '27000000-0000-4000-8000-000000000009', connectionString: '' });
    const names = (values: readonly { screen: string; key: string }[]) => values.map((value) => `${value.screen}--${value.key}`).sort();
    expect(names(cases)).toEqual(names(campaignVisualCases)); expect(cases).toHaveLength(83);
    const schemas = { campaigns: BuilderRouteData, 'campaigns-new': BuilderRouteData, 'campaigns-eligibility': BuilderRouteData, 'campaigns-draft': DraftRouteData, 'campaigns-assets': AssetsRouteData, 'campaigns-naming': NamingRouteData, 'campaigns-update': UpdateRouteData };
    for (const item of cases) {
      expect(schemas[item.screen as keyof typeof schemas].safeParse(item.payload).success, `${item.screen}--${item.key}`).toBe(true);
      expect(item.path).toMatch(/^\/campaigns(?:\/(?:new|draft|assets|naming|eligibility|update))?$/);
    }
  });
});

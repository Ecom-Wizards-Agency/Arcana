import type { ProfileRecord } from '../../app/_lib/profiles';
import type { OrgContext } from '../data/orgs';

export const profile: ProfileRecord = {
  id: 'synthetic-profile', amazonProfileId: 'synthetic-provider-profile', label: 'Synthetic account',
  region: 'NA', countryCode: 'US', currencyCode: 'USD', timezone: 'UTC', syncEnabled: true,
  targetAcos: null, monthlyBudget: null, goalLens: 'balanced',
};
export const period = { start: '2026-08-01', end: '2026-08-29' };
export const org = { orgId: 'synthetic-org', name: 'Synthetic organization', slug: 'synthetic-org', role: 'owner' as const };
export const context: OrgContext = { user: { id: 'synthetic-user', email: 'operator@example.test' }, active: org, memberships: [org] };

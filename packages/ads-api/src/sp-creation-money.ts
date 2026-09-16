import { SP_MARKETPLACE_MONEY_RULES, type CampaignCreationProviderScope } from '@wizard-ads/shared';

type Scope = Pick<CampaignCreationProviderScope, 'marketplaceId' | 'region' | 'currencyCode'>;
export function assertSpProviderMoneyScope(scope: Scope) {
  const rule = SP_MARKETPLACE_MONEY_RULES[scope.marketplaceId];
  if (!rule || rule.region !== scope.region || rule.currencyCode !== scope.currencyCode) throw new Error('Creation money scope mismatch');
  return rule;
}
function decimal(value: string, scale: number): bigint {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{0,5}[1-9])?$/.test(value)) throw new Error('Creation money must use canonical decimals');
  const [integer, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error('Creation money exceeds currency scale');
  return BigInt(`${integer}${fraction.padEnd(scale, '0')}`);
}
export function spMoneyNumber(amount: string, scope: Scope, kind: 'bid' | 'budget'): number {
  const rule = assertSpProviderMoneyScope(scope);
  const value = decimal(amount, rule.scale);
  const minimum = decimal(kind === 'bid' ? rule.bidMin : rule.budgetMin, rule.scale);
  const maximum = decimal(kind === 'bid' ? rule.bidMax : rule.budgetMax, rule.scale);
  const number = Number(amount);
  if (value < minimum || value > maximum || !Number.isFinite(number) || JSON.stringify(number) !== amount) throw new Error('Creation money outside exact provider bounds');
  return number;
}

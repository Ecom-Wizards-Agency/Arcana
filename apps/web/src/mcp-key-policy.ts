/** Browser-safe policy shared by the issue form, route, and server data layer. */
import { MCP_KEY_EXPIRY_DAY_OPTIONS } from '@wizard-ads/shared';
export { MCP_KEY_EXPIRY_DAY_OPTIONS, DEFAULT_MCP_KEY_EXPIRY_DAYS } from '@wizard-ads/shared';

export function isMcpKeyExpiryDays(value: unknown): value is (typeof MCP_KEY_EXPIRY_DAY_OPTIONS)[number] {
  return (
    typeof value === 'number' &&
    MCP_KEY_EXPIRY_DAY_OPTIONS.some((candidate) => candidate === value)
  );
}

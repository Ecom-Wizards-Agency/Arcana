import { createState, verifyState, STATE_TTL_SECONDS, type OAuthStateClaims } from './state';

export function createSpApiState(key: string, claims: OAuthStateClaims, now = Date.now()): string {
  return createState(key, claims, now, 'amazon_spapi');
}
export function verifySpApiState(key: string, state: string | null, nonce: string | null, now = Date.now()) {
  return verifyState(key, state, nonce, now, 'amazon_spapi');
}
export function spApiNonceName(secure: boolean): string {
  return `${secure ? '__Host-' : ''}wizard_ads_spapi_oauth_nonce`;
}
export function spApiNonceCookie(nonce: string | null, secure: boolean): string {
  return `${spApiNonceName(secure)}=${nonce ?? ''}; Path=/; Max-Age=${nonce === null ? 0 : STATE_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

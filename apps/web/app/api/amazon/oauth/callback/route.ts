import { receiveAmazonConsent } from '../../../../../src/oauth/ads-callback';
import { consumeOAuthQuery } from '../../../../../src/oauth/request-custody';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  return receiveAmazonConsent(request, consumeOAuthQuery('/api/amazon/oauth/callback'));
}

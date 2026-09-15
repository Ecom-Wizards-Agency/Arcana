import { receiveSpApiConsent } from '../../../../../../src/oauth/spapi-routes';
import { consumeOAuthQuery } from '../../../../../../src/oauth/request-custody';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  return receiveSpApiConsent(request, consumeOAuthQuery('/api/amazon/spapi/oauth/callback'));
}

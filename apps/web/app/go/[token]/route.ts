import { requestActor, openWebDatabase } from '../../../src/server/request-context';
import { consumeGotoLinkForActor, gotoRedirectLocation } from '@wizard-ads/db';
import { privateResponse } from '../../../src/server/private-response';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ token: string }> };

const notFound = () => privateResponse(new Response('Not found', { status: 404 }));

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const actor = await requestActor(request.headers);
    const signingSecret = process.env['GOTO_LINK_SIGNING_SECRET'];
    if (!signingSecret) return notFound();
    const { token } = await context.params;
    const database = openWebDatabase();
    let response: Response;
    try {
      const link = await consumeGotoLinkForActor(database, actor, { token, signingSecret });
      if (!link) response = notFound();
      else {
        const location = new URL(gotoRedirectLocation(link.route, link.state), request.url);
        // Response.redirect has immutable headers; this response must receive
        // private cache headers after the complete transaction and close.
        response = new Response(null, { status: 307, headers: { Location: location.href } });
      }
    } finally {
      await database.close();
    }
    return privateResponse(response);
  } catch {
    // Authentication, membership, malformed tokens, and absent links are
    // deliberately indistinguishable so this route cannot enumerate tenants.
    return notFound();
  }
}

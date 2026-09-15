import { spApiHealthRoute } from '../../../../../../src/oauth/spapi-routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ connectionId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return spApiHealthRoute(request, (await context.params).connectionId, false);
}
export async function POST(request: Request, context: Context): Promise<Response> {
  return spApiHealthRoute(request, (await context.params).connectionId, true);
}

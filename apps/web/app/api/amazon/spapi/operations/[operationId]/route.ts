import { spApiOperationRoute } from '../../../../../../src/oauth/spapi-routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ operationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return spApiOperationRoute(request, (await context.params).operationId, false);
}
export async function POST(request: Request, context: Context): Promise<Response> {
  return spApiOperationRoute(request, (await context.params).operationId, true);
}

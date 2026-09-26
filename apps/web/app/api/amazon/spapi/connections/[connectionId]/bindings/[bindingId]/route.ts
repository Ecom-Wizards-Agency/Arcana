import { spApiBindingReportingRoute } from '../../../../../../../../src/oauth/spapi-routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ connectionId: string; bindingId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  const { connectionId, bindingId } = await context.params;
  return spApiBindingReportingRoute(request, connectionId, bindingId);
}

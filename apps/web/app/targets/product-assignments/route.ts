import { mutateProductAssignment, listProductAssignments, ProductAssignmentRefused } from '@wizard-ads/db';
import { ProductAssignmentMutation, ProductAssignmentScope } from '@wizard-ads/shared';
import { authenticatedRead, ApiReadError } from '../../../src/server/authenticated-read';
import { authenticatedMutation, MutationInputError } from '../../../src/server/authenticated-mutation';

export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (context) => {
    const scope = ProductAssignmentScope.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!scope.success) throw new ApiReadError('Choose a profile and valid date range.');
    return Response.json(await listProductAssignments(context, scope.data));
  });
}
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const input = ProductAssignmentMutation.safeParse(await request.json());
    if (!input.success) throw new MutationInputError('Choose an advertised product.');
    await mutateProductAssignment(context, input.data);
    return Response.json({ assigned: 1 });
  }, (error) => {
    // The same refusal the screen applies: a derived group offers no chooser.
    if (error instanceof ProductAssignmentRefused) return Response.json({ error: error.message, code: error.code }, { status: 409 });
    return error !== null && typeof error === 'object' && 'code' in error && ['23503','23514'].includes(String(error.code))
      ? Response.json({ error: 'The ad group or advertised product changed. Reload the list before assigning.' }, { status: 409 }) : null;
  });
}

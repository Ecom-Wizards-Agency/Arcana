import { importSponsoredPrompts, SponsoredPromptInputError } from '@wizard-ads/db';
import { SPONSORED_PROMPT_IMPORT_MAX_BYTES, SponsoredPromptImport } from '@wizard-ads/shared';
import { authenticatedMutation, MutationInputError } from '../../../../src/server/authenticated-mutation';
import { screenEnabled } from '../../../../src/screens/types';
import { descriptor } from '../../../../src/screens/sponsored-prompts/descriptor';
export const runtime = 'nodejs';

async function boundedBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new MutationInputError('A JSON export is required');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > SPONSORED_PROMPT_IMPORT_MAX_BYTES) { await reader.cancel(); throw new MutationInputError('The export exceeds the import size limit'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(result)) as unknown;
}
export async function POST(request: Request) {
  return authenticatedMutation(request, async (context) => {
    if (!screenEnabled(descriptor)) return Response.json({ error: 'Sponsored prompts is not enabled' }, { status: 404 });
    const input = SponsoredPromptImport.safeParse(await boundedBody(request));
    if (!input.success) throw new MutationInputError(input.error.issues[0]?.message ?? 'Check the prompt export fields');
    return Response.json(await importSponsoredPrompts(context, input.data), { status: 201 });
  }, (error) => error instanceof SponsoredPromptInputError ? Response.json({ error: error.message }, { status: 409 }) : null);
}

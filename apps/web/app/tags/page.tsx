import { authenticatedPageRead, pageReadErrorMessage } from '../../src/server/authenticated-page-read';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authenticationDestination } from '../../src/server/request-context';
import { listCampaignsByTagFilter, listTagTree } from '@wizard-ads/db';
import type { JsonValue } from '@wizard-ads/db';
import { TagManager } from './tag-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function parseState(value: string | string[] | undefined): JsonValue | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

export default async function TagsPage({ searchParams }: { searchParams: SearchParams }) {
  try {
    return await authenticatedPageRead(await headers(), async (database, actor) => {
      const [tags, campaigns] = await Promise.all([
        listTagTree(database, actor.orgId),
        listCampaignsByTagFilter(database, actor.orgId),
      ]);
      const query = await searchParams;
      return (
        <TagManager
          initialState={parseState(query['state'])}
          tags={tags.map((tag) => ({
            id: tag.id,
            parentId: tag.parentId,
            name: tag.name,
            color: tag.color,
            children: tag.children,
          }))}
          campaigns={campaigns}
        />
      );
    });
  } catch (error) {
    // A page, not an API: an anonymous visitor gets the login screen.
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Tags are unavailable');
    return (
      <main style={{ maxWidth: 760, margin: '48px auto', fontFamily: 'var(--wa-font)' }}>
        <h1>Tags</h1>
        <p role="alert">{message}</p>
      </main>
    );
  }
}

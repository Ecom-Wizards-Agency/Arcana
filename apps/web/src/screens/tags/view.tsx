import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import type { JsonValue } from '@wizard-ads/db';

import { TagManager } from '../../../app/tags/tag-manager';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderReady({ role, query, tags, campaigns }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<TagManager
    canEdit={role !== 'viewer'}
    initialState={parseState(query['state'])}
    tags={tags.map((tag) => ({
      id: tag.id,
      parentId: tag.parentId,
      name: tag.name,
      color: tag.color,
      children: tag.children,
    }))}
    campaigns={campaigns}
  />);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={{ maxWidth: 760, margin: '48px auto', fontFamily: 'var(--wa-font)' }}>
    <h1>Tags</h1>
    <ScreenState variant="error" title="Could not load this screen" body={message} />
  </main>);
}

function parseState(value: string | string[] | undefined): JsonValue | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

export default function ScreenView({ data }: { data: ScreenData }) {
  return <ScreenSurface title="Tags">{ScreenContent({ data })}</ScreenSurface>;
}

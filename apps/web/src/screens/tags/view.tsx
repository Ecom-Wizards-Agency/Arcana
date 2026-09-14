import type { JsonValue } from '@wizard-ads/db';

import { TagManager } from '../../../app/tags/tag-manager';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
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
    <p role="alert">{message}</p>
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

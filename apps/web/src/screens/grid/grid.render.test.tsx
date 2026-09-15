import { render, screen } from '@testing-library/react';
import { CatalogueProducts } from './catalogue-products';
import { catalogueEvidenceFixtures } from './catalogue-fixtures';
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { rendered } from '../render-test-support';
import { columnsFor, defaultVisibleColumns, ENTITY_LABELS } from '@wizard-ads/ui';
import Loading from '../../../app/grid/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { context } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Campaigns" },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'explains an empty profile roster', render: () => <Screen data={{ view: 'empty', props: { data: { profiles: [], profile: null } } }} />, text: 'No advertising profiles yet.' },
  { state: 'not-measured', name: 'does not substitute measured results for absent evidence', render: () => <Screen data={{ ...ready, props: { ...ready.props, slot1: <></>, freshness: <></> } }} />, text: "Campaigns", absent: ['[aria-label="Performance cockpit"]'] }
]);

describe('shared performance presets', () => {
  for (const entity of ['campaigns', 'ad_groups', 'search_terms', 'products', 'placements', 'targets'] as const) {
    it(`renders ${entity} through the shared module with its complete column catalogue`, () => {
      const host = rendered(<Screen data={{ ...ready, props: { ...ready.props, entity } }} />);
      expect(host.textContent).toContain(ENTITY_LABELS[entity]);
      const columns = columnsFor(entity);
      expect(columns.map((column) => column.id)).toEqual(expect.arrayContaining(defaultVisibleColumns(entity)));
      expect(columns.filter((column) => column.pinned)).toHaveLength(1);
      if (entity === 'products') expect(columns.map((column) => column.id)).toContain('gap');
      if (entity === 'products' || entity === 'search_terms' || entity === 'targets') {
        const workspace = host.querySelector('[data-testid="grid-data-loading"]')!;
        const evidence = host.querySelector(entity === 'products' ? '[aria-label="Retail sales and traffic"]' : '[aria-label="ABA search-term evidence"]')!;
        expect(workspace).not.toBeNull();
        expect(evidence).not.toBeNull();
        expect(workspace.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });
  }
});

it('renders nine Products evidence rows with zero, missing facts, partial facts, stale age and provenance',()=>{
  const products=catalogueEvidenceFixtures();
  render(<CatalogueProducts data={{products,missingScopeAsins:[],advertisedIdentities:9,scopedRows:9,truncated:false}}/>);
  const rows=screen.getAllByTestId('catalogue-product-row');expect(rows).toHaveLength(9);
  expect(rows[0]!.textContent).toContain('missing');expect(rows[2]!.textContent).toContain('partial');expect(rows[4]!.textContent).toContain('measured');expect(rows[6]!.textContent).toContain('stale');
  expect(rows[4]!.children[4]!.textContent).toBe('0 USD');expect(rows[4]!.children[6]!.textContent).toBe('0');
  expect(rows[4]!.textContent).toContain('Amazon Product Metadata v1');expect(rows[4]!.textContent).toContain('provider observed Unavailable');
  expect(rows[4]!.textContent).toContain('acquired 2026-09-15');expect(rows[4]!.textContent).toContain('retrieved 2026-09-15');
});

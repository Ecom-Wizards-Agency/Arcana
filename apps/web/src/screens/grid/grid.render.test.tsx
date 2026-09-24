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
import { ProductAssignmentNotice, ProductAssignmentTable } from './performance-chrome';
import type { ProductAssignmentList, ProductAssignmentSource } from '@wizard-ads/shared';

/** One synthetic ad group in the given source state, shaped exactly as the assignment read returns it. */
function assignment(source: ProductAssignmentSource): ProductAssignmentList {
  const unresolved = source === 'proposed' || source === 'unassigned';
  const assignedAsin = source === 'unassigned' ? null : source === 'derived_parent' ? 'B000000099' : 'B000000001';
  const candidates = source === 'proposed' ? [{ asin: 'B000000001', skus: [], parentAsin: null, spend: 20 }, { asin: 'B000000002', skus: [], parentAsin: null, spend: 5 }] : [];
  return { profileId: '00000000-0000-4000-8000-000000000001', start: '2026-09-01', end: '2026-09-14', days: 14, canAssign: true, count: 1,
    unassignedCount: unresolved ? 1 : 0, unassignedSpend: unresolved ? 25 : 0,
    items: [{ adGroupId: 'synthetic-group', campaignId: 'synthetic-campaign', name: 'Synthetic group', asins: source === 'unassigned' ? [] : ['B000000001', 'B000000002'],
      assignedAsin, source, derivedAt: '2026-09-16T00:00:00.000Z', ambiguous: source === 'proposed',
      derived: source === 'manual' ? { asin: 'B000000099', source: 'derived_parent' } : { asin: assignedAsin, source },
      reason: source === 'proposed' ? 'Products do not share a known parent; review the highest-spend candidate.' : source === 'unassigned' ? 'No enabled or paused product ads.' : null,
      candidates, spend: 25 }] };
}
const assignmentScreen = (source: ProductAssignmentSource) => <>
  <ProductAssignmentNotice data={assignment(source)} currencyCode="USD" onOpen={() => { }} />
  <ProductAssignmentTable data={assignment(source)} currencyCode="USD" selected={{}} busy={false} onSelect={() => { }} onSave={() => { }} onRevert={() => { }} />
</>;
const settled = ['[data-testid="grid-unattributed"]', 'select'];

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Campaigns" },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'explains an empty profile roster', render: () => <Screen data={{ view: 'empty', props: { data: { profiles: [], profile: null } } }} />, text: 'No advertising profiles yet.' },
  { state: 'not-measured', name: 'does not substitute measured results for absent evidence', render: () => <Screen data={{ ...ready, props: { ...ready.props, slot1: <></>, freshness: <></> } }} />, text: "Campaigns", absent: ['[aria-label="Performance cockpit"]'] },
  { state: 'derived', name: 'shows a single advertised product as derived without a chooser or notice', render: () => assignmentScreen('derived'), text: 'Assigned: B000000001Derived', absent: settled },
  { state: 'derived-parent', name: 'shows a shared parent as the derived product without a chooser or notice', render: () => assignmentScreen('derived_parent'), text: 'Assigned: B000000099', absent: settled },
  { state: 'proposed', name: 'counts a proposed group in the notice and offers the chooser with every candidate', render: () => assignmentScreen('proposed'), text: '1 ad group needs a product check · $25.00 of spend over 14 days' },
  { state: 'manual', name: 'keeps a manual choice with its derived baseline and a revert control', render: () => assignmentScreen('manual'), text: 'Derived: B000000099 (derived parent)', absent: settled },
  { state: 'unassigned', name: 'explains an unassigned group and why an assignment matters', render: () => assignmentScreen('unassigned'), text: 'unassigned groups show none' },
]);

describe('product assignment sources', () => {
  for (const source of ['derived', 'derived_parent', 'proposed', 'manual', 'unassigned'] as const) {
    it(`renders ${source} with its chip and only the controls that source allows`, () => {
      const host = rendered(assignmentScreen(source));
      const unresolved = source === 'proposed' || source === 'unassigned';
      expect(host.querySelectorAll('[data-testid="product-assignment-row"]')).toHaveLength(1);
      expect(host.querySelectorAll(`[data-assignment-source="${source}"]`)).toHaveLength(1);
      expect(host.querySelectorAll('[data-testid="grid-unattributed"]')).toHaveLength(unresolved ? 1 : 0);
      expect(host.querySelectorAll('select')).toHaveLength(unresolved ? 1 : 0);
      const buttons = [...host.querySelectorAll('button')].map((button) => button.textContent);
      expect(buttons.filter((label) => label === 'Save assignment')).toHaveLength(unresolved ? 1 : 0);
      expect(buttons.filter((label) => label === 'Revert to derived')).toHaveLength(source === 'manual' ? 1 : 0);
      expect(buttons.filter((label) => label === 'Link them')).toHaveLength(unresolved ? 1 : 0);
    });
  }
  it('lists every candidate with its settled spend for a proposed group', () => {
    const host = rendered(assignmentScreen('proposed'));
    expect([...host.querySelectorAll('[aria-label="Assignment candidates"] li')].map((item) => item.textContent))
      .toEqual(['B000000001 · $20.00 over 30 settled days', 'B000000002 · $5.00 over 30 settled days']);
  });
  it('never renders unmeasured unresolved spend as zero', () => {
    const list = assignment('unassigned');
    const host = rendered(<ProductAssignmentNotice data={{ ...list, unassignedSpend: 0, items: list.items.map((item) => ({ ...item, spend: null })) }} currencyCode="USD" onOpen={() => { }} />);
    expect(host.textContent).toContain('spend not measured over 14 days');
    expect(host.textContent).not.toContain('$0.00');
  });
});

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

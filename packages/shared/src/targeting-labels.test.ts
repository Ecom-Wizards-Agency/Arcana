import { describe, expect, it } from 'vitest';
import { MatchType, Placement } from './primitives.js';
import {
  MATCH_TYPE_LABELS,
  PLACEMENT_LABELS,
  TARGET_EXPRESSION_LABELS,
  TARGET_EXPRESSION_TYPES,
  TARGET_KINDS,
  describeTargeting,
  humanizeCode,
  matchTypeLabel,
  placementLabel,
  targetKindLabel,
} from './targeting-labels.js';

/** Snake case, upper or lower: the shape of every stored or Amazon code in this vocabulary. */
const CODE = /[A-Za-z]+_[A-Za-z_]+/;

describe('targeting vocabulary labels', () => {
  it('labels every stored match type, placement and target kind in words', () => {
    expect(Object.keys(MATCH_TYPE_LABELS).sort()).toEqual([...MatchType.options].sort());
    expect(Object.keys(PLACEMENT_LABELS).sort()).toEqual([...Placement.options].sort());
    let checked = 0;
    for (const value of MatchType.options) {
      expect(matchTypeLabel(value)).toBe(MATCH_TYPE_LABELS[value]);
      expect(matchTypeLabel(value)).not.toMatch(CODE);
      checked += 1;
    }
    for (const value of Placement.options) {
      expect(placementLabel(value)).toBe(PLACEMENT_LABELS[value]);
      checked += 1;
    }
    for (const kind of TARGET_KINDS) {
      expect(targetKindLabel(kind)).not.toMatch(CODE);
      checked += 1;
    }
    expect(checked).toBe(MatchType.options.length + Placement.options.length + TARGET_KINDS.length);
  });

  it('reads every Amazon expression type, bare and with a value, without the code', () => {
    let checked = 0;
    for (const type of TARGET_EXPRESSION_TYPES) {
      const bare = describeTargeting({ targeting: type, targetKind: 'target' });
      expect(bare.label).toBe(TARGET_EXPRESSION_LABELS[type]);
      expect(bare.phrase).toBeNull();
      const valued = describeTargeting({ targeting: `${type}="B000SYN001"`, targetKind: 'target' });
      expect(valued.label).toBe(`${TARGET_EXPRESSION_LABELS[type]}: B000SYN001`);
      for (const text of [bare.label, bare.type ?? '', valued.label]) expect(text).not.toContain(type);
      checked += 1;
    }
    expect(checked).toBe(TARGET_EXPRESSION_TYPES.length);
  });

  it('reads the automatic groups and product clauses as the operator names them', () => {
    expect(describeTargeting({ targeting: 'QUERY_HIGH_REL_MATCHES', targetKind: 'target' })).toMatchObject({ label: 'Close match', type: 'Close match', group: 'automatic', phrase: null });
    expect(describeTargeting({ targeting: 'QUERY_BROAD_REL_MATCHES', targetKind: 'target' }).label).toBe('Loose match');
    expect(describeTargeting({ targeting: 'ASIN_SAME_AS="B000SYN001"', targetKind: 'product target' })).toMatchObject({ label: 'Product: B000SYN001', type: 'Product', group: 'product' });
    expect(describeTargeting({ targeting: 'ASIN_CATEGORY_SAME_AS="Home & Kitchen" ASIN_PRICE_BETWEEN="10-20"', targetKind: 'target' }).label)
      .toBe('Category: Home & Kitchen · Price between: 10-20');
    // Report and camel-case spellings of the same concepts.
    expect(describeTargeting({ targeting: 'close-match', targetKind: null }).label).toBe('Close match');
    expect(describeTargeting({ targeting: 'asinSameAs="B000SYN002"', targetKind: 'target' }).label).toBe('Product: B000SYN002');
    expect(describeTargeting({ targeting: 'asin-expanded="B000SYN003"', targetKind: 'target' }).label).toBe('Product and similar: B000SYN003');
  });

  it('never parses a keyword, and keeps its text as the phrase', () => {
    expect(describeTargeting({ targeting: 'complements', targetKind: 'keyword', matchType: 'exact' })).toMatchObject({ label: 'complements', phrase: 'complements', type: 'Exact', group: 'keyword' });
    // Without a kind, ordinary words stay words; only unmistakable codes are read.
    expect(describeTargeting({ targeting: 'brand', targetKind: null }).label).toBe('brand');
    expect(describeTargeting({ targeting: 'synthetic running shoes', targetKind: null, matchType: 'broad' })).toMatchObject({ phrase: 'synthetic running shoes', type: 'Broad' });
    expect(describeTargeting({ targeting: null }).phrase).toBeNull();
  });

  it('puts unknown codes into words instead of showing them', () => {
    expect(humanizeCode('ASIN_SHINY_NEW_THING')).toBe('Asin shiny new thing');
    expect(matchTypeLabel('TARGETING_EXPRESSION_PREDEFINED')).toBe('Automatic targeting');
    expect(matchTypeLabel('SOME_FUTURE_MATCH')).toBe('Some future match');
    expect(placementLabel('PLACEMENT_TOP')).toBe('Top of search');
    expect(placementLabel('topOfSearch')).toBe('Top of search');
    expect(placementLabel('Detail Page on-Amazon')).toBe('Product pages');
    expect(placementLabel('PLACEMENT_SOMEWHERE_NEW')).toBe('Placement somewhere new');
    const future = describeTargeting({ targeting: 'ASIN_FUTURE_PREDICATE', targetKind: 'target' });
    expect(future.label).toBe('Asin future predicate');
    const broken = describeTargeting({ targeting: 'ASIN_BRAND_SAME_AS="Synthetic "quoted" brand"', targetKind: 'target' });
    expect(broken.label).not.toMatch(CODE);
    expect(broken.label).toContain('Brand');
    expect([matchTypeLabel(null), placementLabel(''), targetKindLabel(undefined)]).toEqual([null, null, null]);
  });

  it('names automatic targets apart from product targets', () => {
    expect(targetKindLabel('keyword')).toBe('Keyword');
    expect(targetKindLabel('target', 'QUERY_HIGH_REL_MATCHES')).toBe('Automatic target');
    expect(targetKindLabel('target', 'ASIN_SAME_AS="B000SYN001"')).toBe('Product target');
    expect(targetKindLabel('product target', 'KEYWORD_GROUP_SAME_AS="synthetic"')).toBe('Theme target');
  });
});

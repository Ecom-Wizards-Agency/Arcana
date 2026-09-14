import { describe, expect, it } from 'vitest';
import {
  EW_NAMING_PRESET, LEGACY_NAMING_PRESET, generateCampaignName,
  keywordFromCampaignName, parseCampaignName,
} from './naming.js';

const context = {
  goal: 'Rank', campaignType: 'SKW', matchType: 'EXACT', productName: 'Widget',
  keywordText: 'red widget', targetDescriptor: 'red widget', counter: 1,
};
const day = '2026-09-13';
const compact = { ...EW_NAMING_PRESET, variableOrder: ['Goal', 'AdType', 'MatchType', 'Keyword', 'EW'] };

describe('reverse naming grammar', () => {
  it.each([
    [generateCampaignName(EW_NAMING_PRESET, { ...context, campaignType: 'Halo' }, day), EW_NAMING_PRESET, 'exact', 'red widget'],
    [generateCampaignName(EW_NAMING_PRESET, context, day), EW_NAMING_PRESET, 'partial', 'red widget'],
    [generateCampaignName(LEGACY_NAMING_PRESET, context, day), LEGACY_NAMING_PRESET, 'exact', null],
    ['Rank | SB | Phrase | blue widget | EW', compact, 'exact', 'blue widget'],
    ['Rank | SB | Phrase |  | EW', compact, 'partial', null],
    ['', compact, 'none', null],
    ['Rank / SB / Phrase / blue widget / EW', compact, 'none', null],
    ['Rank | SB | Wrong | blue widget | EW', compact, 'none', null],
    ['Rank | SB | Phrase | blue | widget | EW', compact, 'none', null],
    ['Rank | SB | Phrase | blue widget | Wrong', compact, 'none', null],
  ] as const)('parses %j as %s', (name, preset, confidence, keyword) => {
    expect(parseCampaignName(name, preset).confidence).toBe(confidence);
    expect(keywordFromCampaignName(name, [preset])).toBe(keyword);
  });

  it('preserves only agreed slots when omitted optional values are ambiguous', () => {
    const preset = { ...compact, custom1Value: 'red widget', variableOrder: ['Goal', 'Keyword', 'Custom1', 'EW'] };
    expect(parseCampaignName('Rank | red widget | EW', preset)).toEqual({
      slots: { Goal: 'Rank', EW: 'EW' }, confidence: 'partial',
    });
    expect(keywordFromCampaignName('Rank | red widget | EW', [preset])).toBeNull();
  });

  it('refuses disagreeing presets regardless of their order', () => {
    const first = { ...compact, variableOrder: ['Goal', 'Keyword', 'ProductName', 'EW'] };
    const second = { ...first, variableOrder: ['Goal', 'ProductName', 'Keyword', 'EW'] };
    for (const presets of [[first, second], [second, first]]) {
      expect(keywordFromCampaignName('Rank | red widget | blue widget | EW', presets)).toBeNull();
    }
  });

  it('honors custom separators and refuses invalid preset grammars', () => {
    const preset = { ...compact, delimiter: ' :: ' };
    expect(keywordFromCampaignName('Rank :: SB :: Phrase :: blue widget :: EW', [preset])).toBe('blue widget');
    expect(parseCampaignName('anything', { ...preset, delimiter: '' }).confidence).toBe('none');
    expect(parseCampaignName('one :: two', { ...preset, variableOrder: ['Keyword', 'Keyword'] }).confidence).toBe('none');
    expect(keywordFromCampaignName('anything', [])).toBeNull();
  });
});

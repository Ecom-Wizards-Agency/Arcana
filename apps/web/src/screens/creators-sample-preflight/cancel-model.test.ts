/**
 * The cancel flow's own words for the ledger refusals it shares with the send
 * flow (WP-338p): a refused cancel press names the cancel preview and its one
 * order, never a send preview or a unit count.
 */
import { describe, expect, it } from 'vitest';
import { CREATOR_MCF_REFUSALS } from '@wizard-ads/db';
import { CANCEL_REFUSAL_WORDS, cancelRefusalWords } from './cancel-model';
import { REFUSAL_WORDS } from './send-model';

describe('cancel refusal words', () => {
  const OWN = ['confirmation_mismatch', 'preview_not_latest', 'fingerprint_mismatch'] as const;

  it('gives the three shared refusals the cancel flow\'s own words, differing from the send flow\'s', () => {
    expect(Object.keys(CANCEL_REFUSAL_WORDS).sort()).toEqual([...OWN].sort());
    for (const reason of OWN) {
      expect(cancelRefusalWords(reason)).toBe(CANCEL_REFUSAL_WORDS[reason]);
      expect(cancelRefusalWords(reason)).not.toBe(REFUSAL_WORDS[reason]);
      expect(cancelRefusalWords(reason)).toMatch(/cancel/i);
      expect(cancelRefusalWords(reason)).not.toMatch(/unit|send preview/i);
    }
    expect(cancelRefusalWords('confirmation_mismatch')).toContain('"Cancel 1 order in Amazon"');
  });

  it('falls back to the words every command uses for every other refusal, cancel-only ones included', () => {
    const others = [...CREATOR_MCF_REFUSALS, 'forbidden', 'unavailable', 'invalid'].filter((reason) => !(OWN as readonly string[]).includes(reason));
    expect(others.length).toBe(Object.keys(REFUSAL_WORDS).length - OWN.length);
    for (const reason of others) expect(cancelRefusalWords(reason as keyof typeof REFUSAL_WORDS)).toBe(REFUSAL_WORDS[reason as keyof typeof REFUSAL_WORDS]);
    expect(cancelRefusalWords('cancel_preview_expired')).toBe('The cancel preview is older than 5 minutes. Read the order again.');
  });
});

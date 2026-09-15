import { describe, expect, it } from 'vitest';
import { FeedbackCommand, FeedbackCommandResult, FeedbackItemRecord } from './feedback.js';

const itemId = '11111111-1111-4111-8111-111111111111';
describe('feedback command contract', () => {
  it('normalizes submission content and keeps optional fields and null clearing distinct', () => {
    expect(FeedbackCommand.parse({ kind: 'create', type: 'feature', title: '  Saved   views  ', body: ' Details ' }))
      .toEqual({ kind: 'create', type: 'feature', title: 'Saved views', body: 'Details' });
    expect(FeedbackCommand.parse({ kind: 'edit', itemId, severity: null })).toEqual({ kind: 'edit', itemId, severity: null });
    expect(FeedbackCommand.parse({ kind: 'triage', itemId, adminNote: null })).toEqual({ kind: 'triage', itemId, adminNote: null });
  });
  it('rejects authority fields, mixed intents and replay options', () => {
    for (const extra of [{ orgId: itemId }, { authorId: itemId }, { userId: itemId }, { role: 'owner' }, { retry: true }]) {
      expect(FeedbackCommand.safeParse({ kind: 'toggleVote', itemId, ...extra }).success).toBe(false);
    }
    expect(FeedbackCommand.safeParse({ kind: 'triage', itemId, status: 'planned', title: 'Mixed' }).success).toBe(false);
    expect(FeedbackCommand.safeParse({ kind: 'duplicate', itemId, duplicateOf: itemId, adminNote: 'Mixed' }).success).toBe(false);
  });
  it('normalizes context through the command boundary without trusting caller labels', () => {
    for (const route of ['https://example.test/grid', '//example.test/grid', '/grid\\other', '/grid\nheader']) {
      const parsed = FeedbackCommand.parse({ kind: 'create', type: 'bug', title: 'Context',
        pageContext: { route, profileId: null, appVersion: '   ' } });
      expect(parsed).toMatchObject({ pageContext: { route: null, profileId: null, appVersion: null } });
    }
    const parsed = FeedbackCommand.parse({ kind: 'create', type: 'bug', title: 'Context',
      pageContext: { route: ' /grid ', profileId: null, appVersion: ' version ' } });
    expect(parsed).toMatchObject({ pageContext: { route: '/grid', appVersion: 'version' } });
  });
  it('rejects invalid or empty changes while allowing the unchanged no-body vote intent', () => {
    expect(FeedbackCommand.parse({ kind: 'toggleVote', itemId })).toEqual({ kind: 'toggleVote', itemId });
    for (const command of [null, [], { kind: 'edit', itemId }, { kind: 'triage', itemId },
      { kind: 'toggleVote', itemId: 'missing' }, { kind: 'create', type: 'feature', title: ' ', body: '' },
      { kind: 'create', type: 'feature', title: 'Valid', severity: 'high' },
      { kind: 'create', type: 'bug', title: 'Valid', severity: 'unknown' }]) {
      expect(FeedbackCommand.safeParse(command).success).toBe(false);
    }
  });
  it('retains existing read-model Date and JSON types and refuses invented vote counts', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const item = { id: itemId, orgId: itemId, authorId: null, type: 'bug', title: 'Title', body: '',
      severity: null, status: 'new', adminNote: null, duplicateOf: null, dedupCheckedAt: null,
      pageContext: { route: '/grid', actorType: 'user' }, votes: 0, viewerHasVoted: false,
      createdAt: date, updatedAt: date, statusChangedAt: date };
    expect(FeedbackItemRecord.parse(item)).toEqual(item);
    expect(FeedbackCommandResult.parse({ kind: 'created', item })).toEqual({ kind: 'created', item });
    for (const votes of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(FeedbackCommandResult.safeParse({ kind: 'vote', itemId, voted: false, votes }).success).toBe(false);
    }
  });
});

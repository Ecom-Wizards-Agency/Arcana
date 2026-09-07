import { describe, expect, it } from 'vitest';
import {
  ExperimentCommand, ExperimentCommandResult, ExperimentMutationResponse, ExperimentScopeInput,
  EXPERIMENT_STATUSES, canTransitionExperiment,
} from './experiments.js';

const id = '11111111-1111-4111-8111-111111111111';
const create = { kind: 'create', profileId: id, name: '  Synthetic\n experiment ', type: 'other', metricFocus: 'sales' };

describe('experiment contracts', () => {
  it('binds writable fields to one intent without admitting authority or initial terminal status', () => {
    expect(ExperimentCommand.parse(create)).toMatchObject({ name: 'Synthetic experiment' });
    for (const patch of [{ orgId: id }, { createdBy: id }, { actorId: id }, { endAt: null }, { status: 'ended' }]) {
      expect(ExperimentCommand.safeParse({ ...create, ...patch }).success).toBe(false);
    }
    expect(ExperimentCommand.safeParse({ kind: 'edit', experimentId: id }).success).toBe(false);
    expect(ExperimentCommand.safeParse({ kind: 'edit', experimentId: id, status: 'running', name: 'Changed' }).success).toBe(false);
    expect(ExperimentCommand.safeParse({ kind: 'transition', experimentId: id, note: 'Only a note' }).success).toBe(false);
    expect(ExperimentCommand.parse({ kind: 'transition', experimentId: id, resultNote: null })).toEqual({
      kind: 'transition', experimentId: id, resultNote: null,
    });
  });

  it('keeps deliberate broad scopes and rejects malformed selectors instead of dropping them', () => {
    expect(ExperimentScopeInput.parse({ campaignIds: [' c-1 ', 'c-1', 'c-2'] })).toEqual({ campaignIds: ['c-1', 'c-2'] });
    expect(ExperimentScopeInput.parse({})).toEqual({});
    expect(ExperimentScopeInput.parse({ campaignIds: [] })).toEqual({ campaignIds: [] });
    for (const scope of [null, [], { campaignIds: 'c-1' }, { campaignIds: [false] },
      { campaignIds: ['c-1', ''] }, { campaignIds: [' '] }, { campagnIds: ['c-1'] }]) {
      expect(ExperimentCommand.safeParse({ ...create, scope }).success).toBe(false);
    }
  });

  it('parses valid start dates without accepting invalid dates or out-of-range timestamps', () => {
    for (const startAt of ['2026-09-07', '2026-09-07T00:00:00Z', '2026-09-07T07:00:00+07:00', new Date('2026-09-07T00:00:00Z')]) {
      expect(ExperimentCommand.parse({ ...create, startAt })).toMatchObject({ startAt: new Date('2026-09-07T00:00:00Z') });
    }
    for (const startAt of ['2026-02-30', '2026-02-30T00:00:00Z', 'infinity', '', 'tomorrow', 0, new Date(NaN)]) {
      expect(ExperimentCommand.safeParse({ ...create, startAt }).success).toBe(false);
    }
  });

  it('preserves every allowed transition and the eventless same-status possibility', () => {
    const allowed = new Set(['planned:running', 'planned:aborted', 'running:ended', 'running:aborted',
      'ended:analyzed', 'ended:running', 'ended:aborted', 'analyzed:running', 'analyzed:aborted']);
    let pairs = 0;
    for (const from of EXPERIMENT_STATUSES) for (const to of EXPERIMENT_STATUSES) {
      expect(canTransitionExperiment(from, to)).toBe(from === to || allowed.has(`${from}:${to}`)); pairs++;
    }
    expect(pairs).toBe(25);
  });

  it('keeps database dates native and derives the existing JSON item with a persisted event', () => {
    const now = new Date('2026-09-07T00:00:00Z');
    const item = { id, orgId: id, profileId: id, name: 'Synthetic', hypothesis: '', type: 'other',
      scope: { campaignIds: ['historical-mirror'] }, metricFocus: 'sales', startAt: now, endAt: null,
      status: 'planned', resultNote: null, createdBy: id, createdAt: now, updatedAt: now, statusChangedAt: now };
    const event = { id: 1, experimentId: id, orgId: id, fromStatus: null, toStatus: 'planned', note: 'Created', actorId: id, createdAt: now };
    expect(ExperimentCommandResult.parse({ kind: 'created', item, event }).item.startAt).toEqual(now);
    expect(ExperimentMutationResponse.parse(JSON.parse(JSON.stringify({ item, event })))).toMatchObject({
      item: { startAt: now.toISOString() }, event: { id: 1, createdAt: now.toISOString() },
    });
    expect(ExperimentCommandResult.safeParse({ kind: 'created', item, event: null }).success).toBe(false);
    expect(ExperimentCommandResult.safeParse({ kind: 'updated', item, event }).success).toBe(false);
    expect(ExperimentCommandResult.safeParse({ kind: 'transitioned', item, event: null }).success).toBe(true);
  });
});

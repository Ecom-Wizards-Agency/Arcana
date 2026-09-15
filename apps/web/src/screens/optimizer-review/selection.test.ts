import { expect, it, vi } from 'vitest';
import { workedPlacementRow } from './worked-example';
import { acceptSelection, stageSelection } from './selection';
const { trace: _trace, dependencySet: _dependency, ...inputs } = workedPlacementRow.inputs;
const first = { ...workedPlacementRow, inputs: { ...inputs, methodId: 'sp.reference-efficiency' as const, methodVersion: 'reference.1' as const } };
const second = { ...first, id: '55555555-5555-4555-8555-555555555555' };
const dismissed = { ...first, id: '66666666-6666-4666-8666-666666666666', status: 'dismissed' as const };
it('accepts only selected rows through decide and exports exactly those IDs', async () => {
  const send = vi.fn().mockResolvedValueOnce({ updated: 1, offered: 1, refused: [] }).mockResolvedValueOnce({ batchId: 'synthetic-export', exported: 1, skipped: [] });
  const rows = [first, second, dismissed];
  const ids = await acceptSelection(rows, new Set([second.id]), send);
  expect(send).toHaveBeenNthCalledWith(1, '/api/recommendations/decide', { ids: [second.id], decision: 'accepted', note: 'Optimize Now selection' });
  expect(rows.map((row) => row.status)).toEqual(['proposed', 'proposed', 'dismissed']);
  expect(await stageSelection(first.profileId, rows, ids, send)).toBe('synthetic-export');
  expect(send.mock.calls[1]?.[1]).toMatchObject({ ids: [second.id] });
});
it('refuses dismissed selection and a partial decision acknowledgement', async () => {
  const send = vi.fn().mockResolvedValue({ updated: 0, offered: 1, refused: [{ id: first.id }] });
  await expect(acceptSelection([dismissed], new Set([dismissed.id]), send)).rejects.toThrow('executable');
  expect(send).not.toHaveBeenCalled();
  await expect(acceptSelection([first], new Set([first.id]), send)).rejects.toThrow('does not match');
});

it('exports one complete saved selection across child runs and reuses its identity after a lost response', async () => {
  const rows = [first, { ...second, runId: '77777777-7777-4777-8777-777777777777' }, dismissed];
  const saved = { batchId: '88888888-8888-4888-8888-888888888888', requestId: '99999999-9999-4999-8999-999999999999', reviewFingerprint: 'a'.repeat(64) };
  const result = { ...saved, applyBatchId: '22222222-2222-4222-8222-222222222222',
    forwardRowIds: ['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'],
    counts: { offered: 2, accepted: 2, exported: 2, applyRows: 2 } };
  const { reviewFingerprint: _binding, ...response } = result;
  const send = vi.fn().mockRejectedValueOnce(new Error('Lost export response')).mockResolvedValue(response);
  const execute = () => stageSelection(first.profileId, rows, [second.id,first.id], send, saved);
  await expect(execute()).rejects.toThrow('Lost export response');
  expect(await execute()).toBe(response.applyBatchId);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  expect(send.mock.calls[0]).toEqual(['/api/optimizer/exports', { ...saved, profileId: first.profileId, recommendationIds: [first.id,second.id].sort() }]);
  expect(rows[2]?.status).toBe('dismissed');
});

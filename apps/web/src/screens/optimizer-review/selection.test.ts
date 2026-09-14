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

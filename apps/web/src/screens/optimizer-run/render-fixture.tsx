import { spWriteOperationFixture as operationFixture } from '../../writes/approval-fixtures';
import { profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';
export { spWriteResultFixture as resultFixture, spWriteOperationFixture as operationFixture } from '../../writes/approval-fixtures';
export type { SpWriteResultVisualState as ResultVisualState } from '../../writes/approval-fixtures';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ready = { view: 'ready', props: { profile: { ...profile, id: id(3) }, operation: operationFixture('queued'), batchId: id(5), retry: false, retryProposals: [], retrySnapshots: [] } } satisfies ScreenData;

import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { load as loadReview } from '../optimizer-review/load';
export async function load(access: ScreenActor, input: ScreenParams) {
  const data = await loadReview(access, input);
  if (data.view !== 'ready') return data;
  const row = data.props.review.proposals.find((candidate) => candidate.id === input.params['rowId']);
  if (!row) return { view: 'error' as const, props: { message: 'This target does not belong to the saved preview.' } };
  return { view: 'ready' as const, props: { ...data.props, row } };
}

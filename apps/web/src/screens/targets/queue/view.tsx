import { gateMessage } from '../../../ui/gate-message';
import { QueueReview } from './review';
import type { load } from './load';
export default function Screen({ data }: { data: Awaited<ReturnType<typeof load>> }) {
  return data.view === 'gated' ? <main><h1>Review queued change</h1><p>{gateMessage(data.state)}</p></main> : <QueueReview change={data.change} back={data.back} />;
}

import { gateMessage } from '../../ui/gate-message';
import { Target360 } from './target360';
import type { load } from './load';
export default function ScreenView({ data }: { data: Awaited<ReturnType<typeof load>> }) {
  if (data.view === 'gated') return <main><h1>Target history</h1><p>{gateMessage(data.state)}</p></main>;
  return <Target360 model={data} currencyCode={data.currencyCode} back={data.back} savedView={data.savedView} showLimits={data.showLimits} />;
}

import { gateMessage } from '../../ui/gate-message';
import { OptimizerFrame, OptimizerUnavailable } from '../optimizer/frame';
import { CalculationContent } from '../optimizer-review/components';
import { recordedPlacementInputs } from '../optimizer-review/model';
import type { load } from './load';
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'gated') return <OptimizerUnavailable title="Calculation details" message={gateMessage(data.props.entry.state)} />;
  if (data.view === 'empty') return <OptimizerUnavailable title="Calculation details" message="No profiles yet." />;
  if (data.view === 'error') return <OptimizerUnavailable title="Calculation details" message={data.props.message} />;
  const { profile, row, review } = data.props;
  const placementInputs = recordedPlacementInputs(row, review.children.flatMap((child) => child.calculationSnapshots));
  return <OptimizerFrame title="Calculation details" subtitle={`${profile.label} · ${row.inputs.methodId ?? 'Method unavailable'} · ${row.inputs.methodVersion ?? 'Version unavailable'}`}><CalculationContent snapshots={review.children.flatMap((child) => child.calculationSnapshots)} row={row} profileId={profile.id} currencyCode={profile.currencyCode} placementInputs={placementInputs} backHref={`/optimizer/review/${review.batchId}?profile=${profile.id}`} /></OptimizerFrame>;
}

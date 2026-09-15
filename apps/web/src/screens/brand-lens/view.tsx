import { EmptyState } from '@wizard-ads/ui';
import type { load } from './load';
import { BrandLens } from './workspace';
export { BrandLens } from './workspace';
export type BrandLensData = Awaited<ReturnType<typeof load>>;
export default function Screen({ data }: { data: BrandLensData }) {
  if (data.view === 'gated') return <EmptyState variant="gated" title="Brand lens is unavailable" body="An available database and organisation membership are required." />;
  if (data.view === 'empty') return <EmptyState title="No profiles yet" body="Connect a profile to classify its keywords." />;
  if (data.view === 'error') return <p role="alert">{data.message}</p>;
  return <BrandLens data={data} />;
}

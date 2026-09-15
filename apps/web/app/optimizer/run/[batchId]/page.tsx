import { descriptor as template } from '../../../../src/screens/optimizer-run/descriptor';
import { optimizerRouteDescriptor } from '../../../../src/screens/optimizer/route-descriptor';
import { pageRead } from '../../../../src/server/page-read';
import type { ScreenSearchParams } from '../../../../src/screens/types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams, params }: { searchParams?: Promise<ScreenSearchParams>; params?: Promise<Record<string, string>> } = {}) {
  const descriptor = optimizerRouteDescriptor(template, await params ?? {});
  const data = await pageRead(descriptor, searchParams, params);
  const Screen = await descriptor.client();
  return <Screen data={data} />;
}

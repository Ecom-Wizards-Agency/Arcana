import { descriptor } from '../../src/screens/strategy/descriptor';
import { pageRead } from '../../src/server/page-read';
import type { ScreenSearchParams } from '../../src/screens/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams, params }: {
  searchParams?: Promise<ScreenSearchParams>;
  params?: Promise<Record<string, string>>;
} = {}) {
  const data = await pageRead(descriptor, searchParams, params);
  const Screen = await descriptor.client();
  return Screen({ data });
}

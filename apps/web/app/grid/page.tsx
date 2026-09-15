import { descriptor } from '../../src/screens/grid/descriptor';
import { pageRead } from '../../src/server/page-read';
import type { ScreenSearchParams } from '../../src/screens/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams, params }: {
  searchParams?: Promise<ScreenSearchParams>;
  params?: Promise<Record<string, string>>;
} = {}) {
  const [data, Screen] = await Promise.all([
    pageRead(descriptor, searchParams, params),
    descriptor.client(),
  ]);
  return Screen({ data });
}

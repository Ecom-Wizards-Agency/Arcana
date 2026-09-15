import type { ReactNode } from 'react';
import { descriptor } from '../../../../src/screens/experiments-detail/descriptor';
import { pageRead } from '../../../../src/server/page-read';

/** Resolve tenant visibility before this segment's loading boundary can send HTTP 200. */
export default async function ExperimentLayout({ children, params }: {
  children: ReactNode;
  params: Promise<Record<string, string>>;
}) {
  await pageRead(descriptor, {}, params);
  return children;
}

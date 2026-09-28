import { descriptor } from '../../../../../src/screens/creators-sample-preflight/descriptor';
import { pageRead } from '../../../../../src/server/page-read';
import type { ScreenSearchParams } from '../../../../../src/screens/types';
import {
  approveMcfSend, refreshMcfPreview, releaseMcfSend, requestMcfSettleRead, resolveMcfConflict, sealMcfRecipient, withdrawMcfSend,
} from './actions';

/** Server action references for the send section; each re-reads the actor and rechecks the role in the database. */
const actions = {
  seal: sealMcfRecipient, approve: approveMcfSend, withdraw: withdrawMcfSend, refresh: refreshMcfPreview, settleRead: requestMcfSettleRead,
  release: releaseMcfSend, resolveConflict: resolveMcfConflict,
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams, params }: {
  searchParams?: Promise<ScreenSearchParams>;
  params?: Promise<Record<string, string>>;
} = {}) {
  const data = await pageRead(descriptor, searchParams, params);
  const Screen = await descriptor.client();
  return Screen({ data, actions });
}

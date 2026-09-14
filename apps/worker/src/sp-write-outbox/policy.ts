import { Uuid } from '@wizard-ads/shared';

export interface SpWriteWorkerPolicy {
  dispatchEnabled: boolean;
  reconcileEnabled: boolean;
  profileIds: readonly string[];
  /** Optional exact operation scope for a preapproved bounded smoke cycle. */
  planIds?: readonly string[];
}

/** Missing flags and scope authorize nothing. Never infer permission from credentials. */
export function spWritePolicyFromEnv(env: NodeJS.ProcessEnv): SpWriteWorkerPolicy {
  const enabled = (name: string): boolean => {
    const value = env[name];
    if (value === undefined || value === '' || value === '0') return false;
    if (value !== '1') throw new Error(`Invalid ${name} flag`);
    return true;
  };
  const dispatchEnabled = enabled('OPENSPELL_SP_WRITE_DISPATCH_ENABLED');
  const reconcileEnabled = enabled('OPENSPELL_SP_WRITE_RECONCILE_ENABLED');
  const raw = env['OPENSPELL_SP_WRITE_PROFILE_IDS'];
  const profileIds = raw === undefined || raw === '' ? [] : raw.split(',').map((id) => Uuid.parse(id.trim()));
  if (new Set(profileIds).size !== profileIds.length) throw new Error('Duplicate SP write profile scope');
  if ((dispatchEnabled || reconcileEnabled) && profileIds.length === 0) {
    throw new Error('SP write runtime requires an explicit profile allowlist');
  }
  return { dispatchEnabled, reconcileEnabled, profileIds };
}

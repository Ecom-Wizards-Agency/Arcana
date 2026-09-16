import { enqueueDailyCreativeSyncJobs, ensureCreativeSyncSchedules, type DbHandle } from '@wizard-ads/db';
import { resolveCreativeSyncPolicy, type WorkerDeploymentRole } from './deployment-role.js';
import { ProviderConnectionLoop } from './provider-connection-loop.js';

/** Evo's existing fenced authority owns production; no additional deployment flag is needed. */
export function createCreativeSyncProducer(
  handle: Pick<DbHandle, 'sql'>,
  role: WorkerDeploymentRole,
  env: () => Readonly<Record<string, string | undefined>> = () => process.env,
  logger: Pick<Console, 'error'> = console,
): ProviderConnectionLoop | undefined {
  if (role !== 'evo-report-lane') return undefined;
  return new ProviderConnectionLoop(async () => {
    try {
      if (!resolveCreativeSyncPolicy(env()).enabled) return { outcome: 'idle' };
      await ensureCreativeSyncSchedules(handle);
      const counts = await enqueueDailyCreativeSyncJobs(handle, undefined, new Date(), 'fenced');
      return { outcome: counts.enqueuedJobs > 0 ? 'observed' : 'idle' };
    } catch {
      logger.error('Creative schedule production failed');
      return { outcome: 'unavailable' };
    }
  }, 5 * 60_000);
}

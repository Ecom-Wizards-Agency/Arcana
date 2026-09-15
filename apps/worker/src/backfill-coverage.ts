import { pathToFileURL } from 'node:url';
import { backfillReportCoverage, connectionStringFromEnv, createDb } from '@wizard-ads/db';

export async function runBackfillCoverage(env = process.env, write = console.log) {
  const handle = createDb({ connectionString: connectionStringFromEnv(env), max: 1 });
  try {
    const result = await backfillReportCoverage(handle);
    write(JSON.stringify(result));
    return result;
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBackfillCoverage().catch(() => {
    console.error('Coverage backfill failed. Check database access and report accounting.');
    process.exitCode = 1;
  });
}

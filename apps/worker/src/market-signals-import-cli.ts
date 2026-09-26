/**
 * `pnpm --filter @wizard-ads/worker run market-signals:import -- --once`
 *
 * One import pass for runbooks, reading every file. Prints one JSON line of
 * counts, never a record. Exit codes: 0 every batch imported or already
 * imported; 3 the pass finished with findings (invalid records, a batch whose
 * lines disagree with its header, or a batch whose org_key maps to no
 * organisation); 2 usage or configuration error; 1 the import failed, a file
 * could not be read, or the database refused a batch and the rest of that file waits.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import type { MarketSignalsImportCounts } from '@wizard-ads/shared';
import {
  DirectoryBatchSource,
  MARKET_SIGNALS_DIR_ENV,
  MarketSignalsImporter,
  marketSignalsImportConfigFromEnv,
} from './market-signals-import.js';

export const MARKET_SIGNALS_IMPORT_USAGE = 'usage: market-signals:import --once';

export class MarketSignalsCliUsageError extends Error {}

export function parseMarketSignalsImportArgs(args: readonly string[]): void {
  const flags = args.filter((arg) => arg !== '--');
  if (flags.length !== 1 || flags[0] !== '--once') throw new MarketSignalsCliUsageError(MARKET_SIGNALS_IMPORT_USAGE);
}

export function marketSignalsImportExitCode(counts: MarketSignalsImportCounts): 0 | 1 | 3 {
  if (counts.batchesFailed > 0 || counts.filesFailed > 0) return 1;
  return counts.invalidRecords > 0 || counts.batchesCountMismatch > 0 || counts.batchesUnmappedOrg > 0 ? 3 : 0;
}

export interface MarketSignalsImportCliDeps {
  run(input: { directory: string; orgKeys: ReadonlyMap<string, string>; connectionString: string }): Promise<MarketSignalsImportCounts>;
  write(line: string): void;
  error(line: string): void;
}

const defaultDeps: MarketSignalsImportCliDeps = {
  async run(input) {
    const handle = createDb({ connectionString: input.connectionString, max: 2 });
    try {
      return await new MarketSignalsImporter(handle, new DirectoryBatchSource(input.directory), input.orgKeys).run();
    } finally {
      await handle.close();
    }
  },
  write: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runMarketSignalsImportCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<MarketSignalsImportCliDeps> = {},
): Promise<number> {
  const deps: MarketSignalsImportCliDeps = { ...defaultDeps, ...overrides };
  let input: Parameters<MarketSignalsImportCliDeps['run']>[0];
  try {
    parseMarketSignalsImportArgs(args);
    const config = marketSignalsImportConfigFromEnv(env);
    if (config.directory === null) throw new MarketSignalsCliUsageError(`${MARKET_SIGNALS_DIR_ENV} is not set; the import is off`);
    input = { directory: config.directory, orgKeys: config.orgKeys, connectionString: connectionStringFromEnv(env) };
  } catch (error) {
    deps.error(error instanceof Error ? error.message : MARKET_SIGNALS_IMPORT_USAGE);
    return 2;
  }
  try {
    const counts = await deps.run(input);
    deps.write(JSON.stringify(counts));
    return marketSignalsImportExitCode(counts);
  } catch (error) {
    deps.error(`Market signals import failed (${error instanceof Error ? error.name : 'unknown'})`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMarketSignalsImportCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

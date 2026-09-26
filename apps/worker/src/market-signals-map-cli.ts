/**
 * `pnpm --filter @wizard-ads/worker run market-signals:map -- --org <slug> --profile-key <key> --profile <label>`
 *
 * Maps one wizards-ai profile key to one profile of the organisation (an
 * owner's operator act, run with the worker's service connection). `--profile`
 * matches the profile id, its Amazon profile id or its label; more than one
 * match is refused. Signals already imported under the key take the profile.
 * Exit codes: 0 mapped; 3 organisation or profile not found, or ambiguous;
 * 2 usage error; 1 failure.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import { MarketSignalsMapError, mapMarketSignalsProfile } from '@wizard-ads/db/worker';

export const MARKET_SIGNALS_MAP_USAGE = 'usage: market-signals:map --org <slug> --profile-key <key> --profile <label>';

export interface MarketSignalsMapArgs { orgSlug: string; profileKey: string; profile: string }

export function parseMarketSignalsMapArgs(args: readonly string[]): MarketSignalsMapArgs {
  const values = new Map<string, string>();
  const rest = args.filter((arg) => arg !== '--');
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1]?.trim();
    if (!name || !['--org', '--profile-key', '--profile'].includes(name) || !value || values.has(name)) {
      throw new Error(MARKET_SIGNALS_MAP_USAGE);
    }
    values.set(name, value);
  }
  const orgSlug = values.get('--org');
  const profileKey = values.get('--profile-key');
  const profile = values.get('--profile');
  if (!orgSlug || !profileKey || !profile) throw new Error(MARKET_SIGNALS_MAP_USAGE);
  return { orgSlug, profileKey, profile };
}

export interface MarketSignalsMapCliDeps {
  map(input: MarketSignalsMapArgs, connectionString: string): ReturnType<typeof mapMarketSignalsProfile>;
  write(line: string): void;
  error(line: string): void;
}

const defaultDeps: MarketSignalsMapCliDeps = {
  async map(input, connectionString) {
    const handle = createDb({ connectionString, max: 1 });
    try {
      return await mapMarketSignalsProfile(handle, input);
    } finally {
      await handle.close();
    }
  },
  write: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runMarketSignalsMapCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<MarketSignalsMapCliDeps> = {},
): Promise<number> {
  const deps: MarketSignalsMapCliDeps = { ...defaultDeps, ...overrides };
  let input: MarketSignalsMapArgs;
  let connectionString: string;
  try {
    input = parseMarketSignalsMapArgs(args);
    connectionString = connectionStringFromEnv(env);
  } catch (error) {
    deps.error(error instanceof Error ? error.message : MARKET_SIGNALS_MAP_USAGE);
    return 2;
  }
  try {
    const result = await deps.map(input, connectionString);
    deps.write(JSON.stringify({
      orgId: result.row.orgId, profileKey: result.row.profileKey, profileId: result.row.profileId,
      insightsAttached: result.insightsAttached,
    }));
    return 0;
  } catch (error) {
    if (error instanceof MarketSignalsMapError) {
      deps.error(`${error.message} (${error.reason})`);
      return 3;
    }
    deps.error(`Market signals profile mapping failed (${error instanceof Error ? error.name : 'unknown'})`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMarketSignalsMapCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

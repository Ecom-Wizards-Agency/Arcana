import { SCREEN_REGISTRY } from './screens/registry-metadata';

function specsFor(suite: string): string[] {
  return SCREEN_REGISTRY.flatMap((screen) => screen.specs.filter((spec) => spec.suite === suite).map((spec) => spec.file)).sort();
}

/**
 * The complete browser-suite ownership contract.
 *
 * Order, runner dispatch and command-line selection all derive from this one
 * registry. Keep spec ownership exact: a test file may belong to one process
 * partition only.
 */
export const E2E_SUITE_DEFINITIONS = [
  {
    name: 'tags-goto',
    kind: 'production-bridge',
    config: 'playwright.tags-goto.config.ts',
    project: 'tags-goto',
    expectedSpecFiles: specsFor('tags-goto'),
    expectedTests: 34,
  },
  {
    name: 'grid-performance',
    kind: 'authenticated-dev',
    config: 'playwright.grid-performance.config.ts',
    project: 'grid-performance',
    expectedSpecFiles: specsFor('grid-performance'),
    expectedTests: 1,
  },
  {
    name: 'optimization-groups',
    kind: 'authenticated-dev',
    config: 'playwright.optimization-groups.config.ts',
    project: 'optimization-groups',
    expectedSpecFiles: specsFor('optimization-groups'),
    expectedTests: 3,
  },
  {
    name: 'profile-context',
    kind: 'authenticated-dev',
    config: 'playwright.profile-context.config.ts',
    project: 'profile-context',
    expectedSpecFiles: specsFor('profile-context'),
    expectedTests: 8,
  },
  {
    name: 'auth-guards-anonymous',
    kind: 'authenticated-dev',
    config: 'playwright.auth-guards-anonymous.config.ts',
    project: 'auth-guards-anonymous',
    expectedSpecFiles: specsFor('auth-guards-anonymous'),
    expectedTests: 2,
  },
  {
    name: 'auth-guards-signed-in',
    kind: 'authenticated-dev',
    config: 'playwright.auth-guards-signed-in.config.ts',
    project: 'auth-guards-signed-in',
    expectedSpecFiles: specsFor('auth-guards-signed-in'),
    expectedTests: 3,
  },
  {
    name: 'auth',
    kind: 'authenticated-dev',
    config: 'playwright.auth.config.ts',
    project: 'auth',
    expectedSpecFiles: specsFor('auth'),
    expectedTests: 10,
  },
  {
    name: 'auth-members',
    kind: 'authenticated-dev',
    config: 'playwright.auth-members.config.ts',
    project: 'auth-members',
    expectedSpecFiles: specsFor('auth-members'),
    expectedTests: 5,
  },
  {
    name: 'auth-oauth',
    kind: 'authenticated-dev',
    config: 'playwright.auth-oauth.config.ts',
    project: 'auth-oauth',
    expectedSpecFiles: specsFor('auth-oauth'),
    expectedTests: 7,
  },
  {
    name: 'auth-roles',
    kind: 'authenticated-dev',
    config: 'playwright.auth-roles.config.ts',
    project: 'auth-roles',
    expectedSpecFiles: specsFor('auth-roles'),
    expectedTests: 9,
  },
  {
    name: 'route-acceptance',
    kind: 'authenticated-dev',
    config: 'playwright.route-acceptance.config.ts',
    project: 'route-acceptance',
    expectedSpecFiles: specsFor('route-acceptance'),
    expectedTests: 4,
  },
] as const;

export type E2ESuiteDefinition = (typeof E2E_SUITE_DEFINITIONS)[number];
export type E2ESuite = E2ESuiteDefinition['name'];
export type ProductionBridgeSuiteDefinition = Extract<
  E2ESuiteDefinition,
  { kind: 'production-bridge' }
>;
export type AuthenticatedDevSuiteDefinition = Extract<
  E2ESuiteDefinition,
  { kind: 'authenticated-dev' }
>;

export const E2E_SUITES: readonly E2ESuite[] = E2E_SUITE_DEFINITIONS.map(
  ({ name }) => name,
);

export function getE2ESuiteDefinition(name: E2ESuite): E2ESuiteDefinition {
  const definition = E2E_SUITE_DEFINITIONS.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`No E2E suite definition for '${name}'`);
  return definition;
}

/**
 * Run every selected process partition even when one throws before Playwright
 * can return an exit code. The final nonzero result retains the runner's
 * existing last-failure policy while the callback preserves thrown details.
 */
export async function runE2ESuiteMatrix(
  definitions: readonly E2ESuiteDefinition[],
  runSuite: (definition: E2ESuiteDefinition) => Promise<number>,
  onThrownError: (definition: E2ESuiteDefinition, error: unknown) => void,
): Promise<number> {
  let finalCode = 0;
  for (const definition of definitions) {
    let code: number;
    try {
      code = await runSuite(definition);
    } catch (error) {
      onThrownError(definition, error);
      code = 1;
    }
    if (code !== 0) finalCode = code;
  }
  return finalCode;
}

/** Exact basename ownership, including a path boundary on Windows and POSIX. */
export function e2eTestMatch(name: E2ESuite): RegExp[] {
  return getE2ESuiteDefinition(name).expectedSpecFiles.map((file) =>
    new RegExp(`(?:^|[/\\\\])${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  );
}

export const E2E_EXPECTED_TOTAL = E2E_SUITE_DEFINITIONS.reduce(
  (total, suite) => total + suite.expectedTests, 0,
);

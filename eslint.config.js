// Flat ESLint config for the whole workspace.
//
// Beyond ordinary TypeScript hygiene this file is where the dependency direction
// from AGENTS.md is mechanically enforced:
//
//   shared  <-  core / strategy / ads-api / sp-api / datadive-api / db  <-  web / worker / mcp
//
// `core` never imports `db` or `ads-api`; `apps/web` never imports `ads-api`
// (every Amazon call lives in the worker); `shared` imports nothing of ours.
import js from '@eslint/js';
import { crossPackageImports } from './tools/cross-package-imports.mjs';
import tseslint from 'typescript-eslint';

/** Build a no-restricted-imports rule entry for a set of forbidden workspace packages. */
const forbid = (pairs) => [
  'error',
  {
    paths: pairs.map(([name, message]) => ({ name, message })),
  },
];

// WP-338e: only the dedicated MCF unit may open a sealed recipient or touch the
// MCF ledger's service-role functions. apps/web and apps/mcp may seal (the
// browser) and read outcomes, never open, import the key or drive the unit.
const MCF_UNIT_ONLY = 'only the MCF unit (apps/worker/src/mcf-send, wizard-ads-mcf.service) may open a sealed recipient or drive the MCF ledger.';
const MCF_SERVICE_FUNCTIONS = [
  'claimCreatorMcfOutbox', 'expireCreatorMcfCustody', 'markCreatorMcfLadderExhausted', 'purgeCreatorMcfMasks', 'readCreatorMcfActiveKeyIds',
  'readCreatorMcfAlertSummary', 'readCreatorMcfCustody', 'readCreatorMcfCustodyResidue', 'recordCreatorMcfCancelOutcome',
  'recordCreatorMcfCancelPreview', 'recordCreatorMcfCancelUnsent', 'recordCreatorMcfHeartbeat', 'recordCreatorMcfOutcome', 'recordCreatorMcfPreview',
  'recordCreatorMcfSettlement', 'refuseCreatorMcfPreview', 'releaseCreatorMcfClaim', 'reserveCreatorMcfCancel', 'reserveCreatorMcfDispatch',
];
const mcfPaths = [
  { name: '@wizard-ads/shared', importNames: ['openCreatorMcfRecipient', 'importCreatorMcfRecipientKey'], message: MCF_UNIT_ONLY },
  { name: '@wizard-ads/db/worker', importNames: MCF_SERVICE_FUNCTIONS, message: MCF_UNIT_ONLY },
];
const mcfPatterns = [
  { group: ['**/mcf-send', '**/mcf-send/**', '**/mcf-main', '**/mcf-main.*', '**/creators/mcf-envelope', '**/creators/mcf-envelope.*',
    '**/queries/creators-mcf-send', '**/queries/creators-mcf-send.*'], message: MCF_UNIT_ONLY },
];
/** forbid() plus the MCF bans, for apps/web and apps/mcp. */
const forbidWithMcf = (pairs) => [
  'error',
  { paths: [...pairs.map(([name, message]) => ({ name, message })), ...mcfPaths], patterns: mcfPatterns },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '.vercel/**',
      '_local/**',
      '**/coverage/**',
      'fixtures/golden/**',
    ],
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    // Existing exceptions outside WP-272's file scope; new imports remain forbidden.
    plugins: { workspace: { rules: { 'public-imports': crossPackageImports } } },
    rules: { 'workspace/public-imports': ['error', { existing: [
      { file: 'packages/db/scripts/measure-read-path.ts', source: '../../../apps/web/app/_lib/grid-data.js' },
      { file: 'packages/db/scripts/measure-read-path.ts', source: '../../../apps/web/app/_lib/dashboard-data.js' },
      { file: 'packages/db/scripts/measure-read-path.ts', source: '../../../apps/web/app/_lib/optimizer-page-data.js' },
      { file: 'apps/web/app/grid/measure-corridor.ts', source: '../../../../packages/db/src/testing/harness.js' },
      { file: 'apps/web/src/screens/time-machine/queue.tsx', source: '../../../../../packages/ui/src/cells/ChangeChip' },
      { file: 'apps/web/src/screens/time-machine/queue.tsx', source: '../../../../../packages/core/src/restore-preview' },
      { file: 'apps/web/src/screens/time-machine/load.tsx', source: '../../../../../packages/core/src/restore-preview' },
    ] }] },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/db', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/core', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/strategy', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/ads-api', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/sp-api', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/datadive-api', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/keepa-api', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/ui', 'shared is the contract package: it depends on nothing of ours.'],
      ]),
    },
  },
  {
    files: ['packages/core/**/*.ts', 'packages/strategy/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/db', 'core and strategy are pure: zero I/O, no database.'],
        ['@wizard-ads/ads-api', 'core and strategy are pure: zero I/O, no Amazon calls.'],
        ['@wizard-ads/sp-api', 'core and strategy are pure: zero I/O, no Amazon calls.'],
        ['@wizard-ads/datadive-api', 'core and strategy are pure: zero I/O, no DataDive calls.'],
        ['@wizard-ads/keepa-api', 'core and strategy are pure: zero I/O, no Keepa calls.'],
      ]),
    },
  },
  {
    files: ['packages/sp-api/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/db', 'sp-api is a pure HTTP client: no database.'],
        ['@wizard-ads/core', 'sp-api is transport, not doctrine.'],
        ['@wizard-ads/strategy', 'sp-api receives configuration as arguments.'],
        ['@wizard-ads/ads-api', 'Amazon provider clients stay independent.'],
        ['@wizard-ads/ui', 'sp-api has no presentation dependency.'],
      ]),
    },
  },
  {
    files: ['packages/datadive-api/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/db', 'datadive-api is a pure HTTP client: no database.'],
        ['@wizard-ads/core', 'datadive-api is transport, not doctrine.'],
        ['@wizard-ads/strategy', 'datadive-api receives configuration as arguments.'],
        ['@wizard-ads/ads-api', 'provider clients stay independent.'],
        ['@wizard-ads/ui', 'datadive-api has no presentation dependency.'],
      ]),
    },
  },
  {
    files: ['packages/mrp-api/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/db', 'mrp-api is a pure provider client: no database.'],
        ['@wizard-ads/core', 'mrp-api is a transport boundary, not doctrine.'],
        ['@wizard-ads/strategy', 'mrp-api receives all configuration as arguments.'],
        ['@wizard-ads/ads-api', 'provider clients do not depend on each other.'],
        ['@wizard-ads/ui', 'mrp-api has no presentation concerns.'],
        ['@wizard-ads/campaigns', 'mrp-api has no campaign-generation concerns.'],
      ]),
    },
  },
  {
    // Consent callbacks validate browser custody and enqueue; all provider
    // clients and credential reads remain in the worker, including first setup.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': forbidWithMcf([
        ['@wizard-ads/ads-api', 'every Amazon API call lives in apps/worker, never in the web app.'],
        ['@wizard-ads/db/operator', 'installation provisioning is not an application or organization-role capability.'],
        ['@wizard-ads/agency-operator', 'the installation CLI is not an application dependency.'],
        ['@wizard-ads/sp-api', 'every Amazon API call lives in apps/worker, never in the web app.'],
        ['@wizard-ads/datadive-api', 'every DataDive API call lives in apps/worker, never in the web app.'],
        ['@wizard-ads/mrp-api', 'every MRP MCP call lives in apps/worker, never in the web app.'],
        ['@wizard-ads/keepa-api', 'every Keepa API call lives in apps/worker, never in the web app.'],
        [
          '@wizard-ads/db/worker',
          'decrypted integration credentials are worker-only; the web app may only store or revoke them.',
        ],
      ]),
    },
  },
  {
    files: ['apps/worker/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/db/operator', 'installation provisioning requires its separate operator command.'],
        ['@wizard-ads/agency-operator', 'the installation CLI is not an application dependency.'],
      ]),
    },
  },
  {
    files: ['apps/mcp/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': forbidWithMcf([
        ['@wizard-ads/db/operator', 'installation provisioning requires its separate operator command.'],
        ['@wizard-ads/agency-operator', 'the installation CLI is not an application dependency.'],
      ]),
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

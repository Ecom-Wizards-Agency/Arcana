import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { marketplaceIdForCountry } from '../marketplaces.js';
import {
  MCF_DISPATCH_ENABLED_ENV, MCF_PREVIEW_ENABLED_ENV, MCF_SCOPE_ENV, McfPolicyError, mcfClaimableActions, mcfScopeCovers, mcfSendPolicyFromEnv,
  mcfStepAllowed,
} from './policy.js';

// Synthetic ids made at run time; the marketplace is the public US id.
const CONNECTION = randomUUID();
const OTHER = randomUUID();
const MARKETPLACE = marketplaceIdForCountry('US')!;
const SCOPE = `${CONNECTION}:${MARKETPLACE}`;
const SRC = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(SRC, '../../..');

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;
const refusal = (values: Record<string, string | undefined>): McfPolicyError => {
  try {
    mcfSendPolicyFromEnv(env(values));
  } catch (error) {
    if (error instanceof McfPolicyError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('mcfSendPolicyFromEnv (fail closed)', () => {
  it.each([[undefined, false], ['', false], ['0', false], ['1', true]])('a flag set to %j is %s', (value, on) => {
    const policy = mcfSendPolicyFromEnv(env({ [MCF_PREVIEW_ENABLED_ENV]: value, [MCF_DISPATCH_ENABLED_ENV]: value, [MCF_SCOPE_ENV]: SCOPE }));
    expect(policy).toEqual({ previewEnabled: on, dispatchEnabled: on, scope: [SCOPE] });
  });

  it.each(['true', 'yes', ' 1', '1 ', '2', 'on', '01'])('any other flag value (%j) refuses, naming the variable and not the value', (value) => {
    for (const name of [MCF_PREVIEW_ENABLED_ENV, MCF_DISPATCH_ENABLED_ENV]) {
      const error = refusal({ [name]: value, [MCF_SCOPE_ENV]: SCOPE });
      expect(error.message).toBe(`${name}: invalid_flag`);
    }
  });

  it('nothing set is everything off with no scope', () => {
    expect(mcfSendPolicyFromEnv(env({}))).toEqual({ previewEnabled: false, dispatchEnabled: false, scope: [] });
  });

  it('a flag on without a scope refuses', () => {
    expect(refusal({ [MCF_PREVIEW_ENABLED_ENV]: '1' }).message).toBe(`${MCF_SCOPE_ENV}: scope_required`);
    expect(refusal({ [MCF_DISPATCH_ENABLED_ENV]: '1', [MCF_SCOPE_ENV]: '  ' }).message).toBe(`${MCF_SCOPE_ENV}: scope_required`);
  });

  it('a scope may stand without flags: settlement reads still run for it', () => {
    const policy = mcfSendPolicyFromEnv(env({ [MCF_SCOPE_ENV]: ` ${SCOPE} , ${OTHER}:${MARKETPLACE}` }));
    expect(policy.scope).toEqual([SCOPE, `${OTHER}:${MARKETPLACE}`]);
    expect(mcfClaimableActions(policy)).toEqual(['settle']);
  });

  it('duplicate scope entries refuse', () => {
    expect(refusal({ [MCF_SCOPE_ENV]: `${SCOPE},${SCOPE}` }).message).toBe(`${MCF_SCOPE_ENV}: duplicate_scope`);
  });

  it.each([
    'not-a-scope', `${CONNECTION.toUpperCase()}:${MARKETPLACE}`, `${CONNECTION}:${MARKETPLACE.toLowerCase()}`, `${CONNECTION}`, `${SCOPE},`,
    `${CONNECTION}:${MARKETPLACE}:extra`,
  ])('a malformed scope entry refuses: %s', (scope) => {
    const error = refusal({ [MCF_SCOPE_ENV]: scope });
    expect(error.message).toBe(`${MCF_SCOPE_ENV}: invalid_scope`);
    expect(error.message).not.toContain(scope.split(',')[0]!.slice(0, 12));
  });

  it('no refusal message carries the value it refused', () => {
    const canary = ['Canary', 'Value', 'Qz'].join('');
    for (const values of [{ [MCF_PREVIEW_ENABLED_ENV]: canary }, { [MCF_SCOPE_ENV]: canary }, { [MCF_SCOPE_ENV]: `${canary},${canary}` }]) {
      expect(refusal(values).message).not.toContain(canary);
    }
  });
});

describe('what the policy allows', () => {
  const policy = (preview: boolean, dispatch: boolean, scope = [SCOPE]) => ({ previewEnabled: preview, dispatchEnabled: dispatch, scope });

  it('claims only the actions its flags allow, and settle whenever a scope exists', () => {
    expect(mcfClaimableActions(policy(true, true))).toEqual(['preview', 'dispatch', 'settle']);
    expect(mcfClaimableActions(policy(true, false))).toEqual(['preview', 'settle']);
    expect(mcfClaimableActions(policy(false, true))).toEqual(['dispatch', 'settle']);
    expect(mcfClaimableActions(policy(false, false))).toEqual(['settle']);
    expect(mcfClaimableActions(policy(true, true, []))).toEqual([]);
  });

  it('each step needs its flag and the scope; reads need only the scope', () => {
    expect(mcfStepAllowed(policy(true, false), 'preview', CONNECTION, MARKETPLACE)).toBe(true);
    expect(mcfStepAllowed(policy(true, false), 'dispatch', CONNECTION, MARKETPLACE)).toBe(false);
    expect(mcfStepAllowed(policy(false, true), 'preview', CONNECTION, MARKETPLACE)).toBe(false);
    expect(mcfStepAllowed(policy(false, false), 'read', CONNECTION, MARKETPLACE)).toBe(true);
    expect(mcfStepAllowed(policy(true, true), 'dispatch', OTHER, MARKETPLACE)).toBe(false);
    expect(mcfStepAllowed(policy(true, true), 'read', OTHER, MARKETPLACE)).toBe(false);
    expect(mcfScopeCovers(policy(true, true), CONNECTION, MARKETPLACE)).toBe(true);
  });
});

/** Every worker source file reachable from `entry` through relative imports. */
async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, 'utf8');
    const specifiers = [...text.matchAll(/(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g)]
      .map((match) => match[1] ?? match[2] ?? match[3]!);
    for (const specifier of specifiers) {
      const target = resolve(dirname(file), specifier).replace(/\.js$/, '.ts');
      const candidates = target.endsWith('.ts') ? [target] : [`${target}.ts`, join(target, 'index.ts')];
      for (const candidate of candidates) {
        try {
          await readFile(candidate);
          queue.push(candidate);
          break;
        } catch {
          // Not this candidate.
        }
      }
    }
  }
  return seen;
}

describe('boundaries', () => {
  it('the general worker never reaches mcf-send or mcf-main through its imports', async () => {
    const general = await reachable(join(SRC, 'main.ts'));
    expect(general.size).toBeGreaterThan(20);
    const leaks = [...general].filter((file) => file.includes(`${join('src', 'mcf-send')}`) || file.endsWith('mcf-main.ts'));
    expect(leaks).toEqual([]);
    // Positive control: the same walk from the MCF entry does reach the loop and the custody code.
    const mcf = await reachable(join(SRC, 'mcf-main.ts'));
    expect([...mcf].some((file) => file.endsWith(join('mcf-send', 'loop.ts')))).toBe(true);
    expect([...mcf].some((file) => file.endsWith(join('mcf-send', 'custody.ts')))).toBe(true);
  });

  it('the package root does not export the MCF unit either', async () => {
    const root = await reachable(join(SRC, 'index.ts'));
    expect([...root].filter((file) => file.includes(join('src', 'mcf-send')) || file.endsWith('mcf-main.ts'))).toEqual([]);
  });

  it('lint bars apps/web and apps/mcp from opening recipients, importing the key or driving the unit; the worker may', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const cases: [string, string][] = [
      ["import { openCreatorMcfRecipient } from '@wizard-ads/shared';\nvoid openCreatorMcfRecipient;\n", 'open'],
      ["import { importCreatorMcfRecipientKey } from '@wizard-ads/shared';\nvoid importCreatorMcfRecipientKey;\n", 'key'],
      ["import * as shared from '@wizard-ads/shared';\nvoid shared;\n", 'namespace'],
      ["export { openCreatorMcfRecipient } from '@wizard-ads/shared';\n", 're-export'],
      ["import { reserveCreatorMcfDispatch } from '@wizard-ads/db/worker';\nvoid reserveCreatorMcfDispatch;\n", 'service function'],
      ["import { readCreatorMcfCustody } from '@wizard-ads/db/worker';\nvoid readCreatorMcfCustody;\n", 'custody read'],
      ["import { createMcfSendLoop } from '../../../worker/src/mcf-send/loop.js';\nvoid createMcfSendLoop;\n", 'unit path'],
    ];
    const restricted = async (filePath: string, code: string) => {
      const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
      return result!.messages.filter((message) => message.ruleId === 'no-restricted-imports').length;
    };
    for (const surface of ['apps/web/app/creators/mcf-ban-probe.ts', 'apps/mcp/src/mcf-ban-probe.ts']) {
      for (const [code, name] of cases) {
        expect(await restricted(surface, code), `${surface}: ${name}`).toBeGreaterThan(0);
      }
      // Sealing and reading outcomes stay allowed.
      expect(await restricted(surface, "import { sealCreatorMcfRecipient } from '@wizard-ads/shared';\nvoid sealCreatorMcfRecipient;\n")).toBe(0);
    }
    // The MCP key surface keeps its existing test import from the worker subpath.
    expect(await restricted('apps/mcp/src/mcf-ban-probe.ts', "import { persistCreatorImport } from '@wizard-ads/db/worker';\nvoid persistCreatorImport;\n")).toBe(0);
    for (const [code, name] of cases.slice(0, 6)) {
      expect(await restricted('apps/worker/src/mcf-send/mcf-ban-probe.ts', code), `worker: ${name}`).toBe(0);
    }
  }, 120_000);
});

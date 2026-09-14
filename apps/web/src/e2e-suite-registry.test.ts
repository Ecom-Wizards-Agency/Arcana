import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { SCREEN_REGISTRY } from './screens/registry';
import { describe, expect, it } from 'vitest';
import {
  E2E_SUITE_DEFINITIONS,
  E2E_SUITES,
  getE2ESuiteDefinition,
  runE2ESuiteMatrix,
} from './e2e-suite-registry.js';

describe('web E2E suite registry', () => {
  it('owns every browser spec on disk exactly once through screen descriptors', () => {
    const files = readdirSync(new URL('../e2e/', import.meta.url)).filter((file) => file.endsWith('.spec.ts')).sort();
    const owned = E2E_SUITE_DEFINITIONS.flatMap((suite) => suite.expectedSpecFiles).sort();
    expect(owned).toEqual(files);
    expect(SCREEN_REGISTRY.flatMap((screen) => screen.specs.map((spec) => spec.file)).sort()).toEqual(files);
    for (const suite of E2E_SUITE_DEFINITIONS) {
      expect(suite.expectedSpecFiles).toEqual(SCREEN_REGISTRY.flatMap((screen) => screen.specs.filter((spec) => spec.suite === suite.name).map((spec) => spec.file)).sort());
    }
    expect(E2E_SUITES).toEqual(E2E_SUITE_DEFINITIONS.map((suite) => suite.name));
  });

  it('keeps names, configs, projects and spec ownership unique', () => {
    const values = {
      names: E2E_SUITE_DEFINITIONS.map(({ name }) => name),
      configs: E2E_SUITE_DEFINITIONS.map(({ config }) => config),
      projects: E2E_SUITE_DEFINITIONS.map(({ project }) => project),
      specs: E2E_SUITE_DEFINITIONS.flatMap(({ expectedSpecFiles }) => expectedSpecFiles),
    };
    for (const [label, candidates] of Object.entries(values)) {
      expect(new Set(candidates).size, label).toBe(candidates.length);
    }
  });

  it('counts logical browser tests from owned spec files and resolves every dispatch entry', () => {
    for (const suite of E2E_SUITE_DEFINITIONS) {
      const declared = suite.expectedSpecFiles.reduce((count, file) => count + countTests(readFileSync(new URL(`../e2e/${file}`, import.meta.url), 'utf8')), 0);
      expect(suite.expectedTests, suite.name).toBe(declared);
    }
    expect(E2E_SUITES.map((suite) => getE2ESuiteDefinition(suite))).toEqual(E2E_SUITE_DEFINITIONS);
  });

  it('runs later suites after a thrown setup failure and preserves its diagnostic', async () => {
    const selected = E2E_SUITE_DEFINITIONS.slice(0, 3);
    const thrown = new Error('production bridge setup failed');
    const calls: string[] = [];
    const diagnostics: Array<[string, unknown]> = [];

    const code = await runE2ESuiteMatrix(
      selected,
      async (definition) => {
        calls.push(definition.name);
        if (definition === selected[0]) throw thrown;
        return definition === selected[1] ? 7 : 0;
      },
      (definition, error) => diagnostics.push([definition.name, error]),
    );

    expect(calls).toEqual(selected.map(({ name }) => name));
    expect(diagnostics).toEqual([['tags-goto', thrown]]);
    expect(code).toBe(7);
  });
});

/** Static calls, not text matches in comments. Guard sweeps are one logical test each. */
function countTests(source: string): number {
  const file = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true);
  const arrays = new Map<string, number>();
  function arrayLength(node: ts.Expression): number | undefined {
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return arrayLength(node.expression);
    return ts.isArrayLiteralExpression(node) ? node.elements.length : undefined;
  }
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const length = arrayLength(node.initializer);
      if (length !== undefined) arrays.set(node.name.text, length);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  function count(node: ts.Node, multiplier = 1): number {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') return multiplier;
    if (ts.isForOfStatement(node)) {
      const length = ts.isIdentifier(node.expression) ? arrays.get(node.expression.text) : arrayLength(node.expression);
      return count(node.statement, multiplier * (length ?? 1));
    }
    let total = 0;
    ts.forEachChild(node, (child) => { total += count(child, multiplier); });
    return total;
  }
  return count(file);
}

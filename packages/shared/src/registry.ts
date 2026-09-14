/** Package inventory, including internal and implementation-bearing subpaths.
 * Only explicitly listed re-exports enter generated facades; an empty exports list
 * does not widen the package root. Order and trailing prose belong to each export.
 */
interface RegistryEntry {
  domain: string;
  contract: string | null;
  schema: string | null;
  queries: string | null;
  migrationPrefix: string | null;
  exports: readonly { barrel: string; order: number; clause: string; after: string }[];
}
export const PACKAGE_REGISTRY: readonly RegistryEntry[] = [
  {"domain": "timeline-events", "contract": "timeline-events.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 101, "clause": "*", "after": ""}]},
  {"domain": "time-machine", "contract": "time-machine.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 31, "clause": "*", "after": ""}]},
  {"domain": "market-position", "contract": "market-position.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 100, "clause": "*", "after": ""}]},
  {"domain": "sp-marketplace-capabilities", "contract": "sp-marketplace-capabilities.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 28, "clause": "*", "after": ""}]},
  {"domain": "queued-changes", "contract": "queued-changes.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 30, "clause": "*", "after": ""}]},
  {"domain": "agency", "contract": "agency.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 1, "clause": "*", "after": ""}]},
  {"domain": "amazon-connections", "contract": "amazon-connections.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 3, "clause": "*", "after": ""}]},
  {"domain": "apply", "contract": "apply.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 10, "clause": "*", "after": ""}]},
  {"domain": "asset-library", "contract": "asset-library.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": []},
  {"domain": "campaign-creation", "contract": "campaign-creation.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 20, "clause": "*", "after": ""}]},
  {"domain": "campaign-creation-approval", "contract": "campaign-creation-approval.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": []},
  {"domain": "creative", "contract": "creative.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 13, "clause": "*", "after": ""}]},
  {"domain": "dayparting", "contract": "dayparting.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 19, "clause": "*", "after": ""}]},
  {"domain": "entities", "contract": "entities.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 7, "clause": "*", "after": ""}]},
  {"domain": "experiments", "contract": "experiments.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 6, "clause": "*", "after": ""}]},
  {"domain": "facts", "contract": "facts.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 8, "clause": "*", "after": ""}]},
  {"domain": "feedback", "contract": "feedback.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 5, "clause": "*", "after": ""}]},
  {"domain": "grid-views", "contract": "grid-views.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 27, "clause": "*", "after": ""}]},
  {"domain": "ingestion", "contract": "ingestion.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 25, "clause": "*", "after": ""}]},
  {"domain": "integrations", "contract": "integrations.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 4, "clause": "*", "after": ""}]},
  {"domain": "jobs", "contract": "jobs.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 12, "clause": "*", "after": ""}]},
  {"domain": "mcp-key-metadata", "contract": "mcp-key-metadata.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 2, "clause": "*", "after": ""}]},
  {"domain": "mcp-writes", "contract": "mcp-writes.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": []},
  {"domain": "methods", "contract": "methods.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 23, "clause": "*", "after": ""}]},
  {"domain": "one-time-optimization", "contract": "one-time-optimization.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 16, "clause": "*", "after": ""}]},
  {"domain": "optimization", "contract": "optimization.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 15, "clause": "*", "after": ""}]},
  {"domain": "primitives", "contract": "primitives.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 0, "clause": "*", "after": ""}]},
  {"domain": "provider-connections", "contract": "provider-connections.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 26, "clause": "*", "after": ""}]},
  {"domain": "provider-failure", "contract": "provider-failure.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 24, "clause": "*", "after": ""}]},
  {"domain": "query-intelligence", "contract": "query-intelligence.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 14, "clause": "*", "after": ""}]},
  {"domain": "recommendation-preview", "contract": "recommendation-preview.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 22, "clause": "*", "after": "\n"}]},
  {"domain": "recommendation-revisions", "contract": "recommendation-revisions.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": []},
  {"domain": "recommendations", "contract": "recommendations.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 9, "clause": "*", "after": ""}]},
  {"domain": "reporting", "contract": "reporting.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 17, "clause": "*", "after": ""}]},
  {"domain": "sp-write-application", "contract": "sp-write-application.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": []},
  {"domain": "sp-write-mirror", "contract": "sp-write-mirror.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": []},
  {"domain": "sp-write-preview-evidence", "contract": "sp-write-preview-evidence.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": []},
  {"domain": "sp-writes", "contract": "sp-writes.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 27, "clause": "{ SpPlacementChange, SpCompleteCampaignBiddingState }", "after": ""}]},
  {"domain": "strategy", "contract": "strategy.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 11, "clause": "*", "after": ""}]},
  {"domain": "tags", "contract": "tags.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 21, "clause": "*", "after": ""}]},
  {"domain": "time-machine-writes", "contract": "time-machine-writes.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": []},
  {"domain": "translation", "contract": "translation.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 29, "clause": "*", "after": ""}]},
  {"domain": "unified-reporting", "contract": "unified-reporting.ts", "schema": null, "queries": null, "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 18, "clause": "*", "after": ""}]},
];

const headers: Record<string, string> = {
  "index.ts": "/**\n * `@wizard-ads/shared` is THE contract package.\n *\n * Rules, from AGENTS.md:\n *  - Schemas and inferred types only. No logic, no I/O, no dependency but zod.\n *  - Every shape that crosses a package boundary lives here.\n *  - Cross-package contracts land here before dependent implementations.\n *    Additive guarded-write and campaign-creation contracts are approved by\n *    the repository authority in AGENTS.md.\n */\n"
};

/** Preserve export selection, ordering, comments and whitespace byte for byte. */
export function generatedBarrels(): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([barrel, header]) => {
    const exports = PACKAGE_REGISTRY.flatMap((entry) => entry.exports
      .filter((item) => item.barrel === barrel)
      .map((item) => ({ ...item, module: entry.contract ?? entry.schema ?? entry.queries })));
    return [barrel, header + exports.sort((a, b) => a.order - b.order).map((item) => {
      if (!item.module) throw new Error(`Missing module for ${barrel}`);
      const directory = barrel.split('/').slice(0, -1);
      const module = item.module.replace(/\.ts$/, '.js').split('/');
      while (directory.length && directory[0] === module[0]) {
        directory.shift();
        module.shift();
      }
      const relative = directory.length ? '../'.repeat(directory.length) + module.join('/') : './' + module.join('/');
      return `export ${item.clause} from '${relative}';\n${item.after}`;
    }).join('')];
  }));
}

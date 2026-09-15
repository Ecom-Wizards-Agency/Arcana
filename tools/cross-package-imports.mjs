import path from 'node:path';
/** Relative imports may move inside a workspace, never into another workspace. */
export const crossPackageImports = {
  meta: { type: 'problem', schema: [{ type: 'object', properties: { existing: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, source: { type: 'string' } }, required: ['file','source'], additionalProperties: false } } }, additionalProperties: false }], messages: { boundary: 'Import workspace packages through their public @wizard-ads entry point.' } },
  create(context) {
    const owner = (filename) => /(?:^|\/)((?:apps|packages)\/[^/]+)\//.exec(filename)?.[1];
    function check(node, source) {
      if (typeof source?.value !== 'string' || !source.value.startsWith('.')) return;
      const from = context.filename.replaceAll('\\', '/');
      if (context.options[0]?.existing?.some((item) => from.endsWith('/'+item.file) && source.value === item.source)) return;
      const to = path.resolve(path.dirname(from), source.value).replaceAll('\\', '/');
      if (owner(from) && owner(to) && owner(from) !== owner(to)) context.report({ node, messageId: 'boundary' });
    }
    return { ImportDeclaration: (node) => check(node, node.source), ExportNamedDeclaration: (node) => check(node, node.source), ExportAllDeclaration: (node) => check(node, node.source), ImportExpression: (node) => check(node, node.source) };
  },
};

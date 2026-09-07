import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_FILES, launcherText, verifyArtifact } from './artifact.js';

/** Unprivileged build only; the installer separately requires clean exact main. */
export async function buildAuthorityArtifact(revision: string, destination: string, node: string): Promise<void> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const launcher = launcherText(revision, node);
  const require = createRequire(import.meta.url);
  const tsxRequire = createRequire(require.resolve('tsx/package.json'));
  const esbuild = join(dirname(tsxRequire.resolve('esbuild/package.json')), 'bin/esbuild');
  const driverPatch = 'patches/postgres@3.4.9.patch';
  const patchHash = createHash('sha256').update(await readFile(join(root, driverPatch))).digest('hex');
  const driverPrefix = `node_modules/.pnpm/postgres@3.4.9_patch_hash=${patchHash}/node_modules/postgres/`;
  await mkdir(destination, { recursive: false, mode: 0o755 });
  const inputs = new Set<string>([
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', driverPatch, 'tools/recommendation-authority/package.json',
    'tools/recommendation-authority/src/build.ts',
    'docs/deploy/install-recommendation-authority.sh',
    'docs/deploy/install-recommendation-database-ca.sh',
  ]);
  const revisionDefine = 'OPENSPELL_BROKER_REVISION';
  for (const [entry, output] of [['entry.ts', 'broker.mjs'], ['verify-entry.ts', 'verify.mjs']] as const) {
    const metafile = join(destination, `${output}.meta`);
    execFileSync(esbuild, [join(root, 'tools/recommendation-authority/src', entry),
      '--bundle', '--platform=node', '--format=esm', '--target=node22',
      '--define:' + revisionDefine + '=' + JSON.stringify(revision),
      `--outfile=${join(destination, output)}`, `--metafile=${metafile}`,
    ], { cwd: root, stdio: 'pipe' });
    const metadata = JSON.parse(await readFile(metafile, 'utf8')) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
    };
    if (Object.keys(metadata.outputs).length !== 1
      || Object.values(metadata.outputs).some((item) => item.imports.some((dependency) => !dependency.external || !isBuiltin(dependency.path)))) {
      throw new Error('Authority bundle has a non-builtin runtime import');
    }
    for (const input of Object.keys(metadata.inputs)) {
      const path = relative(root, resolve(root, input));
      if ((!/^(tools\/recommendation-authority\/src\/|docs\/deploy\/openspell-recommendation-(?:authority-contract|database-trust)\.mjs$)/u.test(path)
        && !path.startsWith(driverPrefix))
        || path.includes('..')) throw new Error('Authority bundle imports an unapproved source');
      inputs.add(path);
    }
    // Metadata is build evidence, not an installed runtime dependency.
    const { unlink } = await import('node:fs/promises');
    await unlink(metafile);
    const bundle = await readFile(join(destination, output), 'utf8');
    if (bundle.includes(root)) throw new Error('Authority bundle contains a checkout path');
  }
  const sourceHashes = await Promise.all([...inputs].sort().map(async (path) =>
    `${createHash('sha256').update(await readFile(join(root, path))).digest('hex')}  ${path}`));
  await writeFile(join(destination, 'SOURCE_INPUTS'), `${sourceHashes.join('\n')}\n`);
  await writeFile(join(destination, 'REVISION'), `${revision}\n`);
  await writeFile(join(destination, 'NODE_PATH'), `${node}\n`);
  await writeFile(join(destination, 'LAUNCHER'), launcher);
  await writeFile(join(destination, 'ARTIFACT_COUNTS'), 'directories=1\nfiles=8\nsymlinks=0\n');
  const hashes = await Promise.all(ARTIFACT_FILES.filter((name) => name !== 'ARTIFACT_SHA256').map(async (name) =>
    `${createHash('sha256').update(await readFile(join(destination, name))).digest('hex')}  ${name}`));
  await writeFile(join(destination, 'ARTIFACT_SHA256'), `${hashes.join('\n')}\n`);
  await Promise.all(ARTIFACT_FILES.map((name) => chmod(join(destination, name), 0o644)));
  await verifyArtifact(destination, revision, false);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  void (async () => {
    if (args.length !== 3) throw new Error('Invalid build arguments');
    await buildAuthorityArtifact(args[0]!, args[1]!, args[2]!);
  })().catch(() => {
    process.stderr.write('OpenSpell recommendation authority build failed\n');
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { parseCommand } from './cli.js';
import { BundleFailure } from './engine.js';
import { buildWriteWindowBundle, verifyWriteWindowBundle } from './write-window-bundle.js';

/** Separate command: the original CLI continues to enforce the first-window policy. */
export async function runWriteWindow(argv: readonly string[]): Promise<number> {
  try {
    const command = parseCommand(argv);
    const evidence = command.operation === 'build'
      ? await buildWriteWindowBundle(command)
      : await verifyWriteWindowBundle(command);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    return 0;
  } catch (error: unknown) {
    const code = error instanceof BundleFailure ? error.code : 'PUBLISH_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'error', code })}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runWriteWindow(process.argv.slice(2));
}

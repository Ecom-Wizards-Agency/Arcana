import { fileURLToPath } from 'node:url';
import { productionDatabasePorts, runAuthorityBroker } from './broker.js';
import { RELEASE_ROOT, verifyArtifact } from './artifact.js';

declare const OPENSPELL_BROKER_REVISION: string;
const FAILURE = 'OpenSpell recommendation authority operation could not be confirmed\n';

// Server timeouts cannot bound a lost COMMIT acknowledgement on an open socket.
// A hard process deadline releases the caller to its independent readback; it
// never converts an uncertain attempt into a second CAS.
const deadline = setTimeout(() => {
  process.stderr.write(FAILURE);
  process.exit(1);
}, 15_000);

async function main(): Promise<void> {
  if (process.geteuid?.() !== 0 || Object.keys(process.env).some((key) => key !== 'LANG')
    || process.env['LANG'] !== 'C') throw new Error('Authority runtime unavailable');
  const directory = `${RELEASE_ROOT}/${OPENSPELL_BROKER_REVISION}`;
  if (fileURLToPath(import.meta.url) !== `${directory}/broker.mjs`) throw new Error('Authority release unavailable');
  const result = await runAuthorityBroker(process.argv.slice(2), {
    ...productionDatabasePorts,
    verifyInstallation: () => verifyArtifact(directory, OPENSPELL_BROKER_REVISION, true),
  });
  const output = `${JSON.stringify(result)}\n`;
  if (Buffer.byteLength(output) > 4096) throw new Error('Authority result unavailable');
  process.stdout.write(output);
}

void main().catch(() => {
  process.stderr.write(FAILURE);
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));

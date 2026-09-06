import { RELEASE_ROOT, verifyArtifact, verifyInstalledLauncher } from './artifact.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--installed') await verifyInstalledLauncher();
  else if (args.length === 2 && args[0] === '--release') await verifyArtifact(`${RELEASE_ROOT}/${args[1]}`, args[1]!, true, false);
  else if (args.length === 3 && args[0] === '--stage') await verifyArtifact(args[1]!, args[2]!, false);
  else throw new Error('Invalid verification command');
}
void main().catch(() => {
  process.stderr.write('OpenSpell recommendation authority installation verification failed\n');
  process.exitCode = 1;
});

import { parseAuthorityCommand } from './command.js';
import { connectAuthority, executeAuthority, type AuthorityConnection } from './database.js';
import { loadAuthorityCredential } from './credential.js';

export interface BrokerPorts {
  verifyInstallation(): Promise<void>;
  loadCredential(): Promise<string>;
  connect(credential: string): AuthorityConnection;
  execute: typeof executeAuthority;
}

/** Errors cross only the fixed entry boundary; no adapter is selected by CLI/env. */
export async function runAuthorityBroker(args: readonly string[], ports: BrokerPorts) {
  const command = parseAuthorityCommand(args);
  await ports.verifyInstallation();
  const credential = await ports.loadCredential();
  const connection = ports.connect(credential);
  try {
    return await ports.execute(connection, command);
  } finally {
    await connection.end({ timeout: 1 });
  }
}

export const productionDatabasePorts = Object.freeze({
  loadCredential: loadAuthorityCredential,
  connect: connectAuthority,
  execute: executeAuthority,
});

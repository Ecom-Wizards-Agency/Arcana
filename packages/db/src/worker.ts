/** Worker-only credential reads. Web imports of this subpath are lint failures. */
export { getIntegrationSecret } from './queries/integrations.js';
export * from './queries/amazon-connection-worker.js';
export { lockPrivilegedOrgEditor } from './queries/privileged-actor.js';

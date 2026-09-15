/** Disposable browser-test process. Never imported by a product entrypoint. */
import { createDb } from '@wizard-ads/db';
import { AmazonConnectionLoop } from './amazon-connections.js';
import { createAmazonConnectionProvider, createAmazonConnectionStore } from './amazon-connection-adapters.js';

const rawDatabase = process.env['WIZARD_ADS_TEST_DATABASE_URL'];
const rawMock = process.env['OPENSPELL_TEST_AMAZON_ORIGIN'];
const rawApp = process.env['OPENSPELL_TEST_APP_ORIGIN'];
if (!rawDatabase || !rawMock || !rawApp || process.env['NODE_ENV'] === 'production') throw new Error('Disposable connection test configuration required');
const dbUrl = new URL(rawDatabase); const mock = new URL(rawMock); const app = new URL(rawApp);
if (!['127.0.0.1','localhost','[::1]'].includes(dbUrl.hostname) || dbUrl.pathname !== '/wizard_ads_e2e'
  || [mock, app].some((url) => url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)) {
  throw new Error('Connection browser tests require their loopback fixture');
}
const handle = createDb({ connectionString: rawDatabase, max: 2 });
const mappedHosts: Record<string, string> = {
  'api.amazon.com': '', 'advertising-api.amazon.com': '/na',
  'advertising-api-eu.amazon.com': '/eu', 'advertising-api-fe.amazon.com': '/fe',
};
const provider = createAmazonConnectionProvider(handle, {
  LWA_CLIENT_ID: 'amzn1.application-oa2-client.e2e', LWA_CLIENT_SECRET: 'synthetic-e2e-application-key',
  AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: new URL('/api/amazon/oauth/callback', app).href,
}, { fetch: (input, init) => {
  const source = new URL(String(input));
  const prefix = mappedHosts[source.hostname];
  if (source.protocol !== 'https:' || prefix === undefined
    || !['/auth/o2/token','/v2/profiles'].includes(source.pathname)) throw new Error('Unmapped test provider request');
  return fetch(new URL(prefix + source.pathname, mock), init);
} });
const loop = new AmazonConnectionLoop(createAmazonConnectionStore(handle), provider, 100);
loop.start();
process.send?.({ ready: true });
let stopping: Promise<void> | null = null;
function stop(): void {
  stopping ??= loop.stop().then(() => handle.close()).then(() => { if (process.connected) process.disconnect(); });
  void stopping.catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
}
process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('disconnect', stop);

/** Separate synthetic worker process; no product web module imports this file. */
import { createDb } from '@wizard-ads/db';
import { exchangeSpApiAuthorizationCode, runSpApiConnectionPass } from './spapi-connections.js';
import { ProviderConnectionLoop } from './provider-connection-loop.js';

const database = process.env['WIZARD_ADS_TEST_DATABASE_URL'];
const rawMock = process.env['OPENSPELL_TEST_AMAZON_ORIGIN']; const rawApp = process.env['OPENSPELL_TEST_APP_ORIGIN'];
if (!database || !rawMock || !rawApp || process.env['NODE_ENV'] !== 'test') throw new Error('Synthetic worker configuration required');
const dbUrl = new URL(database); const mock = new URL(rawMock); const app = new URL(rawApp);
if (dbUrl.hostname !== '127.0.0.1' || dbUrl.pathname !== '/wizard_ads_e2e'
  || [mock,app].some((url) => url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)) {
  throw new Error('Synthetic worker requires its loopback fixtures');
}
const handle = createDb({ connectionString: database,max: 2 });
const loop = new ProviderConnectionLoop((signal) => runSpApiConnectionPass({ handle,enabled: () => true,
  accepts: (installation) => installation.clientId === 'synthetic-sp-client' && installation.applicationId === 'synthetic-sp-app'
    && installation.region === 'NA' && installation.redirectUri === new URL('/api/amazon/spapi/oauth/callback',app).href,
  exchange: (installation,code,abort) => exchangeSpApiAuthorizationCode(installation,code,abort,{
    clientId: 'synthetic-sp-client',clientSecret: ['synthetic','sp-application-key'].join('-'),
    fetch: (input,init) => {
      if (input !== 'https://api.amazon.com/auth/o2/token') throw new Error('Unmapped synthetic request');
      return fetch(new URL('/spapi/token',mock),init);
    },
  }),
},signal),100);
loop.start(); process.send?.({ ready: true });
let stopping: Promise<void> | null = null;
function stop(): void {
  stopping ??= loop.stop().then(() => handle.close()).then(() => { if (process.connected) process.disconnect(); });
  void stopping.catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
}
process.once('SIGTERM',stop); process.once('SIGINT',stop); process.once('disconnect',stop);

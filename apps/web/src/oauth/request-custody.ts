import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import type { IncomingMessage } from 'node:http';

const callbacks = new Set(['/api/amazon/oauth/callback', '/api/amazon/spapi/oauth/callback']);
interface Custody { path: string; query: string | null }
// Instrumentation and route handlers have separate webpack module instances.
const globalCustody = globalThis as typeof globalThis & {
  __arcanaOAuthCustody?: { storage: AsyncLocalStorage<Custody | undefined>; installed: boolean };
};
const custody = globalCustody.__arcanaOAuthCustody ??= {
  storage: new AsyncLocalStorage<Custody | undefined>(), installed: false,
};

export function installOAuthQueryCustody(): void {
  if (custody.installed) return;
  custody.installed = true;
  // Node publishes this synchronously before emitting the server's request event.
  // Next's logger, router and tracing therefore receive only the callback path.
  channel('http.server.request.start').subscribe((message) => {
    const { request } = message as { request: IncomingMessage };
    custody.storage.enterWith(undefined);
    let url: URL;
    let path: string;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
      path = decodeURIComponent(url.pathname).replace(/\/$/, '');
    } catch { return; }
    if (!callbacks.has(path)) return;
    const query = url.search.length <= 16_384 ? url.search.slice(1) : '';
    request.url = path;
    // A browser may send its previous callback URL as a referrer on a replay.
    delete request.headers['referer'];
    for (let i = request.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (request.rawHeaders[i]?.toLowerCase() === 'referer') request.rawHeaders.splice(i, 2);
    }
    custody.storage.enterWith({ path, query });
  });
}

/** No URL/header fallback: an adapter without pre-routing custody fails closed. */
export function consumeOAuthQuery(path: string): URLSearchParams {
  const saved = custody.storage.getStore();
  if (!saved || saved.path !== path || saved.query === null) return new URLSearchParams();
  const query = saved.query;
  saved.query = null;
  return new URLSearchParams(query);
}

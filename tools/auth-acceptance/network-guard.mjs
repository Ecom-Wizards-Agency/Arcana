import process from 'node:process';

// Preloaded only in the disposable Next and operator child processes.
const allowed = new Set(JSON.parse(process.env.OPENSPELL_TEST_HTTP_ORIGINS));
const actualFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new globalThis.URL(typeof input === 'string' || input instanceof globalThis.URL ? input : input.url);
  if (!allowed.has(url.origin)) throw new Error('Auth acceptance refused an external HTTP request');
  return actualFetch(input, init);
};

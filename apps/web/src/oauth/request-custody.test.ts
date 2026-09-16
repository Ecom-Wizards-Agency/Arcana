import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { consumeOAuthQuery, installOAuthQueryCustody } from './request-custody';

describe('OAuth query custody before HTTP request observers', () => {
  it('isolates concurrent callbacks, consumes once, and removes query and referrer before dispatch', async () => {
    installOAuthQueryCustody();
    installOAuthQueryCustody();
    const ads = '/api/amazon/oauth/callback';
    const sp = '/api/amazon/spapi/oauth/callback';
    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      seen.push(JSON.stringify({ url: req.url, headers: req.headers, rawHeaders: req.rawHeaders }));
      await setTimeout(req.url === ads ? 25 : 1);
      const wrong = consumeOAuthQuery(req.url === ads ? sp : ads);
      const own = consumeOAuthQuery(req.url!);
      const second = consumeOAuthQuery(req.url!);
      res.end(JSON.stringify({ own: own.get('code'), wrong: wrong.size, second: second.size }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP fixture');
    const get = (path: string) => new Promise<string>((resolve, reject) => {
      request({ hostname: '127.0.0.1', port: address.port, path, headers: { referer: 'http://localhost' + path } }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve(body));
      }).on('error', reject).end();
    });
    try {
      const result = await Promise.all([get(ads + '?code=synthetic-ads&state=synthetic-state-a'), get(sp + '?code=synthetic-sp&state=synthetic-state-b')]);
      expect(result.map((value) => JSON.parse(value))).toEqual([
        { own: 'synthetic-ads', wrong: 0, second: 0 }, { own: 'synthetic-sp', wrong: 0, second: 0 },
      ]);
      expect(seen).toHaveLength(2);
      for (const output of seen) {
        expect(output).not.toContain('synthetic-');
        expect(output).not.toContain('referer');
      }
      expect(consumeOAuthQuery(ads).size).toBe(0);
      expect(JSON.parse(await get('/ordinary'))).toEqual({ own: null, wrong: 0, second: 0 });
    } finally { server.close(); await once(server, 'close'); }
  });
});

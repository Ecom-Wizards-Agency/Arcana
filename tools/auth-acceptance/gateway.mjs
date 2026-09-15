import http from 'node:http';
import { readFileSync } from 'node:fs';

// This service runs only inside the disposable internal network. It proxies
// actual Auth HTTP, serves the maintained email template, and drops selected
// completed responses to reproduce uncertainty without replacing provider work.
const template = readFileSync('/fixture/invite.html', 'utf8');
const events = [];
let fault;
http.createServer(async (request, response) => {
  const url = new globalThis.URL(request.url, 'http://fixture.invalid');
  if (url.pathname === '/template') {
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(template); return;
  }
  if (url.pathname === '/events') {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(events)); return;
  }
  if (url.pathname === '/fault' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 1024) { response.writeHead(413); response.end(); return; }
    }
    const input = JSON.parse(body);
    if (!['POST /invite', 'POST /verify', 'PUT /user'].includes(`${input.method} ${input.path}`)) {
      response.writeHead(400); response.end(); return;
    }
    fault = input; response.writeHead(200); response.end('{}'); return;
  }
  if (!url.pathname.startsWith('/auth/v1/')) { response.writeHead(404); response.end(); return; }
  const path = url.pathname.slice('/auth/v1'.length);
  const event = { method: request.method, path, status: null, responseDropped: false };
  events.push(event);
  const drop = fault?.method === request.method && fault?.path === path;
  if (drop) fault = undefined;
  const headers = { ...request.headers }; delete headers.host;
  const upstream = http.request({ host: 'auth', port: 9999, method: request.method, path: path + url.search, headers }, (reply) => {
    event.status = reply.statusCode;
    if (drop) {
      reply.resume(); reply.on('end', () => { event.responseDropped = true; response.destroy(); });
    } else {
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
    }
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(upstream);
}).listen(8080, '0.0.0.0');

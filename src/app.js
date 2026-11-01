import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createConnectionsHandler } from './integrations/gmail/http.js';
import { Readable } from 'node:stream';
import { handleSentryWebhook } from './integrations/sentry-webhook.js';
import { handleOperator } from './core/operator.js';
import { handleGmailDemo } from './core/gmail-http.js';

// Explicit public-file allowlist; no private configuration or providers are loaded.
const home = readFileSync(new URL('../public/index.html', import.meta.url));
const styles = readFileSync(new URL('../public/styles.css', import.meta.url));
const health = readFileSync(new URL('../public/health.json', import.meta.url));
const pages = new Map([
  ['/', { type: 'text/html; charset=utf-8', body: home }],
  ['/index.html', { type: 'text/html; charset=utf-8', body: home }],
  ['/styles.css', { type: 'text/css; charset=utf-8', body: styles }],
  ['/healthz', { type: 'application/json; charset=utf-8', body: health }],
  ['/health.json', { type: 'application/json; charset=utf-8', body: health }],
]);
for (const [path, file, type] of [
  ['/connections', 'connections.html', 'text/html'],
  ['/connections.html', 'connections.html', 'text/html'],
  ['/connections.css', 'connections.css', 'text/css'],
  ['/connections.js', 'connections.js', 'text/javascript'],
]) pages.set(path, { type: `${type}; charset=utf-8`, body: readFileSync(new URL(`../public/${file}`, import.meta.url)) });

for (const [name, type] of [['incident.html', 'text/html'], ['incident.css', 'text/css'], ['incident.js', 'text/javascript'],
  ['gmail.html', 'text/html'], ['gmail.css', 'text/css'], ['gmail.js', 'text/javascript']]) {
  pages.set(`/${name}`, { type: `${type}; charset=utf-8`, body: readFileSync(new URL(`../public/${name}`, import.meta.url)) });
}

export function createApp(options = {}) {
  const { sentryOptions, operatorOptions } = options;
  const connectionsHandler = createConnectionsHandler(options);
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { response.writeHead(400); response.end(JSON.stringify({ error: 'invalid_url' })); return; }
    try { if (!options.gmailOptions && await connectionsHandler(request, response, url)) return; }
    catch {
      if (!response.headersSent) response.writeHead(503);
      response.end(JSON.stringify({ error: 'service_unavailable' })); return;
    }

    const pathname = url.pathname;
    if (pathname === '/api/webhooks/sentry' || pathname.startsWith('/api/incident/') || pathname.startsWith('/api/gmail/')
      || (options.gmailOptions && pathname.startsWith('/api/connections/'))) {
      try {
        const incoming = new Request(url, { method: request.method, headers: request.headers,
          ...(!['GET', 'HEAD'].includes(request.method) ? { body: Readable.toWeb(request), duplex: 'half' } : {}) });
        const result = pathname.startsWith('/api/gmail/') || pathname.startsWith('/api/connections/')
          ? await handleGmailDemo(incoming, options.gmailOptions)
          : pathname === '/api/webhooks/sentry' ? await handleSentryWebhook(incoming, sentryOptions)
          : await handleOperator(incoming, operatorOptions ?? {
            getToken: () => undefined, getRuntime: () => { throw Error('local_provider_disabled'); }, schedule: () => {},
          });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(503);
        response.end(JSON.stringify({ error: pathname.startsWith('/api/gmail/') || pathname.startsWith('/api/connections/')
          ? 'gmail_unavailable' : 'sentry_delivery_unconfirmed' }));
      }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.writeHead(405);
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    const page = pages.get(pathname);
    if (page) {
      response.setHeader('Content-Type', page.type);
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : page.body);
      return;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}

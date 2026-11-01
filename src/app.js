import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { handleSentryWebhook } from './integrations/sentry-webhook.js';
import { handleOperator } from './core/operator.js';
import { handleImageGeneration } from './images/generate.js';
import { handleImageDisplay } from './images/display.js';

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
for (const [name, type] of [['incident.html', 'text/html'], ['incident.css', 'text/css'], ['incident.js', 'text/javascript']]) {
  pages.set(`/${name}`, { type: `${type}; charset=utf-8`, body: readFileSync(new URL(`../public/${name}`, import.meta.url)) });
}
for (const [name, type] of [['image.html', 'text/html'], ['image.css', 'text/css'], ['image.js', 'text/javascript']]) {
  pages.set(`/${name}`, { type: `${type}; charset=utf-8`, body: readFileSync(new URL(`../public/${name}`, import.meta.url)) });
}

export function createApp({ sentryOptions, operatorOptions, imageOptions } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');

    let url;
    let pathname;
    try {
      url = new URL(request.url, 'http://localhost');
      pathname = url.pathname;
    } catch {
      response.writeHead(400);
      response.end(JSON.stringify({ error: 'invalid_url' }));
      return;
    }
    if (pathname === '/api/webhooks/sentry' || pathname.startsWith('/api/incident/') || ['/api/images/generate', '/api/images/latest', '/api/images/result'].includes(pathname)) {
      try {
        const incoming = new Request(url, { method: request.method, headers: request.headers,
          ...(!['GET', 'HEAD'].includes(request.method) ? { body: Readable.toWeb(request), duplex: 'half' } : {}) });
        const result = pathname === '/api/images/generate' ? await handleImageGeneration(incoming, imageOptions)
          : pathname.startsWith('/api/images/') ? await handleImageDisplay(incoming, imageOptions)
          : pathname === '/api/webhooks/sentry' ? await handleSentryWebhook(incoming, sentryOptions)
          : await handleOperator(incoming, operatorOptions ?? {
            getToken: () => undefined, getRuntime: () => { throw Error('local_provider_disabled'); }, schedule: () => {},
          });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(503);
        response.end(JSON.stringify({ error: 'sentry_delivery_unconfirmed' }));
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

import { createServer } from 'node:http';

// Scaffold metadata only. No provider client or private configuration is loaded.
const overview = {
  name: 'Errand',
  stage: 'scaffold',
  demos: [
    { id: 'developer', priority: 'primary', implemented: false },
    { id: 'everyday-help', audience: 'older adults', implemented: false },
  ],
};

export function createApp() {
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');

    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405);
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200);
      response.end(JSON.stringify(overview));
      return;
    }

    if (pathname === '/healthz') {
      response.writeHead(200);
      response.end(JSON.stringify({ status: 'ok', stage: 'scaffold', servicesConnected: false }));
      return;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}

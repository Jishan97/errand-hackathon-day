import { GmailError } from './composio.js';

export function createConnectionsHandler({ connections, authenticate, publicOrigin } = {}) {
  return async (request, response, url) => {
    if (!url.pathname.startsWith('/api/connections/')) return false;
    const respond = (status, data) => { response.writeHead(status); response.end(JSON.stringify(data)); };
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const routes = {
        '/api/connections/gmail': 'GET',
        '/api/connections/gmail/connect': 'POST',
        '/api/connections/gmail/callback': 'GET',
      };
      if (!routes[url.pathname]) { respond(404, { error: 'connector_not_enabled' }); return true; }
      if (routes[url.pathname] !== request.method) {
        response.setHeader('Allow', routes[url.pathname]); respond(405, { error: 'method_not_allowed' }); return true;
      }
      if (!connections || !authenticate || typeof publicOrigin !== 'string' || !publicOrigin.startsWith('https://')) {
        throw new GmailError('setup_required', 503);
      }
      // Fixed configured origin, never Host/X-Forwarded-Host. No cross-origin credentialed writes.
      if (request.method === 'POST' && (request.headers.origin !== publicOrigin
        || request.headers['x-errand-intent'] !== 'connect-gmail')) {
        respond(403, { error: 'invalid_origin' }); return true;
      }
      const context = await authenticate(request);
      if (!context) throw new GmailError('sign_in_required', 401);
      if (url.pathname.endsWith('/callback')) {
        // No status/account/user query parameter is trusted. Do not log this URL.
        await connections.complete(context, url.searchParams.get('session_uri'));
        response.writeHead(303, { Location: '/connections.html' }); response.end();
      } else if (request.method === 'POST') {
        // No browser-supplied IDs or return URL are read from a request body.
        respond(200, await connections.connect(context));
      } else respond(200, await connections.status(context));
    } catch (error) {
      const code = error instanceof GmailError ? error.code : 'service_unavailable';
      if (url.pathname.endsWith('/callback')) {
        // Fixed clean destination, with no provider identifiers or callback tokens in the URL.
        response.writeHead(303, { Location: '/connections.html?connection=failed' }); response.end();
      } else respond(error instanceof GmailError ? error.status : 503, { error: code });
    }
    return true;
  };
}

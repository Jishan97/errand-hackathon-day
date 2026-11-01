import express from 'express';
import { requireOperator } from './auth.js';
import { createVoiceWebhook } from './voice/twilio.js';

// Phone routes only. Sentry, coding and the demo UI stay in their existing lanes.
export function createApp({ config, logger = () => {}, m1 = null, assistant = null, assistantWorker = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  app.get('/api/phone/health', (_request, response) => response.json({
    service: 'errand-phone', implementation: 'general_chat_and_reminders', liveAcceptance: 'pending',
  }));
  const operatorOnly = requireOperator(config);
  app.get('/api/internal/assistant/status', operatorOnly, async (_request, response) => {
    if (!assistant) return response.status(503).json({ error: { code: 'shared_assistant_unavailable' } });
    try { response.json(await assistant.status()); }
    catch { response.status(503).json({ error: { code: 'assistant_status_unavailable' } }); }
  });
  const receivedBody = Symbol('receivedBody');
  const json = express.json({ limit: '1kb', strict: true,
    verify(request, _response, body) { request[receivedBody] = body.length > 0; } });
  app.post('/api/assistant/worker', json, async (request, response) => {
    if (!assistantWorker) return response.status(503).json({ error: { code: 'shared_worker_unavailable' } });
    if (!request[receivedBody] || request.originalUrl.includes('?') || !request.is('application/json') ||
      !request.body || Array.isArray(request.body) || Object.keys(request.body).length !== 1 ||
      typeof request.body.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.body.token)) {
      return response.status(403).json({ error: { code: 'worker_capability_required' } });
    }
    // The existing database RPC validates the Vault-backed capability before claiming.
    try { response.json(await assistantWorker.run(request.body.token)); }
    catch { response.status(503).json({ error: { code: 'worker_request_unconfirmed' } }); }
  });
  app.all('/api/assistant/worker', (_request, response) => response.status(405).set('Allow', 'POST').json({ error: { code: 'method_not_allowed' } }));

  const form = express.text({ type: 'application/x-www-form-urlencoded', limit: '16kb' });
  const methods = { incoming: 'incoming', outgoing: 'outgoing', connect: 'connect', authenticate: 'authenticate' };
  for (const [route, method] of Object.entries(methods)) {
    app.post(`/api/voice/${route}`, form, (request, response) => {
      if (config.m1Enabled && typeof m1?.[method] === 'function') return m1[method](request, response);
      if (!config.m1Enabled && ['incoming', 'outgoing'].includes(route)) {
        return createVoiceWebhook(config, route === 'incoming' ? 'inbound' : 'outbound')(request, response);
      }
      return response.status(503).json({ error: { code: 'shared_assistant_unavailable' } });
    });
    app.all(`/api/voice/${route}`, (_request, response) => response.status(405).set('Allow', 'POST').json({ error: { code: 'method_not_allowed' } }));
  }
  app.all('/api/media', (_request, response) => response.status(426).set('Upgrade', 'websocket').json({ error: { code: 'websocket_upgrade_required' } }));
  app.use((_request, response) => response.status(404).json({ error: { code: 'not_found' } }));
  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    logger({ event: 'phone_request_failed' });
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    response.status(status).json({ error: { code: status === 500 ? 'internal_error' : 'invalid_request' } });
  });
  return app;
}

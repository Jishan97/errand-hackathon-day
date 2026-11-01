import { GmailError, requireValue } from '../integrations/gmail/composio.js';
import { handleConnectionsRequest } from '../integrations/gmail/http.js';
import { createGmailAuth } from './gmail-auth.js';
import { createGmailRuntime, gmailPublicOrigin } from './gmail-runtime.js';
import { validateGmailMessage } from '../integrations/gmail/capability.js';
import { validateImagePrompt } from '../agents/gmail-image.js';

const response = (status, body, headers = {}) => Response.json(body, { status,
  headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...headers } });
const id = value => requireValue(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value));
const exact = (body, keys) => requireValue(Object.keys(body).sort().join() === [...keys].sort().join());
const publicApproval = ({ scope, ...readback }) => ({ ...readback, digest: scope.digest });
async function json(request) {
  requireValue(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'json_required', 415);
  const reader = request.body?.getReader(); requireValue(reader);
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; requireValue(length <= 8192, 'body_too_large', 413); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { requireValue(false); }
  requireValue(body && typeof body === 'object' && !Array.isArray(body)); return body;
}

export async function handleGmailDemo(request, { getValues = () => ({}), createRuntime = createGmailRuntime, schedule,
  logger = entry => console.info(JSON.stringify(entry)) } = {}) {
  const url = new URL(request.url), path = url.pathname;
  const connection = path.startsWith('/api/connections/');
  const methods = { login: 'POST', logout: 'POST', session: 'GET', search: 'POST', read: 'POST',
    prepare: 'POST', approve: 'POST', status: 'GET', resume: 'POST', cancel: 'POST', pending: 'GET', 'close-manual': 'POST',
    'image-task': 'POST', 'generate-image': 'POST' };
  const action = path.startsWith('/api/gmail/') ? path.slice('/api/gmail/'.length) : '';
  if (!connection && !Object.hasOwn(methods, action)) return response(404, { error: 'not_found' });
  if (!connection && request.method !== methods[action]) return response(405, { error: 'method_not_allowed' }, { Allow: methods[action] });
  try {
    const values = getValues(), publicOrigin = gmailPublicOrigin(values);
    const auth = createGmailAuth({ token: values.OPERATOR_TOKEN });
    if (!connection && request.method === 'POST') {
      requireValue(!url.search && request.headers.get('origin') === publicOrigin
        && request.headers.get('x-errand-intent') === 'gmail-demo', 'invalid_origin', 403);
    }
    if (action === 'login') return response(200, { status: 'signed_in' }, { 'Set-Cookie': auth.login(request.headers.get('authorization')) });
    const context = auth.authenticate(request);
    requireValue(context, 'sign_in_required', 401);
    if (action === 'session') return response(200, { status: 'signed_in' });
    if (action === 'logout') return response(200, { status: 'signed_out' }, { 'Set-Cookie': auth.logout() });
    const runtime = createRuntime(values);
    if (connection) return await handleConnectionsRequest(request, { connections: runtime.connections,
      authenticate: () => context, publicOrigin }) ?? response(404, { error: 'not_found' });
    if (action === 'pending') { requireValue(!url.search); return response(200, { proposals: await runtime.store.pending() }); }
    if (action === 'status') {
      requireValue(url.searchParams.size === 1 && url.searchParams.has('id'));
      const proposalId = url.searchParams.get('id'); id(proposalId);
      const task = await runtime.contextFor(proposalId);
      return response(200, { proposalId, taskId: task.taskId, approval: publicApproval(await runtime.capability.approvalRequest(task, proposalId)),
        outcome: await runtime.store.getOutcome(proposalId) });
    }
    const body = await json(request);
    if (action === 'image-task') { exact(body, []); return response(200, await runtime.store.newTask()); }
    if (action === 'generate-image') {
      exact(body, ['taskId', 'prompt']); id(body.taskId); validateImagePrompt(body.prompt);
      const task = await runtime.store.getTask(body.taskId);
      requireValue(task?.userId === context.userId, 'task_not_found', 404);
      const image = await runtime.generateImage(task, body.prompt);
      return response(200, { taskId: task.taskId, image });
    }
    if (action === 'search') { exact(body, ['query']); return response(200, await runtime.capability.search(context, body.query)); }
    if (action === 'read') { exact(body, ['messageId']); return response(200, await runtime.capability.read(context, body.messageId)); }
    if (action === 'prepare') {
      exact(body, ['taskId', 'message']);
      validateGmailMessage(body.message);
      if (body.taskId !== null) id(body.taskId);
      const task = body.taskId ? await runtime.store.reviseTask(body.taskId) : await runtime.store.newTask();
      requireValue(task?.userId === context.userId, 'task_not_found', 404);
      const proposal = await runtime.capability.prepare(task, body.message);
      return response(200, { ...proposal, taskId: task.taskId, approval: publicApproval(await runtime.capability.approvalRequest(task, proposal.proposalId)) });
    }
    id(body.proposalId);
    const task = await runtime.contextFor(body.proposalId);
    if (action === 'close-manual') {
      exact(body, ['proposalId', 'digest', 'acknowledgement']);
      requireValue(await runtime.store.closeManual(body.proposalId, body.digest, body.acknowledgement) === true, 'manual_close_not_available', 409);
      return response(200, { status: 'manual_review_closed', mayHaveBeenDelivered: true });
    }
    if (action !== 'cancel') requireValue(typeof schedule === 'function', 'scheduler_not_configured', 503);
    if (action === 'approve') {
      exact(body, ['proposalId', 'digest', 'confirmed', 'attachmentConfirmed']);
      const approval = await runtime.capability.approvalRequest(task, body.proposalId);
      requireValue(body.confirmed === true && body.digest === approval.scope.digest
        && (!approval.attachmentRequiresExplicitConfirmation || body.attachmentConfirmed === true), 'approval_mismatch', 409);
      requireValue(await runtime.store.approve(approval.scope) === true, 'approval_unavailable', 409);
    } else {
      exact(body, ['proposalId']);
      if (action === 'cancel') {
        requireValue(await runtime.store.cancel(body.proposalId) === true, 'already_attempted', 409);
        return response(200, { status: 'cancelled' });
      }
      requireValue(await runtime.store.getOutcome(body.proposalId), 'approval_required', 403);
    }
    // The queue/claim is durable first. Resume never resets a consumed claim.
    schedule(runtime.run(body.proposalId).catch(error => logger({ event: 'gmail_resume_required', proposalId: body.proposalId,
      code: error instanceof GmailError ? error.code : 'gmail_worker_unavailable' })));
    return response(202, { status: 'scheduled', proposalId: body.proposalId });
  } catch (error) {
    if (path === '/api/connections/gmail/callback') return new Response(null, { status: 303,
      headers: { Location: '/connections.html?connection=failed', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    return response(error instanceof GmailError ? error.status : 503,
      { error: error instanceof GmailError ? error.code : 'gmail_unavailable',
        ...(error instanceof GmailError && error.code === 'gmail_unresolved' ? { proposalId: error.proposalId } : {}) });
  }
}

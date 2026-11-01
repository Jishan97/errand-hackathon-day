import { createGmailIntegration, bindGmailTools, gmailTools } from '../integrations/gmail/index.js';
import { requireValue } from '../integrations/gmail/composio.js';
import { createGmailStore, createGmailRpc } from '../storage/gmail-store.js';
import { GMAIL_DEMO_USER, createGmailAuth } from './gmail-auth.js';

export function gmailRuntimeValues(env) {
  return Object.fromEntries(['ENABLE_GMAIL_DEMO','PUBLIC_BASE_URL','OPERATOR_TOKEN','SUPABASE_URL','SUPABASE_SECRET_KEY',
    'COMPOSIO_API_KEY','COMPOSIO_GMAIL_AUTH_CONFIG_ID'].map(name => [name, env[name]]));
}

export function gmailPublicOrigin(values) {
  requireValue(values.ENABLE_GMAIL_DEMO === 'true', 'setup_required', 503);
  let parsed;
  try { parsed = new URL(values.PUBLIC_BASE_URL); } catch { requireValue(false, 'setup_required', 503); }
  requireValue(parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.pathname === '/'
    && !parsed.search && !parsed.hash, 'setup_required', 503);
  return parsed.origin;
}

export function createGmailRuntime(values, { rpc, fetchImpl, now } = {}) {
  const publicOrigin = gmailPublicOrigin(values);
  const auth = createGmailAuth({ token: values.OPERATOR_TOKEN, now });
  const { store, approvalGate } = createGmailStore({ userId: GMAIL_DEMO_USER,
    rpc: rpc ?? createGmailRpc({ url: values.SUPABASE_URL, secret: values.SUPABASE_SECRET_KEY }) });
  const gmail = createGmailIntegration({ apiKey: values.COMPOSIO_API_KEY, authConfigId: values.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
    publicOrigin, store, approvalGate, authorizeRead: async context => context.userId === GMAIL_DEMO_USER,
    resolveImageAsset: store.resolveImageAsset, fetchImpl, now });
  async function contextFor(proposalId) {
    const proposal = await store.getProposal(proposalId);
    requireValue(proposal?.userId === GMAIL_DEMO_USER, 'proposal_not_found', 404);
    return { userId: proposal.userId, taskId: proposal.taskId, revision: proposal.revision };
  }
  return Object.freeze({ ...gmail, auth, store, publicOrigin, contextFor, tools: gmailTools,
    bindTools: getAdmittedContext => bindGmailTools(gmail.capability, getAdmittedContext),
    async run(proposalId) {
      const context = await contextFor(proposalId);
      const outcome = await store.getOutcome(proposalId);
      if (outcome?.status === 'queued') {
        const result = await gmail.capability.executeApproved(context, proposalId);
        await store.finishWorker(proposalId);
        return result;
      }
      requireValue(outcome, 'approval_required', 403);
      if (['verified', 'rejected', 'manual_review_closed'].includes(outcome.status)) return outcome;
      return gmail.capability.reconcile(context, proposalId);
    },
  });
}

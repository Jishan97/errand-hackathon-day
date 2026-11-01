import { createGmailIntegration, bindGmailTools, gmailTools } from '../integrations/gmail/index.js';
import { requireValue } from '../integrations/gmail/composio.js';
import { createGmailStore, createGmailRpc } from '../storage/gmail-store.js';
import { GMAIL_DEMO_USER, createGmailAuth } from './gmail-auth.js';
import { createImageGenerator, imageTool, runImageAgent } from '../agents/gmail-image.js';

export function gmailRuntimeValues(env) {
  return Object.fromEntries(['ENABLE_GMAIL_DEMO','PUBLIC_BASE_URL','OPERATOR_TOKEN','SUPABASE_URL','SUPABASE_SECRET_KEY',
    'COMPOSIO_API_KEY','COMPOSIO_GMAIL_AUTH_CONFIG_ID','OPENAI_API_KEY'].map(name => [name, env[name]]));
}

export function gmailPublicOrigin(values) {
  requireValue(values.ENABLE_GMAIL_DEMO === 'true', 'setup_required', 503);
  let parsed;
  try { parsed = new URL(values.PUBLIC_BASE_URL); } catch { requireValue(false, 'setup_required', 503); }
  requireValue(parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.pathname === '/'
    && !parsed.search && !parsed.hash, 'setup_required', 503);
  return parsed.origin;
}

export function createGmailRuntime(values, { rpc, fetchImpl, now, imageRpc, imageOptions = {}, agentOptions = {} } = {}) {
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
  const generate = createImageGenerator({ apiKey: values.OPENAI_API_KEY, store, ...imageOptions,
    claim: (context, assetId) => {
      const call = imageRpc ?? createGmailRpc({ url: values.SUPABASE_URL, secret: values.SUPABASE_SECRET_KEY, rpcName: 'errand_gmail_image' });
      return call('claim', context.userId, { taskId: context.taskId, revision: context.revision, assetId });
    } });
  // Agents API function definitions omit the Responses-only `strict` option.
  const tools = [...gmailTools.map(({ strict, ...tool }) => tool), imageTool];
  return Object.freeze({ ...gmail, auth, store, publicOrigin, contextFor, tools,
    bindTools: getAdmittedContext => {
      const gmailDispatch = bindGmailTools(gmail.capability, getAdmittedContext);
      return async (name, args, options) => name === imageTool.name
        ? generate(await getAdmittedContext(), args, options) : gmailDispatch(name, args);
    },
    generateImage: async (context, prompt) => runImageAgent({ apiKey: values.OPENAI_API_KEY, prompt,
      generate: (args, options) => generate(context, args, options), ...agentOptions }),
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

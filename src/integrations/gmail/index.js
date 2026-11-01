import { createComposioGmail, requireValue } from './composio.js';
import { createGmailConnections } from './connections.js';
import { createGmailCapability } from './capability.js';

export { gmailTools, bindGmailTools } from './capability.js';
export { createConnectionsHandler } from './http.js';

// Shared-core composition point. None of these settings are read from private files.
export function createGmailIntegration({ apiKey, authConfigId, publicOrigin, store,
  approvalGate, authorizeRead, fetchImpl, now }) {
  for (const method of ['getBinding', 'putAttempt', 'getAttempt', 'finishAttempt',
    'putProposal', 'getProposal', 'recordOutcome', 'getOutcome']) {
    requireValue(typeof store?.[method] === 'function', 'store_contract_required');
  }
  requireValue(typeof approvalGate?.claim === 'function' && typeof approvalGate?.canReconcile === 'function'
    && typeof authorizeRead === 'function', 'core_authorization_required');
  const provider = createComposioGmail({ apiKey, authConfigId, fetchImpl });
  const connections = createGmailConnections({ provider, store, publicOrigin, now });
  const capability = createGmailCapability({ provider, connections, store, approvalGate, authorizeRead, now });
  return Object.freeze({ connections, capability });
}

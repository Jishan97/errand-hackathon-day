import { randomUUID } from 'node:crypto';
import { GmailError, requireValue } from './composio.js';

export function authenticated(context) {
  authenticatedUser(context);
  requireValue(typeof context?.sessionId === 'string' && context.sessionId.length > 0, 'sign_in_required', 401);
  return context;
}
export function authenticatedUser(context) {
  requireValue(typeof context?.userId === 'string' && context.userId.length > 0, 'sign_in_required', 401);
  return context;
}

// The durable store contract and authenticated context are supplied by the shared core.
export function createGmailConnections({ provider, store, publicOrigin, now = Date.now }) {
  const origin = new URL(publicOrigin);
  requireValue(origin.protocol === 'https:' && origin.origin === publicOrigin, 'invalid_public_origin');
  const callbackUrl = `${publicOrigin}/api/connections/gmail/callback`;
  async function bindingFor(context) {
    authenticatedUser(context);
    const binding = await store.getBinding(context.userId);
    requireValue(binding?.userId === context.userId, 'not_connected');
    requireValue(typeof binding.bindingId === 'string' && binding.bindingId.length > 0
      && typeof binding.email === 'string', 'connection_unavailable');
    await provider.verifyAccount(context.userId, binding.accountId);
    return binding;
  }
  return Object.freeze({
    bindingFor,
    async status(context) {
      authenticated(context);
      const binding = await store.getBinding(context.userId);
      if (!binding) return { status: 'not_connected' };
      await bindingFor(context);
      const profile = await provider.profile(binding);
      requireValue(profile.emailAddress?.toLowerCase() === binding.email.toLowerCase(), 'connection_unavailable');
      return { status: 'connected', email: binding.email };
    },
    async connect(context) {
      authenticated(context);
      // The fixed project verifier URL must be configured in Composio before onboarding.
      const link = await provider.link(context.userId, callbackUrl);
      await store.putAttempt({ id: randomUUID(), userId: context.userId, sessionId: context.sessionId,
        accountId: link.accountId, expiresAt: now() + 10 * 60 * 1000 });
      return { redirectUrl: link.redirectUrl };
    },
    async complete(context, sessionUri) {
      authenticated(context);
      requireValue(typeof sessionUri === 'string' && sessionUri.length > 0 && sessionUri.length <= 4096, 'invalid_callback');
      const attempt = await store.getAttempt(context.userId, context.sessionId);
      requireValue(attempt && attempt.userId === context.userId && attempt.sessionId === context.sessionId
        && attempt.expiresAt > now(), 'connection_expired');
      const accountId = await provider.completeIdentity(context.userId, sessionUri);
      requireValue(accountId === attempt.accountId, 'connection_mismatch');
      const verified = await provider.verifyAccount(context.userId, accountId);
      const profile = await provider.profile(verified);
      requireValue(typeof profile.emailAddress === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.emailAddress), 'invalid_provider_response', 502);
      // A valid attempt replaces the binding; replay or a superseded attempt cannot do so.
      const saved = await store.finishAttempt(attempt, { ...verified, bindingId: randomUUID(), email: profile.emailAddress });
      if (!saved) throw new GmailError('connection_expired');
      return { status: 'connected', email: profile.emailAddress };
    },
  });
}

// Server only. No environment loading, credential logging, SDK retries or generic agent proxy.
export class GmailError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export function requireValue(condition, code = 'invalid_request', status = 400) {
  if (!condition) throw new GmailError(code, status);
}
export function safeId(value) {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value));
  return value;
}

export function createComposioGmail({ apiKey, authConfigId, fetchImpl = fetch }) {
  requireValue(typeof apiKey === 'string' && apiKey.length > 0, 'setup_required', 503);
  safeId(authConfigId);
  async function request(path, body) {
    let response;
    try {
      response = await fetchImpl(`https://backend.composio.dev${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('provider');
      return await response.json();
    } catch { throw new GmailError('provider_unavailable', 502); }
  }
  async function gmail(binding, path, method = 'GET', body) {
    // Every path is built below; neither an agent nor the browser can supply an endpoint.
    const result = await request('/api/v3.1/tools/execute/proxy', {
      connected_account_id: safeId(binding.accountId), user_id: binding.userId,
      endpoint: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`, method,
      ...(body ? { body } : {}),
    });
    if ([400, 401, 403, 404].includes(result.status) && result.data?.error?.code === result.status) {
      throw new GmailError('provider_rejected', 502);
    }
    requireValue(Number.isInteger(result.status) && result.status >= 200 && result.status < 300
      && result.data && typeof result.data === 'object', 'provider_unavailable', 502);
    return result.data;
  }
  return Object.freeze({
    async link(userId, callbackUrl) {
      const result = await request('/api/v3/connected_accounts/link', {
        user_id: userId, auth_config_id: authConfigId, callback_url: callbackUrl,
      });
      safeId(result.connected_account_id);
      let url;
      try { url = new URL(result.redirect_url); } catch { throw new GmailError('invalid_provider_response', 502); }
      requireValue(url.origin === 'https://connect.composio.dev' && !url.username && !url.password,
        'invalid_provider_response', 502);
      return { accountId: result.connected_account_id, redirectUrl: url.href };
    },
    async completeIdentity(userId, sessionUri) {
      const result = await request('/api/v3.1/connected_accounts/complete_auth', {
        user_id: userId, session_uri: sessionUri,
      });
      requireValue(result.toolkit_slug === 'gmail', 'connection_mismatch');
      return safeId(result.connected_account_id);
    },
    async verifyAccount(userId, accountId) {
      const account = await request(`/api/v3/connected_accounts/${safeId(accountId)}`);
      requireValue(account.id === accountId && account.user_id === userId
        && account.toolkit?.slug === 'gmail' && account.auth_config?.id === authConfigId
        && account.auth_config?.is_composio_managed === true
        && account.status === 'ACTIVE' && account.is_disabled === false
        && account.auth_config?.is_disabled === false
        && account.experimental?.account_type !== 'SHARED', 'connection_unavailable');
      // Deliberately discard provider state/data: they may contain credentials.
      return { userId, accountId };
    },
    profile: binding => gmail(binding, 'profile'),
    list: (binding, query) => gmail(binding, `messages?${new URLSearchParams({ q: query, maxResults: '5', includeSpamTrash: 'false' })}`),
    read: (binding, id) => gmail(binding, `messages/${safeId(id)}?format=full`),
    saveDraft: (binding, message) => gmail(binding, 'drafts', 'POST', { message }),
    readDraft: (binding, id) => gmail(binding, `drafts/${safeId(id)}?format=full`),
    send: (binding, message) => gmail(binding, 'messages/send', 'POST', message),
  });
}

// Reused from the pre-event Errand MVP; scoped to the hackathon incident demo.
import { createPrivateKey, sign } from "node:crypto";

const apiOrigin = "https://api.github.com";
const webOrigin = "https://github.com";
export const githubAppCallbackPath = "/auth/github/callback";
export const githubAppInstalledPath = "/auth/github/installed";
const maxResponseBytes = 256 * 1024;
const permissionsWanted = Object.freeze({ contents: "write", pull_requests: "write" });
const own = (value, key) => value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const safeToken = (value) => typeof value === "string" && value.length >= 1 && value.length <= 2048 && /^[\x21-\x7e]+$/.test(value);
const fail = (code, status) => { const error = new Error(code); error.code = code; if (Number.isInteger(status) && status >= 400 && status <= 599) error.http_status = status; throw error; };

function id(value) {
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || value < 1) fail("github_app_invalid_response"); value = String(value); }
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value) || BigInt(value) < 1n) fail("github_app_invalid_response");
  return BigInt(value).toString();
}
function login(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) fail("github_app_invalid_response");
  return value;
}
function repositoryName(value) {
  if (typeof value !== "string") fail("github_app_invalid_repository");
  const pieces = value.split("/");
  if (pieces.length !== 2 || !/^[A-Za-z0-9_.-]{1,100}$/.test(pieces[1]) || [".", ".."].includes(pieces[1])) fail("github_app_invalid_repository");
  login(pieces[0]);
  return { owner: pieces[0], name: pieces[1], fullName: value };
}
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) fail("github_app_unconfigured");
  return url.origin;
}
function settings(config) {
  const values = own(config, "values");
  const get = (key) => own(values, key);
  if (own(config, "githubAppEnabled") !== true) fail("github_app_unconfigured");
  const selected = {
    appId: id(get("GITHUB_APP_ID")), clientId: get("GITHUB_APP_CLIENT_ID"), clientSecret: get("GITHUB_APP_CLIENT_SECRET"),
    privateKeyBase64: get("GITHUB_APP_PRIVATE_KEY_BASE64"), slug: get("GITHUB_APP_SLUG"), sessionSecret: get("GITHUB_APP_SESSION_SECRET"),
    publicOrigin: origin(get("PUBLIC_BASE_URL")), repository: repositoryName(get("GITHUB_DEMO_REPO")),
  };
  if (typeof selected.clientId !== "string" || !/^[A-Za-z0-9_.-]{5,128}$/.test(selected.clientId)
    || !safeToken(selected.clientSecret) || selected.clientSecret.length < 16 || selected.clientSecret.length > 256
    || typeof selected.privateKeyBase64 !== "string" || selected.privateKeyBase64.length > 32768 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(selected.privateKeyBase64) || !selected.privateKeyBase64
    || typeof selected.slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(selected.slug)
    || typeof selected.sessionSecret !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(selected.sessionSecret)) fail("github_app_unconfigured");
  return selected;
}

export function githubAppIsConfigured(config) {
  try { settings(config); return true; } catch { return false; }
}

function account(value) {
  const type = own(value, "type");
  if (!["User", "Organization", "Bot"].includes(type)) fail("github_app_invalid_response");
  return Object.freeze({ id: id(own(value, "id")), login: login(own(value, "login")), type });
}
function permissions(value) {
  const result = {};
  for (const key of ["contents", "pull_requests", "metadata", "checks", "actions"]) {
    const permission = own(value, key) ?? "none";
    if (!["none", "read", "write"].includes(permission)) fail("github_app_invalid_response");
    result[key] = permission;
  }
  return Object.freeze(result);
}

export function createGitHubAppClient({ config, fetcher = fetch, clock = Date.now }) {
  let selected;
  try { selected = settings(config); } catch { fail("github_app_unconfigured"); }
  if (typeof fetcher !== "function" || typeof clock !== "function") fail("github_app_unconfigured");
  const tokenCache = new Map();
  const pendingTokens = new Map();
  let privateKey;
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail("github_app_clock_invalid"); return value; };
  const validateState = (value) => { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) fail("github_app_invalid_state"); return value; };
  function appJwt() {
    try {
      if (!privateKey) {
        const bytes = Buffer.from(selected.privateKeyBase64, "base64");
        let candidate;
        try { candidate = createPrivateKey(bytes); } finally { bytes.fill(0); }
        if (candidate.asymmetricKeyType !== "rsa" || candidate.asymmetricKeyDetails.modulusLength < 2048) fail("github_app_private_key_invalid");
        privateKey = candidate;
      }
      const seconds = Math.floor(now() / 1000);
      const head = Buffer.from(JSON.stringify({ typ: "JWT", alg: "RS256" })).toString("base64url");
      const body = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: selected.clientId })).toString("base64url");
      const input = `${head}.${body}`;
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
    } catch { fail("github_app_private_key_invalid"); }
  }
  async function request(url, { token = null, method = "GET", body = null, form = false } = {}) {
    const target = new URL(url);
    const oauth = target.origin === webOrigin && target.pathname === "/login/oauth/access_token" && method === "POST";
    if ((!oauth && target.origin !== apiOrigin) || target.username || target.password || target.hash || (token !== null && !safeToken(token))) fail("github_app_invalid_request");
    let timer;
    const controller = new AbortController();
    try {
      return await Promise.race([
        new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); const error = new Error("github_app_request_timeout"); error.code = "github_app_request_timeout"; reject(error); }, 8000); }),
        (async () => {
          const response = await fetcher(target.href, {
            method, redirect: "error", signal: controller.signal,
            headers: { Accept: "application/json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "Errand-GitHub-App", ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body !== null ? { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}) },
            ...(body !== null ? { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) } : {}),
          });
          if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* No provider error body is read. */ }
            fail("github_app_http_error", response.status);
          }
          if (Number(response.headers.get("content-length")) > maxResponseBytes) { await response.body?.cancel().catch(() => {}); fail("github_app_response_too_large"); }
          const reader = response.body?.getReader();
          if (!reader) fail("github_app_invalid_response");
          let size = 0;
          const chunks = [];
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              size += value.byteLength;
              if (size > maxResponseBytes) fail("github_app_response_too_large");
              chunks.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); }
          let result;
          try { result = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { fail("github_app_invalid_response"); }
          if (!result || typeof result !== "object" || Array.isArray(result)) fail("github_app_invalid_response");
          return result;
        })(),
      ]);
    } catch (error) {
      const code = own(error, "code");
      if (["github_app_http_error", "github_app_response_too_large", "github_app_invalid_response", "github_app_request_timeout"].includes(code)) fail(code, own(error, "http_status"));
      fail("github_app_request_failed");
    } finally { clearTimeout(timer); controller.abort(); }
  }
  const api = (path, options) => request(`${apiOrigin}${path}`, options);
  async function getInstallation(installationId) {
    const selectedId = id(installationId);
    const raw = await api(`/app/installations/${selectedId}`, { token: appJwt() });
    const result = Object.freeze({ id: id(raw.id), appId: id(raw.app_id), account: account(raw.account), permissions: permissions(raw.permissions),
      repositorySelection: raw.repository_selection, suspended: raw.suspended_at !== null && raw.suspended_at !== undefined });
    if (result.id !== selectedId || result.appId !== selected.appId || !["all", "selected"].includes(result.repositorySelection)) fail("github_app_installation_mismatch");
    return result;
  }
  function requireRepository(value) {
    const repository = repositoryName(value);
    if (repository.fullName.toLowerCase() !== selected.repository.fullName.toLowerCase()) fail("github_app_repository_not_allowed");
    return repository;
  }
  function sanitizeRepository(raw) {
    const repository = requireRepository(raw.full_name);
    const owner = account(raw.owner);
    if (owner.type !== "User" || owner.login.toLowerCase() !== selected.repository.owner.toLowerCase()) fail("github_app_personal_account_required");
    if (raw.name !== repository.name || typeof raw.private !== "boolean" || typeof raw.default_branch !== "string" || !raw.default_branch || raw.default_branch.length > 255 || /[\u0000-\u001f\u007f]/u.test(raw.default_branch)) fail("github_app_invalid_response");
    return Object.freeze({ id: id(raw.id), fullName: raw.full_name, name: raw.name, owner, private: raw.private, defaultBranch: raw.default_branch });
  }
  return Object.freeze({
    authorizationUrl({ state, codeChallenge }) {
      validateState(state);
      if (typeof codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) fail("github_app_invalid_pkce");
      const url = new URL(`${webOrigin}/login/oauth/authorize`);
      url.search = new URLSearchParams({ client_id: selected.clientId, redirect_uri: selected.publicOrigin + githubAppCallbackPath,
        state, code_challenge: codeChallenge, code_challenge_method: "S256", login: selected.repository.owner, allow_signup: "false", prompt: "select_account" });
      return url.href;
    },
    async exchangeCode({ code, codeVerifier }) {
      if (typeof code !== "string" || !/^[A-Za-z0-9_.~-]{1,512}$/.test(code) || typeof codeVerifier !== "string" || !/^[A-Za-z0-9_.~-]{43,128}$/.test(codeVerifier)) fail("github_app_invalid_oauth_code");
      const raw = await request(`${webOrigin}/login/oauth/access_token`, { method: "POST", form: true,
        body: { client_id: selected.clientId, client_secret: selected.clientSecret, code, code_verifier: codeVerifier, redirect_uri: selected.publicOrigin + githubAppCallbackPath } });
      if (raw.error || raw.token_type !== "bearer" || !safeToken(raw.access_token)) {
        const error = Object.assign(new Error("github_app_oauth_rejected"), { code: "github_app_oauth_rejected" });
        if (["bad_verification_code", "incorrect_client_credentials", "redirect_uri_mismatch"].includes(raw.error)) error.oauth_error_code = raw.error;
        throw error;
      }
      if (raw.expires_in !== undefined && (!Number.isSafeInteger(raw.expires_in) || raw.expires_in < 1 || raw.expires_in > 86400)) fail("github_app_invalid_response");
      return Object.freeze({ accessToken: raw.access_token, expiresAt: raw.expires_in === undefined ? null : new Date(now() + raw.expires_in * 1000).toISOString() });
    },
    async getUser(userAccessToken) {
      if (!safeToken(userAccessToken)) fail("github_app_invalid_user_token");
      return account(await api("/user", { token: userAccessToken }));
    },
    installationUrl({ state }) {
      const url = new URL(`${webOrigin}/apps/${selected.slug}/installations/new`);
      url.searchParams.set("state", validateState(state));
      return url.href;
    },
    getInstallation,
    async createInstallationToken({ installationId, repository }) {
      const selectedId = id(installationId); requireRepository(repository);
      const cacheKey = `${selectedId}:${selected.repository.fullName.toLowerCase()}`;
      for (const [key, cached] of tokenCache) if (cached.expiresMs <= now() + 60000) tokenCache.delete(key);
      if (tokenCache.has(cacheKey)) return tokenCache.get(cacheKey).value;
      if (pendingTokens.has(cacheKey)) return pendingTokens.get(cacheKey);
      if (pendingTokens.size >= 8 || tokenCache.size >= 8) fail("github_app_token_capacity");
      const pending = (async () => {
        const installation = await getInstallation(selectedId);
        if (installation.suspended || installation.account.type !== "User" || installation.account.login.toLowerCase() !== selected.repository.owner.toLowerCase()) fail("github_app_personal_account_required");
        if (installation.permissions.contents !== "write" || installation.permissions.pull_requests !== "write") fail("github_app_permissions_required");
        const requestedPermissions = config.incidentDemoEnabled ? { ...permissionsWanted, checks: "read", actions: "read" } : permissionsWanted;
        if (config.incidentDemoEnabled && (!["read", "write"].includes(installation.permissions.checks) || !["read", "write"].includes(installation.permissions.actions))) fail("github_app_permissions_required");
        const raw = await api(`/app/installations/${selectedId}/access_tokens`, { token: appJwt(), method: "POST", body: { repositories: [selected.repository.name], permissions: requestedPermissions } });
        const expiry = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
        const granted = permissions(raw.permissions);
        if (!safeToken(raw.token) || !Number.isFinite(expiry) || expiry <= now() || expiry > now() + 3700000 || granted.contents !== "write" || granted.pull_requests !== "write") fail("github_app_invalid_token_response");
        if (config.incidentDemoEnabled && (granted.checks !== "read" || granted.actions !== "read")) fail("github_app_invalid_token_scope");
        if (Object.entries(raw.permissions ?? {}).some(([key, value]) => !["contents", "pull_requests", "metadata", ...(config.incidentDemoEnabled ? ["checks", "actions"] : [])].includes(key) && value !== "none")) fail("github_app_invalid_token_scope");
        if (raw.repositories !== undefined && (!Array.isArray(raw.repositories) || raw.repositories.length !== 1 || requireRepository(raw.repositories[0]?.full_name).name.toLowerCase() !== selected.repository.name.toLowerCase())) fail("github_app_invalid_token_scope");
        const value = Object.freeze({ token: raw.token, expiresAt: new Date(expiry).toISOString() });
        tokenCache.set(cacheKey, { expiresMs: expiry, value });
        return value;
      })();
      pendingTokens.set(cacheKey, pending);
      try { return await pending; } finally { pendingTokens.delete(cacheKey); }
    },
    async getRepository(token, fullName) {
      if (!safeToken(token)) fail("github_app_invalid_installation_token");
      const selectedRepository = requireRepository(fullName);
      return sanitizeRepository(await api(`/repos/${selectedRepository.owner}/${selectedRepository.name}`, { token }));
    },
    async listInstallationRepositories(token) {
      if (!safeToken(token)) fail("github_app_invalid_installation_token");
      const result = await api("/installation/repositories?per_page=100&page=1", { token });
      if (!Array.isArray(result.repositories) || result.repositories.length > 100 || result.total_count !== result.repositories.length) fail("github_app_repository_list_incomplete");
      return Object.freeze(result.repositories.map(sanitizeRepository));
    },
    clearTokenCache() { tokenCache.clear(); },
  });
}

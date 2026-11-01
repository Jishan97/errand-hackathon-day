import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { createGitHubAppClient, githubAppIsConfigured, githubAppCallbackPath, githubAppInstalledPath } from "../src/github/app-client.js";

// In-memory, disposable fixtures. These are not user credentials or local configuration.
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyBase64 = Buffer.from(rsa.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
const instant = Date.parse("2026-10-31T10:00:00Z");
const state = "fixture_state_" + "s".repeat(32);
const verifier = "v".repeat(64);
const challenge = "c".repeat(43);
const repository = "DemoUser/errand-agent-demo";
const config = (changes = {}) => ({ githubAppEnabled: true, values: {
  GITHUB_APP_ID: "00123", GITHUB_APP_CLIENT_ID: "Iv1.fixtureClient", GITHUB_APP_CLIENT_SECRET: "fixture-client-secret-only",
  GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64, GITHUB_APP_SLUG: "errand-fixture-app",
  GITHUB_APP_SESSION_SECRET: "s".repeat(48), PUBLIC_BASE_URL: "https://errand.example", GITHUB_DEMO_REPO: repository,
  ...changes,
} });
const installation = (changes = {}) => ({ id: 789, app_id: 123, account: { id: 456, login: "DemoUser", type: "User", email: "excluded@example.test" },
  permissions: { contents: "write", pull_requests: "write", metadata: "read" }, repository_selection: "selected", suspended_at: null, ...changes });
const repo = (changes = {}) => ({ id: 900, full_name: repository, name: "errand-agent-demo", owner: { id: 456, login: "DemoUser", type: "User" },
  private: true, default_branch: "main", clone_url: "excluded", ...changes });
const minted = (changes = {}) => ({ token: "ghs_fixture_installation_token", expires_at: new Date(instant + 3600000).toISOString(),
  permissions: { contents: "write", pull_requests: "write", metadata: "read" }, repositories: [{ full_name: repository }], ...changes });
const json = (value, init) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
function harness(responses, options = {}) {
  const calls = [];
  const client = createGitHubAppClient({ config: config(options.changes), clock: options.clock ?? (() => instant), fetcher: async (url, init) => {
    calls.push({ url, init });
    assert.ok(responses.length, "unexpected GitHub fixture request");
    const next = responses.shift();
    return typeof next === "function" ? next(url, init) : next;
  } });
  return { client, calls };
}
const codeIs = (code) => (error) => error.message === code && error.code === code;

test("GitHub App readiness checks only explicit supplied config and never executes value getters", () => {
  assert.equal(githubAppIsConfigured(config()), true);
  assert.equal(githubAppIsConfigured({ ...config(), githubAppEnabled: false }), false);
  for (const key of Object.keys(config().values)) assert.equal(githubAppIsConfigured(config({ [key]: "" })), false, key);
  let reads = 0;
  const hostile = config();
  Object.defineProperty(hostile.values, "GITHUB_APP_CLIENT_SECRET", { get() { reads += 1; throw new Error("must not execute"); } });
  assert.equal(githubAppIsConfigured(hostile), false);
  assert.equal(reads, 0);
  assert.throws(() => createGitHubAppClient({ config: {} }), codeIs("github_app_unconfigured"));
});

test("authorization and installation URLs bind exact callback, PKCE, state and personal login", () => {
  const { client, calls } = harness([]);
  const url = new URL(client.authorizationUrl({ state, codeChallenge: challenge }));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "https://errand.example/auth/github/callback");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("login"), "DemoUser");
  assert.equal(url.searchParams.get("allow_signup"), "false");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal(client.installationUrl({ state }), `https://github.com/apps/errand-fixture-app/installations/new?state=${state}`);
  assert.equal(githubAppCallbackPath, "/auth/github/callback");
  assert.equal(githubAppInstalledPath, "/auth/github/installed");
  assert.equal(calls.length, 0);
  assert.throws(() => client.authorizationUrl({ state: "short", codeChallenge: challenge }), codeIs("github_app_invalid_state"));
  assert.throws(() => client.authorizationUrl({ state, codeChallenge: "not-a-challenge" }), codeIs("github_app_invalid_pkce"));
});

test("configuration rejects URL/path injection and requests never follow redirects", async () => {
  for (const base of ["http://errand.example", "https://evil@example.test", "https://errand.example/path", "https://errand.example?x=1", "https://errand.example:444"]) {
    assert.equal(githubAppIsConfigured(config({ PUBLIC_BASE_URL: base })), false);
  }
  for (const name of ["DemoUser/repo/extra", "DemoUser/..", "DemoUser/repo?token=1", "evil.example/repo%2fpath"]) assert.equal(githubAppIsConfigured(config({ GITHUB_DEMO_REPO: name })), false);
  const { client, calls } = harness([json({ id: 456, login: "DemoUser", type: "User" })]);
  await client.getUser("ghu_fixture_user_token");
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.headers.Authorization, "Bearer ghu_fixture_user_token");
});

test("OAuth exchange sends code/verifier only to fixed endpoint and discards refresh credentials", async () => {
  const { client, calls } = harness([json({ access_token: "ghu_fixture_access", token_type: "bearer", expires_in: 28800,
    refresh_token: "never-return-this", refresh_token_expires_in: 100000, scope: "untrusted" })]);
  assert.deepEqual(await client.exchangeCode({ code: "fixture-code", codeVerifier: verifier }), { accessToken: "ghu_fixture_access", expiresAt: new Date(instant + 28800000).toISOString() });
  assert.equal(calls[0].url, "https://github.com/login/oauth/access_token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get("client_id"), "Iv1.fixtureClient");
  assert.equal(body.get("client_secret"), "fixture-client-secret-only");
  assert.equal(body.get("code_verifier"), verifier);
  assert.equal(body.get("redirect_uri"), "https://errand.example/auth/github/callback");
  assert.equal(body.has("refresh_token"), false);
});

test("OAuth failures are fixed errors and malformed code/token values make no credential leak", async () => {
  const { client, calls } = harness([json({ error: "raw-provider-error", error_description: "untrusted-private-detail" })]);
  await assert.rejects(client.exchangeCode({ code: "fixture-code", codeVerifier: verifier }), codeIs("github_app_oauth_rejected"));
  await assert.rejects(client.exchangeCode({ code: "bad\ncode", codeVerifier: verifier }), codeIs("github_app_invalid_oauth_code"));
  await assert.rejects(client.getUser("token\r\nInjected: true"), codeIs("github_app_invalid_user_token"));
  assert.equal(calls.length, 1);
});

test("only fixed OAuth protocol rejection codes leave the App client", async () => {
  for (const code of ["bad_verification_code", "incorrect_client_credentials", "redirect_uri_mismatch", "private-unknown-error"]) {
    const { client } = harness([json({ error: code, error_description: "fixture-private-message-must-not-print" })]);
    await assert.rejects(client.exchangeCode({ code: "fixture-code", codeVerifier: verifier }), (error) => {
      assert.equal(error.code, "github_app_oauth_rejected");
      assert.equal(error.message, "github_app_oauth_rejected");
      assert.equal(error.oauth_error_code, code === "private-unknown-error" ? undefined : code);
      assert.ok(!JSON.stringify(error).includes("must-not-print"));
      return true;
    });
  }
});

test("user and installation metadata are whitelisted and numeric identifiers normalized", async () => {
  const { client } = harness([json({ id: "000456", login: "DemoUser", type: "User", email: "hidden", token: "hidden" }), json(installation())]);
  assert.deepEqual(await client.getUser("ghu_fixture"), { id: "456", login: "DemoUser", type: "User" });
  assert.deepEqual(await client.getInstallation("000789"), { id: "789", appId: "123", account: { id: "456", login: "DemoUser", type: "User" },
    permissions: { contents: "write", pull_requests: "write", metadata: "read", checks: "none", actions: "none" }, repositorySelection: "selected", suspended: false });
});

test("App JWT uses RS256 and bounded timestamps with client ID issuer", async () => {
  const { client, calls } = harness([json(installation())]);
  await client.getInstallation("789");
  const token = calls[0].init.headers.Authorization.slice(7);
  const [head, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { typ: "JWT", alg: "RS256" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "Iv1.fixtureClient");
  assert.equal(claims.iat, instant / 1000 - 60);
  assert.equal(claims.exp, instant / 1000 + 540);
  assert.ok(claims.exp - instant / 1000 <= 600);
  assert.equal(verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), rsa.publicKey, Buffer.from(signature, "base64url")), true);
  assert.equal(calls[0].url, "https://api.github.com/app/installations/789");
});

test("invalid or weak private keys remain invalid on repeated attempts and never reach GitHub", async () => {
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
  for (const bytes of [Buffer.from("fixture-not-a-key"), Buffer.from(weak)]) {
    const { client, calls } = harness([], { changes: { GITHUB_APP_PRIVATE_KEY_BASE64: bytes.toString("base64") } });
    await assert.rejects(client.getInstallation("789"), codeIs("github_app_private_key_invalid"));
    await assert.rejects(client.getInstallation("789"), codeIs("github_app_private_key_invalid"));
    assert.equal(calls.length, 0);
  }
});

test("installation metadata rejects mismatched app or installation before any token mint", async () => {
  for (const changes of [{ app_id: 124 }, { id: 790 }]) {
    const { client, calls } = harness([json(installation(changes))]);
    await assert.rejects(client.createInstallationToken({ installationId: "789", repository }), codeIs("github_app_installation_mismatch"));
    assert.equal(calls.length, 1);
  }
});

test("installation token is explicitly narrowed to one configured repo and two write permissions", async () => {
  const { client, calls } = harness([json(installation()), json(minted())]);
  assert.deepEqual(await client.createInstallationToken({ installationId: "789", repository }), { token: "ghs_fixture_installation_token", expiresAt: new Date(instant + 3600000).toISOString() });
  assert.equal(calls[1].url, "https://api.github.com/app/installations/789/access_tokens");
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), { repositories: ["errand-agent-demo"], permissions: { contents: "write", pull_requests: "write" } });
  await assert.rejects(client.createInstallationToken({ installationId: "789", repository: "DemoUser/other" }), codeIs("github_app_repository_not_allowed"));
  await assert.rejects(client.getInstallation("789/../../orgs/private"), codeIs("github_app_invalid_response"));
  assert.equal(calls.length, 2);
});

test("personal-only token mint rejects organization, wrong owner, suspension and missing write permissions", async () => {
  for (const changes of [
    { account: { id: 456, login: "DemoUser", type: "Organization" } },
    { account: { id: 456, login: "AnotherUser", type: "User" } },
    { suspended_at: "2026-10-31T09:00:00Z" },
    { permissions: { contents: "read", pull_requests: "write" } },
  ]) {
    const { client, calls } = harness([json(installation(changes))]);
    await assert.rejects(client.createInstallationToken({ installationId: "789", repository }), (error) => ["github_app_personal_account_required", "github_app_permissions_required"].includes(error.code));
    assert.equal(calls.length, 1);
    assert.equal(calls.some((call) => call.url.includes("/orgs/")), false);
  }
});

test("unexpected token scope, expiry, or repository responses never become cached credentials", async () => {
  for (const changes of [
    { permissions: { contents: "write", pull_requests: "write", administration: "write" } },
    { repositories: [{ full_name: repository }, { full_name: "DemoUser/other" }] },
    { repositories: [{ full_name: "DemoUser/other" }] },
    { expires_at: new Date(instant - 1).toISOString() },
    { token: "bad\r\ntoken" },
  ]) {
    const { client, calls } = harness([json(installation()), json(minted(changes)), json(installation()), json(minted())]);
    await assert.rejects(client.createInstallationToken({ installationId: "789", repository }));
    assert.equal((await client.createInstallationToken({ installationId: "789", repository })).token, "ghs_fixture_installation_token");
    assert.equal(calls.length, 4);
  }
});

test("in-memory scoped token caching coalesces mint requests and refreshes before expiry", async () => {
  let current = instant;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { client, calls } = harness([async () => { await held; return json(installation()); }, json(minted()), json(installation()), json(minted({ token: "ghs_second", expires_at: new Date(instant + 7200000).toISOString() }))], { clock: () => current });
  const first = client.createInstallationToken({ installationId: "789", repository });
  const concurrent = client.createInstallationToken({ installationId: "789", repository });
  release();
  const [one, two] = await Promise.all([first, concurrent]);
  assert.deepEqual(one, two);
  assert.equal(calls.length, 2);
  assert.deepEqual(await client.createInstallationToken({ installationId: "789", repository }), one);
  assert.equal(calls.length, 2);
  current = instant + 3600000 - 60000;
  assert.equal((await client.createInstallationToken({ installationId: "789", repository })).token, "ghs_second");
  assert.equal(calls.length, 4);
});

test("repository reads stay within configured personal repository and discard unneeded provider fields", async () => {
  const { client, calls } = harness([json(repo()), json({ total_count: 1, repositories: [repo()] })]);
  const metadata = await client.getRepository("ghs_fixture", repository);
  assert.deepEqual(metadata, { id: "900", fullName: repository, name: "errand-agent-demo", owner: { id: "456", login: "DemoUser", type: "User" }, private: true, defaultBranch: "main" });
  assert.equal(calls[0].url, `https://api.github.com/repos/${repository}`);
  assert.deepEqual(await client.listInstallationRepositories("ghs_fixture"), [metadata]);
  await assert.rejects(client.getRepository("ghs_fixture", "DemoUser/other"), codeIs("github_app_repository_not_allowed"));
  assert.equal(calls.length, 2);
});

test("HTTP failure bodies are canceled without reading, with fixed status-only errors", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let canceled = 0, read = 0;
    const { client } = harness([{ ok: false, status, body: { cancel: async () => { canceled += 1; }, getReader() { read += 1; throw new Error("hidden body"); } } }]);
    await assert.rejects(client.getUser("ghu_fixture"), (error) => {
      assert.equal(error.message, "github_app_http_error");
      assert.deepEqual(Object.keys(error).sort(), ["code", "http_status"]);
      assert.equal(error.http_status, status);
      return true;
    });
    assert.equal(canceled, 1);
    assert.equal(read, 0);
  }
});

test("response length and malformed JSON are bounded and raw transport errors stay private", async () => {
  const fixtures = [
    json({ oversized: "x".repeat(270000) }),
    new Response("{not-json hidden-value}"),
    () => { throw new Error("raw-private-provider-detail"); },
  ];
  const expected = ["github_app_response_too_large", "github_app_invalid_response", "github_app_request_failed"];
  for (let index = 0; index < fixtures.length; index += 1) {
    const { client } = harness([fixtures[index]]);
    await assert.rejects(client.getUser("ghu_fixture"), codeIs(expected[index]));
  }
});

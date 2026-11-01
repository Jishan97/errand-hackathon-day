import assert from "node:assert/strict";
import test from "node:test";
import { createGithubDeveloperCredential } from "../src/github/developer-credential.js";

const appId = "9007199254740993001";
const userId = "9007199254740993002";
const installationId = "9007199254740993003";
const appToken = "fixture-installation-token-never-print";
const oldPat = "fixture-obsolete-personal-token-never-print";
const config = (enabled = true) => ({ githubAppEnabled: enabled, values: {
  PUBLIC_BASE_URL: "https://fixture.example", GITHUB_DEMO_REPO: "Fixture-Owner/Demo.Site",
  GITHUB_DEMO_URL: "https://fixture-demo.vercel.app", GITHUB_DEMO_TOKEN: oldPat,
  GITHUB_APP_ID: appId, GITHUB_APP_CLIENT_ID: "fixture-app-client-id",
  GITHUB_APP_CLIENT_SECRET: "fixture-private-client-secret", GITHUB_APP_SLUG: "fixture-demo-app",
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from("fixture-key-not-a-real-private-key").toString("base64"),
  GITHUB_APP_SESSION_SECRET: "fixture-session-secret-0000000000000000",
} });
const row = (changes = {}) => ({ owner: "fixture-owner", repository: "demo.site", appId, userId, installationId,
  connectedAt: "2026-10-31T22:49:11.000Z", ...changes });
const installation = (changes = {}) => ({ id: installationId, appId, suspended: false,
  account: { id: userId, login: "Fixture-Owner", type: "User" },
  permissions: { contents: "write", pull_requests: "write", metadata: "read" }, ...changes });

function fixture({ connection = row(), installed = installation(), configured = config() } = {}) {
  let current = connection;
  const reads = [], inspected = [], minted = [];
  const credential = createGithubDeveloperCredential({ config: configured,
    repository: { async get(binding) { reads.push(binding); return current; } },
    client: {
      async getInstallation(id) { inspected.push(id); return installed; },
      async createInstallationToken(input) { minted.push(input); return { token: appToken, expiresAt: "2026-11-01T00:00:00.000Z" }; },
    },
  });
  return { credential, reads, inspected, minted, disconnect() { current = null; } };
}

test("no connection row means unavailable and no installation lookup or token mint", async () => {
  const f = fixture({ connection: null });
  assert.equal(f.credential.configured, true);
  assert.equal(await f.credential.isAvailable(), false);
  await assert.rejects(f.credential.getToken(), { message: "github_app_not_connected" });
  assert.deepEqual(f.reads, Array(2).fill({ owner: "fixture-owner", repository: "demo.site", appId }));
  assert.deepEqual(f.inspected, []); assert.deepEqual(f.minted, []);
});

test("incomplete App setup cannot query connections or use a legacy PAT", async () => {
  for (const configured of [config(false), { ...config(), values: { ...config().values, GITHUB_APP_CLIENT_SECRET: "" } }]) {
    const f = fixture({ configured });
    assert.equal(f.credential.configured, false);
    assert.equal(await f.credential.isAvailable(), false);
    await assert.rejects(f.credential.getToken(), { message: "github_app_not_connected" });
    assert.deepEqual(f.reads, []); assert.deepEqual(f.minted, []);
  }
});

test("a row for another owner, repository or App fails before installation access", async () => {
  for (const changes of [
    { owner: "another-owner" }, { repository: "another-demo" }, { appId: "1" },
    { installationId: "invalid" }, { userId: "invalid" },
  ]) {
    const f = fixture({ connection: row(changes) });
    await assert.rejects(f.credential.isAvailable(), { message: "github_connection_unverified" });
    await assert.rejects(f.credential.getToken(), { message: "github_connection_unverified" });
    assert.deepEqual(f.inspected, []); assert.deepEqual(f.minted, []);
  }
});

test("stored account ID must match the personal installation account before minting", async () => {
  const f = fixture({ connection: row({ userId: "9007199254740993999" }) });
  await assert.rejects(f.credential.getToken(), { message: "github_personal_installation_required" });
  assert.deepEqual(f.inspected, [installationId]);
  assert.deepEqual(f.minted, []);
});

test("organization, suspended, foreign App/owner and insufficient installation permissions cannot mint", async () => {
  for (const changes of [
    { account: { id: userId, login: "Fixture-Owner", type: "Organization" } },
    { account: { id: userId, login: "Fixture-Owner", type: "Bot" } },
    { suspended: true }, { id: "1" }, { appId: "1" },
    { account: { id: userId, login: "another-owner", type: "User" } },
    { permissions: { contents: "read", pull_requests: "write" } },
    { permissions: { contents: "write", pull_requests: "read" } },
    { permissions: {} },
  ]) {
    const f = fixture({ installed: installation(changes) });
    await assert.rejects(f.credential.getToken(), { message: "github_personal_installation_required" });
    assert.equal(f.inspected.length, 1); assert.deepEqual(f.minted, []);
  }
});

test("verified personal installation mints only the server-configured repository token", async () => {
  const f = fixture();
  assert.equal(await f.credential.isAvailable(), true);
  assert.equal(await f.credential.getToken(), appToken);
  assert.deepEqual(f.inspected, [installationId]);
  assert.deepEqual(f.minted, [{ installationId, repository: "Fixture-Owner/Demo.Site" }]);
  assert.ok(Object.isFrozen(f.credential));
  assert.ok(!JSON.stringify(f.credential).includes(appToken));
  assert.ok(!JSON.stringify(f.credential).includes(oldPat));
});

test("a fresh connection read after disconnect prevents reusing an earlier installation token", async () => {
  const f = fixture();
  assert.equal(await f.credential.getToken(), appToken);
  f.disconnect();
  assert.equal(await f.credential.isAvailable(), false);
  await assert.rejects(f.credential.getToken(), { message: "github_app_not_connected" });
  assert.equal(f.reads.length, 3);
  assert.deepEqual(f.inspected, [installationId]);
  assert.equal(f.minted.length, 1);
});

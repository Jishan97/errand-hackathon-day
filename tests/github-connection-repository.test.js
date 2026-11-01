import assert from "node:assert/strict";
import test from "node:test";
import { createGithubConnectionRepository, GithubConnectionRepositoryError } from "../src/storage/github-connection-repository.js";

const key = { owner: "Fixture-Owner", repository: "Demo.Site", appId: "9007199254740993001" };
const savedInput = { ...key, userId: "9007199254740993002", installationId: "9007199254740993003" };
const record = (changes = {}) => ({ owner: "fixture-owner", repository: "demo.site", appId: key.appId,
  userId: savedInput.userId, installationId: savedInput.installationId, connectedAt: "2026-10-31T22:49:11.000Z", ...changes });
const privateText = "fixture-private-credential-never-forward";
const errorCode = (expected) => (error) => {
  assert.ok(error instanceof GithubConnectionRepositoryError);
  assert.equal(error.code, expected); assert.equal(error.message, expected);
  assert.ok(!String(error.stack).includes(privateText));
  return true;
};

test("connection adapter uses fixed RPCs, canonical keys and decimal strings without forwarding credentials", async () => {
  const calls = [];
  const repository = createGithubConnectionRepository({ rpc: async (name, args) => {
    calls.push({ name, args });
    return name.endsWith("disconnect") ? { status: "disconnected", token: privateText } : { ...record(), token: privateText, login: privateText };
  } });
  const withIgnoredFields = Object.defineProperty({ ...savedInput, accountType: "Organization", token: privateText }, "privateKey", { get() { assert.fail("Unregistered credential fields must not be read"); } });
  assert.deepEqual(await repository.get(key), record());
  assert.deepEqual(await repository.save(withIgnoredFields), record());
  assert.deepEqual(await repository.disconnect({ ...key, userId: savedInput.userId }), { status: "disconnected" });
  const common = { p_owner: "fixture-owner", p_repository: "demo.site", p_app_id: key.appId };
  assert.deepEqual(calls, [
    { name: "errand_github_connection_get", args: common },
    { name: "errand_github_connection_save", args: { ...common, p_user_id: savedInput.userId, p_installation_id: savedInput.installationId, p_account_type: "User" } },
    { name: "errand_github_connection_disconnect", args: { ...common, p_user_id: savedInput.userId } },
  ]);
  assert.ok(!JSON.stringify(calls).includes(privateText));
  assert.ok(Object.isFrozen(repository));
});

test("empty and disconnected connection reads are null while disconnect remains idempotent", async () => {
  let active = null;
  const repository = createGithubConnectionRepository({ rpc: async (name) => {
    if (name.endsWith("save")) return active = record();
    if (name.endsWith("disconnect")) { active = null; return { status: "disconnected" }; }
    return active;
  } });
  assert.equal(await repository.get(key), null);
  assert.deepEqual(await repository.save(savedInput), record());
  assert.deepEqual(await repository.get(key), record());
  assert.deepEqual(await repository.disconnect({ ...key, userId: savedInput.userId }), { status: "disconnected" });
  assert.deepEqual(await repository.disconnect({ ...key, userId: savedInput.userId }), { status: "disconnected" });
  assert.equal(await repository.get(key), null);
});

test("owner, repository and IDs reject malformed values locally without number coercion or RPC", async () => {
  const repository = createGithubConnectionRepository({ rpc: () => assert.fail("Invalid binding must not reach RPC") });
  for (const [field, values] of [
    ["owner", ["", "-name", "name-", "a--b", "a/b", "with space", "a".repeat(40), null, 12]],
    ["repository", ["", ".", "..", "a/b", "with space", "a".repeat(101), null, 12]],
    ["appId", ["", "0", "01", "-1", "1e3", "1.5", " 1", "1\n", "1".repeat(21), null, 42, 1n]],
  ]) for (const value of values) await assert.rejects(repository.get({ ...key, [field]: value }), errorCode("invalid_github_connection_binding"));
  for (const field of ["userId", "installationId"]) for (const value of [undefined, null, "", "0", "01", "2e3", 42]) {
    await assert.rejects(repository.save({ ...savedInput, [field]: value }), errorCode("invalid_github_connection_binding"));
  }
  for (const value of [undefined, null, "", "0", 42]) await assert.rejects(repository.disconnect({ ...key, userId: value }), errorCode("invalid_github_connection_binding"));
});

test("required-field accessors and malformed input records fail with fixed safe errors", async () => {
  const repository = createGithubConnectionRepository({ rpc: () => assert.fail("Invalid binding must not reach RPC") });
  for (const method of ["get", "save", "disconnect"]) for (const value of [undefined, null, [], {}, Object.defineProperty({ ...savedInput }, "owner", { get() { throw Error(privateText); } })]) {
    await assert.rejects(repository[method](value), errorCode("invalid_github_connection_binding"));
  }
});

test("responses must retain the exact repository, app and saving account/installation bindings", async () => {
  for (const changes of [
    { owner: "another-owner" }, { repository: "another-site" }, { appId: "1" }, { userId: "1" }, { installationId: "1" },
    { appId: 123 }, { userId: "01" }, { connectedAt: "not-a-time" }, { connectedAt: "2026-02-30T00:00:00.000Z" },
  ]) {
    const repository = createGithubConnectionRepository({ rpc: async () => record(changes) });
    await assert.rejects(repository.save(savedInput), errorCode("invalid_github_connection_response"));
  }
  for (const result of [undefined, [], {}, { data: record() }, { error: privateText }, null]) {
    const repository = createGithubConnectionRepository({ rpc: async () => result });
    await assert.rejects(repository.save(savedInput), errorCode("invalid_github_connection_response"));
  }
  const boundGet = createGithubConnectionRepository({ rpc: async () => record({ repository: "another-site" }) });
  await assert.rejects(boundGet.get(key), errorCode("invalid_github_connection_response"));
});

test("normalized connection results are immutable projections and malformed result getters remain redacted", async () => {
  const repository = createGithubConnectionRepository({ rpc: async () => ({ ...record(), accessToken: privateText, privateKey: privateText }) });
  const returned = await repository.get(key);
  assert.ok(Object.isFrozen(returned));
  assert.deepEqual(returned, record());
  assert.ok(!JSON.stringify(returned).includes(privateText));
  const malformed = createGithubConnectionRepository({ rpc: async () => Object.defineProperty(record(), "userId", { get() { throw Error(privateText); } }) });
  await assert.rejects(malformed.get(key), errorCode("invalid_github_connection_response"));
});

test("unknown or lost RPC outcomes are redacted and never automatically retried", async () => {
  let calls = 0;
  const repository = createGithubConnectionRepository({ rpc: async () => { calls++; throw Object.assign(Error(privateText), { body: privateText }); } });
  for (const method of ["get", "save", "disconnect"]) {
    await assert.rejects(repository[method](savedInput), errorCode("github_connection_request_failed"));
  }
  assert.equal(calls, 3);
  for (const result of [null, {}, { status: "connected" }, { status: true }]) {
    const invalid = createGithubConnectionRepository({ rpc: async () => result });
    await assert.rejects(invalid.disconnect(savedInput), errorCode("invalid_github_connection_response"));
  }
});

test("construction requires only an explicit RPC and never requests configuration or storage", () => {
  for (const options of [undefined, null, [], {}, { rpc: null }, Object.defineProperty({}, "rpc", { get() { throw Error(privateText); } })]) {
    assert.throws(() => createGithubConnectionRepository(options), errorCode("invalid_github_connection_repository"));
  }
  assert.doesNotThrow(() => createGithubConnectionRepository({ rpc: () => assert.fail("No storage at construction") }));
});

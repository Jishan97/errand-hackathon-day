// Reused from the pre-event Errand MVP; scoped to the hackathon incident demo.
const ownerPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const repositoryPattern = /^[a-z0-9_.-]{1,100}$/;
const decimalPattern = /^[1-9][0-9]{0,19}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class GithubConnectionRepositoryError extends Error {
  constructor(code) { super(code); this.name = "GithubConnectionRepositoryError"; this.code = code; }
}

function field(record, key) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function decimal(value) {
  if (typeof value !== "string" || !decimalPattern.test(value)) throw new Error();
  return value;
}

function key(input) {
  const owner = field(input, "owner"), repository = field(input, "repository");
  if (typeof owner !== "string" || typeof repository !== "string") throw new Error();
  const normalizedOwner = owner.toLowerCase(), normalizedRepository = repository.toLowerCase();
  if (!ownerPattern.test(normalizedOwner) || normalizedOwner.includes("--") ||
    !repositoryPattern.test(normalizedRepository) || [".", ".."].includes(normalizedRepository)) throw new Error();
  return { p_owner: normalizedOwner, p_repository: normalizedRepository, p_app_id: decimal(field(input, "appId")) };
}

function connection(value, expected) {
  if (value === null) return null;
  const owner = field(value, "owner"), repository = field(value, "repository"), appId = decimal(field(value, "appId"));
  const userId = decimal(field(value, "userId")), installationId = decimal(field(value, "installationId"));
  const connectedAt = field(value, "connectedAt");
  if (owner !== expected.p_owner || repository !== expected.p_repository || appId !== expected.p_app_id ||
    (expected.p_user_id !== undefined && userId !== expected.p_user_id) ||
    (expected.p_installation_id !== undefined && installationId !== expected.p_installation_id) ||
    typeof connectedAt !== "string" || !timestampPattern.test(connectedAt) ||
    !Number.isFinite(Date.parse(connectedAt)) || new Date(connectedAt).toISOString() !== connectedAt) throw new Error();
  return Object.freeze({ owner, repository, appId, userId, installationId, connectedAt });
}

// The trusted caller first verifies GitHub's personal User account and fixed
// repository ownership. This adapter stores IDs only, never credentials, and
// hard-codes User so caller input cannot broaden the supported account type.
export function createGithubConnectionRepository(options) {
  let rpc;
  try { rpc = field(options, "rpc"); if (typeof rpc !== "function") throw new Error(); }
  catch { throw new GithubConnectionRepositoryError("invalid_github_connection_repository"); }

  async function request(name, input, parameters, response) {
    let args;
    try { args = parameters(input); }
    catch { throw new GithubConnectionRepositoryError("invalid_github_connection_binding"); }
    let result;
    try { result = await rpc(name, args); }
    catch { throw new GithubConnectionRepositoryError("github_connection_request_failed"); }
    try { return response(result, args); }
    catch { throw new GithubConnectionRepositoryError("invalid_github_connection_response"); }
  }

  return Object.freeze({
    get: (input) => request("errand_github_connection_get", input, key, connection),
    save: (input) => request("errand_github_connection_save", input, (value) => ({ ...key(value),
      p_user_id: decimal(field(value, "userId")), p_installation_id: decimal(field(value, "installationId")), p_account_type: "User",
    }), (result, expected) => { const saved = connection(result, expected); if (!saved) throw new Error(); return saved; }),
    disconnect: (input) => request("errand_github_connection_disconnect", input,
      (value) => ({ ...key(value), p_user_id: decimal(field(value, "userId")) }),
      (result) => { if (field(result, "status") !== "disconnected") throw new Error(); return Object.freeze({ status: "disconnected" }); }),
  });
}

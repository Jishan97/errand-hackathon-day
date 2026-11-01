// Reused bounded transport for the existing GitHub App connection only.
const rpcNames = new Set(["errand_github_connection_get"]);
export class StorageError extends Error {
  constructor(code) {
    super(code);
    this.name = "StorageError";
    this.code = code;
  }
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new StorageError("storage_response_too_large");
      chunks.push(value);
    }
    if (!length) return null;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createServerRpcClient({ supabaseUrl, secretKey, fetcher = globalThis.fetch, timeoutMs = 10_000 }) {
  let origin;
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
      || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch {
    throw new StorageError("canonical_supabase_url_required");
  }
  // New secret keys go only in apikey; they are not JWT Bearer tokens.
  if (typeof secretKey !== "string" || !/^sb_secret_[A-Za-z0-9_-]{20,200}$/.test(secretKey)) {
    throw new StorageError("server_secret_key_required");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new StorageError("invalid_storage_timeout");
  }

  async function rpc(name, parameters) {
    if (!rpcNames.has(name)) throw new StorageError("unknown_storage_operation");
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(`${origin}/rest/v1/rpc/${name}`, {
            method: "POST", redirect: "error", signal: controller.signal,
            headers: { apikey: secretKey, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(parameters),
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new StorageError("storage_request_rejected");
          }
          return await readJson(response);
        })(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new StorageError("storage_request_timed_out"));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // Provider errors may include request bodies, personal data or credentials.
      throw new StorageError("storage_request_failed");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return rpc;
}

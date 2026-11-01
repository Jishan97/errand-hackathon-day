import OpenAI from "openai";

const apiOrigin = "https://api.openai.com";
const maxResponseBytes = 256 * 1024;
class ClientFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Explicit credentials and origin prevent SDK environment defaults from changing
// this client's destination, project headers, logging or retry behavior.
export function createIncidentApiClient({ apiKey, requestTimeoutMs, fetcher = globalThis.fetch }) {
  return new OpenAI({
    apiKey,
    baseURL: `${apiOrigin}/v1`,
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    maxRetries: 0,
    timeout: requestTimeoutMs,
    logLevel: "off",
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== apiOrigin || !url.pathname.startsWith("/v1/agents/sessions")) {
        throw new ClientFailure("unexpected_provider_url");
      }
      // Send only this client's headers. The SDK can inherit custom headers from
      // the user's shell; they must not override the explicit credentials.
      const headers = new Headers({
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "OpenAI-Beta": "agents=v1",
      });
      const idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
      if (idempotencyKey && /^[a-f0-9-]{36}$/.test(idempotencyKey)) headers.set("Idempotency-Key", idempotencyKey);
      const response = await fetcher(input, { ...init, headers, redirect: "error" });
      if (Number(response.headers.get("content-length")) > maxResponseBytes) {
        await response.body?.cancel();
        throw new ClientFailure("provider_response_too_large");
      }
      const chunks = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxResponseBytes) {
              await reader.cancel();
              throw new ClientFailure("provider_response_too_large");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      return new Response(size ? Buffer.concat(chunks, size) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    },
  });
}

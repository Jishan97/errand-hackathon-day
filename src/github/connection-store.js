// Reused from the pre-event Errand MVP; scoped to the hackathon incident demo.
import { createServerRpcClient } from "../storage/github-rpc.js";
import { createGithubConnectionRepository } from "../storage/github-connection-repository.js";

export function createGithubConnectionStore(config) {
  if (!config.githubAppEnabled || !config.values.SUPABASE_URL || !config.values.SUPABASE_SECRET_KEY) return null;
  return createGithubConnectionRepository({ rpc: createServerRpcClient({
    supabaseUrl: config.values.SUPABASE_URL, secretKey: config.values.SUPABASE_SECRET_KEY, timeoutMs: 3000,
  }) });
}

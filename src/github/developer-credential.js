// Reused from the pre-event Errand MVP; scoped to the hackathon incident demo.
import { createGitHubAppClient, githubAppIsConfigured } from "./app-client.js";
import { createGithubConnectionStore } from "./connection-store.js";

export function createGithubDeveloperCredential({ config, repository = null, client = null }) {
  const store = repository ?? createGithubConnectionStore(config);
  const configured = githubAppIsConfigured(config) && Boolean(store);
  const github = configured ? client ?? createGitHubAppClient({ config }) : null;
  const [owner, name] = (config.values.GITHUB_DEMO_REPO ?? "").toLowerCase().split("/");
  const binding = { owner, repository: name, appId: config.values.GITHUB_APP_ID };
  async function connection() {
    if (!configured) return null;
    const row = await store.get(binding);
    if (row && (row.owner !== owner || row.repository !== name || row.appId !== binding.appId || !/^[1-9]\d{0,19}$/.test(row.installationId) || !/^[1-9]\d{0,19}$/.test(row.userId))) throw Error("github_connection_unverified");
    return row;
  }
  return Object.freeze({
    configured,
    async isAvailable() { return Boolean(await connection()); },
    async getToken() {
      const row = await connection();
      if (!row) throw Error("github_app_not_connected");
      const installation = await github.getInstallation(row.installationId);
      if (installation.id !== row.installationId || installation.appId !== binding.appId || installation.suspended ||
        installation.account?.type !== "User" || installation.account.login?.toLowerCase() !== owner || installation.account.id !== row.userId ||
        installation.permissions?.contents !== "write" || installation.permissions?.pull_requests !== "write") throw Error("github_personal_installation_required");
      const result = await github.createInstallationToken({ installationId: row.installationId, repository: config.values.GITHUB_DEMO_REPO });
      return result.token;
    },
  });
}

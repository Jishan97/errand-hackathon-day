import { createGitHubAppClient } from './app-client.js';

// The operator-controlled incident demo uses the existing App installation
// directly. General developer connections keep their separate OAuth binding.
export function createIncidentInstallationCredential({ config, client = null }) {
  const repository = config.values.GITHUB_DEMO_REPO;
  if (config.incidentDemoEnabled !== true || config.githubAppEnabled !== true ||
      repository?.toLowerCase() !== 'jishan97/errand-agent-demo') throw Error('incident_repository_required');
  const github = client ?? createGitHubAppClient({ config });
  const owner = repository.split('/')[0].toLowerCase();
  return Object.freeze({
    async getToken() {
      // Query by the fixed repository, never by a caller-provided installation ID.
      const installation = await github.getRepositoryInstallation(repository);
      if (installation.appId !== BigInt(config.values.GITHUB_APP_ID).toString() || installation.suspended ||
          installation.account?.type !== 'User' || installation.account.login?.toLowerCase() !== owner) {
        throw Error('github_personal_installation_required');
      }
      const p = installation.permissions;
      if (p?.contents !== 'write' || p.pull_requests !== 'write' ||
          !['read', 'write'].includes(p.checks) || !['read', 'write'].includes(p.actions)) {
        throw Error('github_app_permissions_required');
      }
      // The shared client revalidates the installation and mints a short-lived
      // token restricted to this repo and the four required permissions.
      return (await github.createInstallationToken({ installationId: installation.id, repository })).token;
    },
  });
}

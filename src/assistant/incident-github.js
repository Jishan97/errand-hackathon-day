// Reused from the pre-event Errand MVP; scoped to the hackathon incident demo.
import { createGithubDeveloperCredential } from "../github/developer-credential.js";
import { createHash } from "node:crypto";

export const incidentSourcePaths = Object.freeze(["api/upload.js", "lib/upload-parser.js", "tests/upload-parser.test.js", "package.json"]);
export const uploadWorkflow = `name: upload-regression
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  upload-regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: '24'
      - run: node --test tests/upload-parser.test.js
`;
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash = (s) => createHash("sha256").update(s).digest("hex");

export function createIncidentGithub({ config, credential = null, fetcher = fetch }) {
  const repo = config.values.GITHUB_DEMO_REPO;
  const access = config.githubAppEnabled ? credential ?? createGithubDeveloperCredential({ config }) : null;
  function demoOrigin() {
    try {
      const url = new URL(config.values.GITHUB_DEMO_URL);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(url.hostname)) throw Error();
      return url.origin;
    } catch { throw Error("incident_demo_url_invalid"); }
  }
  async function api(path, method = "GET", body = null, accept = "application/vnd.github+json") {
    if (repo?.toLowerCase() !== "jishan97/errand-agent-demo" || !config.incidentDemoEnabled) throw Error("incident_repository_required");
    const token = access ? await access.getToken() : config.values.GITHUB_DEMO_TOKEN;
    if (!token) throw Error("incident_github_unavailable");
    const response = await fetcher(`https://api.github.com/repos/${repo}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "User-Agent": "errand-incident-demo", "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw Error("incident_github_request_unconfirmed"); }
    const raw = await response.text();
    if (raw.length > 256000) throw Error("incident_github_response_too_large");
    return JSON.parse(raw);
  }
  async function main() {
    const ref = await api("/git/ref/heads/main");
    if (!sha(ref?.object?.sha)) throw Error("incident_head_unconfirmed");
    return ref.object.sha;
  }
  async function content(path, ref) {
    const file = await api(`/contents/${path}?ref=${ref}`);
    if (file.encoding !== "base64" || typeof file.content !== "string" || file.content.length > 48000) throw Error("incident_source_unconfirmed");
    const value = Buffer.from(file.content, "base64").toString("utf8");
    if (value.length > 24000 || value.includes("\u0000")) throw Error("incident_source_unconfirmed");
    return value;
  }
  async function verifyBase(baseSha) {
    if (!sha(baseSha) || await main() !== baseSha) throw Error("incident_base_changed");
    if (await content(".github/workflows/upload-regression.yml", baseSha) !== uploadWorkflow) throw Error("incident_ci_definition_changed");
  }
  return Object.freeze({
    currentHead: () => main(),
    async snapshot(baseSha) {
      await verifyBase(baseSha);
      const files = await Promise.all(incidentSourcePaths.map(async (path) => ({ path, content: await content(path, baseSha) })));
      return { baseSha, files };
    },
    async createPullRequest({ taskId, baseSha, files, prepared = false }) {
      await verifyBase(baseSha);
      if (!/^[a-f0-9-]{36}$/.test(taskId) || !Array.isArray(files) || files.length !== 2 ||
        new Set(files.map((f) => f.path)).size !== 2 || files.some((f) => !["lib/upload-parser.js", "tests/upload-parser.test.js"].includes(f.path) || typeof f.content !== "string" || f.content.length > 24000 || f.content.includes("\u0000"))) throw Error("incident_patch_rejected");
      const commit = await api(`/git/commits/${baseSha}`);
      if (!sha(commit?.tree?.sha)) throw Error("incident_tree_unconfirmed");
      const tree = await api("/git/trees", "POST", { base_tree: commit.tree.sha, tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })) });
      if (!sha(tree?.sha)) throw Error("incident_tree_unconfirmed");
      const fix = await api("/git/commits", "POST", { message: "Fix sample upload line endings with regression tests", tree: tree.sha, parents: [baseSha] });
      if (!sha(fix?.sha)) throw Error("incident_commit_unconfirmed");
      const branch = `codex/incident-${taskId}`;
      await api("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: fix.sha });
      const pr = await api("/pulls", "POST", { title: "Fix sample upload failure", head: branch, base: "main", draft: prepared,
        body: prepared ? "A real Sentry alert triggered this draft PR. Codex prepared and tested this minimal fix during the hackathon for the known fictional LF/CRLF upload bug. The regression suite fails before the parser change and passes after. This prepared patch is only applied when all four reviewed source hashes match. It was not generated by a hosted coding run on this alert. Human review is required; no merge or deployment is authorized by this path." : "A hosted Sol coding workspace reproduced the fictional CSV upload failure and generated this parser fix and regression tests. One-run operator approval authorized this scoped fix and merge only after the fixed upload-regression check passes. Deployment and original upload replay are verified separately." });
      if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || pr.head?.sha !== fix.sha || pr.base?.sha !== baseSha || pr.state !== "open" || pr.html_url !== `https://github.com/${repo}/pull/${pr.number}`) throw Error("incident_pr_unconfirmed");
      return { number: pr.number, headSha: fix.sha, baseSha, branch, pullRequest: pr.html_url,
        patchHashes: Object.fromEntries(files.map((f) => [f.path, hash(f.content)])) };
    },
    async checks(pr) {
      if (!Number.isSafeInteger(pr?.number) || !sha(pr.headSha) || !sha(pr.baseSha)) throw Error("incident_pr_required");
      await verifyBase(pr.baseSha);
      const current = await api(`/pulls/${pr.number}`);
      if (current.state !== "open" || current.draft || current.merged || current.head?.sha !== pr.headSha || current.head?.ref !== pr.branch || current.base?.sha !== pr.baseSha || current.base?.ref !== "main" || current.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || current.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) throw Error("incident_pr_changed");
      const changed = await api(`/pulls/${pr.number}/files?per_page=10`);
      if (!Array.isArray(changed) || changed.length !== 2 || new Set(changed.map((f) => f.filename)).size !== 2 || changed.some((f) => !["lib/upload-parser.js", "tests/upload-parser.test.js"].includes(f.filename) || !["modified", "added"].includes(f.status))) throw Error("incident_patch_changed");
      const hashesMatch = await Promise.all(changed.map(async (file) => hash(await content(file.filename, pr.headSha)) === pr.patchHashes?.[file.filename]));
      if (hashesMatch.some((matches) => !matches)) throw Error("incident_patch_changed");
      const checks = await api(`/commits/${pr.headSha}/check-runs?per_page=100`);
      const runs = checks?.check_runs?.filter((r) => r.name === "upload-regression" && r.app?.slug === "github-actions" && r.head_sha === pr.headSha);
      if (!Array.isArray(runs) || runs.length === 0) return { status: "pending" };
      if (runs.some((r) => r.status !== "completed")) return { status: "pending" };
      if (runs.some((r) => r.conclusion !== "success")) throw Error("incident_ci_failed");
      for (const check of runs) {
        const prefix = `https://github.com/${repo}/actions/runs/`;
        const runId = typeof check.details_url === "string" && check.details_url.startsWith(prefix) ? check.details_url.slice(prefix.length).match(/^([1-9]\d*)(?:\/job\/[1-9]\d*)?$/)?.[1] : null;
        if (!runId) throw Error("incident_ci_identity_unconfirmed");
        const run = await api(`/actions/runs/${runId}`);
        if (run.path !== ".github/workflows/upload-regression.yml" || run.event !== "pull_request" || run.head_sha !== pr.headSha ||
          run.head_branch !== pr.branch || run.repository?.full_name?.toLowerCase() !== repo.toLowerCase() || run.status !== "completed" || run.conclusion !== "success") throw Error("incident_ci_identity_unconfirmed");
      }
      return { status: "passed" };
    },
    async merge(pr) {
      if ((await this.checks(pr)).status !== "passed") throw Error("incident_ci_pending");
      const head = await api(`/git/commits/${pr.headSha}`);
      if (head.sha !== pr.headSha || !sha(head.tree?.sha) || !Array.isArray(head.parents) ||
          head.parents.length !== 1 || head.parents[0]?.sha !== pr.baseSha) throw Error("incident_head_changed");
      // Build a fixed merge of the exact checked tree, not whatever main happens
      // to contain when GitHub processes a PR merge request. A concurrent main
      // commit is not an ancestor of this commit, so force:false rejects it.
      const merged = await api('/git/commits', 'POST', {
        message: `Merge approved upload fix #${pr.number}`,
        tree: head.tree.sha, parents: [pr.baseSha, pr.headSha],
      });
      if (!sha(merged.sha) || merged.tree?.sha !== head.tree.sha || !Array.isArray(merged.parents) ||
          merged.parents.length !== 2 || merged.parents[0]?.sha !== pr.baseSha || merged.parents[1]?.sha !== pr.headSha) {
        throw Error("incident_merge_unconfirmed");
      }
      const updated = await api('/git/refs/heads/main', 'PATCH', { sha: merged.sha, force: false });
      if (updated.ref !== 'refs/heads/main' || updated.object?.type !== 'commit' || updated.object?.sha !== merged.sha) {
        throw Error("incident_merge_unconfirmed");
      }
      return { mergeSha: merged.sha };
    },
    async confirmMerged(pr, mergeSha) {
      if (!Number.isSafeInteger(pr?.number) || !sha(pr.headSha) || !sha(pr.baseSha) || !sha(mergeSha)) throw Error("incident_pr_required");
      const current = await api(`/pulls/${pr.number}`);
      if (current.number !== pr.number || current.draft || current.head?.sha !== pr.headSha ||
          current.head?.ref !== pr.branch || current.base?.ref !== 'main' ||
          current.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() ||
          current.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) throw Error("incident_pr_changed");
      if (current.state === 'open' && current.merged === false) return { status: 'pending' };
      if (current.state !== 'closed' || current.merged !== true || current.merge_commit_sha !== mergeSha) throw Error("incident_merge_unconfirmed");
      return { status: 'passed' };
    },
    async replay(mergeSha) {
      if (!config.incidentDemoEnabled || repo?.toLowerCase() !== "jishan97/errand-agent-demo" || !sha(mergeSha)) throw Error("incident_merge_required");
      const origin = demoOrigin();
      // Avoid re-triggering the planted failure while an older build is live.
      // This endpoint reports its commit even when its unrelated checkout gate
      // returns 503. Only the release identity is used here, never health alone.
      const health = await fetcher(`${origin}/api/health`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "Cache-Control": "no-cache" } });
      if (![200, 503].includes(health.status)) { await health.body?.cancel().catch(() => {}); return { status: "pending" }; }
      const healthRaw = await health.text();
      if (healthRaw.length > 4000) throw Error("incident_replay_invalid");
      let deployed;
      try { deployed = JSON.parse(healthRaw); } catch { throw Error("incident_replay_invalid"); }
      if (deployed?.commit !== mergeSha) return { status: "pending" };
      const response = await fetcher(`${origin}/api/upload`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" }, body: JSON.stringify({ sample: "plants" }) });
      const raw = await response.text();
      if (raw.length > 4000) throw Error("incident_replay_invalid");
      const result = JSON.parse(raw);
      if (result.commit !== mergeSha) return { status: "pending" };
      if (response.status !== 200 || result.rows !== 2 || result.totalQuantity !== 3 || result.sample !== "plants") throw Error("incident_replay_failed");
      return { status: "passed", deployedCommit: mergeSha, uploadReplay: "passed" };
    },
  });
}

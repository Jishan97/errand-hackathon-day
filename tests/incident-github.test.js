import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createIncidentGithub, incidentSourcePaths, uploadWorkflow } from "../src/assistant/incident-github.js";

const repository = "Jishan97/errand-agent-demo";
const baseSha = "a".repeat(40), treeSha = "b".repeat(40), headSha = "c".repeat(40), mergeSha = "d".repeat(40);
const taskId = "11111111-1111-4111-8111-111111111111";
const branch = `codex/incident-${taskId}`;
const token = "fixture-installation-token-never-display";
const origin = "https://fixture-incident.vercel.app";
const config = { incidentDemoEnabled: true, githubAppEnabled: false, values: {
  GITHUB_DEMO_REPO: repository, GITHUB_DEMO_TOKEN: token, GITHUB_DEMO_URL: origin,
} };
const files = [
  { path: "lib/upload-parser.js", content: "export const parse = (text) => text.split(/\\r?\\n/);\n" },
  { path: "tests/upload-parser.test.js", content: "import test from 'node:test';\ntest('fictional fixture', () => {});\n" },
];
const hash = (text) => createHash("sha256").update(text).digest("hex");
const descriptor = () => ({ number: 7, baseSha, headSha, branch,
  pullRequest: `https://github.com/${repository}/pull/7`, patchHashes: Object.fromEntries(files.map((f) => [f.path, hash(f.content)])),
});
const pull = () => ({ number: 7, state: "open", draft: false, merged: false,
  head: { sha: headSha, ref: branch, repo: { full_name: repository } },
  base: { sha: baseSha, ref: "main", repo: { full_name: repository } }, html_url: `https://github.com/${repository}/pull/7`,
});
const check = () => ({ id: 91, name: "upload-regression", status: "completed", conclusion: "success", head_sha: headSha,
  app: { slug: "github-actions" }, details_url: `https://github.com/${repository}/actions/runs/42/job/91`,
});
const run = () => ({ id: 42, path: ".github/workflows/upload-regression.yml", name: "upload-regression", event: "pull_request",
  head_sha: headSha, head_branch: branch, status: "completed", conclusion: "success", repository: { full_name: repository },
});

function fixture({ settings = {}, overrides = {}, app = false, credential } = {}) {
  const requests = [];
  let isMerged = false;
  const activeConfig = { ...config, ...settings, githubAppEnabled: app,
    values: { ...config.values, ...settings.values },
  };
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const defaults = {
    "GET /git/ref/heads/main": () => ({ object: { sha: isMerged ? mergeSha : baseSha } }),
    [`GET /contents/.github/workflows/upload-regression.yml?ref=${baseSha}`]: () => ({ encoding: "base64", content: Buffer.from(uploadWorkflow).toString("base64") }),
    [`GET /git/commits/${baseSha}`]: () => ({ tree: { sha: treeSha } }),
    "POST /git/trees": () => ({ sha: treeSha }),
    [`GET /git/commits/${headSha}`]: () => ({ sha: headSha, tree: { sha: treeSha }, parents: [{ sha: baseSha }] }),
    "POST /git/commits": (init) => {
      const body = JSON.parse(init.body);
      return body.parents.length === 2
        ? { sha: mergeSha, tree: { sha: body.tree }, parents: body.parents.map((sha) => ({ sha })) }
        : { sha: headSha };
    },
    "POST /git/refs": () => ({ ref: `refs/heads/${branch}`, object: { sha: headSha } }),
    "POST /pulls": pull,
    "GET /pulls/7": () => isMerged ? { ...pull(), state: 'closed', merged: true, merge_commit_sha: mergeSha } : pull(),
    "GET /pulls/7/files?per_page=10": () => files.map((f) => ({ filename: f.path, status: "modified" })),
    [`GET /commits/${headSha}/check-runs?per_page=100`]: () => ({ total_count: 1, check_runs: [check()] }),
    "GET /actions/runs/42": run,
    "PATCH /git/refs/heads/main": () => { isMerged = true; return { ref: 'refs/heads/main', object: { type: 'commit', sha: mergeSha } }; },
  };
  for (const path of incidentSourcePaths) {
    defaults[`GET /contents/${path}?ref=${baseSha}`] = () => ({ encoding: "base64", content: Buffer.from(`fixture source ${path}\n`).toString("base64") });
  }
  for (const file of files) defaults[`GET /contents/${file.path}?ref=${headSha}`] = () => ({ encoding: "base64", content: Buffer.from(file.content).toString("base64") });
  const api = createIncidentGithub({ config: activeConfig, credential, fetcher: async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url, init });
    if (url === `${origin}/api/health`) {
      const value = overrides.health ?? (() => ({ commit: mergeSha, checkout: "disabled" }));
      return typeof value === "function" ? response(await value(init), 503) : value;
    }
    if (url === `${origin}/api/upload`) {
      const value = overrides.replay ?? (() => ({ commit: mergeSha, rows: 2, totalQuantity: 3, sample: "plants" }));
      return typeof value === "function" ? response(await value(init)) : value;
    }
    assert.equal(parsed.origin, "https://api.github.com", "Fixture must never contact another origin");
    assert.ok(parsed.pathname.startsWith(`/repos/${repository}/`));
    const path = parsed.pathname.slice(`/repos/${repository}`.length) + parsed.search;
    const key = `${init.method} ${path}`;
    const handler = overrides[key] ?? defaults[key];
    assert.equal(typeof handler, "function", `Unexpected fixture API call: ${key}`);
    const value = await handler(init);
    return value instanceof Response ? value : response(value);
  } });
  return { api, requests, writes: () => requests.filter(({ init }) => init.method !== "GET") };
}

test("incident snapshot reads only the fixed source allowlist at an exact main commit with pinned CI", async () => {
  const f = fixture();
  const result = await f.api.snapshot(baseSha);
  assert.equal(result.baseSha, baseSha);
  assert.deepEqual(result.files.map((file) => file.path), [...incidentSourcePaths]);
  assert.deepEqual(f.writes(), []);
  for (const request of f.requests) {
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.headers.Authorization, `Bearer ${token}`);
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.ok(!request.url.includes(token));
  }
});

test("incident GitHub rejects another owner/repository or disabled mode before any request", async () => {
  for (const settings of [{ incidentDemoEnabled: false }, { values: { GITHUB_DEMO_REPO: "another-owner/errand-agent-demo" } }, { values: { GITHUB_DEMO_REPO: "Jishan97/another-repository" } }]) {
    const f = fixture({ settings });
    await assert.rejects(f.api.snapshot(baseSha), /incident_repository_required/);
    await assert.rejects(f.api.replay(mergeSha), /incident_repository_required|incident_merge_required/);
    assert.deepEqual(f.requests, []);
  }
});

test("changed main or modified trusted workflow prevents source use and all writes", async () => {
  for (const overrides of [
    { "GET /git/ref/heads/main": () => ({ object: { sha: mergeSha } }) },
    { [`GET /contents/.github/workflows/upload-regression.yml?ref=${baseSha}`]: () => ({ encoding: "base64", content: Buffer.from(`${uploadWorkflow}\n# changed`).toString("base64") }) },
  ]) {
    const f = fixture({ overrides });
    await assert.rejects(f.api.createPullRequest({ taskId, baseSha, files }), /incident_base_changed|incident_ci_definition_changed/);
    assert.deepEqual(f.writes(), []);
  }
});

test("scoped patch creates the exact two-file tree, branch and PR and returns immutable patch hashes", async () => {
  const f = fixture();
  const pr = await f.api.createPullRequest({ taskId, baseSha, files });
  assert.deepEqual(pr.patchHashes, descriptor().patchHashes);
  assert.equal(pr.headSha, headSha); assert.equal(pr.baseSha, baseSha); assert.equal(pr.number, 7);
  assert.equal(pr.branch, branch);
  const tree = f.requests.find(({ url }) => url.endsWith("/git/trees"));
  assert.deepEqual(JSON.parse(tree.init.body), { base_tree: treeSha, tree: files.map((file) => ({ ...file, mode: "100644", type: "blob" })) });
  const ref = f.requests.find(({ url }) => url.endsWith("/git/refs"));
  assert.deepEqual(JSON.parse(ref.init.body), { ref: `refs/heads/${branch}`, sha: headSha });
  const request = f.requests.find(({ url, init }) => url.endsWith("/pulls") && init.method === "POST");
  assert.equal(JSON.parse(request.init.body).base, "main");
  assert.equal(JSON.parse(request.init.body).head, branch);
});

test("patch scope rejects extra, duplicate, workflow, oversized and NUL files without writes", async () => {
  for (const patch of [
    [...files, { path: "api/upload.js", content: "changed" }],
    [files[0], files[0]],
    [files[0], { path: ".github/workflows/upload-regression.yml", content: "forged CI" }],
    [files[0], { ...files[1], content: "x".repeat(24001) }],
    [files[0], { ...files[1], content: "bad\u0000text" }],
  ]) {
    const f = fixture();
    await assert.rejects(f.api.createPullRequest({ taskId, baseSha, files: patch }), /incident_patch_rejected/);
    assert.deepEqual(f.writes(), []);
  }
});

test("checks prove the exact head, two hashes and trusted workflow run before merge", async () => {
  const f = fixture();
  assert.deepEqual(await f.api.checks(descriptor()), { status: "passed" });
  assert.ok(f.requests.some(({ url }) => url.endsWith("/actions/runs/42")));
  assert.deepEqual(await f.api.merge(descriptor()), { mergeSha });
  const writes = f.writes();
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[0].init.body), { message: 'Merge approved upload fix #7', tree: treeSha, parents: [baseSha, headSha] });
  assert.deepEqual(JSON.parse(writes[1].init.body), { sha: mergeSha, force: false });
  assert.deepEqual(await f.api.confirmMerged(descriptor(), mergeSha), { status: 'passed' });
});

test('a concurrent main update is never force-pushed or retried after fixed-tree merge rejection', async () => {
  let mutations = 0;
  const f = fixture({ overrides: { 'PATCH /git/refs/heads/main': (init) => {
    mutations++;
    assert.deepEqual(JSON.parse(init.body), { sha: mergeSha, force: false });
    return new Response('non-fast-forward', { status: 422 });
  } } });
  await assert.rejects(f.api.merge(descriptor()), /incident_github_request_unconfirmed/);
  assert.equal(mutations, 1);
  assert.equal(f.requests.some(({ url }) => url.endsWith('/pulls/7/merge')), false);
});

test('changed head ancestry or merge response cannot update the production branch', async () => {
  for (const overrides of [
    { [`GET /git/commits/${headSha}`]: () => ({ sha: headSha, tree: { sha: treeSha }, parents: [{ sha: mergeSha }] }) },
    { 'POST /git/commits': () => ({ sha: mergeSha, tree: { sha: baseSha }, parents: [{ sha: baseSha }, { sha: headSha }] }) },
    { 'POST /git/commits': () => ({ sha: mergeSha, tree: { sha: treeSha }, parents: [{ sha: headSha }, { sha: baseSha }] }) },
  ]) {
    const f = fixture({ overrides });
    await assert.rejects(f.api.merge(descriptor()), /incident_head_changed|incident_merge_unconfirmed/);
    assert.equal(f.requests.some(({ init }) => init.method === 'PATCH'), false);
  }
});

test('indirect PR merge confirmation waits for propagation and rejects an unbound result', async () => {
  assert.deepEqual(await fixture().api.confirmMerged(descriptor(), mergeSha), { status: 'pending' });
  for (const current of [
    { ...pull(), state: 'closed', merged: false },
    { ...pull(), state: 'closed', merged: true, merge_commit_sha: baseSha },
    { ...pull(), state: 'closed', merged: true, merge_commit_sha: mergeSha, head: { ...pull().head, sha: baseSha } },
  ]) {
    const f = fixture({ overrides: { 'GET /pulls/7': () => current } });
    await assert.rejects(f.api.confirmMerged(descriptor(), mergeSha), /incident_pr_changed|incident_merge_unconfirmed/);
    assert.deepEqual(f.writes(), []);
  }
});

test("changed PR head, base, fork, draft or branch cannot be merged", async () => {
  for (const current of [
    { ...pull(), head: { ...pull().head, sha: mergeSha } },
    { ...pull(), base: { ...pull().base, sha: mergeSha } },
    { ...pull(), base: { ...pull().base, repo: { full_name: "other/target" } } },
    { ...pull(), head: { ...pull().head, repo: { full_name: "other/fork" } } },
    { ...pull(), draft: true },
    { ...pull(), head: { ...pull().head, ref: "unapproved-branch" } },
  ]) {
    const f = fixture({ overrides: { "GET /pulls/7": () => current } });
    await assert.rejects(f.api.merge(descriptor()), /incident_pr_changed/);
    assert.deepEqual(f.writes(), []);
  }
});

test("a changed hash, duplicate file listing or unauthorized path blocks merge", async () => {
  const variants = [
    { [`GET /contents/${files[0].path}?ref=${headSha}`]: () => ({ encoding: "base64", content: Buffer.from("changed-after-approval").toString("base64") }) },
    { "GET /pulls/7/files?per_page=10": () => [files[0], files[0]].map((file) => ({ filename: file.path, status: "modified" })) },
    { "GET /pulls/7/files?per_page=10": () => [{ filename: files[0].path, status: "modified" }, { filename: "package.json", status: "modified" }] },
  ];
  for (const overrides of variants) {
    const f = fixture({ overrides });
    await assert.rejects(f.api.merge(descriptor()), /incident_patch_changed/);
    assert.deepEqual(f.writes(), []);
  }
});

test("missing, foreign-app, wrong-head and running checks stay pending and cannot merge", async () => {
  for (const runs of [[], [{ ...check(), app: { slug: "untrusted-ci" } }], [{ ...check(), head_sha: baseSha }], [{ ...check(), status: "in_progress", conclusion: null }]]) {
    const f = fixture({ overrides: { [`GET /commits/${headSha}/check-runs?per_page=100`]: () => ({ total_count: runs.length, check_runs: runs }) } });
    assert.deepEqual(await f.api.checks(descriptor()), { status: "pending" });
    await assert.rejects(f.api.merge(descriptor()), /incident_ci_pending/);
    assert.deepEqual(f.writes(), []);
  }
});

test("failed regression cannot be hidden by another successful matching check", async () => {
  const f = fixture({ overrides: { [`GET /commits/${headSha}/check-runs?per_page=100`]: () => ({ total_count: 2, check_runs: [check(), { ...check(), conclusion: "failure" }] }) } });
  await assert.rejects(f.api.merge(descriptor()), /incident_ci_failed/);
  assert.deepEqual(f.writes(), []);
});

test("a named passing job from a wrong workflow, event, head, branch or repository is not trusted", async () => {
  for (const value of [
    { ...run(), path: ".github/workflows/untrusted.yml" }, { ...run(), event: "workflow_dispatch" },
    { ...run(), head_sha: baseSha }, { ...run(), head_branch: "unapproved-branch" },
    { ...run(), repository: { full_name: "other/repository" } }, { ...run(), conclusion: "failure" },
  ]) {
    const f = fixture({ overrides: { "GET /actions/runs/42": () => value } });
    await assert.rejects(f.api.merge(descriptor()), /incident_ci/);
    assert.deepEqual(f.writes(), []);
  }
});

test("check-run links cannot redirect trusted-workflow verification to another repository or origin", async () => {
  for (const details_url of ["https://attacker.invalid/actions/runs/42/job/91", "https://github.com/other/repository/actions/runs/42/job/91", `https://github.com/${repository}/actions/runs/42/job/91?untrusted=1`]) {
    const f = fixture({ overrides: { [`GET /commits/${headSha}/check-runs?per_page=100`]: () => ({ total_count: 1, check_runs: [{ ...check(), details_url }] }) } });
    await assert.rejects(f.api.merge(descriptor()), /incident_ci/);
    assert.deepEqual(f.writes(), []);
  }
});

test("App mode obtains a fresh scoped credential for API calls and never uses PAT fallback", async () => {
  let tokens = 0;
  const f = fixture({ app: true, credential: { async getToken() { tokens += 1; return "fixture-app-token"; } } });
  await f.api.snapshot(baseSha);
  assert.equal(tokens, f.requests.length);
  assert.ok(f.requests.every(({ init }) => init.headers.Authorization === "Bearer fixture-app-token"));
  const denied = fixture({ app: true, credential: { async getToken() { throw Error("github_app_not_connected"); } } });
  await assert.rejects(denied.api.snapshot(baseSha), /github_app_not_connected/);
  assert.deepEqual(denied.requests, []);
});

test("upload replay waits for the exact merged deployment and never sends GitHub authorization", async () => {
  const f = fixture();
  assert.deepEqual(await f.api.replay(mergeSha), { status: "passed", deployedCommit: mergeSha, uploadReplay: "passed" });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url, `${origin}/api/health`);
  assert.equal(f.requests[0].init.method, "GET");
  assert.equal(f.requests[0].init.headers.Authorization, undefined);
  const { url, init } = f.requests[1];
  assert.equal(url, `${origin}/api/upload`);
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(init.redirect, "error");
  assert.deepEqual(JSON.parse(init.body), { sample: "plants" });
  const older = fixture({ overrides: { replay: () => ({ commit: baseSha, rows: 2, totalQuantity: 3, sample: "plants" }) } });
  assert.deepEqual(await older.api.replay(mergeSha), { status: "pending" });
});

test("old deployment and unconfirmed health never POST another planted upload error", async () => {
  for (const health of [() => ({ commit: baseSha }), () => ({ commit: null }), new Response("unavailable", { status: 502 })]) {
    const f = fixture({ overrides: { health } });
    assert.deepEqual(await f.api.replay(mergeSha), { status: "pending" });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].init.method, "GET");
  }
});

test("demo origin must be an explicit HTTPS Vercel root without credentials, port, path, query or fragment", async () => {
  for (const value of ["http://fixture.vercel.app", "https://example.com", "https://fixture.vercel.app.evil.test", "https://user@fixture.vercel.app", "https://fixture.vercel.app:8443", "https://fixture.vercel.app/path", "https://fixture.vercel.app?other=1", "https://fixture.vercel.app#other", "not-a-url"]) {
    const f = fixture({ settings: { values: { GITHUB_DEMO_URL: value } } });
    await assert.rejects(f.api.replay(mergeSha), /incident_demo_url_invalid/);
    assert.deepEqual(f.requests, []);
  }
});

test("currentHead returns only the validated main commit for preparation", async () => {
  const f = fixture();
  assert.equal(await f.api.currentHead(), baseSha);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.writes(), []);
});

test("exact deployment with wrong upload result or failure status cannot report recovery", async () => {
  for (const replay of [
    () => ({ commit: mergeSha, rows: 1, totalQuantity: 3, sample: "plants" }),
    () => ({ commit: mergeSha, rows: 2, totalQuantity: 30, sample: "plants" }),
    () => ({ commit: mergeSha, rows: 2, totalQuantity: 3, sample: "other" }),
    new Response(JSON.stringify({ commit: mergeSha, rows: 2, totalQuantity: 3, sample: "plants" }), { status: 503 }),
  ]) {
    const f = fixture({ overrides: { replay } });
    await assert.rejects(f.api.replay(mergeSha), /incident_replay_failed/);
  }
});

test("remote API failure remains fixed and does not read or echo provider error bodies", async () => {
  let canceled = 0, read = 0;
  const api = createIncidentGithub({ config, fetcher: async () => ({ ok: false,
    body: { async cancel() { canceled += 1; } }, async text() { read += 1; throw Error("fixture-private-provider-error"); },
  }) });
  await assert.rejects(api.snapshot(baseSha), { message: "incident_github_request_unconfirmed" });
  assert.equal(read, 0); assert.equal(canceled, 1);
});


test('prepared recording PR verification is read-only and checks current draft and exact file bytes',async()=>{
 const args={...descriptor(),files};
 const valid={"GET /pulls/7":()=>({...pull(),draft:true})};
 const f=fixture({overrides:valid});
 assert.equal((await f.api.verifyPreparedPullRequest(args)).pullRequest,args.pullRequest);
 assert.deepEqual(f.writes(),[]);
 for(const current of [{...pull(),draft:true,state:'closed'},{...pull(),draft:false},{...pull(),draft:true,head:{...pull().head,sha:mergeSha}}]){
  const bad=fixture({overrides:{"GET /pulls/7":()=>current}});
  await assert.rejects(bad.api.verifyPreparedPullRequest(args),/incident_pr_changed/);
  assert.deepEqual(bad.writes(),[]);
 }
 const bad=fixture({overrides:{...valid,[`GET /contents/${files[0].path}?ref=${headSha}`]:()=>({encoding:'base64',content:Buffer.from('changed').toString('base64')})}});
 await assert.rejects(bad.api.verifyPreparedPullRequest(args),/incident_patch_changed/);
 assert.deepEqual(bad.writes(),[]);
});

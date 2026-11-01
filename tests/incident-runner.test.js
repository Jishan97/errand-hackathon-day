import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createIncidentRunner, INCIDENT_REPAIR_SCOPE } from "../src/agents/incident-runner.js";

const baseSha = "a".repeat(40);
const nonce = "11111111-1111-4111-8111-111111111111";
const instant = Date.parse("2026-10-31T10:00:00Z");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const config = { values: { OPENAI_API_KEY: "fixture-openai-key", OPENAI_AGENT_MODEL: "gpt-6.1-sol", GITHUB_DEMO_TOKEN: "never-enter-hosted-workspace" } };
const parser = `export function parseUpload(csv) {
 const lines = csv.trim().split('\\r\\n');
 if (lines.shift() !== 'name,quantity') throw new Error('header');
 const rows = lines.map(line => {const [name,raw] = line.split(',').map(value => value.trim()); const quantity=Number(raw); if (!name || !Number.isInteger(quantity) || quantity<1) throw new Error('quantity'); return {name,quantity};});
 return {rows:rows.length,totalQuantity:rows.reduce((sum,row)=>sum+row.quantity,0)};
}`;
const originalTest = `import test from 'node:test'; import assert from 'node:assert/strict'; import {parseUpload} from '../lib/upload-parser.js';
test('CRLF upload',()=>assert.deepEqual(parseUpload('name,quantity\\r\\nfern,2\\r\\nrose,1\\r\\n'),{rows:2,totalQuantity:3}));`;
const regressionTest = originalTest + `\ntest('LF upload regression',()=>assert.deepEqual(parseUpload('name,quantity\\nfern,2\\nrose,1\\n'),{rows:2,totalQuantity:3}));`;
const fixtureFiles = () => [
  { path: "api/upload.js", content: "export default function upload() { return { sample: 'plants' }; }\n" },
  { path: "lib/upload-parser.js", content: parser },
  { path: "tests/upload-parser.test.js", content: originalTest },
  { path: "package.json", content: '{"name":"credential-free-upload-fixture","type":"module","scripts":{"test":"node --test"}}\n' },
];
const isCode = (code) => (error) => error.message === code && error.code === code;

function harness(options = {}) {
  const calls = [], bodies = new Map(), payloads = new Map();
  const state = { sessionStatus: "in_progress", turnStatus: "in_progress", turnsPublished: true, items: [], artifacts: [], body: null, ...options.state };
  const turn = () => ({ id: "turn_fixture_1", session_id: "session_fixture_1", subagent_id: null, status: state.turnStatus });
  const session = () => ({ id: "session_fixture_1", agent: { model: state.body.agent.model },
    environment: { id: "env_fixture_1", type: "openai_hosted", network: { access: "disabled" } },
    metadata: state.body.metadata, required_actions: [], status: state.sessionStatus, ...state.sessionChanges });
  const call = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
  const sessions = {
    create: call("create", (body) => { state.body = body; return session(); }),
    retrieve: call("retrieve", () => session()),
    delete: call("delete", (id) => ({ id, deleted: true, object: "agent.session.deleted" })),
    events: { create: call("cancel", () => undefined) },
    turns: {
      list: call("turns.list", () => ({ data: state.turnsPublished ? [turn()] : [], has_more: false })),
      retrieve: call("turns.retrieve", () => ({ ...turn(), ...state.turnChanges })),
      items: { list: call("items.list", () => ({ data: state.items, has_more: false })) },
    },
    artifacts: {
      list: call("artifacts.list", () => ({ data: state.artifacts, has_more: false })),
      content: call("artifacts.content", (id) => new Response(payloads.get(id))),
    },
  };
  const makeRunner = (changes = {}) => createIncidentRunner({ config, clock: () => instant, randomId: () => nonce,
    createClient: () => ({ beta: { agents: { sessions } } }), ...options.runner, ...changes });
  function artifact(path, bytes, changes = {}) {
    const id = `artifact_fixture_${state.artifacts.length + 1}`;
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    payloads.set(id, content); bodies.set(path, content);
    const metadata = { id, path, session_id: "session_fixture_1", turn_id: "turn_fixture_1", environment_id: "env_fixture_1", size_bytes: content.byteLength, ...changes };
    state.artifacts.push(metadata);
    return metadata;
  }
  return { runner: makeRunner(), makeRunner, state, calls, sessions, artifact, payloads, bodies };
}

function commandFrom(body, phase) {
  const marker = phase === "before" ? "BEFORE COMMAND (run exactly; absolute workspace paths are embedded):\n" : "AFTER COMMAND:\n";
  return body.agent.instructions.split(marker)[1].split("\n\n")[0];
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "errand-incident-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const { path, content } of fixtureFiles()) { await mkdir(join(directory, path, ".."), { recursive: true }); await writeFile(join(directory, path), content); }
  return directory;
}

// Execute the runner's exact oracle program locally, with only its absolute
// /workspace root remapped into a disposable test directory. No provider runs.
async function executeOracle(h, directory, phase) {
  const command = commandFrom(h.state.body, phase);
  const encoded = command.slice("node --input-type=module -e ".length);
  assert.equal(encoded[0], "'"); assert.equal(encoded.at(-1), "'");
  const program = encoded.slice(1, -1).replaceAll(`'"'"'`, "'").replaceAll("/workspace", directory.replaceAll('\\', '/'));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { env: {}, encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, phase === "before" ? 1 : 0, result.stderr);
  h.state.items.push({ id: `command_${phase}`, type: "command_execution", turn_id: "turn_fixture_1", command,
    status: "completed", exit_code: result.status, output: result.stdout, duration_ms: 100 });
  h.artifact(`/workspace/outputs/${phase}.json`, await readFile(join(directory, "outputs", `${phase}.json`)));
  if (phase === "after") for (const path of ["lib/upload-parser.js", "tests/upload-parser.test.js"]) h.artifact(`/workspace/outputs/${path}`, await readFile(join(directory, "outputs", path)));
}

async function completedInvestigation(t) {
  const h = harness();
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  const directory = await workspace(t);
  await writeFile(join(directory, "tests/upload-parser.test.js"), regressionTest);
  await executeOracle(h, directory, "before");
  h.state.turnStatus = "completed"; h.state.sessionStatus = "idle";
  return { ...h, handle, directory };
}

test("incident runner requires explicitly supplied Sol config and does not load ambient secrets", () => {
  for (const values of [{}, { OPENAI_API_KEY: "fixture", OPENAI_AGENT_MODEL: "gpt-6-astra" }, { OPENAI_API_KEY: "bad\nkey", OPENAI_AGENT_MODEL: "gpt-6.1-sol" }]) assert.throws(() => createIncidentRunner({ config: { values } }), isCode("incident_runner_unconfigured"));
  let reads = 0;
  const values = { OPENAI_AGENT_MODEL: "gpt-6.1-sol" };
  Object.defineProperty(values, "OPENAI_API_KEY", { get() { reads += 1; throw new Error("not executed"); } });
  assert.throws(() => createIncidentRunner({ config: { values } }), isCode("incident_runner_unconfigured"));
  assert.equal(reads, 0);
});

test("investigation starts resumably with allowlisted inline files, Sol and disabled networking", async () => {
  const h = harness();
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  assert.equal(handle.status, "pending"); assert.equal(handle.sessionId, "session_fixture_1"); assert.equal(handle.turnId, null);
  assert.equal(handle.mode, "investigate"); assert.equal(handle.baseSha, baseSha); assert.equal(handle.startedAt, instant);
  assert.equal(handle.manifest.length, 4); assert.equal(handle.sourceHash, sha(JSON.stringify(handle.manifest)));
  assert.deepEqual(h.state.body.environment.network, { access: "disabled" });
  assert.equal(h.state.body.environment.type, "openai_hosted"); assert.equal(h.state.body.environment.container_size, "small");
  assert.deepEqual(h.state.body.agent.tools, []); assert.deepEqual(h.state.body.agent.multi_agent, { enabled: false });
  assert.deepEqual(h.state.body.vault_ids, []); assert.equal(h.state.body.agent.model, "gpt-6.1-sol");
  const files = Object.fromEntries(h.state.body.environment.files.map((file) => { assert.equal(file.type, "inline"); return [file.path, Buffer.from(file.data, "base64").toString()]; }));
  for (const file of fixtureFiles()) assert.equal(files[`/workspace/${file.path}`], file.content);
  assert.equal(Object.keys(files).length, 4);
  assert.equal(JSON.stringify(h.state.body).includes(config.values.OPENAI_API_KEY), false);
  assert.equal(JSON.stringify(h.state.body).includes(config.values.GITHUB_DEMO_TOKEN), false);
  assert.match(h.state.body.agent.instructions, /investigation only/);
  assert.equal(h.calls.length, 1, "starting work does not poll or wait for completion");
});

test("non-allowlisted, duplicate, oversized and executable source records are rejected before creation", async () => {
  const h = harness();
  let reads = 0;
  const hostile = { path: "package.json" }; Object.defineProperty(hostile, "content", { get() { reads += 1; return "private"; } });
  for (const files of [
    [...fixtureFiles(), { path: ".env", content: "never read" }],
    fixtureFiles().map((file, index) => index === 0 ? { path: "../api/upload.js", content: "" } : file),
    fixtureFiles().map((file, index) => index === 0 ? { ...file, content: "x".repeat(32769) } : file),
    fixtureFiles().map((file) => file.path === "package.json" ? hostile : file),
  ]) await assert.rejects(h.runner.startInvestigation({ files, baseSha }), isCode("incident_invalid_sources"));
  assert.equal(reads, 0); assert.equal(h.calls.length, 0);
});

test("fix creation requires reproduced findings at the exact base commit", async () => {
  const h = harness();
  for (const findings of [undefined, {}, { reproduced: false, baseSha }, { reproduced: true, baseSha: "b".repeat(40) }]) await assert.rejects(h.runner.startFix({ files: fixtureFiles(), baseSha, findings }), isCode("incident_findings_required"));
  const handle = await h.runner.startFix({ files: fixtureFiles(), baseSha, findings: { reproduced: true, baseSha, raw: "untrusted caller text never sent" } });
  assert.equal(handle.mode, "fix");
  assert.match(h.state.body.agent.instructions, /AFTER COMMAND/);
  assert.equal(JSON.stringify(h.state.body).includes("untrusted caller text never sent"), false);
  assert.equal(h.state.body.agent.instructions.includes("split(/"), false, "the runner provides an oracle, not a prepared repair");
});

test("poll discovers a durable root turn and returns immediately while it is active", async () => {
  const h = harness({ state: { turnsPublished: false } });
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  assert.equal((await h.runner.poll(handle)).turnId, null);
  h.state.turnsPublished = true;
  const next = await h.makeRunner().poll(handle);
  assert.equal(next.status, "pending"); assert.equal(next.turnId, "turn_fixture_1");
  assert.equal(h.calls.some((call) => call.name === "artifacts.list"), false);
});

test("session and turn binding mismatches fail closed and preserve the cleanup handle", async () => {
  const h = harness();
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  for (const changes of [{ agent: { model: "gpt-6-astra" } }, { metadata: { ...h.state.body.metadata, base_sha: "b".repeat(40) } }, { environment: { id: "env_fixture_1", type: "openai_hosted", network: { access: "enabled" } } }]) {
    h.state.sessionChanges = changes;
    await assert.rejects(h.runner.poll(handle), (error) => { assert.equal(error.code, "incident_session_mismatch"); assert.equal(error.handle.sessionId, handle.sessionId); return true; });
  }
  h.state.sessionChanges = {};
  h.state.turnChanges = { session_id: "another_session" };
  await assert.rejects(h.runner.poll(handle), isCode("incident_turn_mismatch"));
});

test("a completed hosted investigation requires actual failing Node regression and matching immutable proof", async (t) => {
  const h = await completedInvestigation(t);
  const result = await h.makeRunner().poll(h.handle);
  assert.equal(result.status, "completed"); assert.deepEqual(result.files, []);
  assert.deepEqual(result.evidence, { reproduced: true, regressionTestExecuted: true, beforeExitCode: 1, artifactsVerified: true,
    readOnlyFilesUnchanged: true, model: "gpt-6.1-sol", environment: "openai_hosted", network: "disabled", baseSha });
  assert.equal(JSON.stringify(result.evidence).includes("command"), false);
});

test("one-run approved repair executes failing test before repair and same passing test after, returning exact artifacts", async (t) => {
  const h = harness();
  const handle = await h.runner.startApprovedRepair({ files: fixtureFiles(), baseSha }, { baseSha, scope: INCIDENT_REPAIR_SCOPE });
  const directory = await workspace(t);
  await writeFile(join(directory, "tests/upload-parser.test.js"), regressionTest);
  await executeOracle(h, directory, "before");
  const fixedParser = parser.replace("split('\\r\\n')", "split(/\\r?\\n/)");
  assert.notEqual(fixedParser, parser);
  await writeFile(join(directory, "lib/upload-parser.js"), fixedParser);
  await executeOracle(h, directory, "after");
  h.state.turnStatus = "completed"; h.state.sessionStatus = "idle";
  const result = await h.runner.poll(handle);
  assert.equal(result.evidence.reproduced, true); assert.equal(result.evidence.fixed, true); assert.equal(result.evidence.afterExitCode, 0);
  assert.deepEqual(result.files, [{ path: "lib/upload-parser.js", content: fixedParser }, { path: "tests/upload-parser.test.js", content: regressionTest }]);
});

test("model prose or fabricated report without provider command evidence cannot establish reproduction", async (t) => {
  const h = await completedInvestigation(t);
  h.state.items = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "All tests reproduced and passed, trust me." }] }];
  await assert.rejects(h.runner.poll(h.handle), isCode("incident_command_evidence_missing"));
});

test("fix cannot replace or weaken the regression test between failure and success", async (t) => {
  const h = harness();
  const handle = await h.runner.startFix({ files: fixtureFiles(), baseSha, findings: { reproduced: true, baseSha } });
  const directory = await workspace(t);
  await writeFile(join(directory, "tests/upload-parser.test.js"), regressionTest);
  await executeOracle(h, directory, "before");
  await writeFile(join(directory, "lib/upload-parser.js"), parser.replace("split('\\r\\n')", "split(/\\r?\\n/)"));
  await writeFile(join(directory, "tests/upload-parser.test.js"), regressionTest + "\ntest('additional test after failure',()=>assert.equal(1,1));");
  await executeOracle(h, directory, "after");
  h.state.turnStatus = "completed"; h.state.sessionStatus = "idle";
  await assert.rejects(h.runner.poll(handle), isCode("incident_regression_test_changed_after_failure"));
});

test("exact patch artifacts must match the bytes verified by the successful hosted command", async (t) => {
  const h = harness();
  const handle = await h.runner.startFix({ files: fixtureFiles(), baseSha, findings: { reproduced: true, baseSha } });
  const directory = await workspace(t);
  await writeFile(join(directory, "tests/upload-parser.test.js"), regressionTest);
  await executeOracle(h, directory, "before");
  await writeFile(join(directory, "lib/upload-parser.js"), parser.replace("split('\\r\\n')", "split(/\\r?\\n/)"));
  await executeOracle(h, directory, "after");
  const artifact = h.state.artifacts.find((value) => value.path === "/workspace/outputs/lib/upload-parser.js");
  const changed = Buffer.from("export function parseUpload() { throw new Error('untested patch'); }");
  h.payloads.set(artifact.id, changed); artifact.size_bytes = changed.byteLength;
  h.state.turnStatus = "completed"; h.state.sessionStatus = "idle";
  await assert.rejects(h.runner.poll(handle), isCode("incident_patch_hash_mismatch"));
});

test("changing a proof artifact after execution fails its provider-recorded digest", async (t) => {
  const h = await completedInvestigation(t);
  const artifact = h.state.artifacts[0];
  const proof = JSON.parse(h.payloads.get(artifact.id)); proof.test_output_sha256 = "f".repeat(64);
  const changed = Buffer.from(JSON.stringify(proof)); h.payloads.set(artifact.id, changed); artifact.size_bytes = changed.byteLength;
  await assert.rejects(h.runner.poll(h.handle), isCode("incident_command_evidence_missing"));
});

test("pending publication does not turn an idle session or completed turn into success", async () => {
  const h = harness({ state: { sessionStatus: "idle", turnStatus: "completed" } });
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  assert.equal((await h.runner.poll(handle)).status, "pending");
  h.state.turnStatus = "failed";
  await assert.rejects(h.runner.poll(handle), isCode("incident_turn_failed"));
});

test("artifacts bind exact session, turn, environment, size and path", async (t) => {
  const h = await completedInvestigation(t);
  const artifact = h.state.artifacts[0];
  artifact.environment_id = "other_env";
  await assert.rejects(h.runner.poll(h.handle), isCode("incident_invalid_artifact"));
  artifact.environment_id = "env_fixture_1"; artifact.session_id = "other_session";
  await assert.rejects(h.runner.poll(h.handle), isCode("incident_invalid_artifact"));
  artifact.session_id = "session_fixture_1"; artifact.size_bytes += 1;
  await assert.rejects(h.runner.poll(h.handle), isCode("incident_artifact_size_mismatch"));
  artifact.size_bytes -= 1; artifact.turn_id = "other_turn";
  assert.equal((await h.runner.poll(h.handle)).status, "pending");
});

test("trusted verifier detects immutable repository edits rather than approving an unrelated change", async (t) => {
  const h = harness();
  await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  const directory = await workspace(t);
  await writeFile(join(directory, "tests/upload-parser.test.js"), regressionTest);
  await writeFile(join(directory, "api/upload.js"), "changed API outside patch scope");
  const command = commandFrom(h.state.body, "before");
  const program = command.slice("node --input-type=module -e ".length + 1, -1).replaceAll(`'"'"'`, "'").replaceAll("/workspace", directory.replaceAll('\\', '/'));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { env: {}, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 2);
  const proof = JSON.parse(await readFile(join(directory, "outputs", "before.json")));
  assert.equal(proof.read_only_files_unchanged, false);
});

test("cleanup first cancels active work, then deletes after a later terminal acknowledgment", async () => {
  const h = harness();
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  assert.deepEqual(await h.runner.cleanup(handle), { status: "pending", cancellationRequested: true, apiRemovalAcknowledged: false });
  assert.equal(h.calls.some((call) => call.name === "delete"), false);
  assert.deepEqual(h.calls.find((call) => call.name === "cancel").args[1], { events: [{ type: "agent.session.input.cancel" }] });
  h.state.sessionStatus = "idle"; h.state.turnStatus = "cancelled";
  assert.deepEqual(await h.runner.cleanup(handle), { status: "deleted", cancellationRequested: false, apiRemovalAcknowledged: true });
});

test("cleanup rejects another session's binding and permits cleanup of a failed bound session", async () => {
  const h = harness();
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  h.state.sessionChanges = { metadata: { ...h.state.body.metadata, run_nonce: "unrelated" } };
  await assert.rejects(h.runner.cleanup(handle), isCode("incident_session_mismatch"));
  assert.equal(h.calls.some((call) => call.name === "cancel" || call.name === "delete"), false);
  h.state.sessionChanges = {}; h.state.sessionStatus = "failed"; h.state.turnStatus = "failed";
  assert.equal((await h.runner.cleanup(handle)).status, "deleted");
});

test("a transient hosted deletion conflict stays pending without inventing a cleanup receipt", async () => {
  const h = harness();
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  h.state.sessionStatus = 'idle'; h.state.turnStatus = 'completed';
  h.sessions.delete = async () => { throw Object.assign(Error('fixture conflict'), { status: 409 }); };
  assert.deepEqual(await h.runner.cleanup(handle), { status: 'pending', apiRemovalAcknowledged: false, cancellationRequested: false });
});

test("abort, request timeout and provider error messages are bounded and sanitized", async () => {
  const h = harness();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.runner.startInvestigation({ files: fixtureFiles(), baseSha, signal: controller.signal }), isCode("incident_aborted"));
  assert.equal(h.calls.length, 0);
  h.sessions.create = async () => new Promise(() => {});
  await assert.rejects(h.makeRunner({ requestTimeoutMs: 5 }).startInvestigation({ files: fixtureFiles(), baseSha }), isCode("incident_request_timeout"));
  h.sessions.create = async () => { throw Object.assign(new Error("private provider payload"), { status: 429, request_id: "private" }); };
  await assert.rejects(h.makeRunner().startInvestigation({ files: fixtureFiles(), baseSha }), (error) => {
    assert.equal(error.message, "incident_provider_rate_limited"); assert.equal(error.http_status, 429);
    assert.equal(JSON.stringify(error).includes("private"), false); return true;
  });
});

test("expired or tampered resume handles cannot silently create replacement work", async () => {
  const h = harness();
  const handle = await h.runner.startInvestigation({ files: fixtureFiles(), baseSha });
  await assert.rejects(h.runner.poll({ ...handle, sourceHash: "f".repeat(64) }), isCode("incident_invalid_handle"));
  await assert.rejects(h.makeRunner({ clock: () => instant + 9 * 60000 }).poll(handle), isCode("incident_run_expired"));
  assert.equal(h.calls.filter((call) => call.name === "create").length, 1);
});


test("one-run approval requires exact baseline and fixed scope before creating a hosted session", async () => {
  const h = harness();
  const snapshot = { files: fixtureFiles(), baseSha };
  for (const approval of [undefined, null, {}, { baseSha, scope: "anything" }, { baseSha: "b".repeat(40), scope: INCIDENT_REPAIR_SCOPE }]) {
    await assert.rejects(h.runner.startApprovedRepair(snapshot, approval), isCode("incident_approval_required"));
  }
  let accessed = false;
  const accessor = { baseSha };
  Object.defineProperty(accessor, "scope", { get() { accessed = true; return INCIDENT_REPAIR_SCOPE; } });
  await assert.rejects(h.runner.startApprovedRepair(snapshot, accessor), isCode("incident_approval_required"));
  assert.equal(accessed, false);
  assert.equal(h.calls.length, 0);
  const handle = await h.runner.startApprovedRepair(snapshot, { baseSha, scope: INCIDENT_REPAIR_SCOPE });
  assert.equal(handle.mode, "fix");
  assert.equal(h.calls.length, 1);
  assert.match(h.state.body.agent.instructions, /BEFORE COMMAND/);
  assert.match(h.state.body.agent.instructions, /AFTER COMMAND/);
  assert.equal(h.state.body.agent.instructions.includes("split(/"), false);
});

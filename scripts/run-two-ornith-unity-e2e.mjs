import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { waitForUnityEditor } from "./unity-editor-readiness.mjs";
import { snapshotUnityProject, snapshotHashes, writeUnitySnapshot, restoreUnityProjectSnapshot } from "./unity-project-snapshot.mjs";

const repo = process.cwd();
const model = "Ornith-1.5-35B-A3B-OptiQ-4bit";
const endpoint = (process.env.OMLX_ENDPOINT || "http://127.0.0.1:8000/v1").replace(/\/$/, "");
const auth = { authorization: `Bearer ${process.env.OMLX_API_KEY || "mmnn"}` };
const original = process.env.MAIN_ORIGINAL_UNITY_PROJECT || "/Users/michael/Documents/Unity/TestCli";
const evidence = path.resolve(process.env.MAIN_TWO_ROUND_EVIDENCE || "test-results/ornith-supplement-repair-20261023");
const unity = process.env.MAIN_UNITY_CLI || path.join(process.env.HOME || "", ".unity/bin/unity");
const projectRoots = ["Assets", "Packages", "ProjectSettings", ".protocols", "Screenshots"];
await fs.mkdir(evidence, { recursive: false });

async function request(route) {
  const response = await fetch(`${endpoint.replace(/\/v1$/, "")}${route}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return { unavailable: response.status };
  return response.json();
}
async function inventory(directory, recursive = true) {
  let files = 0, bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) { const child = await inventory(file); files += child.files; bytes += child.bytes; }
    else if (entry.isFile()) { files++; bytes += (await fs.stat(file)).size; }
  }
  return { path: directory, files, bytes };
}
async function state(phase) {
  const [models, scheduler, stats] = await Promise.all([request("/v1/models/status"), request("/api/status"), request("/admin/api/stats")]);
  const cacheRoot = path.join(process.env.HOME || "", ".omlx/cache");
  const shards = [];
  for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]$/.test(entry.name)) continue;
    let files = 0, bytes = 0;
    const folder = path.join(cacheRoot, entry.name);
    for (const name of await fs.readdir(folder)) if (name.endsWith(".safetensors")) { files++; bytes += (await fs.stat(path.join(folder, name))).size; }
    shards.push({ shard: entry.name, files, bytes });
  }
  const safeStats = stats && typeof stats === "object" ? { ...stats, api_key: "[REDACTED]" } : stats;
  return { phase, at: new Date().toISOString(), models, scheduler, stats: safeStats,
    cache: { policy: "record only; no clearing, unloading, model switching or warmup requests", ssd: { path: cacheRoot, shards },
      responseState: await inventory(path.join(cacheRoot, "response-state")),
      hotAndPaged: "Owned by loaded OMLX scheduler; available counters are in scheduler/stats. No reset performed." } };
}
function assertModel(snapshot) {
  const loaded = snapshot.models.models?.filter(record => record.loaded && !record.is_loading) || [];
  if (loaded.length !== 1 || loaded[0].id !== model || snapshot.models.loaded_count !== 1 || snapshot.models.models?.some(record => record.is_loading))
    throw new Error("Single loaded Ornith model condition failed; refusing implicit model load.");
  if (snapshot.scheduler.active_requests || snapshot.scheduler.waiting_requests) throw new Error("OMLX has active/waiting requests; refusing overlap.");
}
async function write(name, value) { await fs.writeFile(path.join(evidence, name), JSON.stringify(value, null, 2)); }
async function fingerprint(root, prefixes) {
  const result = {};
  const visit = async folder => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) result[path.relative(root, file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    }
  };
  for (const prefix of prefixes) await visit(path.join(root, prefix));
  return result;
}
async function processToLog(command, args, log, env = process.env, timeout = 1_500_000) {
  const handle = await fs.open(log, "w");
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: repo, env, stdio: ["ignore", handle.fd, handle.fd] });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", async error => { clearTimeout(timer); await handle.close(); resolve({ code: null, error: String(error) }); });
    child.on("close", async (code, signal) => { clearTimeout(timer); await handle.close(); resolve({ code, signal }); });
  });
}
async function unityCommand(command, parameters = {}) {
  const args = ["command", ...command.split(" "), "--project-path", original, "--format", "json", "--result-only", "--no-pager", "--timeout", "20", "--"];
  for (const [key, value] of Object.entries(parameters)) args.push(`--${key}`, typeof value === "string" ? value : JSON.stringify(value));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(unity, args, { cwd: original, env: { ...process.env, UNITY_NON_INTERACTIVE: "1", UNITY_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 25_000);
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`Unity CLI exit ${code}: ${(stdout || stderr).slice(-1500)}`);
        const value = JSON.parse(stdout);
        if (value?.success === false || value?.Success === false) throw new Error(JSON.stringify(value));
        resolve(value?.data?.result ?? value?.result ?? value?.data ?? value);
      } catch (error) { reject(error); }
    });
  });
  await fs.appendFile(path.join(evidence, "unity-host-commands.jsonl"), JSON.stringify({ at: new Date().toISOString(), command, parameters, result }) + "\n");
  return result;
}
async function stopPlayIfNeeded() {
  const status = await unityCommand("editor status");
  if (status.playMode !== "stopped") await unityCommand("editor.playmode stop");
}
async function awaitIdle(phase) {
  const probes = [], started = Date.now();
  while (Date.now() - started < 90_000) {
    const scheduler = await request("/api/status");
    probes.push({ at: new Date().toISOString(), active: scheduler.active_requests, waiting: scheduler.waiting_requests });
    await write(`${phase}-idle.json`, probes);
    if (scheduler.active_requests === 0 && scheduler.waiting_requests === 0) return;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error("OMLX did not become idle; no overlapping inference or implicit model load is allowed.");
}

const start = await state("initial"); assertModel(start); await write("initial-state.json", start);
const requestFile = path.join(evidence, "original-request.txt");
const incident = JSON.parse(execFileSync("python3", ["-c", `import json,sqlite3
c=sqlite3.connect('file:/Users/michael/Library/Application Support/com.localagent.ide/sessions/session-store.sqlite3?mode=ro',uri=True)
s=json.loads(c.execute('select snapshot_json from session_snapshots where session_id=?',('1792669744930',)).fetchone()[0])
cp=next(iter(s['runtimeSnapshot']['runtimeV2Checkpoints'].values()))
print(json.dumps(next(e for e in cp['events'] if e['type']=='turn.admitted')))`], { encoding: "utf8" }));
await fs.writeFile(requestFile, incident.objective);
await write("original-admission.json", incident);
const beforeOriginal = await fingerprint(original, projectRoots); await write("original-files-before.json", beforeOriginal);
const baseline = await snapshotUnityProject(original, projectRoots);
await writeUnitySnapshot(path.join(evidence, "project-baseline.json.gz"), baseline);
const initialEditor = await waitForUnityEditor(unity, original, path.join(evidence, "initial-editor-readiness.json"));
if (!initialEditor.ready) throw new Error("Existing TestCli Editor is not ready; no Editor will be launched by this runner.");
await unityCommand("editor set_auto_tick", { enable: true, interval_ms: 16, persist: false });
await stopPlayIfNeeded();
const initialScenes = await unityCommand("script eval", { code: "var scenes = new System.Collections.Generic.List<object>(); for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++) { var s = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i); scenes.Add(new { path = s.path, dirty = s.isDirty }); } return new { scenes };" });
if (!Array.isArray(initialScenes.scenes) || initialScenes.scenes.some(scene => scene.dirty || !scene.path)) throw new Error("Existing project has unsaved scenes; baseline restoration is not safe.");
await write("initial-scenes.json", initialScenes);
const sourceFiles = execFileSync("rg", ["--files", "src", "src-tauri/src", "src-tauri/examples", "tests", "scripts", "vite.config.ts", "playwright.config.ts", "package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"], { encoding: "utf8" }).trim().split("\n").sort();
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await fs.readFile(file)).digest("hex")])));
const sourceDigest = createHash("sha256").update(JSON.stringify(sourceHashes)).digest("hex");
await write("source-manifest.json", { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceDigest, files: sourceHashes,
  settings: { model, endpoint, preferSubagents: true, autoApproveTools: true, autoApproveToolScopes: ["workspace_write", "shell", "local_file_read", "external_write", "browser_control", "mcp_action"] } });
const results = [];
let previousOutput = null;
for (const round of [1, 2]) {
  const directory = path.join(evidence, `round-${round}`); await fs.mkdir(directory);
  const project = original;
  let editor = null, result = null, stage = "baseline_check";
  try {
    if (round === 2) {
      await unityCommand("editor set_auto_tick", { enable: true, interval_ms: 16, persist: false });
      await stopPlayIfNeeded();
      const restored = await restoreUnityProjectSnapshot(project, baseline, previousOutput);
      await write(`round-${round}/baseline-restoration.json`, restored);
      if (JSON.stringify(restored.hashes) !== JSON.stringify(snapshotHashes(baseline))) throw new Error("TestCli baseline restoration did not match the saved files.");
      await unityCommand("script recompile");
      const compileDeadline = Date.now() + 180_000;
      let compileSettled = false;
      while (Date.now() < compileDeadline) {
        let compilation = null;
        try { compilation = await unityCommand("script recompile_status"); }
        catch (error) { await write(`round-${round}/recompile-reload-wait.json`, { at: new Date().toISOString(), error: String(error) }); }
        if (compilation && ["completed", "up_to_date"].includes(compilation.status)) {
          await write(`round-${round}/recompile.json`, compilation);
          if (compilation.failed !== false) throw new Error("Restored baseline did not compile successfully.");
          compileSettled = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (!compileSettled) throw new Error("Restored baseline compilation did not settle before the host deadline.");
      await unityCommand("editor set_auto_tick", { enable: true, interval_ms: 16, persist: false });
      const restoredEditor = await waitForUnityEditor(unity, project, path.join(directory, "restored-editor-readiness.json"));
      if (!restoredEditor.ready) throw new Error("Restored TestCli Editor did not finish its domain reload.");
      for (const [index, scene] of initialScenes.scenes.entries()) await unityCommand("scene open", { path: scene.path, additive: index > 0 });
    }
    stage = "idle_check";
    await awaitIdle(`round-${round}/before`);
    const before = await state(`round-${round}-before`); await write(`round-${round}/before.json`, before); assertModel(before);
    await write(`round-${round}/input-files.json`, await fingerprint(project, projectRoots));
    console.log(`Round ${round}: existing project ${project}; independent Session store; sole loaded model ${model}; source ${sourceDigest.slice(0, 12)}`);
    stage = "existing_editor_readiness";
    editor = await waitForUnityEditor(unity, project, path.join(directory, "editor-readiness.json"));
    await write(`round-${round}/editor-bootstrap.json`, editor);
    if (!editor.ready) throw new Error("Existing TestCli Editor did not report ready; no additional Editor is launched.");
    await unityCommand("editor set_auto_tick", { enable: true, interval_ms: 16, persist: false });
    const consoleBefore = await unityCommand("console get", { tail: 100 });
    await write(`round-${round}/console-before.json`, consoleBefore);
    if (!Array.isArray(consoleBefore.entries) || typeof consoleBefore.session !== "string" || !Number.isFinite(consoleBefore.cursor)) throw new Error("Console baseline has no typed entries or stable cursor.");
    const consoleBaseline = { session: consoleBefore.session, cursor: consoleBefore.cursor };
    stage = "production_task";
    result = await processToLog(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "tests/e2e/real-omlx-plan-flow.spec.ts", "--grep", "Unity Execute uses production tool", "--reporter=line"], path.join(directory, "playwright.log"), {
    ...process.env, PATH: `${path.dirname(unity)}:${process.env.PATH || ""}`, MAIN_REAL_OMLX_E2E: "1", MAIN_FROZEN_RUNTIME_E2E: "1", OMLX_MODELS: model,
    REAL_OMLX_FIXTURE: "unity", REAL_OMLX_WORKSPACE: project, REAL_OMLX_EVIDENCE_DIR: directory,
    REAL_OMLX_SESSION_STORE_PATH: path.join(directory, "test-session.sqlite3"), REAL_UNITY_CONSOLE_BASELINE: JSON.stringify(consoleBaseline),
    REAL_OMLX_PROTOCOL_EVIDENCE_DIR: path.join(directory, "protocol"),
    MAIN_ORNITH_REQUEST_FILE: requestFile, MAIN_TEST_SKILL_PACKAGE_IDS: "5dd1df5ff118f451a48318fc1f557f0e7935a5bb69d2d4bf2e6f0fd936096b9b",
    REAL_OMLX_EXECUTION_TIMEOUT_MS: "780000", PLAYWRIGHT_REUSE_EXISTING_SERVER: "0",
    });
  } catch (error) {
    result = { code: 1, stage, error: String(error) };
    await write(`round-${round}/host-failure.json`, result);
  }
  await write(`round-${round}/editor-ownership.json`, { project, reusedExistingEditor: true, editorLaunched: false, editorClosed: false });
  await fs.cp(path.join(repo, "test-results/playwright"), path.join(directory, "playwright-artifacts"), { recursive: true }).catch(() => {});
  let stateError = null;
  try { await awaitIdle(`round-${round}/after`); } catch (error) { stateError = String(error); }
  let after;
  try { after = await state(`round-${round}-after`); }
  catch (error) { after = { unavailable: String(error) }; stateError = String(error); }
  await write(`round-${round}/after.json`, { ...after, stateError });
  const output = await snapshotUnityProject(project, projectRoots);
  previousOutput = snapshotHashes(output);
  await write(`round-${round}/output-files.json`, previousOutput);
  await writeUnitySnapshot(path.join(directory, "project-output.json.gz"), output);
  await write(`round-${round}/console-after.json`, await unityCommand("console get", { tail: 1000 }).catch(error => ({ unavailable: String(error) })));
  const acceptance = await fs.readFile(path.join(directory, "acceptance.json"), "utf8").then(JSON.parse).catch(error => ({ outcome: null, hostFailure: result,
    unavailable: String(error), sceneSaved: false, userInteractionVerified: false, gaps: ["Task or host ended before independent Unity acceptance could run."] }));
  await write(`round-${round}/acceptance.json`, acceptance);
  results.push({ round, sourceDigest, project, result, editor, acceptance, stateError });
  await write("results.json", results);
  console.log(`Round ${round}: test exit ${result.code}; task result ${acceptance.outcome?.resultKind || (acceptance.paused ? "paused" : "unavailable")}`);
  try { assertModel(after); } catch (error) { results.at(-1).stateError = String(error); await write("results.json", results); }
}
const afterOriginal = await fingerprint(original, projectRoots); await write("original-files-after.json", afterOriginal);
await write("project-file-delta.json", { project: original, changed: [...new Set([...Object.keys(beforeOriginal), ...Object.keys(afterOriginal)])].filter(name => beforeOriginal[name] !== afterOriginal[name]), baselineRetained: "project-baseline.json.gz", finalRoundOutputRetained: true });
await stopPlayIfNeeded();
const finalHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await fs.readFile(file)).digest("hex")])));
const sourceUnchanged = JSON.stringify(sourceHashes) === JSON.stringify(finalHashes);
await write("source-unchanged.json", { unchanged: sourceUnchanged, sourceDigest,
  afterDigest: createHash("sha256").update(JSON.stringify(finalHashes)).digest("hex") });
console.log(`Two independent rounds retained in ${evidence}`);
process.exitCode = sourceUnchanged && results.every(result => result.result.code === 0 && !result.stateError) ? 0 : 1;

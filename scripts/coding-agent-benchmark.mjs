import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseAgentRuntimeLog, READ_FILE_TOOL_NAMES } from "./analyze-agent-runtime-log.mjs";
import { snapshotHashes, snapshotUnityProject } from "./unity-project-snapshot.mjs";

// Prepare a fresh disposable workspace with --twinny-archive for each trial.
// Point REAL_OMLX_WORKSPACE at the reported workspace and use
// scripts/run-real-omlx-plan-e2e.mjs with REAL_OMLX_FIXTURE=mframework,
// REAL_OMLX_MUTATION_FILE=MFramework/Audio/AudioManager.cs,
// REAL_OMLX_TEST_GREP="coding benchmark", and
// REAL_OMLX_CODING_BENCHMARK=chat|analyze|repair|plan.
// Set REAL_OMLX_FIRST_RESPONSE=1 only for the experimental MAIN profile.
// Keep model, cache regime, working copy, and user context matched across runs.
// The Assets-only benchmark verifies isolated source effects. Its fixture
// leaves engine validation unavailable rather than launching a host shell.

const sha256 = value => createHash("sha256").update(value).digest("hex");
const finite = value => typeof value === "number" && Number.isFinite(value);
const sum = values => values.reduce((total, value) => total + value, 0);
const elapsed = (start, end) => finite(start) && finite(end) && end >= start
  ? Math.round(end - start) : null;
const earliest = (...times) => Math.min(...times.filter(finite));

export async function readBenchmarkWorkspaceFingerprint(workspace) {
  const files = snapshotHashes(await snapshotUnityProject(workspace, ["."]));
  return { files, sha256: sha256(JSON.stringify(files)) };
}

function nativeTime(value) {
  return /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value);
}

export function summarizeBenchmarkUsage(rows) {
  const complete = key => rows.length > 0 && rows.every(row => finite(row[key]));
  const total = key => complete(key) ? sum(rows.map(row => row[key])) : null;
  const inputTokens = total("inputTokens");
  const cachedInputTokens = total("cachedInputTokens");
  return {
    inputTokens, cachedInputTokens, outputTokens: total("outputTokens"),
    maxInputTokens: complete("inputTokens") ? Math.max(...rows.map(row => row.inputTokens)) : null,
    uncachedInputTokens: inputTokens !== null && cachedInputTokens !== null
      ? inputTokens - cachedInputTokens : null,
  };
}

export function readChatCompletionUsage(sse) {
  for (const line of sse.split(/\r?\n/).reverse()) {
    if (!line.startsWith("data:") || line.trimEnd().endsWith("[DONE]")) continue;
    try {
      const { usage } = JSON.parse(line.slice(5));
      if (!finite(usage?.prompt_tokens) || !finite(usage?.completion_tokens)) continue;
      return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null };
    } catch { /* An incomplete or non-JSON SSE event has no usage. */ }
  }
  return null;
}

/** Record protocol shape only. Neither the intent JSON nor the answer is retained. */
export function classifyBenchmarkFirstResponse(sse) {
  let content = "";
  let tools = false;
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data: {")) continue;
    try {
      const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta;
      if (typeof delta?.content === "string") content += delta.content;
      if (delta?.tool_calls?.length) tools = true;
    } catch { /* The stream can be canceled with a partial trailing event. */ }
  }
  content = content.trimStart();
  const prefix = "MAIN_INTENT ";
  if (!content) return tools ? "tool_without_header" : "empty";
  if (!content.startsWith(prefix)) {
    if (prefix.startsWith(content)) return "partial_prefix";
    if (content.startsWith("{")) return "json_without_header";
    if (content.startsWith("```")) return "markdown_without_header";
    return "text_without_header";
  }
  const newline = content.indexOf("\n");
  try {
    JSON.parse(content.slice(prefix.length, newline < 0 ? undefined : newline));
  } catch {
    return newline < 0 ? "incomplete_header" : "invalid_header_json";
  }
  return tools ? "header_and_tool" : newline >= 0 && content.slice(newline + 1).trim()
    ? "header_and_answer" : "header_only";
}

function uniqueCommandRecords(events) {
  const seen = new Set();
  return events.filter(entry => {
    if (!entry.payload.commandKey) return true;
    // Browser fixture logs can include the same record through IPC and its
    // debug observer. A different attempt, stream, or result is still counted.
    const key = JSON.stringify([entry.event, entry.payload]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Summarize by canonical Run. When the submit timestamp is absent, report
 * timing from run admission separately. Avoid guessing the UI send time. */
export function summarizeMainBenchmark(events, { runId, submittedAt } = {}) {
  const byRun = new Map();
  for (const event of events) {
    const id = event.payload.runId;
    if (!event.event.startsWith("store.runtime_v2_") || !id || (runId && id !== runId)) continue;
    if (!byRun.has(id)) byRun.set(id, []);
    byRun.get(id).push(event);
  }
  return [...byRun].map(([runId, run]) => {
    const timeOf = event => event ? nativeTime(event.timestamp) : NaN;
    const admission = run.find(entry => /(?:chat|workspace_read|execute|plan)_admitted$/.test(entry.event))
      ?? run.find(entry => entry.payload.eventType === "run.started");
    const summary = run.findLast(entry => entry.event.endsWith("_plan_run_summary"));
    const finalProjection = run.find(entry => entry.event.endsWith("_projection_published") &&
      entry.payload.audience === "final" && entry.payload.storeDisposition !== "ignored");
    const final = finalProjection ?? run.findLast(entry => /(?:chat|workspace_read|execute|plan)_terminal$/.test(entry.event));
    const opened = uniqueCommandRecords(run.filter(entry => /_provider_request_opened$/.test(entry.event)));
    const timedDispatches = uniqueCommandRecords(run.filter(entry => entry.event.endsWith("_provider_request_timing") &&
      entry.payload.stage === "dispatched"));
    const dispatch = timedDispatches[0] ?? opened[0];
    const result = uniqueCommandRecords(run.filter(entry => /_(?:provider_wire_shape|plan_provider_response_shape)$/.test(entry.event)));
    const receipt = run.find(entry =>
      /_(?:plan_read_completed|tool_execution_completed)$/.test(entry.event) &&
      READ_FILE_TOOL_NAMES.has(entry.payload.toolName) &&
      (entry.event.endsWith("_plan_read_completed") || entry.payload.status === "succeeded"));
    const mutation = run.find(entry => entry.event.endsWith("_tool_execution_completed") &&
      entry.payload.mutationCommitted === true);
    const validation = uniqueCommandRecords(run.filter(entry => entry.event.endsWith("_tool_execution_completed") &&
      typeof entry.payload.validationPassed === "boolean"));
    const firstRawText = result.find(entry => finite(entry.payload.firstPublicTextMs ??
      entry.payload.firstSemanticVisibleElapsedMs));
    const rawTextOffset = firstRawText?.payload.firstPublicTextMs ??
      firstRawText?.payload.firstSemanticVisibleElapsedMs;
    const matchingDispatch = timedDispatches.findLast(entry => entry.payload.commandKey === firstRawText?.payload.commandKey &&
      timeOf(entry) <= timeOf(firstRawText));
    const matchingOpen = opened.find(entry => entry.payload.commandKey === firstRawText?.payload.commandKey);
    const rawTextAt = finite(rawTextOffset) ? timeOf(matchingDispatch ?? matchingOpen) + rawTextOffset : NaN;
    const firstPublicText = run.find(entry => entry.event.endsWith("_provider_request_timing") &&
      entry.payload.stage === "first_public_text");
    const firstMilestone = run.find(entry => entry.event.endsWith("_projection_published") &&
      entry.payload.audience === "chat_milestone" && entry.payload.storeDisposition !== "ignored");
    const started = finite(submittedAt) && byRun.size === 1 ? submittedAt : timeOf(admission);
    const startedFrom = finite(submittedAt) && byRun.size === 1 ? "submitted" : "run_admission";
    const usage = summarizeBenchmarkUsage(result.map(entry => entry.payload.providerUsage ?? entry.payload));
    const official = summary?.payload;
    const inputTokens = official?.providerInputTokens ?? usage.inputTokens;
    const cachedInputTokens = official?.providerCachedInputTokens ?? usage.cachedInputTokens;
    const resultKind = official?.resultKind ?? final?.payload.resultKind ?? null;
    const firstVisibleAt = earliest(timeOf(firstPublicText), timeOf(firstMilestone), timeOf(finalProjection));
    const firstUsefulAt = earliest(timeOf(firstMilestone), timeOf(receipt), timeOf(mutation), timeOf(validation[0]),
      resultKind === "success" || resultKind === "partial" ? timeOf(final) : NaN);
    const strategy = summary || opened.some(entry => entry.event.endsWith("_plan_provider_request_opened"))
      ? "plan" : admission?.payload.strategy ??
      ({ runtime_v2_chat_admitted: "chat", runtime_v2_workspace_read_admitted: "analyze",
         runtime_v2_execute_admitted: "execute", runtime_v2_plan_admitted: "plan" }[admission?.event.replace("store.", "")]) ?? null;
    return {
      application: "main", runId, strategy, resultKind, timingOrigin: startedFrom,
      firstDispatchMs: elapsed(started, timeOf(dispatch)),
      firstProviderTextMs: elapsed(started, rawTextAt),
      firstVisibleMs: elapsed(started, firstVisibleAt),
      firstUsefulMs: elapsed(started, firstUsefulAt),
      firstFileReadMs: elapsed(started, timeOf(receipt)),
      firstMutationMs: elapsed(started, timeOf(mutation)),
      elapsedMs: elapsed(started, timeOf(final)) ?? (startedFrom === "run_admission" ? official?.elapsedMs ?? null : null),
      providerRequests: official?.modelRequestCount ?? (timedDispatches.length || opened.length),
      providerWallMs: official?.modelRequestToResponseMs ??
        (result.length && result.every(entry => finite(entry.payload.dispatchElapsedMs))
          ? sum(result.map(entry => entry.payload.dispatchElapsedMs)) : null),
      usage: { ...usage, inputTokens, cachedInputTokens, outputTokens: official?.providerOutputTokens ?? usage.outputTokens,
        uncachedInputTokens: finite(inputTokens) && finite(cachedInputTokens) ? inputTokens - cachedInputTokens : null },
      validation: { passed: validation.filter(entry => entry.payload.validationPassed).length,
        failed: validation.filter(entry => !entry.payload.validationPassed).length },
    };
  });
}

function parseOmlxMetrics(log) {
  const completions = [];
  let cacheRestore = null;
  for (const line of log.split(/\r?\n/)) {
    const time = line.match(/^(\d{4}-\d{2}-\d{2}) (\d\d:\d\d:\d\d),(\d{3})/);
    if (!time) continue;
    const at = Date.parse(`${time[1]}T${time[2]}.${time[3]}`);
    const cache = line.match(/Prefix cache restore .*?cached=(\d+) suffix=(\d+)/);
    if (cache) cacheRestore = { at, cached: Number(cache[1]), suffix: Number(cache[2]) };
    const done = line.match(/Chat completion: model=([^,]+), (\d+) tokens in ([\d.]+)s .*?prompt: (\d+)/);
    if (!done) continue;
    const wallMs = Math.round(Number(done[3]) * 1000);
    const inputTokens = Number(done[4]);
    const cachedInputTokens = cacheRestore && cacheRestore.at >= at - wallMs - 100 &&
      cacheRestore.cached + cacheRestore.suffix === inputTokens ? cacheRestore.cached : 0;
    const timing = line.match(/stream_visible_ttft=([\d.]+)s/);
    completions.push({ at, wallMs, model: done[1], inputTokens, cachedInputTokens,
      outputTokens: Number(done[2]), firstVisibleMs: timing ? Math.round(Number(timing[1]) * 1000) : null });
    cacheRestore = null;
  }
  return completions;
}

/** Twinny starts its generation timer after editor context preparation. Its
 * file diagnostic receipt and optional shell receipts are kept distinct. */
export function summarizeTwinnyBenchmark(log, omlxLog = "") {
  const completions = parseOmlxMetrics(omlxLog);
  const turns = [];
  let turn = null;
  for (const line of log.split(/\r?\n/)) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d\d:\d\d:\d\d\.\d{3}) \[\w+\] (.*)$/);
    if (!match) continue;
    const at = Date.parse(`${match[1]}T${match[2]}`);
    const message = match[3];
    const start = message.match(/^Chat → (.+) \(([^)]+)\) ·/);
    if (start) {
      turn = { at, model: start[1], provider: start[2], steps: [], firstRead: null, firstWrite: null,
        readCount: 0, editCount: 0, failedReadCount: 0, failedEditCount: 0, ideDiagnostics: 0 };
      continue;
    }
    if (!turn) continue;
    if (/^Chat tools · request \d+ /.test(message)) turn.steps.push(at);
    if (message.startsWith("Chat tools · read `")) {
      turn.firstRead ??= at;
      turn.readCount++;
    }
    if (message.startsWith("Chat edited ")) {
      turn.firstWrite ??= at;
      turn.editCount++;
    }
    if (message.startsWith("Chat tools · read_file failed")) turn.failedReadCount++;
    if (message.startsWith("Chat tools · edit_file failed")) turn.failedEditCount++;
    if (message.startsWith("Chat tools · checked ")) turn.ideDiagnostics++;
    if (!message.startsWith("Chat ← ")) continue;

    const steps = turn.steps.length ? turn.steps : [turn.at];
    const candidates = completions.filter(request => request.at >= turn.at && request.at <= at + 25);
    const correlated = candidates.length === steps.length && candidates.every((request, index) =>
      request.model === turn.model && request.at >= steps[index] && request.at < (steps[index + 1] ?? at + 26) &&
      Math.abs(request.at - request.wallMs - steps[index]) <= 500);
    // The visible wire delta may carry a tool invocation rather than human
    // readable text. Keep it distinct from MAIN's public UI text metric.
    turns.push({
      application: "twinny", model: turn.model, provider: turn.provider,
      startedAt: new Date(turn.at).toISOString(), timingOrigin: "generation_start",
      strategy: turn.editCount ? "execute" : turn.steps.length ? "analyze" : "chat",
      elapsedMs: elapsed(turn.at, at), firstFileReadMs: elapsed(turn.at, turn.firstRead),
      firstMutationMs: elapsed(turn.at, turn.firstWrite), firstVisibleMs: null,
      firstProviderVisibleMs: correlated ? candidates[0].firstVisibleMs : null,
      providerRequests: steps.length, providerWallMs: correlated ? sum(candidates.map(request => request.wallMs)) : null,
      usage: summarizeBenchmarkUsage(correlated ? candidates : []),
      tools: { read: turn.readCount, edit: turn.editCount, failedRead: turn.failedReadCount,
        failedEdit: turn.failedEditCount, ideDiagnostics: turn.ideDiagnostics },
    });
    turn = null;
  }
  return turns;
}

/** Restore the pre-edit side of a recorded Twinny reply into a new fixture.
 * All recorded post-edit hashes must match the source before it is copied. */
export async function prepareTwinnyBenchmarkFixture(archive, parent = os.tmpdir()) {
  if (!path.isAbsolute(archive.root || "") || !Array.isArray(archive.files) || !archive.files.length) {
    throw new Error("A Twinny reply-change archive with an absolute source root is required.");
  }
  const original = await snapshotUnityProject(archive.root, ["."]);
  const files = new Map();
  for (const entry of archive.files) {
    const relative = entry.path;
    if (typeof relative !== "string" || relative.includes("\\") || path.isAbsolute(relative) ||
        relative.split("/").some(component => !component || component === "." || component === "..") ||
        files.has(relative) || entry.status !== "modified" || typeof entry.before !== "string") {
      throw new Error("Only unique, relative modified files with recorded before content are supported.");
    }
    if (!original.files[relative] || original.files[relative].sha256 !== entry.afterHash) {
      throw new Error(`Source changed since the Twinny recording: ${relative}`);
    }
    files.set(relative, entry.before);
  }
  const fixture = await fs.mkdtemp(path.join(parent, "main-twinny-baseline-"));
  try {
    await fs.mkdir(path.join(fixture, "workspace"));
    const workspace = path.join(fixture, "workspace");
    for (const directory of original.directories) await fs.mkdir(path.join(workspace, directory), { recursive: true });
    for (const [relative, file] of Object.entries(original.files)) {
      const bytes = files.has(relative) ? Buffer.from(files.get(relative), "utf8") : Buffer.from(file.content, "base64");
      await fs.writeFile(path.join(workspace, relative), bytes, { mode: file.mode & 0o777 });
    }
    const before = await readBenchmarkWorkspaceFingerprint(workspace);
    const manifest = {
      workspace, replayedFiles: [...files.keys()], fileCount: Object.keys(before.files).length, sha256: before.sha256,
      evidence: "Recorded pre-edit bytes for touched files. Untouched files use the current source snapshot.",
    };
    await fs.writeFile(path.join(fixture, "manifest.json"), JSON.stringify({ ...manifest, files: before.files }, null, 2));
    return manifest;
  } catch (error) {
    await fs.rm(fixture, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    "main-log": { type: "string" }, "twinny-log": { type: "string" }, "omlx-log": { type: "string" },
    "main-run": { type: "string" }, "twinny-archive": { type: "string" },
  } });
  const read = async name => values[name] ? fs.readFile(values[name], "utf8") : "";
  if (values["twinny-archive"]) {
    const archive = JSON.parse(await read("twinny-archive"));
    console.log(JSON.stringify(await prepareTwinnyBenchmarkFixture(archive), null, 2));
    return;
  }
  if (!values["main-log"] && !values["twinny-log"]) {
    throw new Error("Provide --main-log, --twinny-log (optionally --omlx-log), or --twinny-archive.");
  }
  const [mainLog, twinnyLog, omlxLog] = await Promise.all([read("main-log"), read("twinny-log"), read("omlx-log")]);
  console.log(JSON.stringify({
    main: summarizeMainBenchmark(parseAgentRuntimeLog(mainLog), { runId: values["main-run"] }),
    twinny: summarizeTwinnyBenchmark(twinnyLog, omlxLog),
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

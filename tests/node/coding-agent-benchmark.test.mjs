import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyBenchmarkFirstResponse, prepareTwinnyBenchmarkFixture, readChatCompletionUsage, summarizeMainBenchmark,
  summarizeTwinnyBenchmark,
} from "../../scripts/coding-agent-benchmark.mjs";

test("Twinny correlation counts cached and uncached tokens without treating editor diagnostics as builds", () => {
  const log = [
    "2026-11-26 10:23:00.000 [info] Chat → test-model (oMLX) · 2 messages, 123 chars",
    "2026-11-26 10:23:00.000 [info] Chat tools · request 1 (native) · 50 chars, about 20 tokens",
    "2026-11-26 10:23:01.100 [info] Chat tools · read `Code.cs:1–16`",
    "2026-11-26 10:23:01.200 [info] Chat tools · request 2 (native) · 80 chars, about 40 tokens",
    "2026-11-26 10:23:02.400 [info] Chat edited Code.cs:4",
    "2026-11-26 10:23:02.600 [info] Chat tools · edit_file failed · Code.cs: no match",
    "2026-11-26 10:23:02.800 [info] Chat tools · checked `Code.cs` · clean",
    "2026-11-26 10:23:03.000 [info] Chat ← 3s · 1807 chars",
  ].join("\n");
  const server = [
    "2026-11-26 10:23:01,000 - Chat completion: model=test-model, 20 tokens in 1.00s (20 tok/s), prompt: 40, stream_visible_ttft=0.32s",
    "2026-11-26 10:23:01,300 - Prefix cache restore for test: source=paged cached=40 suffix=20",
    "2026-11-26 10:23:02,300 - Chat completion: model=test-model, 30 tokens in 1.10s (30 tok/s), prompt: 60",
  ].join("\n");
  const [report] = summarizeTwinnyBenchmark(log, server);
  assert.equal(report.strategy, "execute");
  assert.equal(report.timingOrigin, "generation_start");
  assert.equal(report.firstFileReadMs, 1100);
  assert.equal(report.firstMutationMs, 2400);
  assert.equal(report.firstProviderVisibleMs, 320);
  assert.equal(report.firstVisibleMs, null);
  assert.equal(report.providerRequests, 2);
  assert.deepEqual(report.usage, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 50,
    maxInputTokens: 60, uncachedInputTokens: 60 });
  assert.deepEqual(report.tools, { read: 1, edit: 1, failedRead: 0, failedEdit: 1, ideDiagnostics: 1 });
  const [ambiguous] = summarizeTwinnyBenchmark(log,
    server + "\n2026-11-26 10:23:02,050 - Chat completion: model=other, 3 tokens in 0.1s (30 tok/s), prompt: 10");
  assert.equal(ambiguous.usage.inputTokens, null);
});

test("Chat Completions report reads final numeric usage without treating missing cache details as a miss", () => {
  const chunk = JSON.stringify({ usage: { prompt_tokens: 55, completion_tokens: 9 } });
  assert.deepEqual(readChatCompletionUsage(`data: {broken}\n\ndata: ${chunk}\n\ndata: [DONE]\n\n`),
    { inputTokens: 55, outputTokens: 9, cachedInputTokens: null });
  assert.equal(readChatCompletionUsage("data: {}\n\ndata: [DONE]"), null);
});

test("first-response classification reveals only the protocol shape", () => {
  const withDelta = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n`;
  assert.equal(classifyBenchmarkFirstResponse(withDelta({ content: "{\n" })), "json_without_header");
  assert.equal(classifyBenchmarkFirstResponse(withDelta({ tool_calls: [{}] })), "tool_without_header");
  assert.equal(classifyBenchmarkFirstResponse(withDelta({ content: "MAIN_INTENT {}\nprivate body" })), "header_and_answer");
});

test("MAIN perf report separates user submit, first evidence, mutation, and validation outcome by Run", () => {
  const events = [
    [1001, "execute_admitted", {}],
    [1002, "provider_request_opened", { commandKey: "first" }],
    [1003, "provider_request_timing", { commandKey: "first", stage: "dispatched" }],
    [1004, "provider_wire_shape", { commandKey: "first", firstSemanticVisibleElapsedMs: 500,
      inputTokens: 12, cachedInputTokens: 10, outputTokens: 8 }],
    [1005, "tool_execution_completed", { toolName: "read_file", status: "failed" }],
    [1006, "tool_execution_completed", { toolName: "read_file", status: "succeeded" }],
    [1007, "tool_execution_completed", { toolName: "apply_patch", mutationCommitted: true }],
    [1008, "tool_execution_completed", { toolName: "run_command", validationPassed: false }],
    [1009, "projection_published", { audience: "final", resultKind: "partial" }],
  ].map(([timestamp, event, payload]) => ({
    timestamp: String(timestamp), event: `store.runtime_v2_${event}`, payload: { runId: "run", ...payload },
  }));
  events.push({ ...events[3], timestamp: "1009.1" });
  const [report] = summarizeMainBenchmark(events, { runId: "run", submittedAt: 1_000_000 });
  assert.equal(report.strategy, "execute");
  assert.equal(report.resultKind, "partial");
  assert.equal(report.firstDispatchMs, 3000);
  assert.equal(report.firstProviderTextMs, 3500);
  assert.equal(report.firstVisibleMs, 9000, "the action draft is not public output");
  assert.equal(report.firstUsefulMs, 6000, "the failed read is not evidence");
  assert.equal(report.firstFileReadMs, 6000);
  assert.equal(report.firstMutationMs, 7000);
  assert.equal(report.elapsedMs, 9000);
  assert.deepEqual(report.validation, { passed: 0, failed: 1 });
  assert.equal(report.usage.uncachedInputTokens, 2);
});

test("MAIN reports first actual public stream and durable milestone separately", () => {
  const events = [
    [1000, "workspace_read_admitted", {}],
    [1001, "provider_request_timing", { commandKey: "analyze", stage: "dispatched" }],
    [1002, "provider_request_timing", { commandKey: "analyze", stage: "first_public_text" }],
    [1003, "projection_published", { audience: "chat_milestone", storeDisposition: "ignored" }],
    [1004, "projection_published", { audience: "chat_milestone", storeDisposition: "projected" }],
    [1005, "projection_published", { audience: "final", resultKind: "success" }],
  ].map(([timestamp, event, payload]) => ({
    timestamp: String(timestamp), event: `store.runtime_v2_${event}`, payload: { runId: "read", ...payload },
  }));
  const [report] = summarizeMainBenchmark(events);
  assert.equal(report.firstVisibleMs, 2000);
  assert.equal(report.firstUsefulMs, 4000);
  assert.equal(report.firstProviderTextMs, null, "missing legacy timing remains unknown");
});

test("Twinny archive fixture replays before bytes into a distinct workspace and refuses drift or traversal", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "coding-benchmark-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const assets = path.join(parent, "Assets");
  const file = path.join(assets, "MFramework", "Code.cs");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "after\n");
  await fs.writeFile(path.join(assets, "untouched.cs"), "keep me\n");
  const archive = { root: assets, files: [{ path: "MFramework/Code.cs", status: "modified", before: "before\n",
    afterHash: createHash("sha256").update("after\n").digest("hex") }] };
  const fixture = await prepareTwinnyBenchmarkFixture(archive, parent);
  assert.equal(fixture.fileCount, 2);
  assert.equal(await fs.readFile(file, "utf8"), "after\n");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "MFramework", "Code.cs"), "utf8"), "before\n");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "untouched.cs"), "utf8"), "keep me\n");
  await assert.rejects(prepareTwinnyBenchmarkFixture({ ...archive,
    files: [{ ...archive.files[0], path: "../outside" }] }, parent), /relative/);
  await fs.writeFile(file, "newer\n");
  await assert.rejects(prepareTwinnyBenchmarkFixture(archive, parent), /changed/);
});

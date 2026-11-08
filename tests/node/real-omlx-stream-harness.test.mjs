import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const { createRealOmlxStreamInactivity, createRealOmlxStreamCapture } = createTsModuleLoader()(
  "tests/e2e/realOmlxStreamHarness.ts",
);

test("continuous nonempty transport progress outlives one timeout window", async () => {
  const timeoutMs = 100;
  const clock = createRealOmlxStreamInactivity(timeoutMs);
  const start = Date.now();
  await clock.wait(() => delay(20));
  clock.headersReceived();
  for (let index = 0; index < 7; index += 1) {
    const bytes = await clock.wait(() => delay(25, new Uint8Array([index + 1])));
    clock.observeChunk(bytes.byteLength);
  }
  assert.ok(Date.now() - start > timeoutMs);
  await clock.wait(() => Promise.resolve({ done: true }));
});

test("response headers and first chunk own independent inactivity windows", async () => {
  let now = 0;
  const clock = createRealOmlxStreamInactivity(100, () => now);
  await clock.wait(() => Promise.resolve());
  now = 90;
  clock.headersReceived();
  now = 150;
  await clock.wait(() => Promise.resolve());
  clock.observeChunk(1);
  assert.equal(clock.phase, "idle_chunk");
});

for (const phase of ["response_headers", "first_chunk", "idle_chunk"]) {
  test(`a true ${phase} stall expires`, async () => {
    const clock = createRealOmlxStreamInactivity(25);
    if (phase !== "response_headers") clock.headersReceived();
    if (phase === "idle_chunk") clock.observeChunk(1);
    await assert.rejects(clock.wait(() => new Promise(() => {})), new RegExp(`STREAM_REQUEST_TIMEOUT: ${phase}`));
  });
}

test("empty transport chunks do not renew inactivity, but split UTF-8 bytes do", async () => {
  let now = 0;
  const clock = createRealOmlxStreamInactivity(100, () => now);
  clock.headersReceived();
  now = 80;
  clock.observeChunk(1); // A partial UTF-8 code point is real byte progress.
  now = 150;
  await clock.wait(() => Promise.resolve());
  clock.observeChunk(0);
  now = 181;
  await assert.rejects(clock.wait(() => Promise.resolve()), /idle_chunk/);
});

test("omitted transport timeout remains unbounded inside the outer test budget", async () => {
  let now = 0;
  const clock = createRealOmlxStreamInactivity(null, () => now);
  now = 1_000_000;
  assert.equal(await clock.wait(() => Promise.resolve("headers")), "headers");
  clock.headersReceived();
  now += 1_000_000;
  assert.equal(await clock.wait(() => Promise.resolve("chunk")), "chunk");
});

for (const reason of ["STREAM_REQUEST_TIMEOUT: idle_chunk", "runtime_v2_stream_canceled", "outer_test_finished"]) {
  test(`partial SSE persists truthfully on ${reason}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "main-stream-capture-"));
    try {
      const base = path.join(dir, "partial");
      const capture = createRealOmlxStreamCapture(base);
      const text = 'data: {"choices":[{"delta":{"content":"unfinished';
      capture.append(text, Buffer.byteLength(text));
      const finish = capture.finish(false, reason);
      capture.append("late bytes", 10);
      assert.equal(capture.finish(true, null), finish);
      await finish;
      assert.equal(await fs.readFile(`${base}.response.sse`, "utf8"), text);
      const meta = JSON.parse(await fs.readFile(`${base}.response-meta.json`, "utf8"));
      assert.equal(meta.complete, false);
      assert.equal(meta.incomplete, true);
      assert.equal(meta.truncated, true);
      assert.equal(meta.incompleteReason, reason);
      assert.equal(meta.totalBytes, Buffer.byteLength(text));
      assert.equal(meta.chunks, 1);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}

test("complete SSE stays complete while recording diagnostic capture truncation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "main-stream-capture-"));
  try {
    const base = path.join(dir, "complete");
    const capture = createRealOmlxStreamCapture(base, 5);
    capture.append("data: [DONE]", 12);
    await capture.finish(true, null);
    const meta = JSON.parse(await fs.readFile(`${base}.response-meta.json`, "utf8"));
    assert.equal(await fs.readFile(`${base}.response.sse`, "utf8"), "data:");
    assert.equal(meta.complete, true);
    assert.equal(meta.incomplete, false);
    assert.equal(meta.incompleteReason, null);
    assert.equal(meta.truncated, true);
    assert.equal(meta.totalChars, 12);
    assert.equal(meta.recordedChars, 5);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

async function actualStreamShim(fetch, directory, replayConfirmation = false) {
  const source = await fs.readFile("tests/e2e/real-omlx-plan-flow.spec.ts", "utf8");
  const fixture = source.slice(source.indexOf("const breakoutTask = "), source.indexOf("const realOmlxImagePath = "));
  const code = fixture + "const breakoutColdRestore = false; let breakoutConfirmationReplayed = false;\n" +
    source.slice(source.indexOf("  type RealOmlxChatStream = {"),
      source.indexOf('  await page.exposeFunction("__MAIN_E2E_WEB_READ"')) + "\nreturn breakoutTask;";
  const { default: ts } = await import("typescript");
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const handlers = {};
  const page = { exposeFunction: async (name, handler) => { handlers[name] = handler; } };
  const providerWire = [];
  const { createHash } = await import("node:crypto");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const breakoutTask = await new AsyncFunction("page", "createRealOmlxStreamCapture", "createRealOmlxStreamInactivity", "fetch", "fs", "path", "createHash", "providerWire", "process", "console", "testInfo", compiled)(
    page, createRealOmlxStreamCapture, createRealOmlxStreamInactivity, fetch, fs, path, createHash, providerWire,
    { env: { REAL_OMLX_PROTOCOL_EVIDENCE_DIR: directory, ...(replayConfirmation ? { REAL_OMLX_BREAKOUT_REPLAY_CONFIRMATION: "1" } : {}) } },
    { log() {}, warn() {} }, { title: "real OMLX Breakout incident Plan reaches exact review with fixture" },
  );
  return { open: handlers.__MAIN_E2E_CHAT_STREAM_OPEN, read: handlers.__MAIN_E2E_CHAT_STREAM_READ,
    cancel: handlers.__MAIN_E2E_CHAT_STREAM_CANCEL, close: page.__realOmlxCloseChatStreams, providerWire, breakoutTask };
}
const streamArgs = streamId => ({ streamId, url: "http://fixture.invalid/chat", headers: {},
  body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "fixture" }] }), timeoutMs: 1_000 });

test("the opt-in Breakout replay substitutes only the original confirmation response", async () => {
  let forwarded = 0;
  const shim = await actualStreamShim(async () => {
    forwarded++;
    return new Response("data: [DONE]\n\n");
  }, undefined, true);
  const ask = { type: "function", function: { name: "ask_plan_questions" } };
  const open = (streamId, content, tools) => shim.open({ ...streamArgs(streamId),
    body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content }], tools }) });
  const read = async streamId => {
    let text = "";
    while (true) {
      const result = await shim.read(streamId);
      text += result.chunk;
      if (result.done) return text;
    }
  };
  await open("wrong-objective", "Another task", [ask]);
  await read("wrong-objective");
  await open("missing-tool", shim.breakoutTask, []);
  await read("missing-tool");
  await open("recorded-confirmation", shim.breakoutTask, [ask]);
  const replayed = await read("recorded-confirmation");
  assert.match(replayed, /"name":"ask_plan_questions"/);
  assert.match(replayed, /打砖块游戏设计确认/);
  await open("real-continuation", shim.breakoutTask, [ask]);
  await read("real-continuation");
  assert.equal(forwarded, 3);
  assert.deepEqual(shim.providerWire.map(request => request.responseOrigin),
    ["real_omlx", "real_omlx", "recorded_breakout_confirmation", "real_omlx"]);
});

// Exercise the actual registered spec handlers without a browser or model.
test("actual stream shim accepts header + progressing generation longer than its unchanged window", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-stream-shim-"));
  try {
    const start = Date.now();
    let index = 0;
    const shim = await actualStreamShim(async () => {
      await delay(600);
      return new Response(new ReadableStream({ async pull(controller) {
        await delay(index === 0 ? 600 : 120);
        if (index++ < 5) controller.enqueue(new TextEncoder().encode(`data: chunk-${index}\n\n`));
        else controller.close();
      } }));
    }, directory);
    await shim.open(streamArgs("continuous"));
    let text = "";
    while (true) { const result = await shim.read("continuous"); text += result.chunk; if (result.done) break; }
    assert.ok(Date.now() - start > 1_000);
    assert.match(text, /chunk-5/);
    const meta = JSON.parse(await fs.readFile(path.join(directory, "continuous.response-meta.json"), "utf8"));
    assert.equal(meta.complete, true);
    assert.equal(meta.truncated, false);
    assert.equal(meta.chunks, 5);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("actual stream shim expires a stalled read and records its incomplete raw SSE", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-stream-shim-"));
  try {
    let index = 0;
    const partial = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
    const shim = await actualStreamShim(async () => new Response(new ReadableStream({ pull(controller) {
      if (index++ === 0) controller.enqueue(new TextEncoder().encode(partial));
      else return new Promise(() => {});
    } })), directory);
    await shim.open(streamArgs("stalled"));
    assert.equal((await shim.read("stalled")).chunk, partial);
    await assert.rejects(shim.read("stalled"), /STREAM_REQUEST_TIMEOUT: idle_chunk/);
    assert.equal(await fs.readFile(path.join(directory, "stalled.response.sse"), "utf8"), partial);
    const meta = JSON.parse(await fs.readFile(path.join(directory, "stalled.response-meta.json"), "utf8"));
    assert.equal(meta.complete, false);
    assert.equal(meta.truncated, true);
    assert.equal(meta.phase, "idle_chunk");
    assert.match(meta.incompleteReason, /STREAM_REQUEST_TIMEOUT/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("actual cancellation retains partial evidence despite a late EOF and a never-settling reader cancel", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-stream-shim-"));
  try {
    let index = 0;
    const shim = await actualStreamShim(async () => new Response(new ReadableStream({ pull(controller) {
      if (index++ === 0) controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
      else return new Promise(() => {});
    }, cancel() { return new Promise(() => {}); } })), directory);
    await shim.open(streamArgs("canceled"));
    await shim.read("canceled");
    const pending = shim.read("canceled");
    await Promise.race([shim.cancel("canceled"), delay(300).then(() => { throw new Error("cancel waited for reader.cancel"); })]);
    assert.deepEqual(await pending, { done: true, chunk: "", canceled: true });
    await shim.close();
    const meta = JSON.parse(await fs.readFile(path.join(directory, "canceled.response-meta.json"), "utf8"));
    assert.equal(meta.complete, false);
    assert.equal(meta.incompleteReason, "runtime_v2_stream_canceled");
    assert.equal(await fs.readFile(path.join(directory, "canceled.response.sse"), "utf8"), "data: partial\n\n");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("actual cancellation before response headers aborts fetch and persists the empty incomplete phase", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-stream-shim-"));
  try {
    let started;
    const fetchStarted = new Promise(resolve => { started = resolve; });
    const shim = await actualStreamShim((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
      started();
    }), directory);
    const opening = shim.open(streamArgs("headers-canceled"));
    await fetchStarted;
    assert.equal(await shim.cancel("headers-canceled"), true);
    assert.deepEqual(await opening, { status: 0, canceled: true });
    const meta = JSON.parse(await fs.readFile(path.join(directory, "headers-canceled.response-meta.json"), "utf8"));
    assert.equal(meta.complete, false);
    assert.equal(meta.phase, "response_headers");
    assert.equal(meta.incompleteReason, "runtime_v2_stream_canceled");
    assert.equal(meta.totalBytes, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("actual outer cleanup archives an active read without turning its late EOF into success", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-stream-shim-"));
  try {
    let index = 0;
    const shim = await actualStreamShim(async () => new Response(new ReadableStream({ pull(controller) {
      if (index++ === 0) controller.enqueue(new TextEncoder().encode("data: before outer timeout\n\n"));
      else return new Promise(() => {});
    } })), directory);
    await shim.open(streamArgs("outer-canceled"));
    await shim.read("outer-canceled");
    const pending = shim.read("outer-canceled");
    await shim.close();
    assert.deepEqual(await pending, { done: true, chunk: "", canceled: true });
    const meta = JSON.parse(await fs.readFile(path.join(directory, "outer-canceled.response-meta.json"), "utf8"));
    assert.equal(meta.complete, false);
    assert.equal(meta.incompleteReason, "outer_test_finished");
    assert.equal(meta.chunks, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("browser stream bridge reports host cancellation truthfully and preserves real transport errors", async () => {
  const source = await fs.readFile("tests/e2e/real-omlx-plan-flow.spec.ts", "utf8");
  const code = source.slice(source.indexOf('      if (cmd === "start_chat_stream") {'),
    source.indexOf('      if (cmd === "get_project_skeleton") {'));
  const { default: ts } = await import("typescript");
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const invoke = new AsyncFunction("cmd", "args", "window", "emitTauriEvent", "canceledStreamIds", compiled);
  for (const phase of ["before_open", "headers", "read", "error"]) {
    const events = [];
    let reads = 0;
    const canceled = new Set(phase === "before_open" ? ["stream"] : []);
    const browser = {
      __MAIN_E2E_CHAT_STREAM_OPEN: async () => {
        if (phase === "before_open") assert.fail("already canceled stream reopened");
        if (phase === "error") throw new Error("network failure");
        return { canceled: phase === "headers" };
      },
      __MAIN_E2E_CHAT_STREAM_READ: async () => { reads++; return { done: true, chunk: "", canceled: true }; },
    };
    await invoke("start_chat_stream", { streamId: "stream" }, browser, (name, data) => events.push({ name, ...data }), canceled);
    assert.equal(reads, phase === "read" ? 1 : 0);
    assert.deepEqual(events.map(event => event.status), phase === "before_open" ? [] : phase === "error" ? ["error"] : ["cancelled"]);
    assert.equal(events.some(event => event.status === "ok"), false);
  }
});

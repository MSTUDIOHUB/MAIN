import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (cache.has(normalizedPath)) return cache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fsSync.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  cache.set(normalizedPath, module.exports);
  return module.exports;
}

const devServerRuntime = loadTs(path.join(workspaceRoot, "src/lib/devServerRuntime.ts"));
const cachePolicy = loadTs(path.join(workspaceRoot, "src/lib/readOnlyToolCachePolicy.ts"));
const sanitizer = loadTs(path.join(workspaceRoot, "src/lib/ptyOutputSanitizer.ts"));
const ipc = loadTs(path.join(workspaceRoot, "src/lib/ipc.ts"));
const toolExecutor = loadTs(path.join(workspaceRoot, "src/lib/toolExecutor.ts"));
const ptyCommandRuntime = loadTs(path.join(workspaceRoot, "src/lib/ptyCommandRuntime.ts"));
const recoveryTools = loadTs(path.join(workspaceRoot, "src/lib/approvedPlanRecoveryTools.ts"));
const planEvidence = loadTs(path.join(workspaceRoot, "src/lib/planEvidence.ts"));

test("PTY observation analysis distinguishes waiting, readiness, and later failure", () => {
  const waiting = devServerRuntime.analyzePtyObservationResult(JSON.stringify({
    running: true,
    tail: "Waiting for your frontend dev server to start on http://localhost:1420/",
  }));
  assert.equal(waiting.status, "running");

  const ready = devServerRuntime.analyzePtyObservationResult(JSON.stringify({
    running: true,
    tail: "Error: old launch failed\nVITE v7.0.4 ready in 812 ms\nLocal: http://localhost:1420/",
  }));
  assert.equal(ready.status, "ready");
  assert.equal(ready.url, "http://localhost:1420/");

  const failed = devServerRuntime.analyzePtyObservationResult(JSON.stringify({
    running: false,
    exitCode: 1,
    tail: "VITE ready in 812 ms\nLocal: http://localhost:1420/\nError: process exited with code 1",
  }));
  assert.equal(failed.status, "failed");

  const restartedAfterOldFailure = devServerRuntime.analyzePtyObservationResult(JSON.stringify({
    active: true,
    running: true,
    foregroundState: "busy",
    tail: "Error: old launch failed\nStarting development server",
  }));
  assert.equal(restartedAfterOldFailure.status, "running");
});

test("PTY observation uses foreground ownership instead of the persistent login shell", () => {
  const readyReadPayload = devServerRuntime.analyzePtyObservationResult(JSON.stringify({
    text: "VITE ready in 120 ms\nLocal: http://localhost:1420/",
    startOffset: 100,
    endOffset: 158,
    truncated: false,
  }));
  assert.equal(readyReadPayload.status, "ready");
  assert.equal(readyReadPayload.url, "http://localhost:1420/");

  const occupied = devServerRuntime.analyzePtyObservationResult(JSON.stringify({
    active: true,
    running: true,
    pid: 100,
    foregroundPid: 200,
    shellAvailable: false,
    tail: "",
  }));
  assert.equal(occupied.status, "running");

  const released = devServerRuntime.analyzePtyObservationResult(JSON.stringify({
    active: true,
    running: true,
    pid: 100,
    foregroundPid: 100,
    shellAvailable: true,
    tail: "VITE ready in 500 ms\nLocal: http://localhost:1420/",
  }));
  assert.equal(released.status, "stopped");

  const unsupportedForegroundInspection = devServerRuntime.analyzePtyObservationResult(JSON.stringify({
    active: true,
    running: true,
    pid: 100,
    foregroundPid: null,
    shellAvailable: true,
    foregroundState: "unknown",
    tail: "",
  }));
  assert.equal(unsupportedForegroundInspection.status, "running");
});

test("PTY busy means observe the existing foreground process, not port or terminal failure", () => {
  const busy = devServerRuntime.analyzePtyObservationResult(
    "PTY_BUSY: integrated terminal is occupied by foreground generation=4",
  );
  assert.equal(busy.status, "running");
  assert.equal(busy.terminalBusy, true);
  assert.equal(busy.portConflict, false);
  assert.deepEqual(
    devServerRuntime.classifyPtyCommandFailure("PTY_BUSY: foreground process is still running"),
    {
      kind: "pty_occupied",
      terminalBusy: true,
      portConflict: false,
      nextCapability: "observe_pty",
    },
  );
  assert.deepEqual(
    devServerRuntime.classifyPtyCommandFailure("Error: listen EADDRINUSE: address already in use"),
    {
      kind: "port_conflict",
      terminalBusy: false,
      portConflict: true,
      nextCapability: "probe_existing_service",
    },
  );
});

test("dev-server lifecycle ignores stale PTY generations and opens browser only after current readiness", () => {
  const launch = {
    id: "launch-2",
    kind: "cmd",
    value: "npm run dev",
    sourceTool: "execute_command",
    observationStatus: "pending",
    foregroundGeneration: 2,
    outputSequence: 80,
    createdAt: 10,
  };
  const staleReady = {
    id: "ready-1",
    kind: "dev_server_url",
    value: "http://localhost:1111/",
    sourceTool: "read_pty_since",
    observationStatus: "ready",
    foregroundGeneration: 1,
    outputSequence: 120,
    createdAt: 11,
  };
  assert.deepEqual(devServerRuntime.resolveDevServerRuntimeState([launch, staleReady]), {
    status: "pending",
    url: null,
    foregroundGeneration: 2,
    outputSequence: 80,
    terminalBusy: false,
    portConflict: false,
    nextCapability: "observe_pty",
  });

  const currentReady = {
    ...staleReady,
    id: "ready-2",
    value: "http://localhost:1420/",
    foregroundGeneration: 2,
    outputSequence: 180,
    terminalBusy: true,
    createdAt: 12,
  };
  const readyState = devServerRuntime.resolveDevServerRuntimeState([launch, staleReady, currentReady]);
  assert.equal(readyState.status, "ready");
  assert.equal(readyState.url, "http://localhost:1420/");
  assert.equal(readyState.nextCapability, "browser");
  assert.equal(readyState.foregroundGeneration, 2);
  assert.equal(readyState.outputSequence, 180);

  const preflight = devServerRuntime.resolveBrowserValidationPreflight({
    requestedUrl: "http://localhost:5173/",
    ledger: [launch, staleReady, currentReady],
  });
  assert.equal(preflight.action, "correct");
  assert.equal(preflight.url, "http://localhost:1420/");
  assert.equal(preflight.nextCapability, "browser");
  assert.equal(preflight.reason, null);
});

test("readiness stays sticky for one PTY generation and a healthy existing service reconciles a real port conflict", () => {
  const launch = {
    id: "launch",
    kind: "cmd",
    value: "npm run dev",
    sourceTool: "execute_command",
    observationStatus: "pending",
    foregroundGeneration: 5,
    createdAt: 1,
  };
  const ready = {
    id: "ready",
    kind: "dev_server_url",
    value: "http://localhost:1420/",
    sourceTool: "read_pty_since",
    observationStatus: "ready",
    foregroundGeneration: 5,
    createdAt: 2,
  };
  const incrementalRunning = {
    id: "running",
    kind: "tool",
    value: "terminal",
    sourceTool: "read_pty_since",
    observationStatus: "running",
    foregroundGeneration: 5,
    outputSequence: 240,
    createdAt: 3,
  };
  const sticky = devServerRuntime.resolveDevServerRuntimeState([launch, ready, incrementalRunning]);
  assert.equal(sticky.status, "ready");
  assert.equal(sticky.url, "http://localhost:1420/");
  assert.equal(sticky.nextCapability, "browser");
  assert.equal(sticky.outputSequence, 240);

  const conflict = {
    id: "conflict",
    kind: "cmd",
    value: "npm run dev",
    sourceTool: "execute_command",
    observationStatus: "failed",
    portConflict: true,
    createdAt: 4,
  };
  const conflicted = devServerRuntime.resolveDevServerRuntimeState([conflict]);
  assert.equal(conflicted.status, "failed");
  assert.equal(conflicted.portConflict, true);
  assert.equal(conflicted.nextCapability, "reconcile");

  const healthyProbe = {
    id: "probe",
    kind: "cmd",
    value: "curl -fsS http://localhost:1420/",
    sourceTool: "run_command",
    createdAt: 5,
  };
  const reused = devServerRuntime.resolveDevServerRuntimeState([conflict, healthyProbe]);
  assert.equal(reused.status, "ready");
  assert.equal(reused.url, "http://localhost:1420/");
  assert.equal(reused.portConflict, false);
  assert.equal(reused.nextCapability, "browser");
});

test("a running execute_command starts a new generation and cannot inherit old readiness", () => {
  const oldLaunch = {
    id: "launch-old",
    kind: "cmd",
    value: "npm run dev",
    sourceTool: "execute_command",
    observationStatus: "pending",
    foregroundGeneration: 8,
    createdAt: 1,
  };
  const oldReady = {
    id: "ready-old",
    kind: "dev_server_url",
    value: "http://localhost:1420/",
    sourceTool: "read_pty_since",
    observationStatus: "ready",
    foregroundGeneration: 8,
    createdAt: 2,
  };
  const newRunningLaunch = {
    id: "launch-new",
    kind: "cmd",
    value: "npm run dev",
    sourceTool: "execute_command",
    observationStatus: "running",
    foregroundGeneration: 9,
    outputSequence: 20,
    createdAt: 3,
  };
  const staleTail = {
    ...oldReady,
    id: "stale-tail",
    createdAt: 4,
  };

  const state = devServerRuntime.resolveDevServerRuntimeState([
    oldLaunch,
    oldReady,
    newRunningLaunch,
    staleTail,
  ]);
  assert.equal(state.status, "running");
  assert.equal(state.url, null);
  assert.equal(state.foregroundGeneration, 9);
  assert.equal(state.outputSequence, 20);
  assert.equal(state.nextCapability, "observe_pty");
});

test("PTY evidence retains generation and output cursor for resume", () => {
  const launch = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "execute_command",
    target: "npm run dev",
    result: JSON.stringify({
      command: "npm run dev",
      output: "starting",
      foregroundGeneration: 7,
      endOffset: 88,
    }),
  });
  assert.equal(launch.observationStatus, "pending");
  assert.equal(launch.foregroundGeneration, 7);
  assert.equal(launch.outputSequence, 88);

  const ready = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "read_pty_since",
    target: "terminal",
    result: JSON.stringify({
      text: "VITE ready in 100 ms\nLocal: http://localhost:1420/",
      foregroundGeneration: 7,
      endOffset: 144,
    }),
  });
  assert.equal(ready.observationStatus, "ready");
  assert.equal(ready.foregroundGeneration, 7);
  assert.equal(ready.outputSequence, 144);
});

test("ordered evidence ledger retains repeated mutations and browser validations", () => {
  const mutation = {
    id: "mutation-1",
    kind: "file",
    value: "src/App.tsx",
    sourceTool: "apply_patch",
    createdAt: 1,
  };
  const browser = {
    id: "browser-1",
    kind: "browser_dom",
    value: "http://localhost:1420/",
    sourceTool: "browser_evaluate",
    createdAt: 2,
  };
  let ledger = planEvidence.appendPlanEvidenceEntry([], mutation);
  ledger = planEvidence.appendPlanEvidenceEntry(ledger, { ...mutation, id: "mutation-2", createdAt: 3 });
  ledger = planEvidence.appendPlanEvidenceEntry(ledger, browser);
  ledger = planEvidence.appendPlanEvidenceEntry(ledger, { ...browser, id: "browser-2", createdAt: 4 });
  assert.deepEqual(ledger.map((entry) => entry.id), [
    "mutation-1",
    "mutation-2",
    "browser-1",
    "browser-2",
  ]);
});

test("latest pending launch invalidates an older observed dev-server URL", () => {
  const ready = {
    id: "ready",
    kind: "dev_server_url",
    value: "http://localhost:1420/",
    sourceTool: "read_pty_since",
    observationStatus: "ready",
    createdAt: 1,
  };
  assert.equal(devServerRuntime.resolveLatestObservedDevServerUrl([ready]), "http://localhost:1420/");
  const restartedLedger = [
    ready,
    {
      id: "restart",
      kind: "cmd",
      value: "npm run dev",
      sourceTool: "execute_command",
      observationStatus: "pending",
      createdAt: 2,
    },
  ];
  assert.equal(devServerRuntime.resolveLatestObservedDevServerUrl(restartedLedger), null);
  assert.deepEqual(devServerRuntime.resolveDevServerRuntimeObservation(restartedLedger), {
    status: "pending",
    url: null,
  });

  const unknownTail = {
    id: "unknown-tail",
    kind: "tool",
    value: "terminal",
    sourceTool: "read_pty_tail",
    observationStatus: "unknown",
    createdAt: 3,
  };
  assert.deepEqual(devServerRuntime.resolveDevServerRuntimeObservation([...restartedLedger, unknownTail]), {
    status: "pending",
    url: null,
  });
  assert.equal(devServerRuntime.resolveBrowserValidationPreflight({
    requestedUrl: "http://localhost:5173/",
    ledger: [...restartedLedger, unknownTail],
  }).action, "block");
});

test("browser validation adopts the runtime-observed local origin", () => {
  const resolved = devServerRuntime.reconcileBrowserValidationUrl({
    requestedUrl: "http://localhost:5173/editor?mode=test",
    observedUrl: "http://localhost:1420/",
  });
  assert.equal(resolved.corrected, true);
  assert.equal(resolved.url, "http://localhost:1420/editor?mode=test");

  const blocked = devServerRuntime.resolveBrowserValidationPreflight({
    requestedUrl: "http://localhost:5173/",
    ledger: [{
      id: "pending",
      kind: "cmd",
      value: "npm run dev",
      sourceTool: "execute_command",
      observationStatus: "pending",
      createdAt: 1,
    }],
  });
  assert.equal(blocked.action, "block");

  const corrected = devServerRuntime.resolveBrowserValidationPreflight({
    requestedUrl: "http://localhost:5173/",
    ledger: [{
      id: "ready",
      kind: "dev_server_url",
      value: "http://localhost:1420/",
      sourceTool: "read_pty_since",
      observationStatus: "ready",
      createdAt: 2,
    }],
  });
  assert.equal(corrected.action, "correct");
  assert.equal(corrected.url, "http://localhost:1420/");
});

test("volatile terminal observations are never eligible for the read-only cache", () => {
  for (const name of ["read_pty_buffer", "read_pty_tail", "read_pty_since", "get_pty_status"]) {
    assert.equal(cachePolicy.isVolatileReadOnlyToolName(name), true, name);
    assert.equal(cachePolicy.shouldCacheReadOnlyToolResult(name), false, name);
  }
  assert.equal(cachePolicy.isVolatileReadOnlyToolName("read_file"), false);
  assert.equal(cachePolicy.shouldCacheReadOnlyToolResult("read_file"), true);
});

test("action-only Plan recovery preserves the PTY process lifecycle surface", () => {
  const readOnlyTools = new Set(["read_pty_tail", "get_pty_status"]);
  for (const name of [
    "execute_command",
    "send_pty_input",
    "read_pty_buffer",
    "read_pty_tail",
    "read_pty_since",
    "get_pty_status",
  ]) {
    assert.equal(recoveryTools.isApprovedPlanRecoveryToolName(name, readOnlyTools), true, name);
  }
});

test("PTY sanitizer preserves warnings cleared by carriage-return and strips terminal control", () => {
  const raw = "\u001b]0;terminal\u0007\u001b[33mWarn waiting for http://localhost:1420/\u001b[0m\r\u001b[K\n\n\n\nError: timeout";
  const clean = sanitizer.sanitizePtyOutput(raw);
  assert.match(clean, /Warn waiting for http:\/\/localhost:1420\//);
  assert.match(clean, /Error: timeout/);
  assert.doesNotMatch(clean, /\u001b|\u0007/);
  assert.doesNotMatch(clean, /\n{4,}/);
});

test("get_pty_status sanitation lets a newer ANSI-decorated VITE launch supersede an old port error", async () => {
  const rawTail = [
    "\u001b[31mError:\u001b[0m Port 1420 is already in use",
    "VITE v7.0.4 \u001b[32mready\u001b[0m in 155 ms",
    "\u001b[32m➜\u001b[0m  \u001b[1mLocal:\u001b[0m   http://localhost:\u001b[1m1420\u001b[0m/",
  ].join("\n");
  const rawStatus = {
    active: true,
    running: true,
    bufferStartOffset: 0,
    bufferEndOffset: rawTail.length,
    bufferBytes: rawTail.length,
    tail: rawTail,
  };
  const originalGetPtyStatus = ipc.getPtyStatus;
  ipc.getPtyStatus = async () => rawStatus;
  let status;
  try {
    status = await toolExecutor.executeTool("get_pty_status", { wait_ms: 0 }, workspaceRoot);
  } finally {
    ipc.getPtyStatus = originalGetPtyStatus;
  }
  const observation = devServerRuntime.analyzePtyObservationResult(JSON.stringify(status));

  assert.doesNotMatch(status.tail, /\u001b/);
  assert.match(status.tail, /Error: Port 1420 is already in use/);
  assert.equal(observation.status, "ready");
  assert.equal(observation.url, "http://localhost:1420/");
});

test("PTY command admission rejects shell commands while a foreground process owns the terminal", () => {
  const busy = ptyCommandRuntime.resolvePtyCommandAdmission({
    active: true,
    running: true,
    pid: 100,
    foregroundPid: 200,
    shellAvailable: false,
  });
  assert.equal(busy.allowed, false);
  assert.match(busy.reason, /PTY_BUSY/);
  assert.match(busy.reason, /foreground process group pid=200/);

  const idle = ptyCommandRuntime.resolvePtyCommandAdmission({
    active: true,
    running: true,
    pid: 100,
    foregroundPid: 100,
    shellAvailable: true,
  });
  assert.deepEqual(idle, { allowed: true });

  const freshUnknown = {
    active: true,
    running: true,
    pid: 100,
    foregroundPid: null,
    shellAvailable: true,
    foregroundState: "unknown",
    foregroundGeneration: 0,
  };
  assert.deepEqual(ptyCommandRuntime.resolvePtyCommandAdmission(freshUnknown), { allowed: true });
  assert.equal(ptyCommandRuntime.hasActivePtyForeground(freshUnknown), false);

  const managedUnknown = { ...freshUnknown, foregroundGeneration: 1 };
  assert.equal(ptyCommandRuntime.resolvePtyCommandAdmission(managedUnknown).allowed, false);
  assert.match(ptyCommandRuntime.resolvePtyCommandAdmission(managedUnknown).reason || "", /PTY_FOREGROUND_UNKNOWN/);
  assert.equal(ptyCommandRuntime.hasActivePtyForeground(managedUnknown), true);
});

test("PTY input normalization is exact and does not generically unescape text", () => {
  const structured = ptyCommandRuntime.normalizePtyInput("", "interrupt");
  assert.equal(structured.value.length, 1);
  assert.equal(structured.value.charCodeAt(0), 3);
  assert.equal(structured.controlAction, "interrupt");

  const ordinary = ptyCommandRuntime.normalizePtyInput("\\n");
  assert.equal(ordinary.value, "\\n");
  assert.equal(ordinary.controlAction, null);
});

test("PTY control arguments reject conflicting text and appended newlines", async () => {
  await assert.rejects(
    toolExecutor.executeTool(
      "send_pty_input",
      { control: "interrupt", input: "y", wait_ms: 0 },
      workspaceRoot,
      "pty-control-conflict-test",
    ),
    /PTY_CONTROL_INPUT_CONFLICT/,
  );
  await assert.rejects(
    toolExecutor.executeTool(
      "send_pty_input",
      { control: "interrupt", append_newline: true, wait_ms: 0 },
      workspaceRoot,
      "pty-control-newline-test",
    ),
    /PTY_CONTROL_NEWLINE_FORBIDDEN/,
  );
});

test("PTY interrupt aliases write one ETX byte and cannot be resent to the same foreground", async () => {
  const before = {
    active: true,
    running: true,
    pid: 100,
    foregroundPid: 200,
    shellAvailable: false,
    foregroundState: "busy",
    foregroundGeneration: 4,
    bufferStartOffset: 0,
    bufferEndOffset: 12,
    bufferBytes: 12,
    tail: "vite",
  };
  const after = {
    ...before,
    foregroundPid: 100,
    shellAvailable: true,
    foregroundState: "idle",
    bufferEndOffset: 14,
    bufferBytes: 14,
    tail: "vite\n^C",
  };
  const statuses = [before, after, before];
  const writes = [];
  const originalGetPtyStatus = ipc.getPtyStatus;
  const originalWritePty = ipc.writePty;
  const originalReadPtySince = ipc.readPtySince;
  ipc.getPtyStatus = async () => statuses.shift() || before;
  ipc.writePty = async (input) => {
    if (writes.length > 0) {
      return {
        accepted: false,
        duplicate: true,
        deliveryState: "duplicate",
        foregroundGeneration: 4,
      };
    }
    writes.push(input);
    return {
      accepted: true,
      duplicate: false,
      deliveryState: "delivered",
      foregroundGeneration: 4,
    };
  };
  ipc.readPtySince = async () => ({
    text: "^C",
    startOffset: 12,
    endOffset: 14,
    truncated: false,
    bufferStartOffset: 0,
    bufferEndOffset: 14,
  });
  try {
    const raw = await toolExecutor.executeTool(
      "send_pty_input",
      { input: "\\u0003", wait_ms: 0 },
      workspaceRoot,
      "pty-control-alias-test",
    );
    const result = JSON.parse(raw);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 1);
    assert.equal(writes[0].charCodeAt(0), 3);
    assert.equal(result.input, "CTRL_C");
    assert.equal(result.controlAction, "interrupt");
    assert.equal(result.controlEffect, "foreground_released");
    assert.equal(result.deliveryState, "delivered");
    assert.equal(result.shellAvailableAfter, true);

    const duplicateRaw = await toolExecutor.executeTool(
      "send_pty_input",
      { control: "interrupt", wait_ms: 0 },
      workspaceRoot,
      "pty-control-alias-test",
    );
    const duplicate = JSON.parse(duplicateRaw);
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.deliveryState, "duplicate");
    assert.match(duplicate.nextAction, /get_pty_status/);
    assert.equal(writes.length, 1);
  } finally {
    ipc.getPtyStatus = originalGetPtyStatus;
    ipc.writePty = originalWritePty;
    ipc.readPtySince = originalReadPtySince;
  }
});

test("PTY control delivery remains accepted when post-write observation fails", async () => {
  const status = {
    active: true,
    running: true,
    pid: 110,
    foregroundPid: 210,
    shellAvailable: false,
    foregroundState: "busy",
    foregroundGeneration: 9,
    bufferStartOffset: 0,
    bufferEndOffset: 20,
    bufferBytes: 20,
    tail: "vite",
  };
  const originalGetPtyStatus = ipc.getPtyStatus;
  const originalWritePty = ipc.writePty;
  const originalReadPtySince = ipc.readPtySince;
  let statusCalls = 0;
  ipc.getPtyStatus = async () => {
    statusCalls += 1;
    if (statusCalls > 1) throw new Error("status channel unavailable");
    return status;
  };
  ipc.writePty = async () => ({
    accepted: true,
    duplicate: false,
    deliveryState: "delivered",
    foregroundGeneration: 9,
  });
  ipc.readPtySince = async () => { throw new Error("tail channel unavailable"); };
  try {
    const raw = await toolExecutor.executeTool(
      "send_pty_input",
      { control: "interrupt", wait_ms: 0 },
      workspaceRoot,
      "pty-control-observation-test",
    );
    const result = JSON.parse(raw);
    assert.equal(result.accepted, true);
    assert.equal(result.deliveryState, "delivered");
    assert.equal(result.controlEffect, "status_unknown");
    assert.match(result.observationError, /tail channel unavailable/);
    assert.match(result.observationError, /status channel unavailable/);
  } finally {
    ipc.getPtyStatus = originalGetPtyStatus;
    ipc.writePty = originalWritePty;
    ipc.readPtySince = originalReadPtySince;
  }
});

test("PTY input rejects an explicitly idle foreground", async () => {
  const originalGetPtyStatus = ipc.getPtyStatus;
  ipc.getPtyStatus = async () => ({
    active: true,
    running: true,
    pid: 120,
    foregroundPid: 120,
    shellAvailable: true,
    foregroundState: "idle",
    foregroundGeneration: 2,
    bufferStartOffset: 0,
    bufferEndOffset: 0,
    bufferBytes: 0,
    tail: "",
  });
  try {
    await assert.rejects(
      toolExecutor.executeTool(
        "send_pty_input",
        { input: "y", wait_ms: 0 },
        workspaceRoot,
        "pty-idle-input-test",
      ),
      /PTY_INPUT_NO_ACTIVE_FOREGROUND/,
    );
    const controlRaw = await toolExecutor.executeTool(
      "send_pty_input",
      { control: "interrupt", wait_ms: 0 },
      workspaceRoot,
      "pty-idle-input-test",
    );
    const controlResult = JSON.parse(controlRaw);
    assert.equal(controlResult.accepted, true);
    assert.equal(controlResult.duplicate, true);
    assert.equal(controlResult.deliveryState, "not_needed");
    assert.equal(controlResult.controlEffect, "foreground_released");
  } finally {
    ipc.getPtyStatus = originalGetPtyStatus;
  }
});

test("PTY command output does not treat terminal echo as successful shell execution", () => {
  assert.match(
    ptyCommandRuntime.buildUnconfirmedPtyCommandError("npm run dev", "npm run dev\nnpm run dev"),
    /PTY_COMMAND_ECHO_ONLY/,
  );
  assert.match(
    ptyCommandRuntime.buildUnconfirmedPtyCommandError("npm run dev", ""),
    /PTY_COMMAND_UNCONFIRMED/,
  );
  assert.equal(
    ptyCommandRuntime.buildUnconfirmedPtyCommandError(
      "npm run dev",
      "npm run dev\nVITE v5.4.21 ready in 812 ms\nLocal: http://localhost:1420/",
    ),
    null,
  );
});

test("agent tool surface no longer exposes destructive PTY buffer clearing", () => {
  const toolSchemas = loadTs(path.join(workspaceRoot, "src/lib/toolSchemas.ts"));
  const names = toolSchemas.TOOL_DEFINITIONS.map((tool) => tool.function.name);
  assert.equal(names.includes("clear_pty_buffer"), false);
});

test("process evidence entries retain ordering instead of deduplicating retries", () => {
  const first = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "execute_command",
    target: "npm run dev",
    result: JSON.stringify({ command: "npm run dev", output: "starting" }),
  });
  const second = first && { ...first, id: "retry", createdAt: first.createdAt + 1 };
  const ledger = planEvidence.appendPlanEvidenceEntry(
    planEvidence.appendPlanEvidenceEntry([], first),
    second,
  );
  assert.equal(ledger.length, 2);
  assert.equal(ledger.every((entry) => entry.observationStatus === "pending"), true);
});

test("PTY lifecycle input is not promoted to Plan execution evidence", () => {
  assert.equal(planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "send_pty_input",
    target: "CTRL_C",
    result: JSON.stringify({ accepted: true, controlAction: "interrupt" }),
  }), null);
});

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

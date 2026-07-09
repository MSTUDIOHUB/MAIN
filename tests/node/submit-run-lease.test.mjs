import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];
      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildSubmitAgentUserMessage,
  startSubmitRunLease,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitRunLease.ts"),
);

test("submit run lease builds text-only user messages", () => {
  assert.deepEqual(
    buildSubmitAgentUserMessage({
      userContent: "hello",
      currentImages: [],
    }),
    { role: "user", content: "hello" },
  );
});

test("submit run lease builds multimodal user messages with images before text", () => {
  assert.deepEqual(
    buildSubmitAgentUserMessage({
      userContent: "describe",
      currentImages: ["data:image/png;base64,a", "data:image/png;base64,b"],
    }),
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,a" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,b" } },
        { type: "text", text: "describe" },
      ],
    },
  );
});

test("submit run lease appends agent message, opens abort lease, and persists harness marker", () => {
  const agentMessages = [{ role: "assistant", content: "old" }];
  const abortController = { signal: { aborted: false } };
  const goals = [];
  const persistedMarkers = [];
  const harnessMarkers = [];
  const lease = startSubmitRunLease({
    userContent: "ship the goal",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-1",
    effectiveRunIntent: "goal",
    runtimeRunIntent: "execute",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "executing",
      isPlanApproved: true,
    }),
    appendAgentMessage: (message) => {
      agentMessages.push(message);
    },
    createAbortController: () => abortController,
    setAbortController: (nextAbortController) => {
      assert.equal(nextAbortController, abortController);
    },
    startGoal: (objective, options) => {
      goals.push({ objective, options });
    },
    getCurrentHarnessInstanceId: () => "instance-a",
    persistHarnessRunMarker: (marker) => {
      persistedMarkers.push(marker);
      return { ...marker, persisted: true };
    },
    setHarnessRunMarker: (marker) => {
      harnessMarkers.push(marker);
    },
    nowMs: () => 456,
  });

  assert.equal(lease.turnAgentMessagesStart, 1);
  assert.deepEqual(lease.agentUserMessage, { role: "user", content: "ship the goal" });
  assert.equal(lease.abortController, abortController);
  assert.deepEqual(goals, [
    { objective: "ship the goal", options: { sessionKey: "workspace-a:7" } },
  ]);
  assert.equal(persistedMarkers[0].instanceId, "instance-a");
  assert.equal(persistedMarkers[0].messagesLen, 2);
  assert.equal(persistedMarkers[0].planStage, "executing");
  assert.equal(persistedMarkers[0].isPlanApproved, true);
  assert.equal(persistedMarkers[0].startedAt, 456);
  assert.equal(harnessMarkers[0].persisted, true);
  assert.equal(lease.harnessRunMarker.persisted, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTsWithMocks(sourcePath, mocks, cache = new Map()) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTsWithMocks(candidate, mocks, cache);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  cache.set(normalized, module.exports);
  return module.exports;
}

function loadTs(sourcePath) {
  return loadTsWithMocks(sourcePath, new Map());
}

const runtime = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtime-v2/index.ts",
));
const readPolicy = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtime-v2/workspaceReadPolicy.ts",
));

test("workspace read policy excludes every effect-capable tool", () => {
  for (const toolName of [
    "read_file",
    "grep_search",
    "get_file_outline",
    "git_diff",
    "web_search",
  ]) {
    assert.equal(readPolicy.isRuntimeV2WorkspaceReadToolName(toolName), true);
  }
  for (const toolName of [
    "apply_patch",
    "write_file",
    "replace_in_file",
    "run_command",
    "browser_evaluate",
    "computer_use",
  ]) {
    assert.equal(readPolicy.isRuntimeV2WorkspaceReadToolName(toolName), false);
  }
});

test("production workspace read runner uses analyze, reads evidence, and concludes once", async () => {
  let revision = 0;
  let providerCalls = 0;
  const appendedEvents = [];
  const projections = [];
  const providerModes = [];
  const toolNames = [];

  const checkpointPort = {
    getRuntimeV2Checkpoint() {
      return null;
    },
    createRuntimeV2CheckpointPort() {
      return {
        async load() {
          return null;
        },
        async append({ event }) {
          appendedEvents.push(event);
          revision += 1;
          return {
            disposition: "committed",
            checkpoint: { revision },
          };
        },
      };
    },
  };
  const executionPorts = {
    createRuntimeV2LiveExecutionState() {
      return {
        messages: [],
        modelContext: [],
        childRuns: new Map(),
        childAbortControllers: new Map(),
        childTelemetry: new Map(),
        workspaceOverview: "",
        subagentCandidates: [],
        evidenceCounter: 0,
        latestProviderResult: null,
        latestVisibleText: "",
        lastProviderTransport: null,
        providerLaneProfile: null,
        authorization: null,
      };
    },
    createRuntimeV2ProviderPort() {
      return {
        async request({ command }) {
          providerModes.push(command.payload.mode);
          providerCalls += 1;
          return providerCalls === 1
            ? {
                visibleText: "",
                commentary: "正在确认编辑器事件入口。",
                toolCalls: [{
                  id: "read-editor",
                  name: "read_file",
                  arguments: { path: "src/components/editor.js" },
                }],
                diagnostics: [],
              }
            : {
                visibleText: "### 结论\n\n编辑器事件入口位于 `src/components/editor.js`。",
                toolCalls: [],
                diagnostics: [],
              };
        },
      };
    },
    createRuntimeV2ToolPort() {
      return {
        async execute({ command }) {
          if (command.kind === "collect_observation") {
            return {
              type: "observation.recorded",
              run: command.run,
              evidence: {
                id: "workspace-overview",
                kind: "source",
                target: "/fixture",
                version: "overview-v1",
              },
            };
          }
          toolNames.push(command.payload.toolName);
          return {
            type: "tool.completed",
            run: command.run,
            idempotencyKey: command.idempotencyKey,
            status: "succeeded",
            evidence: [{
              id: "source-editor",
              kind: "source",
              target: "src/components/editor.js",
              version: "source-v1",
            }],
          };
        },
      };
    },
    createRuntimeV2SchedulerPort() {
      return {
        async execute() {
          throw new Error("scheduler should not run in this fixture");
        },
      };
    },
  };
  const projectionPort = {
    createRuntimeV2ProjectionPort() {
      return {
        async publish(value) {
          projections.push(value);
        },
      };
    },
  };
  const runner = loadTsWithMocks(
    path.join(workspaceRoot, "src/store/runtimeV2/workspaceReadRunner.ts"),
    new Map([
      ["../../lib/runtime-v2", runtime],
      ["./checkpointPort", checkpointPort],
      ["./executionPorts", executionPorts],
      ["./projectionPort", projectionPort],
    ]),
  );

  const timerInterval = setInterval(() => undefined, 60_000);
  const state = {
    conversationTurns: [{
      id: "turn-read",
      clientSubmissionId: "submission-read",
      userPrompt: "编辑器事件入口在哪里？",
    }],
    planLifecycle: {
      sessionKey: "session-read",
      sessionEpoch: "epoch-read",
    },
    preferSubagents: false,
    _nextTaskId: () => 10,
  };
  const settlement = await runner.runSubmitRuntimeV2WorkspaceRead({
    get: () => state,
    set: () => undefined,
    context: {
      turnId: "turn-read",
      uiDisplayTurnId: "turn-read",
      runWorkspace: "/fixture",
      runSessionKey: "session-read",
      runSessionId: 1,
      runScopeKey: "/fixture",
      phaseLanguage: "zh",
      effectiveRunIntent: "analyze",
      runtimeRunIntent: "analyze",
      abortCtrl: new AbortController(),
      timerInterval,
      harnessRunId: "run-read",
      turnInputContextSignals: { subagentPreference: "forbidden" },
    },
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    normalizeSessionRuntimeSnapshot: (snapshot) => snapshot,
    publishOwnerScopedRuntimeProjection: () => ({
      published: true,
      disposition: "published",
    }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: () => undefined,
  });

  assert.equal(settlement.outcome.resultKind, "success");
  assert.deepEqual(providerModes, ["analyze", "analyze"]);
  assert.deepEqual(toolNames, ["read_file"]);
  assert.equal(
    appendedEvents.filter((event) => event.type === "turn.completed").length,
    1,
  );
  assert.equal(
    appendedEvents.filter((event) => event.type === "run.completed").length,
    1,
  );
  const final = projections.find((entry) => entry.audience === "final");
  assert.match(final.projection.markdown, /编辑器事件入口/);
  assert.equal(
    appendedEvents.some((event) =>
      event.type === "command.scheduled" &&
      event.command.kind === "execute_validation"
    ),
    false,
  );
});

test("workspace read runner source does not import or delegate to Chat", () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/workspaceReadRunner.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /chatRunner|runSubmitRuntimeV2Chat|strategy:\s*"chat"/);
  assert.match(source, /strategy:\s*"analyze"/);
});

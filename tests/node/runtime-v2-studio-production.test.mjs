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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
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

const runtime = loadTsWithMocks(
  path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
  new Map(),
);
const adapter = loadTsWithMocks(
  path.join(workspaceRoot, "src/store/runtimeV2/studioAdapter.ts"),
  new Map(),
);

test("production Studio runner executes one frozen plan and closes exactly once", async () => {
  let taskId = 0;
  let state = {
    conversationTurns: [{
      id: "studio-turn",
      clientSubmissionId: "studio-submission",
      runtimeEngineVersion: "v2",
      userPrompt: "Configure Godot 4.4",
      status: "executing",
      blockIds: [],
    }],
    config: { language: "zh" },
    planLifecycle: {
      sessionKey: "studio-session",
      sessionEpoch: "studio-epoch",
    },
    runtimeV2Checkpoints: {},
    runtimeEvents: [],
    taskFlow: [],
    harnessRunMarker: {
      sessionKey: "studio-session",
      turnId: "studio-turn",
      runId: "studio-run",
      runtimeIntent: "studio_workflow",
      status: "running",
    },
    _nextTaskId() {
      taskId += 1;
      return taskId;
    },
  };
  const get = () => state;
  const set = (patchOrUpdater) => {
    const patch = typeof patchOrUpdater === "function"
      ? patchOrUpdater(state)
      : patchOrUpdater;
    state = { ...state, ...(patch || {}) };
  };
  const checkpointPort = {
    getRuntimeV2Checkpoint(current, owner) {
      return current.runtimeV2Checkpoints?.[owner.turnId] || null;
    },
    createRuntimeV2CheckpointPort() {
      return {
        async load({ owner }) {
          return state.runtimeV2Checkpoints?.[owner.turnId] || null;
        },
        async append(input) {
          const current = state.runtimeV2Checkpoints?.[input.owner.turnId] || null;
          const result = runtime.appendRuntimeV2Checkpoint({
            checkpoint: current,
            owner: input.owner,
            expectedRevision: input.expectedRevision,
            event: input.event,
          });
          if (result.checkpoint) {
            state = {
              ...state,
              runtimeV2Checkpoints: {
                ...state.runtimeV2Checkpoints,
                [input.owner.turnId]: result.checkpoint,
              },
            };
          }
          return result;
        },
      };
    },
  };
  const runner = loadTsWithMocks(
    path.join(workspaceRoot, "src/store/runtimeV2/studioRunner.ts"),
    new Map([
      ["../../lib/runtime-v2", runtime],
      ["./checkpointPort", checkpointPort],
      ["./projectionPort", {
        createRuntimeV2ProjectionPort: () => ({ async publish() {} }),
      }],
      ["./studioAdapter", adapter],
    ]),
  );
  const receiptMap = new Map();
  const studioReceipts = {
    async load({ receiptKey }) {
      return receiptMap.get(receiptKey) || null;
    },
    async claim({ receipt }) {
      const existing = receiptMap.get(receipt.receiptKey);
      if (existing) return { disposition: "existing", receipt: existing };
      receiptMap.set(receipt.receiptKey, receipt);
      return { disposition: "claimed", receipt };
    },
    async settle({ receiptKey, expectedRevision, receipt }) {
      const current = receiptMap.get(receiptKey);
      if (!current || current.revision !== expectedRevision) {
        return { disposition: "conflict", receipt: current || null };
      }
      receiptMap.set(receiptKey, receipt);
      return { disposition: "committed", receipt };
    },
  };
  const config = {
    engine: "godot",
    engineLanguage: "GDScript",
    engineVersion: "4.4",
    reviewMode: "lean",
    activeStudioAgent: "godot-specialist",
    packVersion: "pack-v1",
  };
  const calls = [];
  const actions = adapter.buildRuntimeV2StudioSetupActionPlan({
    mode: "configure",
    engine: "godot",
    version: "4.4",
    raw: "godot 4.4",
  });
  const settlement = await runner.runSubmitRuntimeV2Studio({
    get,
    set,
    context: {
      turnId: "studio-turn",
      uiDisplayTurnId: "studio-turn",
      runWorkspace: "/fixture",
      runSessionKey: "studio-session",
      runSessionId: 1,
      runScopeKey: "/fixture",
      phaseLanguage: "zh",
      effectiveRunIntent: "studio_workflow",
      runtimeRunIntent: "studio_workflow",
      abortCtrl: new AbortController(),
      timerInterval: undefined,
      harnessRunId: "studio-run",
      turnInputContextSignals: { subagentPreference: "forbidden" },
    },
    actions,
    runtimeService: {
      async ensureInitialized() {
        calls.push("launch");
        return config;
      },
      async loadConfig() {
        calls.push("observe");
        return config;
      },
      async configureEngine() {
        calls.push("interact");
        return config;
      },
    },
    studioReceipts,
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
  assert.deepEqual(calls, ["launch", "observe", "interact", "observe"]);
  assert.equal(receiptMap.size, 4);
  const checkpoint = state.runtimeV2Checkpoints["studio-turn"];
  assert.equal(
    checkpoint.aggregate.events.filter(
      (event) => event.type === "turn.completed",
    ).length,
    1,
  );
  assert.equal(
    runtime.deriveRuntimeV2StudioLedgerState(
      checkpoint.aggregate,
    ).successfulActions.length,
    4,
  );
});

test("Studio production source has no legacy executor or prose lifecycle rule", () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/studioRunner.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /WorkflowEngine|AgentOrchestrator|useAppStore|visibleText\.(?:includes|match|search)/,
  );
  assert.match(source, /studioReceipts/);
  assert.match(source, /cold_resume/);
});

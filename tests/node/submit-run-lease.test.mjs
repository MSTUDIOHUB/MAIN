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
const {
  closeHarnessRunMarker,
  isHarnessRunMarkerOwnedByRun,
  persistHarnessRunMarker,
  persistHarnessRunMarkerIfOwned,
  readHarnessRunMarker,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/harnessCrashTelemetry.ts"),
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
    canonicalUserText: "ship the visible goal",
    goalSourceContext: "prior Plan conclusion",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-1",
    effectiveRunIntent: "goal",
    runtimeRunIntent: "goal",
    goalCreationAuthorization: {
      kind: "goal_creation_authorization",
      intent: "goal",
      source: "visible_goal_shortcut",
    },
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
    {
      objective: "ship the visible goal",
      options: { sessionKey: "workspace-a:7", sourceContext: "prior Plan conclusion", ownerTurnId: "turn-1" },
    },
  ]);
  assert.equal(persistedMarkers[0].instanceId, "instance-a");
  assert.match(persistedMarkers[0].runId, /^run-/);
  assert.equal(persistedMarkers[0].messagesLen, 2);
  assert.equal(persistedMarkers[0].planStage, "executing");
  assert.equal(persistedMarkers[0].isPlanApproved, true);
  assert.equal(persistedMarkers[0].startedAt, 456);
  assert.equal(persistedMarkers[0].parentRunId, null);
  assert.equal(persistedMarkers[0].turnStartMessageIndex, 1);
  assert.equal(harnessMarkers[0].persisted, true);
  assert.equal(lease.harnessRunMarker.persisted, true);
  assert.equal(lease.runId, persistedMarkers[0].runId);
  assert.equal(lease.parentRunId, null);
});

test("submit run lease refuses inferred or internally resolved Goal creation without explicit authority", () => {
  const agentMessages = [];
  let startGoalCalls = 0;
  startSubmitRunLease({
    userContent: "internal goal request",
    canonicalUserText: "internal goal request",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-internal-goal",
    effectiveRunIntent: "goal",
    runtimeRunIntent: "goal",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "idle",
      isPlanApproved: false,
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => { startGoalCalls += 1; },
    getCurrentHarnessInstanceId: () => "instance-a",
    persistHarnessRunMarker: (marker) => marker,
    setHarnessRunMarker: () => {},
    nowMs: () => 457,
  });

  assert.equal(startGoalCalls, 0);
});

test("submit run lease links only exact same-turn resumes", () => {
  const agentMessages = [
    { role: "user", content: "initial" },
    { role: "assistant", content: "choose" },
  ];
  const previousMarker = {
    runId: "run-parent",
    sessionKey: "workspace-a:7",
    turnId: "turn-1",
    turnStartMessageIndex: 0,
  };
  let persisted;
  const lease = startSubmitRunLease({
    userContent: "[turn_intake]\n[user_request]\napprove\n[/user_request]\n[/turn_intake]",
    canonicalUserText: "approve",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-1",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "executing",
      isPlanApproved: true,
      harnessRunMarker: previousMarker,
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => assert.fail("goal must not start"),
    getCurrentHarnessInstanceId: () => "instance-a",
    persistHarnessRunMarker: (marker) => (persisted = marker),
    setHarnessRunMarker: () => {},
    nowMs: () => 789,
  });

  assert.equal(lease.parentRunId, "run-parent");
  assert.equal(persisted.parentRunId, "run-parent");
  assert.equal(persisted.turnStartMessageIndex, 0);
});

test("action continuations preserve their exact paused parent run even when another marker is current", () => {
  const agentMessages = [{ role: "user", content: "newer turn" }];
  let persisted;
  const lease = startSubmitRunLease({
    userContent: "Use B",
    canonicalUserText: "Use B",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-choice",
    effectiveRunIntent: "execute",
    runtimeRunIntent: "execute",
    parentRunIdOverride: "run-choice-paused",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "idle",
      isPlanApproved: false,
      harnessRunMarker: {
        runId: "run-other-current",
        sessionKey: "workspace-a:7",
        turnId: "turn-newer",
        turnStartMessageIndex: 0,
      },
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => assert.fail("goal must not start"),
    getCurrentHarnessInstanceId: () => "instance-a",
    persistHarnessRunMarker: (marker) => (persisted = marker),
    setHarnessRunMarker: () => {},
    nowMs: () => 790,
  });

  assert.equal(lease.parentRunId, "run-choice-paused");
  assert.equal(persisted.parentRunId, "run-choice-paused");
  assert.equal(persisted.turnId, "turn-choice");
});

test("approved handoffs preserve a preallocated child run id through the submission lease", () => {
  const agentMessages = [{ role: "user", content: "reviewed plan" }];
  let persisted;
  const lease = startSubmitRunLease({
    userContent: "execute approved plan",
    canonicalUserText: "execute approved plan",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-plan",
    effectiveRunIntent: "plan",
    runtimeRunIntent: "execute",
    parentRunIdOverride: "run-review",
    runIdOverride: "run-approved-child",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "executing",
      isPlanApproved: true,
      harnessRunMarker: {
        runId: "run-review",
        sessionKey: "workspace-a:7",
        turnId: "turn-plan",
        turnStartMessageIndex: 0,
      },
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => assert.fail("goal must not start"),
    getCurrentHarnessInstanceId: () => "instance-a",
    persistHarnessRunMarker: (marker) => (persisted = marker),
    setHarnessRunMarker: () => {},
    nowMs: () => 791,
  });

  assert.equal(lease.runId, "run-approved-child");
  assert.equal(lease.parentRunId, "run-review");
  assert.equal(persisted.runId, "run-approved-child");
  assert.equal(persisted.parentRunId, "run-review");
});

test("Goal choice continuations append guidance without creating a replacement Goal", () => {
  const agentMessages = [{ role: "assistant", content: "Choose startup behavior" }];
  let persisted;
  const lease = startSubmitRunLease({
    userContent: "显示欢迎页",
    canonicalUserText: "显示欢迎页",
    currentImages: [],
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    runSessionId: 7,
    turnId: "turn-goal",
    effectiveRunIntent: "goal",
    runtimeRunIntent: "goal",
    continueExistingGoal: true,
    parentRunIdOverride: "run-goal:slice:1",
    getRuntimeSnapshot: () => ({
      agentMessagesLength: agentMessages.length,
      planStage: "idle",
      isPlanApproved: false,
    }),
    appendAgentMessage: (message) => agentMessages.push(message),
    createAbortController: () => ({ signal: { aborted: false } }),
    setAbortController: () => {},
    startGoal: () => assert.fail("a Goal continuation must retain the existing Goal"),
    getCurrentHarnessInstanceId: () => "instance-a",
    persistHarnessRunMarker: (marker) => (persisted = marker),
    setHarnessRunMarker: () => {},
    nowMs: () => 792,
  });

  assert.deepEqual(agentMessages.at(-1), { role: "user", content: "显示欢迎页" });
  assert.equal(lease.parentRunId, "run-goal:slice:1");
  assert.equal(persisted.workflowMode, "edit");
  assert.equal(persisted.runtimeIntent, "goal");
});

test("harness run ownership distinguishes sequential loops on the same conversation turn", () => {
  const marker = {
    status: "running",
    runId: "run-new",
    sessionKey: "workspace-a:7",
    turnId: "turn-plan",
  };
  assert.equal(isHarnessRunMarkerOwnedByRun(marker, {
    runId: "run-new",
    sessionKey: "workspace-a:7",
    turnId: "turn-plan",
  }), true);
  assert.equal(isHarnessRunMarkerOwnedByRun(marker, {
    runId: "run-old",
    sessionKey: "workspace-a:7",
    turnId: "turn-plan",
  }), false);
});

test("global harness persistence uses run ownership CAS across background sessions", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const markerB = persistHarnessRunMarker({
      schemaVersion: 1,
      runId: "run-b",
      instanceId: "instance-a",
      sessionKey: "workspace-b:2",
      turnId: "turn-b",
      status: "running",
      startedAt: 200,
      updatedAt: 200,
    });
    const ownerA = {
      runId: "run-a",
      sessionKey: "workspace-a:1",
      turnId: "turn-a",
    };
    const ownerB = {
      runId: "run-b",
      sessionKey: "workspace-b:2",
      turnId: "turn-b",
    };

    assert.equal(persistHarnessRunMarkerIfOwned({
      ...markerB,
      runId: "run-a",
      sessionKey: "workspace-a:1",
      turnId: "turn-a",
      iteration: 3,
    }, ownerA), null);
    assert.equal(readHarnessRunMarker().runId, "run-b");
    assert.equal(closeHarnessRunMarker({
      status: "completed",
      closeReason: "old_session_finished",
    }, ownerA), null);
    assert.equal(readHarnessRunMarker().status, "running");

    const closedB = closeHarnessRunMarker({
      status: "completed",
      closeReason: "owner_finished",
    }, ownerB);
    assert.equal(closedB.runId, "run-b");
    assert.equal(readHarnessRunMarker().status, "completed");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

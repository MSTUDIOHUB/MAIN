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

const { createGameStudioLocalSlashBridge } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/gameStudioLocalSlashBridge.ts"),
);
const { startGameStudioLocalSlashSubmission } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/gameStudioLocalSlashSubmission.ts"),
);
const { hasCanceledTurnTerminalProjection } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/sessionCancellationBarrier.ts"),
);

function createState(overrides = {}) {
  const updates = [];
  const state = {
    taskFlow: [],
    conversationTurns: [],
    runtimeEvents: [],
    agentMessages: [{ role: "user", content: "hello" }],
    contextMemoryState: { buckets: {} },
    contextMemoryStateByRuntimeKey: {},
    providerCompatibilityByRuntimeKey: {},
    currentTurnId: null,
    selectedMainModeKey: "game_studio",
    selectedNexusModeKey: "game_studio",
    imageStudio: { runtime: {} },
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: true,
    pendingSlashCommand: null,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: null,
    planStage: "idle",
    isPlanApproved: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    selectedDiffTaskId: null,
    autoApproveTools: false,
    autoApproveToolScopes: [],
    webSearchEnabled: false,
    webSearchProvider: "off",
    queuedUserMessage: null,
    activeGuidance: null,
    input: "/help",
    contextMentions: ["README.md"],
    attachedFiles: ["notes.md"],
    lockedComposerIntent: "plan",
    pendingRunDecision: { kind: "intent_confirmation" },
    preferredResponseLanguage: "en",
    isGenerating: true,
    agentStatus: "running",
    elapsedTime: 12,
    harnessRunMarker: null,
    config: {
      sessionRecordingEnabled: true,
      eventStreamMode: "dual",
    },
    updateSession(scopeKey, sessionId, patch) {
      updates.push({ scopeKey, sessionId, patch });
    },
    ...overrides,
  };
  return { state, updates };
}

function createHarness(state) {
  const sets = [];
  return {
    sets,
    get: () => state,
    set: (patch) => {
      sets.push(patch);
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next && typeof next === "object") Object.assign(state, next);
    },
  };
}

function createBridgeInput(state, harness, overrides = {}) {
  let nextId = 10;
  return {
    sessionGet: harness.get,
    sessionSet: harness.set,
    nextTaskId: () => nextId++,
    text: "/help",
    turnId: "turn-1",
    userContextItems: [{ type: "file", path: "README.md", label: "README.md", status: "ready" }],
    isHidden: false,
    reuseCurrentTurn: false,
    parentPlanTurnId: null,
    preferredLanguage: "zh",
    effectiveRunIntent: "studio_workflow",
    effectiveDisplayIntent: "studio_workflow",
    effectiveIntentSummary: "Game Studio help",
    effectiveCommandDirective: { kind: "studio_workflow", source: "studio_slash" },
    effectiveWorkflowMode: "edit",
    turnTitle: "Game Studio help",
    shouldSeedSessionTitleForTurn: true,
    ensuredSessionId: 7,
    sessionScopeKey: "/repo",
    runSessionKey: "/repo:7",
    titleIntentSignature: "sig-help",
    sanitizeTaskBlocksForPersist: (blocks) => blocks.map((block) => ({ ...block, persisted: true })),
    buildSessionRuntimeSnapshot: (state) => ({ normalized: true, snapshot: state }),
    ...overrides,
  };
}

test("game studio local slash bridge appends visible local turn and persists session snapshot", async () => {
  const { state, updates } = createState();
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness));

  const result = await bridge.appendLocalStudioTurn("# Help", {
    systemVariant: "game_studio_local_markdown",
  });

  assert.equal(result.disposition, "appended");
  assert.equal(result.adoptionDecision.kind, "not_requested");
  assert.equal(result.userBlockId, 10);
  assert.equal(result.conclusionBlockId, 11);
  assert.equal(state.taskFlow.length, 2);
  assert.equal(state.taskFlow[0].type, "user");
  assert.equal(state.taskFlow[0].id, 10);
  assert.equal(state.taskFlow[0].contextItems[0].path, "README.md");
  assert.equal(state.taskFlow[1].type, "system");
  assert.equal(state.taskFlow[1].id, 11);
  assert.equal(state.taskFlow[1].variant, "game_studio_local_markdown");
  assert.equal(state.conversationTurns.length, 1);
  assert.equal(state.conversationTurns[0].status, "done");
  assert.deepEqual(state.conversationTurns[0].blockIds, [10, 11]);
  assert.equal(state.currentTurnId, "turn-1");
  assert.equal(state.input, "");
  assert.deepEqual(state.contextMentions, []);
  assert.deepEqual(state.attachedFiles, []);
  assert.equal(state.agentStatus, "idle");
  assert.equal(state.isGenerating, false);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].scopeKey, "/repo");
  assert.equal(updates[0].sessionId, 7);
  assert.equal(updates[0].patch.title, "Game Studio help");
  assert.equal(updates[0].patch.titleSource, "local_seed");
  assert.equal(updates[0].patch.messages[0].persisted, true);
  assert.equal(updates[0].patch.runtimeSnapshot.normalized, true);
  assert.equal(updates[0].patch.runtimeSnapshot.snapshot.currentTurnId, "turn-1");
});

test("game studio local slash bridge atomically commits success, error, and canceled conclusions", async () => {
  const cases = [
    {
      name: "success",
      summary: "# Help",
      terminal: {
        runId: "run-success",
        parentRunId: "run-parent",
        resultKind: "success",
        reason: "local_slash_completed",
        timestampMs: 222,
      },
      slash: {
        command: "/help",
        executionMode: "local_fast",
        outcome: "completed",
      },
      expectedTypes: [
        "run.started",
        "slash.command.started",
        "slash.command.completed",
        "run.completed",
        "turn.completed",
      ],
    },
    {
      name: "error",
      summary: "Slash command failed: metadata unavailable",
      terminal: {
        runId: "run-error",
        parentRunId: null,
        resultKind: "error",
        reason: "local_slash_error",
        timestampMs: 333,
      },
      slash: {
        command: "/help",
        executionMode: "local_fast",
        outcome: "failed",
        error: { message: "metadata unavailable" },
      },
      expectedTypes: [
        "run.started",
        "slash.command.started",
        "slash.command.failed",
        "run.completed",
        "turn.completed",
      ],
    },
    {
      name: "canceled",
      summary: "Slash command canceled. No further local action was performed.",
      terminal: {
        runId: "run-canceled",
        parentRunId: null,
        resultKind: "canceled",
        reason: "local_slash_canceled",
        timestampMs: 444,
      },
      slash: {
        command: "/help",
        executionMode: "local_fast",
        outcome: "failed",
        error: { message: "Local slash command canceled" },
      },
      expectedTypes: [
        "run.started",
        "slash.command.started",
        "slash.command.failed",
        "run.aborted",
        "run.completed",
        "turn.completed",
      ],
    },
  ];

  for (const scenario of cases) {
    const { state, updates } = createState();
    const harness = createHarness(state);
    const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness));
    bridge.emitLocalSlashRuntimeEvent({
      type: "run.started",
      threadId: "/repo:7",
      turnId: "turn-1",
      timestampMs: 200,
      runId: scenario.terminal.runId,
      parentRunId: scenario.terminal.parentRunId,
    });
    bridge.emitLocalSlashRuntimeEvent({
      type: "slash.command.started",
      threadId: "/repo:7",
      turnId: "turn-1",
      timestampMs: 201,
      command: scenario.slash.command,
      executionMode: scenario.slash.executionMode,
    });
    const setCountBeforeConclusion = harness.sets.length;
    const updateCountBeforeConclusion = updates.length;

    const result = await bridge.appendLocalStudioTurn(scenario.summary, {
      presentation: "assistant_final",
      lifecycle: {
        terminal: scenario.terminal,
        slash: scenario.slash,
      },
    });

    assert.equal(
      harness.sets.length - setCountBeforeConclusion,
      1,
      `${scenario.name} conclusion must use one sessionSet transaction`,
    );
    assert.equal(result.disposition, "appended", scenario.name);
    assert.deepEqual(result.terminal, scenario.terminal, scenario.name);
    assert.deepEqual(
      state.runtimeEvents.map((event) => event.type),
      scenario.expectedTypes,
      scenario.name,
    );
    const slashTerminal = state.runtimeEvents.find((event) =>
      event.type === "slash.command.completed" || event.type === "slash.command.failed"
    );
    assert.equal(slashTerminal.command, scenario.slash.command, scenario.name);
    assert.equal(slashTerminal.executionMode, scenario.slash.executionMode, scenario.name);
    if (scenario.slash.outcome === "failed") {
      assert.deepEqual(slashTerminal.error, scenario.slash.error, scenario.name);
    }
    const runTerminal = state.runtimeEvents.find((event) => event.type === "run.completed");
    const turnTerminal = state.runtimeEvents.find((event) => event.type === "turn.completed");
    assert.equal(
      state.runtimeEvents.filter((event) => event.type === "run.completed").length,
      1,
      scenario.name,
    );
    assert.equal(
      state.runtimeEvents.filter((event) => event.type === "turn.completed").length,
      1,
      scenario.name,
    );
    assert.equal(
      runTerminal.resultKind,
      scenario.terminal.resultKind,
      scenario.name,
    );
    assert.equal(runTerminal.summary, scenario.summary, scenario.name);
    assert.equal(runTerminal.runId, scenario.terminal.runId, scenario.name);
    assert.equal(runTerminal.parentRunId, scenario.terminal.parentRunId, scenario.name);
    assert.equal(
      turnTerminal.resultKind,
      scenario.terminal.resultKind,
      scenario.name,
    );
    assert.equal(
      state.runtimeEvents.filter((event) => event.type === "run.aborted").length,
      scenario.name === "canceled" ? 1 : 0,
      scenario.name,
    );
    if (scenario.name === "canceled") {
      const aborted = state.runtimeEvents.find((event) => event.type === "run.aborted");
      assert.equal(aborted.runId, scenario.terminal.runId);
      assert.equal(aborted.reason, scenario.terminal.reason);
      assert.equal(aborted.message, scenario.summary);
    }
    assert.equal(state.conversationTurns[0].runtimeOutcome.resultKind, scenario.terminal.resultKind);
    assert.equal(state.conversationTurns[0].runtimeOutcome.runId, scenario.terminal.runId);
    assert.equal(state.conversationTurns[0].summary, scenario.summary);
    assert.equal(state.taskFlow.filter((block) =>
      block.turnId === "turn-1" &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
    ).length, 1, scenario.name);
    assert.equal(
      updates.length - updateCountBeforeConclusion,
      1,
      `${scenario.name} must persist one complete projection`,
    );
    assert.deepEqual(
      updates.at(-1).patch.runtimeSnapshot.snapshot.runtimeEvents.map((event) => event.type),
      scenario.expectedTypes,
      `${scenario.name} persisted lifecycle`,
    );
  }
});

test("game studio local slash bridge adopts the exact admitted Turn without duplicating its user block", async () => {
  const admittedUserBlock = {
    id: 41,
    turnId: "turn-1",
    type: "user",
    content: "/help",
    contextItems: [{ type: "file", path: "README.md", label: "README.md", status: "ready" }],
  };
  const admittedTurn = {
    id: "turn-1",
    clientSubmissionId: "submission-1",
    workspaceInstructionReceiptId: "receipt-1",
    workspaceInstructionSource: "slash_command",
    userPrompt: "/help",
    title: "Pending workspace instruction",
    mode: "edit",
    intent: "analyze",
    displayIntent: "analyze",
    status: "planning",
    summary: "",
    blockIds: [41],
    processCollapsed: false,
    collapsed: false,
    createdAt: 100,
  };
  const { state } = createState({
    taskFlow: [admittedUserBlock],
    conversationTurns: [admittedTurn],
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
  }));

  const result = await bridge.appendLocalStudioTurn("# Help", {
    systemVariant: "game_studio_local_markdown",
    lifecycle: {
      terminal: {
        runId: "run-local-slash-turn-1",
        parentRunId: null,
        resultKind: "success",
        reason: "local_slash_completed",
        timestampMs: 222,
      },
      slash: {
        command: "/help",
        executionMode: "local_fast",
        outcome: "completed",
      },
    },
  });

  assert.equal(result.disposition, "appended");
  assert.deepEqual(result.adoptionDecision, {
    kind: "adopted",
    turnId: "turn-1",
    userBlockId: 41,
  });
  assert.equal(result.userBlockId, 41);
  assert.equal(result.conclusionBlockId, 10);
  assert.equal(state.taskFlow.filter((block) => block.type === "user").length, 1);
  assert.equal(state.taskFlow[0], admittedUserBlock);
  assert.equal(state.taskFlow[1].type, "system");
  assert.equal(state.taskFlow[1].variant, "game_studio_local_markdown");
  assert.equal(state.conversationTurns.length, 1);
  assert.deepEqual(state.conversationTurns[0].blockIds, [41, 10]);
  assert.equal(state.conversationTurns[0].clientSubmissionId, "submission-1");
  assert.equal(state.conversationTurns[0].status, "done");
  assert.deepEqual(state.conversationTurns[0].runtimeOutcome, {
    status: "completed",
    reason: "local_slash_completed",
    resultKind: "success",
    runId: "run-local-slash-turn-1",
    parentRunId: null,
    updatedAt: 222,
  });
});

test("game studio local slash bridge rejects a non-exact admitted user-block identity without mutation", async () => {
  const { state, updates } = createState({
    taskFlow: [{ id: 41, turnId: "turn-1", type: "user", content: "/help" }],
    conversationTurns: [{
      id: "turn-1",
      userPrompt: "/help",
      title: "Pending workspace instruction",
      mode: "edit",
      status: "planning",
      summary: "",
      blockIds: [41],
      collapsed: false,
      createdAt: 100,
    }],
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    adoptExistingTurn: true,
    admittedUserBlockId: 999,
  }));
  const beforeTaskFlow = state.taskFlow;
  const beforeTurns = state.conversationTurns;

  const result = await bridge.appendLocalStudioTurn("# Help");

  assert.equal(result.disposition, "rejected");
  assert.equal(result.adoptionDecision.reason, "user_block_not_linked");
  assert.equal(state.taskFlow, beforeTaskFlow);
  assert.equal(state.conversationTurns, beforeTurns);
  assert.equal(updates.length, 0);
});

test("game studio local slash bridge isolates presentation recovery when admitted identity drifted", async () => {
  const { state, updates } = createState({
    taskFlow: [
      { id: 41, turnId: "turn-1", type: "user", content: "/help" },
      { id: 42, turnId: "turn-1", type: "agent", content: "old A", visibility: "assistant_final", streaming: true },
      { id: 43, turnId: "turn-1", type: "agent", content: "", visibility: "assistant_final", streaming: true },
    ],
    conversationTurns: [{
      id: "turn-1",
      userPrompt: "/help",
      title: "Pending workspace instruction",
      mode: "edit",
      status: "executing",
      summary: "",
      blockIds: [41, 42, 43],
      collapsed: false,
      createdAt: 100,
    }],
    currentTurnId: "turn-1",
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    adoptExistingTurn: true,
    admittedUserBlockId: 999,
  }));
  const rejectedAppend = await bridge.appendLocalStudioTurn("# Help");
  assert.equal(rejectedAppend.disposition, "rejected");

  const repairInput = {
    content: "斜杠命令执行失败：Turn identity changed",
    terminal: {
      runId: "run-local-slash-turn-1",
      parentRunId: null,
      resultKind: "error",
      reason: "local_slash_error",
      timestampMs: 333,
    },
    rejectedAppend,
    slashFailure: {
      command: "/help",
      executionMode: "local_fast",
      error: { message: "Turn identity changed" },
    },
  };
  const repaired = await bridge.ensureVisibleConclusion(repairInput);
  const replayed = await bridge.ensureVisibleConclusion(repairInput);

  assert.equal(repaired.disposition, "recovery_completed");
  assert.deepEqual(replayed, repaired);
  const recoveryTurn = state.conversationTurns.find((turn) =>
    turn.runtimeOutcome?.runId === "run-local-slash-turn-1-presentation-recovery"
  );
  assert.ok(recoveryTurn);
  assert.notEqual(recoveryTurn.id, "turn-1");
  const finals = state.taskFlow.filter((block) =>
    block.turnId === recoveryTurn.id && block.type === "agent" && block.visibility === "assistant_final"
  );
  assert.equal(finals.length, 1);
  assert.equal(finals[0].streaming, false);
  assert.match(finals[0].content, /Turn identity changed/);
  assert.equal(state.conversationTurns.find((turn) => turn.id === "turn-1").status, "executing");
  assert.equal(recoveryTurn.status, "error");
  assert.equal(recoveryTurn.runtimeOutcome.status, "completed");
  assert.equal(recoveryTurn.runtimeOutcome.resultKind, "error");
  assert.equal(recoveryTurn.runtimeOutcome.parentRunId, "run-local-slash-turn-1");
  assert.equal(recoveryTurn.runtimeOutcome.updatedAt, 333);
  assert.deepEqual(state.runtimeEvents.filter((event) => event.turnId === recoveryTurn.id).map((event) => [event.type, event.turnId]), [
    ["run.started", recoveryTurn.id],
    ["run.completed", recoveryTurn.id],
    ["turn.completed", recoveryTurn.id],
  ]);
  assert.equal(repaired.turnId, recoveryTurn.id);
  assert.equal(repaired.runId, "run-local-slash-turn-1-presentation-recovery");
  assert.equal(state.currentTurnId, "turn-1");
  assert.equal(state.input, "/help");
  assert.deepEqual(state.contextMentions, ["README.md"]);
  assert.deepEqual(state.attachedFiles, ["notes.md"]);
  assert.equal(state.isGenerating, true);
  assert.equal(state.agentStatus, "running");
  assert.equal(state.runtimeEvents.filter((event) => event.turnId === recoveryTurn.id).length, 3);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.title, undefined);
});

test("game studio local slash submission isolates a same-ID replacement through the real bridge", async () => {
  const admittedUserBlock = { id: 41, turnId: "turn-1", type: "user", content: "/agent unity-specialist" };
  const admittedTurn = {
    id: "turn-1",
    clientSubmissionId: "submission-original",
    workspaceInstructionReceiptId: "receipt-original",
    userPrompt: "/agent unity-specialist",
    title: "Pending local slash",
    mode: "edit",
    status: "executing",
    summary: "",
    blockIds: [41],
    collapsed: false,
    createdAt: 100,
  };
  const { state, updates } = createState({
    taskFlow: [admittedUserBlock],
    conversationTurns: [admittedTurn],
    currentTurnId: "turn-1",
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    text: "/agent unity-specialist",
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
  }));
  let releaseAgentSwitch;
  const agentSwitchBarrier = new Promise((resolve) => {
    releaseAgentSwitch = resolve;
  });
  const submission = startGameStudioLocalSlashSubmission({
    command: {
      type: "agent",
      slug: "unity-specialist",
      canonicalCommand: "/agent unity-specialist",
    },
    preferredLanguage: "zh",
    runSessionKey: "/repo:7",
    turnId: "turn-1",
    runId: "run-original",
    parentRunId: null,
    runtimeService: {
      resolveSlashCommand: () => ({ kind: "agent", slug: "unity-specialist" }),
    },
    getGameStudioInitialized: () => true,
    setActiveStudioAgentKey: async () => agentSwitchBarrier,
    appendLocalStudioTurn: bridge.appendLocalStudioTurn,
    ensureVisibleConclusion: bridge.ensureVisibleConclusion,
    emitRuntimeEvent: bridge.emitLocalSlashRuntimeEvent,
    logStoreEvent: () => {},
    nowMs: () => 500,
  });

  state.taskFlow = [{ id: 41, turnId: "turn-1", type: "user", content: "replacement work" }];
  state.conversationTurns = [{
    ...admittedTurn,
    clientSubmissionId: "submission-replacement",
    workspaceInstructionReceiptId: "receipt-replacement",
    userPrompt: "replacement work",
    createdAt: 200,
  }];
  state.input = "replacement draft";
  state.contextMentions = ["replacement.ts"];
  state.attachedFiles = ["replacement.md"];
  state.pendingRunDecision = { kind: "intent_confirmation", originalInput: "replacement work" };
  state.isGenerating = true;
  state.agentStatus = "running";
  state.elapsedTime = 19;
  releaseAgentSwitch();

  const completion = await submission.completion;
  const replacement = state.conversationTurns.find((turn) => turn.id === "turn-1");
  const recovery = state.conversationTurns.find((turn) =>
    turn.runtimeOutcome?.runId === "run-original-presentation-recovery"
  );

  assert.equal(completion.resultKind, "error");
  assert.equal(completion.conclusionAppended, true);
  assert.equal(completion.appendResult.disposition, "rejected");
  assert.equal(completion.appendResult.adoptionDecision.reason, "turn_identity_not_exact");
  assert.deepEqual(completion.conclusionOwner, {
    disposition: "recovery_completed",
    turnId: recovery.id,
    runId: "run-original-presentation-recovery",
    parentRunId: "run-original",
    resultKind: "error",
    summary: completion.summary,
  });
  assert.equal(replacement.status, "executing");
  assert.equal(replacement.runtimeOutcome, undefined);
  assert.ok(recovery);
  assert.equal(recovery.runtimeOutcome.status, "completed");
  assert.equal(recovery.runtimeOutcome.parentRunId, "run-original");
  assert.equal(state.runtimeEvents.filter((event) =>
    event.type === "turn.completed" && event.turnId === "turn-1"
  ).length, 0);
  assert.equal(state.runtimeEvents.filter((event) =>
    event.type === "run.completed" && event.turnId === "turn-1"
  ).length, 1);
  assert.deepEqual(state.runtimeEvents.filter((event) => event.turnId === recovery.id).map((event) => event.type), [
    "run.started",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(state.taskFlow.filter((block) =>
    block.turnId === recovery.id && block.type === "agent" && block.visibility === "assistant_final"
  ).length, 1);
  assert.equal(state.currentTurnId, "turn-1");
  assert.equal(state.input, "replacement draft");
  assert.deepEqual(state.contextMentions, ["replacement.ts"]);
  assert.deepEqual(state.attachedFiles, ["replacement.md"]);
  assert.equal(state.pendingRunDecision.originalInput, "replacement work");
  assert.equal(state.isGenerating, true);
  assert.equal(state.agentStatus, "running");
  assert.equal(state.elapsedTime, 19);
  assert.equal(updates.length, 1);
  const persisted = updates[0].patch.runtimeSnapshot.snapshot;
  assert.equal(persisted.conversationTurns.find((turn) => turn.id === "turn-1").status, "executing");
  assert.equal(persisted.runtimeEvents.filter((event) =>
    event.type === "turn.completed" && event.turnId === "turn-1"
  ).length, 0);
  assert.equal(persisted.runtimeEvents.filter((event) =>
    event.type === "run.completed" && event.turnId === "turn-1"
  ).length, 1);
  assert.equal(persisted.runtimeEvents.filter((event) =>
    event.type === "turn.completed" && event.turnId === recovery.id
  ).length, 1);
});

test("game studio local slash cancellation closes only its recovery owner after same-ID drift", async () => {
  const admittedTurn = {
    id: "turn-1",
    clientSubmissionId: "submission-original",
    workspaceInstructionReceiptId: "receipt-original",
    userPrompt: "/agent unity-specialist",
    title: "Pending local slash",
    mode: "edit",
    status: "executing",
    summary: "",
    blockIds: [41],
    collapsed: false,
    createdAt: 100,
  };
  const { state, updates } = createState({
    taskFlow: [{ id: 41, turnId: "turn-1", type: "user", content: admittedTurn.userPrompt }],
    conversationTurns: [admittedTurn],
    currentTurnId: "turn-1",
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    text: admittedTurn.userPrompt,
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
  }));
  let releaseAgentSwitch;
  const agentSwitchBarrier = new Promise((resolve) => {
    releaseAgentSwitch = resolve;
  });
  const controller = new AbortController();
  const submission = startGameStudioLocalSlashSubmission({
    command: {
      type: "agent",
      slug: "unity-specialist",
      canonicalCommand: admittedTurn.userPrompt,
    },
    preferredLanguage: "en",
    runSessionKey: "/repo:7",
    turnId: "turn-1",
    runId: "run-canceled-original",
    parentRunId: null,
    runtimeService: {
      resolveSlashCommand: () => ({ kind: "agent", slug: "unity-specialist" }),
    },
    getGameStudioInitialized: () => true,
    setActiveStudioAgentKey: async () => {
      await agentSwitchBarrier;
      if (controller.signal.aborted) {
        const error = new Error("agent switch canceled before commit");
        error.name = "AbortError";
        throw error;
      }
    },
    appendLocalStudioTurn: bridge.appendLocalStudioTurn,
    ensureVisibleConclusion: bridge.ensureVisibleConclusion,
    emitRuntimeEvent: bridge.emitLocalSlashRuntimeEvent,
    logStoreEvent: () => {},
    abortSignal: controller.signal,
    nowMs: () => 600,
  });

  state.taskFlow = [{ id: 41, turnId: "turn-1", type: "user", content: "replacement work" }];
  state.conversationTurns = [{
    ...admittedTurn,
    clientSubmissionId: "submission-replacement",
    workspaceInstructionReceiptId: "receipt-replacement",
    userPrompt: "replacement work",
    createdAt: 200,
  }];
  state.input = "replacement draft";
  state.isGenerating = true;
  state.agentStatus = "running";
  state.elapsedTime = 23;
  controller.abort();
  releaseAgentSwitch();

  const completion = await submission.completion;
  const replacement = state.conversationTurns.find((turn) => turn.id === "turn-1");
  const recovery = state.conversationTurns.find((turn) =>
    turn.runtimeOutcome?.runId === "run-canceled-original-presentation-recovery"
  );

  assert.equal(completion.resultKind, "canceled");
  assert.ok(recovery);
  assert.deepEqual(completion.conclusionOwner, {
    disposition: "recovery_completed",
    turnId: recovery.id,
    runId: "run-canceled-original-presentation-recovery",
    parentRunId: "run-canceled-original",
    resultKind: "canceled",
    summary: completion.summary,
  });
  assert.equal(replacement.status, "executing");
  assert.equal(replacement.runtimeOutcome, undefined);
  assert.deepEqual(state.runtimeEvents.filter((event) => event.turnId === "turn-1").map((event) => event.type), [
    "run.started",
    "slash.command.started",
    "slash.command.failed",
    "run.aborted",
    "run.completed",
  ]);
  assert.deepEqual(state.runtimeEvents.filter((event) => event.turnId === recovery.id).map((event) => event.type), [
    "run.started",
    "run.aborted",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(hasCanceledTurnTerminalProjection({
    sessionKey: "/repo:7",
    turnId: recovery.id,
    runtimeEvents: state.runtimeEvents,
    taskFlow: state.taskFlow,
  }), true);
  assert.equal(state.taskFlow.filter((block) =>
    block.turnId === recovery.id && block.type === "agent" && block.visibility === "assistant_final"
  ).length, 1);
  assert.equal(state.currentTurnId, "turn-1");
  assert.equal(state.input, "replacement draft");
  assert.equal(state.isGenerating, true);
  assert.equal(state.agentStatus, "running");
  assert.equal(state.elapsedTime, 23);
  assert.equal(updates.length, 1);
  const persisted = updates[0].patch.runtimeSnapshot.snapshot;
  assert.equal(hasCanceledTurnTerminalProjection({
    sessionKey: "/repo:7",
    turnId: recovery.id,
    runtimeEvents: persisted.runtimeEvents,
    taskFlow: persisted.taskFlow,
  }), true);
  const projectionBeforeConflict = JSON.stringify({
    taskFlow: state.taskFlow,
    conversationTurns: state.conversationTurns,
    runtimeEvents: state.runtimeEvents,
    currentTurnId: state.currentTurnId,
    input: state.input,
    isGenerating: state.isGenerating,
    agentStatus: state.agentStatus,
    elapsedTime: state.elapsedTime,
  });
  const conflictResolution = await bridge.ensureVisibleConclusion({
    content: "A conflicting error must not replace the canceled conclusion.",
    terminal: {
      runId: "run-canceled-original",
      parentRunId: null,
      resultKind: "error",
      reason: "conflicting_replay",
      timestampMs: 999,
    },
    rejectedAppend: completion.appendResult,
    slashFailure: {
      command: admittedTurn.userPrompt,
      executionMode: "local_fast",
      error: { message: "conflicting replay" },
    },
  });
  assert.deepEqual(conflictResolution, completion.conclusionOwner);
  assert.equal(JSON.stringify({
    taskFlow: state.taskFlow,
    conversationTurns: state.conversationTurns,
    runtimeEvents: state.runtimeEvents,
    currentTurnId: state.currentTurnId,
    input: state.input,
    isGenerating: state.isGenerating,
    agentStatus: state.agentStatus,
    elapsedTime: state.elapsedTime,
  }), projectionBeforeConflict);
  assert.equal(updates.length, 1);
});

test("game studio local slash bridge canonicalizes duplicate-id finals only for the captured owner", async () => {
  const { state } = createState({
    taskFlow: [
      { id: 41, turnId: "turn-1", type: "user", content: "/help" },
      { id: 42, turnId: "turn-1", type: "agent", content: "old A", visibility: "assistant_final", streaming: true },
      { id: 42, turnId: "turn-1", type: "agent", content: "", visibility: "assistant_final", streaming: true },
    ],
    conversationTurns: [{
      id: "turn-1",
      clientSubmissionId: "submission-1",
      workspaceInstructionReceiptId: "receipt-1",
      userPrompt: "/help",
      title: "Pending workspace instruction",
      mode: "edit",
      status: "executing",
      summary: "",
      blockIds: [41, 42],
      collapsed: false,
      createdAt: 100,
    }],
    currentTurnId: "turn-1",
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
  }));

  const repaired = await bridge.ensureVisibleConclusion({
    content: "Recovered exact owner conclusion",
    terminal: {
      runId: "run-exact",
      parentRunId: "run-parent",
      resultKind: "error",
      reason: "local_slash_error",
      timestampMs: 444,
    },
    rejectedAppend: {
      disposition: "rejected",
      turnId: "turn-1",
      conclusionBlockId: null,
      userBlockId: 41,
      presentation: "assistant_final",
      adoptionDecision: {
        kind: "rejected",
        reason: "user_block_not_found",
        turnId: "turn-1",
        userBlockId: 41,
      },
      terminal: null,
    },
    slashFailure: {
      command: "/help",
      executionMode: "local_fast",
      error: { message: "user block missing" },
    },
  });

  assert.deepEqual(repaired, {
    disposition: "original_repaired",
    turnId: "turn-1",
    runId: "run-exact",
    parentRunId: "run-parent",
    resultKind: "error",
    summary: "Recovered exact owner conclusion",
  });
  const finals = state.taskFlow.filter((block) =>
    block.turnId === "turn-1" && block.type === "agent" && block.visibility === "assistant_final"
  );
  assert.equal(finals.length, 1);
  assert.equal(finals[0].streaming, false);
  assert.equal(finals[0].content, "Recovered exact owner conclusion");
  assert.equal(state.conversationTurns.length, 1);
  assert.equal(state.conversationTurns[0].runtimeOutcome.runId, "run-exact");
  assert.equal(state.conversationTurns[0].runtimeOutcome.parentRunId, "run-parent");
});

test("game studio local slash bridge writes caught-error conclusions as assistant_final", async () => {
  const { state } = createState({
    taskFlow: [{ id: 41, turnId: "turn-1", type: "user", content: "/auto" }],
    conversationTurns: [{
      id: "turn-1",
      userPrompt: "/auto",
      title: "Pending workspace instruction",
      mode: "edit",
      status: "planning",
      summary: "",
      blockIds: [41],
      collapsed: false,
      createdAt: 100,
    }],
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    text: "/auto",
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
  }));

  const result = await bridge.appendLocalStudioTurn("斜杠命令执行失败：disk unavailable", {
    presentation: "assistant_final",
    lifecycle: {
      terminal: {
        runId: "run-local-slash-turn-1",
        parentRunId: null,
        resultKind: "error",
        reason: "local_slash_error",
      },
      slash: {
        command: "/auto",
        executionMode: "local_fast",
        outcome: "failed",
        error: { message: "disk unavailable" },
      },
    },
  });

  assert.equal(result.disposition, "appended");
  assert.equal(result.presentation, "assistant_final");
  assert.equal(state.taskFlow.at(-1).type, "agent");
  assert.equal(state.taskFlow.at(-1).visibility, "assistant_final");
  assert.equal(state.conversationTurns[0].status, "error");
  assert.equal(state.conversationTurns[0].runtimeOutcome.resultKind, "error");
});

test("game studio local slash bridge never idles a newer active Turn", async () => {
  const admittedUserBlock = { id: 41, turnId: "turn-1", type: "user", content: "/help" };
  const { state } = createState({
    taskFlow: [admittedUserBlock, { id: 50, turnId: "turn-2", type: "user", content: "new work" }],
    conversationTurns: [
      {
        id: "turn-1",
        clientSubmissionId: "submission-1",
        workspaceInstructionReceiptId: "receipt-1",
        userPrompt: "/help",
        title: "Local slash",
        mode: "edit",
        status: "executing",
        summary: "",
        blockIds: [41],
        collapsed: false,
        createdAt: 100,
      },
      {
        id: "turn-2",
        userPrompt: "new work",
        title: "New active Turn",
        mode: "edit",
        status: "executing",
        summary: "",
        blockIds: [50],
        collapsed: false,
        createdAt: 200,
      },
    ],
    currentTurnId: "turn-2",
    input: "new draft",
    contextMentions: ["new-context.ts"],
    attachedFiles: ["new-file.md"],
    pendingRunDecision: { kind: "intent_confirmation", originalInput: "new work" },
    isGenerating: true,
    agentStatus: "running",
    elapsedTime: 9,
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness, {
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
  }));

  const result = await bridge.appendLocalStudioTurn("# Help", {
    presentation: "assistant_final",
    lifecycle: {
      terminal: {
        runId: "run-old",
        parentRunId: null,
        resultKind: "success",
        reason: "local_slash_completed",
      },
      slash: {
        command: "/help",
        executionMode: "local_fast",
        outcome: "completed",
      },
    },
  });

  assert.equal(result.disposition, "appended");
  assert.equal(state.conversationTurns.find((turn) => turn.id === "turn-1").status, "done");
  assert.equal(state.currentTurnId, "turn-2");
  assert.equal(state.input, "new draft");
  assert.deepEqual(state.contextMentions, ["new-context.ts"]);
  assert.deepEqual(state.attachedFiles, ["new-file.md"]);
  assert.equal(state.pendingRunDecision.originalInput, "new work");
  assert.equal(state.isGenerating, true);
  assert.equal(state.agentStatus, "running");
  assert.equal(state.elapsedTime, 9);
});

test("game studio local slash bridge skips transcript events in legacy mode", () => {
  const { state, updates } = createState({
    config: {
      sessionRecordingEnabled: true,
      eventStreamMode: "legacy",
    },
  });
  const harness = createHarness(state);
  const bridge = createGameStudioLocalSlashBridge(createBridgeInput(state, harness));

  bridge.emitLocalSlashRuntimeEvent({
    type: "slash.command.started",
    threadId: "/repo:7",
    turnId: "turn-1",
    timestampMs: 123,
    command: "/help",
    executionMode: "local_fast",
  });

  assert.equal(state.runtimeEvents.length, 0);

  bridge.emitLocalSlashRuntimeEvent({
    type: "slash.command.failed",
    threadId: "/repo:7",
    turnId: "turn-1",
    timestampMs: 123,
    command: "/help",
    executionMode: "local_fast",
    error: { message: "help unavailable" },
  });

  assert.equal(state.runtimeEvents.length, 1);
  assert.equal(state.runtimeEvents[0].type, "slash.command.failed");

  bridge.emitLocalSlashRuntimeEvent({
    type: "run.started",
    threadId: "/repo:7",
    turnId: "turn-1",
    timestampMs: 124,
    runId: "run-local-slash-turn-1",
    parentRunId: null,
  });

  assert.equal(state.runtimeEvents.length, 2);
  assert.equal(state.runtimeEvents[1].type, "run.started");

  bridge.emitLocalSlashRuntimeEvent({
    type: "run.completed",
    threadId: "/repo:7",
    turnId: "turn-1",
    timestampMs: 125,
    runId: "run-local-slash-turn-1",
    parentRunId: null,
    resultKind: "error",
    summary: "help unavailable",
  });
  bridge.emitLocalSlashRuntimeEvent({
    type: "turn.completed",
    threadId: "/repo:7",
    turnId: "turn-1",
    timestampMs: 126,
    resultKind: "error",
  });

  assert.equal(updates.length, 0);
  assert.deepEqual(
    state.runtimeEvents.map((event) => event.type),
    ["slash.command.failed", "run.started", "run.completed", "turn.completed"],
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTs(sourcePath, customMocks = null) {
  const normalized = path.resolve(sourcePath);
  if (!customMocks && moduleCache.has(normalized)) return moduleCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const mod = { exports: {} };
  if (!customMocks) moduleCache.set(normalized, mod.exports);
  const runtimeRequire = (specifier) => {
    if (customMocks && Object.prototype.hasOwnProperty.call(customMocks, specifier)) {
      return customMocks[specifier];
    }
    if (specifier === "@tauri-apps/api/core") {
      return { invoke: async () => { throw new Error("unexpected invoke in unit test"); } };
    }
    if (specifier === "@tauri-apps/api/event") {
      return { listen: async () => () => {} };
    }
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate, customMocks);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(mod.exports, mod, runtimeRequire);
  if (!customMocks) moduleCache.set(normalized, mod.exports);
  return mod.exports;
}

const durableTurnContext = loadTs(path.join(workspaceRoot, "src/lib/durableTurnContext.ts"));
const runtimeV2 = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
const carryover = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/sessionSourceCarryover.ts"));
const validationCommand = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionValidationCommand.ts"));
const executionContract = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionContract.ts"));
const executionProviderTools = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderTools.ts"));
const executionProviderInstruction = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderInstruction.ts"));
const requestPolicy = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderRequestPolicy.ts"));
const languageRetry = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderLanguageRetry.ts"));
const errorClassifier = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderErrorClassification.ts"));
const cancellationBarrier = loadTs(path.join(workspaceRoot, "src/store/sessionCancellationBarrier.ts"));
const storeLogLevel = loadTs(path.join(workspaceRoot, "src/lib/storeLogLevel.ts"));
const gateReceipt = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionToolGateReceipt.ts"));
const projectBaseline = loadTs(path.join(workspaceRoot, "src/lib/projectBaseline.ts"));
const streamResponseFormat = loadTs(path.join(workspaceRoot, "src/lib/streamResponseFormat.ts"));
const streaming = loadTs(path.join(workspaceRoot, "src/lib/streaming.ts"));

const SHA_A = "sha256-" + "a".repeat(64);
const SHA_B = "sha256-" + "b".repeat(64);
const SHA_C = "sha256-" + "c".repeat(64);

function makeTurnAndRun(turnId = "turn-2", runId = "run-2") {
  const turn = {
    workspaceKey: "/repo",
    sessionKey: "session-1",
    sessionEpoch: "epoch-1",
    clientSubmissionId: `sub-${turnId}`,
    turnId,
  };
  const run = {
    workspaceKey: "/repo",
    sessionKey: "session-1",
    sessionEpoch: "epoch-1",
    turnId,
    runId,
    attemptId: `${runId}-attempt-1`,
    parentRunId: null,
  };
  return { turn, run };
}

function buildExecuteCheckpoint(events, strategy = "execute") {
  const { turn, run } = makeTurnAndRun("turn-cur", "run-cur");
  let checkpoint = null;
  let seq = 0;
  const push = (draft) => {
    const res = runtimeV2.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint ? checkpoint.revision : 0,
      event: {
        schemaVersion: runtimeV2.RUNTIME_V2_EVENT_SCHEMA_VERSION,
        sequence: seq++,
        eventId: `ev-${seq}`,
        at: 1_700_000_000_000 + seq,
        ...draft,
      },
    });
    assert.equal(res.disposition, "committed");
    checkpoint = res.checkpoint;
  };
  push({
    type: "turn.admitted",
    turn,
    strategy,
    objective: "repair module and verify",
    constraints: [],
    acceptanceCriteria: ["fixed"],
    acceptanceCriterionIds: ["c1"],
  });
  push({ type: "run.started", run, phase: "observing" });
  for (const draft of events(run, turn)) push(draft);
  return checkpoint;
}

function buildExecuteAggregate(events, strategy = "execute") {
  return buildExecuteCheckpoint(events, strategy).aggregate;
}

test("cross-turn DurableTurnContext inspectedFiles + disk-reverified carryover unlocks contracts without bypassing live edit reads", async () => {
  const durable = durableTurnContext.buildDurableTurnContext({
    turnId: "turn-1",
    turnBlocks: [
      { id: 1, type: "user", turnId: "turn-1", content: "inspect MFramework" },
      { id: 2, type: "tool", turnId: "turn-1", toolName: "read_file", target: "Assets/MFramework/Core/AddressableLoader.cs", toolStatus: "executed" },
      { id: 3, type: "tool", turnId: "turn-1", toolName: "read_file", target: ".MAIN/plans/plan-1/rev-1.md", toolStatus: "executed" },
      { id: 4, type: "tool", turnId: "turn-1", toolName: "write_file", target: "Assets/MFramework/Core/NewFile.cs", toolStatus: "executed" },
      { id: 5, type: "agent", turnId: "turn-1", visibility: "assistant_final", content: "Found issues in AddressableLoader.cs." },
    ],
    inspectedFiles: [
      "Assets/MFramework/Pool/ObjectPoolManager.cs",
      "Assets/MFramework/Core/NewFile.cs",
    ],
  });
  assert.ok(durable);
  assert.deepEqual(durable.execution?.inspectedFiles, [
    "Assets/MFramework/Pool/ObjectPoolManager.cs",
    "Assets/MFramework/Core/AddressableLoader.cs",
  ]);
  const serialized = durableTurnContext.serializeDurableTurnContextForModel(durable, 4000);
  assert.match(serialized, /inspectedFiles/);
  assert.doesNotMatch(serialized, /\.MAIN\/plans/);

  const { turn: priorTurn, run: priorRun } = makeTurnAndRun("turn-1", "run-1");
  let checkpoint = null;
  let seq = 0;
  const priorController = new runtimeV2.RuntimeV2Controller({
    checkpoint: {
      load: async () => checkpoint,
      append: async ({ owner, expectedRevision, event }) => {
        const res = runtimeV2.appendRuntimeV2Checkpoint({ checkpoint, owner, expectedRevision, event });
        if (res.disposition === "committed" || res.disposition === "idempotent") checkpoint = res.checkpoint;
        return res;
      },
      commitEmergencyTerminal: async () => ({ disposition: "conflict", envelope: null }),
    },
    provider: { request: async () => ({ content: "", toolCalls: [] }) },
    tool: { execute: async () => { throw new Error("not used"); } },
    scheduler: { execute: async () => { throw new Error("not used"); } },
    projection: { publish: async () => {} },
    clockId: { now: () => 1000 + (++seq), nextId: (s) => `${s}-${++seq}`, nextIdempotencyKey: ({ run: r, kind }) => `${r.runId}:${kind}:${++seq}` },
  });
  await priorController.admit({ turn: priorTurn, run: priorRun, strategy: "execute", objective: "inspect", initialPhase: "observing" });
  await priorController.recordObservation({ id: "e1", kind: "source", target: "Assets/Core/Unchanged.cs", version: SHA_A });
  await priorController.recordObservation({ id: "e2", kind: "source", target: "Assets/Core/ModifiedOnDisk.cs", version: SHA_B });
  await priorController.recordObservation({ id: "e3", kind: "source", target: ".MAIN/plans/plan-1/rev-1.md", version: SHA_C });
  await priorController.finishTerminal("success", "ok");

  const priorCandidates = carryover.collectPriorSessionVersionedSources({
    state: { runtimeV2Checkpoints: { "turn-1": checkpoint } },
    sessionKey: "session-1",
    workspaceKey: "/repo",
    excludeTurnId: "turn-2",
  });
  assert.equal(priorCandidates.some((c) => c.target.includes(".MAIN/plans")), false);

  const admitted = [];
  let evidenceSeq = 0;
  const carryoverResult = await carryover.carryOverPriorSessionSources({
    state: { runtimeV2Checkpoints: { "turn-1": checkpoint } },
    sessionKey: "session-1",
    workspaceKey: "/repo",
    turnId: "turn-2",
    runId: "run-2",
    readFileVersion: async (target) => {
      if (target === "Assets/Core/Unchanged.cs") return SHA_A;
      if (target === "Assets/Core/ModifiedOnDisk.cs") return SHA_C;
      return null;
    },
    recordObservation: async (evidence) => { admitted.push(evidence); },
    nextEvidenceId: () => `carry-${++evidenceSeq}`,
  });

  assert.equal(carryoverResult.admittedCount, 1);
  assert.equal(carryoverResult.skippedStaleCount, 1);
  assert.equal(admitted[0]?.target, "Assets/Core/Unchanged.cs");
  assert.equal(admitted[0]?.version, SHA_A);

  const followUpAggregate = buildExecuteAggregate((run) => [
    { type: "observation.recorded", run, evidence: admitted[0] },
  ]);
  const contractResult = executionContract.validateRuntimeV2ExecutionContractSubmission({
    aggregate: followUpAggregate,
    args: {
      summary: "Fix carried-over target",
      root_causes: ["Observed bug in carried-over source"],
      changes: [{
        operation: "modify",
        targets: ["Assets/Core/Unchanged.cs"],
        change: "Fix logic",
        expected_outcome: "Passes inline assertion",
      }],
      validations: [{
        kind: "finite_command",
        command: 'python3 -c "assert 1 == 1"',
        expected_outcome: "Exits 0",
      }],
    },
  });
  assert.equal(contractResult.allowed, true);
});

test("multi-violation contract diagnostics aggregate all issues, provide fix hints, and gate record_execution_contract by strategy", () => {
  const piped = validationCommand.finiteValidationCommandRejection("python3 -m unittest | tail -20");
  assert.equal(piped?.reasonCode, "finite_validation_contract_required");
  assert.equal(piped?.rejectionReason, "pipeline_exit_status_ambiguous");
  assert.match(piped?.message || "", /管道|tail/);

  const grepOnly = validationCommand.finiteValidationCommandRejection("grep -rn Foo src/");
  assert.equal(grepOnly?.rejectionReason, "unbounded_command_segment");
  assert.match(grepOnly?.message || "", /inline_assertion|python3 -c/);

  const multiAggregate = buildExecuteAggregate(() => []);
  const rejected = executionContract.validateRuntimeV2ExecutionContractSubmission({
    aggregate: multiAggregate,
    args: {
      summary: "Fix and verify",
      root_causes: ["Verified issue"],
      changes: [
        { operation: "modify", targets: ["src/unread.ts"], change: "update", expected_outcome: "fixed" },
        { operation: "delete", targets: ["src/unread.ts"], change: "remove", expected_outcome: "removed" },
      ],
      validations: [
        { kind: "finite_command", command: "npm test | tail -n 10", expected_outcome: "passes" },
      ],
    },
  });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reason, /EXECUTION_CONTRACT_REJECTED \(3 issues\):/);
  assert.match(rejected.reason, /\[1\].*pipeline_exit_status_ambiguous/);
  assert.match(rejected.reason, /\[2\].*Unread targets: src\/unread\.ts/);
  assert.match(rejected.reason, /\[3\].*conflicting modify and delete/);

  const execCheckpoint = buildExecuteCheckpoint(() => [], "execute");
  const planCheckpoint = buildExecuteCheckpoint(() => [], "plan");
  const dummyCommand = {
    kind: "request_model",
    run: multiAggregate.run.identity,
    phase: "observing",
    idempotencyKey: "cmd-1",
    payload: {
      mode: "execute",
      collaborationAllowed: true,
      remainingSubagentCapacity: 1,
      collaborationRequestMode: "serialized",
    },
  };
  const makePorts = (cp) => ({
    get: () => ({
      runtimeV2Checkpoints: {
        [cp.owner.turnId]: cp,
      },
    }),
    context: { turnId: cp.owner.turnId, runWorkspace: "/repo", runSessionKey: "session-1", phaseLanguage: "zh" },
  });
  const planTools = executionProviderTools.selectRuntimeV2ProviderToolDefinitions({
    ports: makePorts(planCheckpoint),
    command: dummyCommand,
    available: [executionContract.RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL],
  });
  assert.equal(planTools.some((t) => t.function.name === "record_execution_contract"), false);

  const execTools = executionProviderTools.selectRuntimeV2ProviderToolDefinitions({
    ports: makePorts(execCheckpoint),
    command: dummyCommand,
    available: [executionContract.RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL],
  });
  assert.equal(execTools.some((t) => t.function.name === "record_execution_contract"), true);

  const instr = executionProviderInstruction.providerModeInstruction(dummyCommand, "", {
    hasReadFile: true,
    hasMutation: false,
    hasSpawnSubagent: true,
    hasWaitSubagents: true,
  });
  assert.match(instr, /sequentially rather than concurrently/);
});

test("language retry skips incomplete execute/validate modes, rolls back ephemeral history, and classifies stream repetition", async () => {
  const incompleteExec = buildExecuteAggregate(() => []);
  assert.equal(
    requestPolicy.canRuntimeV2RequestConcludeWithProse({
      aggregate: incompleteExec,
      requestMode: "execute",
    }),
    false,
  );
  assert.equal(
    requestPolicy.canRuntimeV2RequestConcludeWithProse({
      aggregate: incompleteExec,
      requestMode: "validate",
    }),
    false,
  );
  assert.equal(
    requestPolicy.canRuntimeV2RequestConcludeWithProse({
      aggregate: incompleteExec,
      requestMode: "conclude",
    }),
    true,
  );
  assert.equal(
    requestPolicy.evaluateRuntimeV2LanguageRetry({
      text: "The previous attempt checked the files and needs a tool call next.",
      targetLanguage: "zh",
      aborted: false,
      toolCallCount: 0,
      hasProtocolViolation: false,
      outputTruncated: false,
      proseConclusionAllowed: false,
    }).shouldRetry,
    false,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Internal error", { status: 500 });
  const live = {
    messages: [{ role: "user", content: "initial" }],
    latestProviderAssistantReasoning: null,
  };
  try {
    await assert.rejects(() =>
      languageRetry.retryRuntimeV2ProviderLanguageMismatch({
        live,
        ports: {
          get: () => ({}),
          context: { phaseLanguage: "zh", runWorkspace: "/repo", runSessionKey: "session-1" },
          logStoreEvent: () => {},
        },
        command: {
          kind: "request_model",
          run: incompleteExec.run.identity,
          phase: "finalizing",
          idempotencyKey: "cmd-lang",
          payload: { mode: "conclude" },
        },
        requestMode: "conclude",
        result: {
          content: "Here is the complete final analysis in English words only for retry test.",
          semanticContent: "Here is the complete final analysis in English words only for retry test.",
          toolCalls: [],
          finishReason: "stop",
          clientStopReason: null,
          protocolViolation: null,
        },
        streamedText: "",
        resetStreamedText: () => {},
        providerTools: [],
        requestSettings: {
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          model: "gpt-4o-mini",
          apiProtocol: "openai",
          apiFormat: "chat_completions",
          useRustProxy: false,
        },
        textEnvelope: false,
        effectiveToolChoice: null,
        maxOutputTokens: 256,
        signal: new AbortController().signal,
        reasoningOnlyCharLimit: null,
        activity: { preparing: () => {}, requestDispatched: () => () => {} },
        rebuildRetryMessages: () => live.messages.slice(),
        wireCallbacks: () => ({ onToken: () => {}, onDone: () => {}, onError: () => {} }),
      }),
    );
    assert.deepEqual(live.messages, [{ role: "user", content: "initial" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const eventsLogged = [];
  const repLive = {
    messages: [{ role: "user", content: "task" }],
    latestProviderAssistantReasoning: null,
    provenStructuredToolTransports: new Set(),
  };
  for (let i = 0; i < 2; i += 1) {
    const out = errorClassifier.classifyAndRecordRuntimeV2ProviderAttemptError({
      error: Object.assign(new Error("STREAM_VISIBLE_TEXT_REPETITION: cycle"), { code: "STREAM_VISIBLE_TEXT_REPETITION" }),
      textEnvelope: false,
      attemptVariant: "native_tools",
      command: { kind: "request_model", run: incompleteExec.run.identity, phase: "acting", idempotencyKey: `c-${i}`, payload: {} },
      live: repLive,
      logStoreEvent: (event, data) => eventsLogged.push({ event, data }),
    });
    assert.equal(out.protocolFallbackAllowed, false);
    assert.equal(runtimeV2.isRuntimeV2ProviderProtocolError(out.lastError), true);
    assert.equal(out.lastError.code, "provider_response_rejected");
  }
  const repFeedbackCount = repLive.messages.filter(
    (m) => typeof m.content === "string" && m.content.includes("[runtime-v2 provider feedback: visible_stream_repetition]"),
  ).length;
  assert.equal(repFeedbackCount, 1);
  assert.equal(eventsLogged[0]?.data?.repetitionAborted, true);
});

test("single-owner cancellation barrier prevents controller checkpoint race and recognizes multi-run canceled projections", async () => {
  const { turn, run } = makeTurnAndRun("turn-cancel", "run-cancel");
  let checkpoint = null;
  let appendCount = 0;
  const abortController = new AbortController();
  let seq = 0;
  const controller = new runtimeV2.RuntimeV2Controller({
    checkpoint: {
      load: async () => checkpoint,
      append: async ({ owner, expectedRevision, event }) => {
        appendCount += 1;
        const res = runtimeV2.appendRuntimeV2Checkpoint({ checkpoint, owner, expectedRevision, event });
        if (res.disposition === "committed" || res.disposition === "idempotent") checkpoint = res.checkpoint;
        return res;
      },
      commitEmergencyTerminal: async () => ({ disposition: "conflict", envelope: null }),
    },
    provider: { request: async () => ({ content: "", toolCalls: [] }) },
    tool: { execute: async () => { throw new Error("not used"); } },
    scheduler: { execute: async () => { throw new Error("not used"); } },
    projection: { publish: async () => {} },
    clockId: { now: () => 1700000000000 + (++seq), nextId: (s) => `${s}-${++seq}`, nextIdempotencyKey: ({ run: r, kind }) => `${r.runId}:${kind}:${++seq}` },
  }, undefined, {
    abortSignal: abortController.signal,
    isExternalCancellationPending: () => true,
  });

  await controller.admit({ turn, run, strategy: "execute", objective: "edit something", initialPhase: "observing" });
  const appendsBeforeAbort = appendCount;
  abortController.abort();
  await assert.rejects(() => controller.driveOnce(), /RUNTIME_V2_EXTERNAL_CANCELLATION_PENDING/);
  assert.equal(appendCount, appendsBeforeAbort);
  assert.equal(controller.snapshot().aggregate?.terminalOutcome ?? null, null);

  assert.equal(
    cancellationBarrier.hasCanceledTurnTerminalProjection({
      sessionKey: "session-1",
      turnId: "turn-multi",
      runtimeEvents: [
        { type: "run.aborted", threadId: "session-1", turnId: "turn-multi", runId: "plan-run" },
        { type: "run.completed", threadId: "session-1", turnId: "turn-multi", runId: "plan-run", resultKind: "success" },
        { type: "run.aborted", threadId: "session-1", turnId: "turn-multi", runId: "exec-run" },
        { type: "run.completed", threadId: "session-1", turnId: "turn-multi", runId: "exec-run", resultKind: "canceled" },
        { type: "turn.completed", threadId: "session-1", turnId: "turn-multi", resultKind: "canceled" },
      ],
      taskFlow: [{ type: "agent", turnId: "turn-multi", visibility: "assistant_final" }],
    }),
    true,
  );
});

test("semantic log levels, blocked tool causal details, root-filtered baseline probes, and stream_options HTTP 400 fallback", async () => {
  assert.equal(storeLogLevel.resolveStoreEventLogLevel("runtime_v2_execute_infrastructure_failure"), "error");
  assert.equal(storeLogLevel.resolveStoreEventLogLevel("runtime_v2_tool_execution_blocked"), "warn");
  assert.equal(storeLogLevel.resolveStoreEventLogLevel("runtime_v2_provider_language_retry"), "warn");
  assert.equal(storeLogLevel.resolveStoreEventLogLevel("runtime_v2_ledger_committed", { eventType: "recovery.exhausted" }), "warn");
  assert.equal(storeLogLevel.resolveStoreEventLogLevel("plan_workspace_hydration_empty"), "debug");
  assert.equal(storeLogLevel.resolveStoreEventLogLevel("active_guidance_cleared", {}), "debug");
  assert.equal(storeLogLevel.resolveStoreEventLogLevel("runtime_v2_tool_execution_completed"), "info");

  const logged = [];
  gateReceipt.runtimeV2ToolAuthorizationRejectionReceipt({
    ports: {
      get: () => ({}),
      live: { messages: [] },
      logStoreEvent: (event, data) => logged.push({ event, data }),
      context: { phaseLanguage: "zh" },
    },
    command: { kind: "execute_tool", run: makeTurnAndRun().run, idempotencyKey: "k1", phase: "acting", payload: {} },
    toolName: "record_execution_contract",
    args: {
      changes: [{ operation: "modify", targets: ["Assets/A.cs"] }],
      validations: [{ kind: "finite_command", command: "npm test | tail" }],
    },
    target: "record_execution_contract",
    failureContextTarget: "record_execution_contract",
    rejection: {
      allowed: false,
      reasonCode: "execution_contract_rejected",
      reason: "EXECUTION_CONTRACT_REJECTED: secret=Bearer topsecret pipeline_exit_status_ambiguous",
    },
  });
  assert.equal(logged[0]?.event, "runtime_v2_tool_execution_blocked");
  assert.match(logged[0]?.data?.detail || "", /\[REDACTED\]/);
  assert.match(logged[0]?.data?.argSummary || "", /Assets\/A\.cs/);

  const statOrReadCalls = [];
  const dirListCalls = [];
  const unityFiles = new Map([
    ["ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 2022.3.20f1\n"],
    ["Assets/Core/Boot.cs", "class Boot {}"],
  ]);
  await projectBaseline.buildProjectBaselineContext({
    workspace: "/unity-repo",
    io: {
      canonicalizeWorkspace: async (w) => w,
      resolveVcsRoot: async () => "/unity-repo",
      getFileByteSize: async ({ path: p }) => {
        statOrReadCalls.push(p);
        const content = unityFiles.get(p);
        if (!content) throw new Error("missing");
        return Buffer.byteLength(content);
      },
      readFile: async ({ path: p }) => {
        statOrReadCalls.push(p);
        const content = unityFiles.get(p);
        if (!content) throw new Error("missing");
        return content;
      },
      listDirectory: async ({ path: dir }) => {
        dirListCalls.push(dir);
        if (dir === "") {
          return [
            { name: "Assets", kind: "directory" },
            { name: "ProjectSettings", kind: "directory" },
          ];
        }
        if (dir === "ProjectSettings") return [{ name: "ProjectVersion.txt", kind: "file" }];
        if (dir === "Assets") return [{ name: "Core", kind: "directory" }];
        if (dir === "Assets/Core") return [{ name: "Boot.cs", kind: "file" }];
        return [];
      },
    },
  });
  assert.equal(statOrReadCalls.some((p) => p === "package.json" || p === "Cargo.toml"), false);
  assert.equal(dirListCalls.includes(".cursor/rules"), false);
  assert.equal(dirListCalls.includes(".MAIN/rules"), false);

  assert.equal(
    streamResponseFormat.isUnsupportedStreamUsageOption('HTTP 400 Bad Request: {"error":{"param":"stream_options","code":"extra_forbidden"}}'),
    true,
  );
  assert.equal(
    streamResponseFormat.isUnsupportedStreamUsageOption("HTTP 400 Bad Request: invalid api key"),
    false,
  );

  const originalFetch = globalThis.fetch;
  const fetchBodies = [];
  let doneResult = null;
  globalThis.fetch = async (_url, init) => {
    const parsedBody = JSON.parse(String(init.body));
    fetchBodies.push(parsedBody);
    if (fetchBodies.length === 1) {
      return new Response(JSON.stringify({
        error: { message: "Extra inputs are not permitted", param: "stream_options", code: "extra_forbidden" },
      }), { status: 400, statusText: "Bad Request" });
    }
    const sse = [
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const res = await streaming.streamChatCompletion(
      [{ role: "user", content: "hi" }],
      {
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        apiProtocol: "openai",
        apiFormat: "chat_completions",
        useRustProxy: false,
      },
      {
        onToken: () => {},
        onDone: (r) => { doneResult = r; },
        onError: (e) => { throw e; },
      },
    );
    assert.equal(fetchBodies.length, 2);
    assert.deepEqual(fetchBodies[0].stream_options, { include_usage: true });
    assert.equal("stream_options" in fetchBodies[1], false);
    assert.equal(res.content, "hello");
    assert.equal(doneResult?.usage?.inputTokens, 12);
    assert.equal(doneResult?.usage?.outputTokens, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

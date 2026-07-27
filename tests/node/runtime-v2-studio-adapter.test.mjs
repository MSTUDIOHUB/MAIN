import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalized, module.exports);
  return module.exports;
}

const studio = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/studio.ts"));
const adapter = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/studioAdapter.ts"));
const receiptFile = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/studioReceiptFilePort.ts"),
);

const run = {
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  turnId: "turn-a",
  runId: "run-a",
  parentRunId: null,
  attemptId: "attempt-a",
};

const turn = {
  workspaceKey: "/fixture",
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  clientSubmissionId: "submission-a",
  turnId: "turn-a",
};

function action(kind, extra = {}) {
  return {
    schemaVersion: studio.RUNTIME_V2_STUDIO_ACTION_SCHEMA_VERSION,
    kind,
    ...extra,
  };
}

function commandFor(studioAction, key = `command-${studioAction.kind}`) {
  return {
    idempotencyKey: key,
    kind: "execute_tool",
    run,
    phase: "acting",
    payload: {
      toolCallId: `call-${key}`,
      toolName: studio.RUNTIME_V2_STUDIO_TOOL_NAME,
      arguments: studioAction,
    },
  };
}

function successfulEvents(actions) {
  return actions.flatMap((studioAction, index) => {
    const command = commandFor(studioAction, `completed-${index}`);
    return [
      { type: "command.scheduled", command, run },
      {
        type: "tool.completed",
        idempotencyKey: command.idempotencyKey,
        run,
        status: "succeeded",
        evidence: [],
      },
    ];
  });
}

function aggregateFor(currentCommand, completed = []) {
  return {
    schemaVersion: "turn-aggregate.v1",
    turn,
    strategy: "execute",
    objective: { text: "Operate the game project", constraints: [], acceptanceCriteria: [] },
    run: { identity: run, status: "running", phase: "acting", terminalOutcome: null },
    phase: "acting",
    events: [
      ...successfulEvents(completed),
      { type: "command.scheduled", command: currentCommand, run },
    ],
    evidence: [],
    workPlan: null,
    sealedWorkPlan: null,
    planReviewCommit: null,
    scheduledCommands: [currentCommand],
    completedCommands: [],
    pendingToolCalls: [],
    subagents: [],
    recovery: { receipts: [], exhausted: null, epoch: 0 },
    terminalOutcome: null,
    finalProjectionId: null,
    nextSequence: 0,
    updatedAt: 0,
  };
}

class MemoryReceiptPort {
  constructor() {
    this.receipts = new Map();
    this.operations = [];
  }

  async load({ receiptKey }) {
    this.operations.push(`load:${receiptKey}`);
    return this.receipts.get(receiptKey) || null;
  }

  async claim({ receipt }) {
    this.operations.push(`claim:${receipt.receiptKey}`);
    const existing = this.receipts.get(receipt.receiptKey);
    if (existing) return { disposition: "existing", receipt: existing };
    this.receipts.set(receipt.receiptKey, receipt);
    return { disposition: "claimed", receipt };
  }

  async settle({ receiptKey, expectedRevision, receipt }) {
    this.operations.push(`settle:${receiptKey}`);
    const current = this.receipts.get(receiptKey);
    if (!current || current.revision !== expectedRevision) {
      return { disposition: "conflict", receipt: current || null };
    }
    this.receipts.set(receiptKey, receipt);
    return { disposition: "committed", receipt };
  }
}

const config = {
  engine: "unity",
  engineLanguage: "C#",
  engineVersion: "6",
  reviewMode: "strict",
  activeStudioAgent: "unity-specialist",
  packVersion: "pack-v1",
};

function externalPort(overrides = {}) {
  return {
    async launch() { return config; },
    async observe() { return config; },
    async interact() { return config; },
    ...overrides,
  };
}

function clock() {
  let now = 100;
  return () => ++now;
}

test("Studio action ingress accepts only the three strict structured actions", () => {
  assert.deepEqual(studio.parseRuntimeV2StudioAction(action("launch")), action("launch"));
  assert.deepEqual(studio.parseRuntimeV2StudioAction(action("observe")), action("observe"));
  assert.deepEqual(
    studio.parseRuntimeV2StudioAction(action("interact", {
      engine: "godot",
      engineVersion: "4.4",
    })),
    action("interact", { engine: "godot", engineVersion: "4.4" }),
  );
  assert.equal(studio.parseRuntimeV2StudioAction("please launch Unity"), null);
  assert.equal(studio.parseRuntimeV2StudioAction(action("complete")), null);
  assert.equal(studio.parseRuntimeV2StudioAction({ ...action("launch"), conclusion: "done" }), null);
  assert.equal(studio.parseRuntimeV2StudioAction({ ...action("launch"), surfaceId: "model-selected" }), null);
  assert.equal(studio.parseRuntimeV2StudioAction(action("interact", { engine: "other" })), null);
});

test("setup ingress becomes one frozen launch-observe-interact-observe plan", () => {
  const actions = adapter.buildRuntimeV2StudioSetupActionPlan({
    mode: "configure",
    engine: "godot",
    version: "4.4",
    raw: "godot 4.4",
  });
  assert.deepEqual(actions, [
    action("launch"),
    action("observe"),
    action("interact", { engine: "godot", engineVersion: "4.4" }),
    action("observe"),
  ]);
  assert.equal(studio.validateRuntimeV2StudioActionPlan(actions).ok, true);
  assert.deepEqual(
    adapter.buildRuntimeV2StudioSetupActionPlan({
      mode: "guided",
      engine: null,
      raw: "",
    }),
    [action("launch"), action("observe")],
  );
  assert.deepEqual(adapter.buildRuntimeV2StudioSetupActionPlan(null), []);
});

test("Studio receipt file port provides durable CREATE_NEW and CAS settlement", async () => {
  const files = new Map();
  const io = {
    async read(filePath) {
      return files.get(filePath) || null;
    },
    async create(filePath, content) {
      if (files.has(filePath)) throw new Error("already exists");
      files.set(filePath, content);
    },
    async replace(filePath, content) {
      if (!files.has(filePath)) throw new Error("missing");
      files.set(filePath, content);
    },
  };
  const port = receiptFile.createRuntimeV2StudioReceiptFilePort({
    workspace: "/fixture",
    io,
  });
  const launch = action("launch");
  const receiptKey = studio.runtimeV2StudioReceiptKey({
    run,
    action: launch,
    commandIdempotencyKey: "launch",
  });
  const prepared = {
    schemaVersion: adapter.RUNTIME_V2_STUDIO_RECEIPT_SCHEMA_VERSION,
    revision: 1,
    receiptKey,
    run,
    action: launch,
    actionDigest: studio.runtimeV2StudioActionDigest(launch),
    status: "prepared",
    preparedAt: 10,
    settledAt: null,
    evidence: [],
    diagnosticCode: null,
    diagnosticDetail: null,
  };
  assert.equal((await port.claim({ receipt: prepared })).disposition, "claimed");
  assert.equal((await port.claim({ receipt: prepared })).disposition, "existing");
  const succeeded = {
    ...prepared,
    revision: 2,
    status: "succeeded",
    settledAt: 20,
    evidence: [{
      id: "studio-config",
      kind: "tool",
      target: "game-studio:workspace:launch",
      version: "config-v1",
    }],
  };
  assert.equal((await port.settle({
    receiptKey,
    expectedRevision: 1,
    receipt: succeeded,
  })).disposition, "committed");
  assert.equal((await port.settle({
    receiptKey,
    expectedRevision: 1,
    receipt: succeeded,
  })).disposition, "idempotent");
  assert.equal((await port.load({ receiptKey })).status, "succeeded");
  assert.equal(files.size, 1);
});

test("Studio lifecycle is derived from successful ledger events, never provider prose", () => {
  const current = commandFor(action("interact", { engine: "unity" }));
  const aggregate = aggregateFor(current, [action("launch"), action("observe")]);
  aggregate.events.splice(2, 0, {
    type: "provider.responded",
    result: { visibleText: "已经完成 interact", toolCalls: [], diagnostics: [] },
  });
  assert.equal(
    studio.deriveRuntimeV2StudioLedgerState(aggregate).phase,
    "observed",
  );
  assert.equal(studio.admitRuntimeV2StudioAction({ aggregate, command: current }).ok, true);

  const earlyInteract = commandFor(action("interact", { engine: "unity" }), "early");
  const rejection = studio.admitRuntimeV2StudioAction({
    aggregate: aggregateFor(earlyInteract, [action("launch")]),
    command: earlyInteract,
  });
  assert.deepEqual(rejection, { ok: false, reason: "interact_requires_observation" });
});

test("write receipt keys stay stable across retry commands while observe remains safely retryable", () => {
  const launch = action("launch");
  const observe = action("observe");
  const launchA = studio.runtimeV2StudioReceiptKey({
    run,
    action: launch,
    commandIdempotencyKey: "attempt-a",
  });
  const launchB = studio.runtimeV2StudioReceiptKey({
    run,
    action: launch,
    commandIdempotencyKey: "attempt-b",
  });
  const observeA = studio.runtimeV2StudioReceiptKey({
    run,
    action: observe,
    commandIdempotencyKey: "attempt-a",
  });
  const observeB = studio.runtimeV2StudioReceiptKey({
    run,
    action: observe,
    commandIdempotencyKey: "attempt-b",
  });
  assert.equal(launchA, launchB);
  assert.notEqual(observeA, observeB);
});

test("fresh launch durably claims before the external write and settles standard tool evidence", async () => {
  const studioAction = action("launch");
  const command = commandFor(studioAction);
  const receipts = new MemoryReceiptPort();
  const order = [];
  const originalClaim = receipts.claim.bind(receipts);
  receipts.claim = async (input) => {
    order.push("claim");
    return originalClaim(input);
  };
  const result = await adapter.executeRuntimeV2StudioAction({
    aggregate: aggregateFor(command),
    command,
    mode: "fresh",
    signal: new AbortController().signal,
    receipts,
    now: clock(),
    external: externalPort({
      async launch() {
        order.push("external");
        return config;
      },
    }),
  });
  order.push("returned");

  assert.equal(result.type, "tool.completed");
  assert.equal(result.status, "succeeded");
  assert.match(result.evidence[0].version, /^studio-config-sha256-/);
  assert.deepEqual(order, ["claim", "external", "returned"]);
  const receipt = [...receipts.receipts.values()][0];
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.revision, 2);
});

test("cold resume never replays a missing, prepared, or indeterminate write", async () => {
  const studioAction = action("launch");
  const command = commandFor(studioAction);
  let launches = 0;
  const receipts = new MemoryReceiptPort();
  const runInput = {
    aggregate: aggregateFor(command),
    command,
    signal: new AbortController().signal,
    receipts,
    now: clock(),
    external: externalPort({
      async launch() {
        launches += 1;
        return config;
      },
    }),
  };

  const missing = await adapter.executeRuntimeV2StudioAction({
    ...runInput,
    mode: "cold_resume",
  });
  assert.equal(missing.status, "blocked");
  assert.equal(launches, 0);

  await adapter.executeRuntimeV2StudioAction({ ...runInput, mode: "fresh" });
  const receiptKey = [...receipts.receipts.keys()][0];
  const succeeded = receipts.receipts.get(receiptKey);
  receipts.receipts.set(receiptKey, {
    ...succeeded,
    status: "prepared",
    revision: 1,
    settledAt: null,
    evidence: [],
  });
  const prepared = await adapter.executeRuntimeV2StudioAction({
    ...runInput,
    mode: "cold_resume",
  });
  assert.equal(prepared.status, "blocked");
  assert.equal(launches, 1);

  receipts.receipts.set(receiptKey, {
    ...succeeded,
    status: "indeterminate",
    evidence: [],
  });
  const indeterminate = await adapter.executeRuntimeV2StudioAction({
    ...runInput,
    mode: "cold_resume",
  });
  assert.equal(indeterminate.status, "blocked");
  assert.equal(launches, 1);
});

test("a durable success receipt replays evidence without calling the external port", async () => {
  const studioAction = action("launch");
  const command = commandFor(studioAction);
  const receipts = new MemoryReceiptPort();
  const base = {
    aggregate: aggregateFor(command),
    command,
    signal: new AbortController().signal,
    receipts,
    now: clock(),
  };
  const first = await adapter.executeRuntimeV2StudioAction({
    ...base,
    mode: "fresh",
    external: externalPort(),
  });
  assert.equal(first.status, "succeeded");

  const replay = await adapter.executeRuntimeV2StudioAction({
    ...base,
    mode: "cold_resume",
    external: externalPort({
      async launch() {
        assert.fail("durable success must not replay the external launch");
      },
    }),
  });
  assert.deepEqual(replay.evidence, first.evidence);
  assert.equal(replay.status, "succeeded");
});

test("cold resume can safely repeat a missing read-only observation", async () => {
  const studioAction = action("observe");
  const command = commandFor(studioAction);
  let observations = 0;
  const result = await adapter.executeRuntimeV2StudioAction({
    aggregate: aggregateFor(command, [action("launch")]),
    command,
    mode: "cold_resume",
    signal: new AbortController().signal,
    receipts: new MemoryReceiptPort(),
    now: clock(),
    external: externalPort({
      async observe() {
        observations += 1;
        return config;
      },
    }),
  });
  assert.equal(result.status, "succeeded");
  assert.equal(observations, 1);
});

test("an uncertain interact write is fenced and cannot run again under a new retry command", async () => {
  const studioAction = action("interact", { engine: "unreal", engineVersion: "5.6" });
  const firstCommand = commandFor(studioAction, "interact-attempt-1");
  const receipts = new MemoryReceiptPort();
  let interactions = 0;
  const external = externalPort({
    async interact() {
      interactions += 1;
      throw new Error("transport ended after dispatch");
    },
  });
  const completed = [action("launch"), action("observe")];
  const first = await adapter.executeRuntimeV2StudioAction({
    aggregate: aggregateFor(firstCommand, completed),
    command: firstCommand,
    mode: "fresh",
    signal: new AbortController().signal,
    receipts,
    now: clock(),
    external,
  });
  assert.equal(first.status, "blocked");
  assert.equal([...receipts.receipts.values()][0].status, "indeterminate");

  const retryCommand = commandFor(studioAction, "interact-attempt-2");
  const retry = await adapter.executeRuntimeV2StudioAction({
    aggregate: aggregateFor(retryCommand, completed),
    command: retryCommand,
    mode: "fresh",
    signal: new AbortController().signal,
    receipts,
    now: clock(),
    external,
  });
  assert.equal(retry.status, "blocked");
  assert.equal(interactions, 1);
});

test("a post-effect receipt CAS conflict blocks completion and fences every retry", async () => {
  const studioAction = action("launch");
  const firstCommand = commandFor(studioAction, "launch-cas-1");
  const receipts = new MemoryReceiptPort();
  let launches = 0;
  receipts.settle = async ({ receiptKey }) => {
    receipts.operations.push(`settle-conflict:${receiptKey}`);
    return {
      disposition: "conflict",
      receipt: receipts.receipts.get(receiptKey) || null,
    };
  };
  const external = externalPort({
    async launch() {
      launches += 1;
      return config;
    },
  });
  const first = await adapter.executeRuntimeV2StudioAction({
    aggregate: aggregateFor(firstCommand),
    command: firstCommand,
    mode: "fresh",
    signal: new AbortController().signal,
    receipts,
    now: clock(),
    external,
  });
  assert.equal(first.status, "blocked");

  const retryCommand = commandFor(studioAction, "launch-cas-2");
  const retry = await adapter.executeRuntimeV2StudioAction({
    aggregate: aggregateFor(retryCommand),
    command: retryCommand,
    mode: "fresh",
    signal: new AbortController().signal,
    receipts,
    now: clock(),
    external,
  });
  assert.equal(retry.status, "blocked");
  assert.equal(launches, 1);
});

test("GameStudioRuntimeService port maps launch, observe and interact without owning Turn state", async () => {
  const calls = [];
  const service = {
    async ensureInitialized(agent) {
      calls.push(["launch", agent]);
      return config;
    },
    async loadConfig() {
      calls.push(["observe"]);
      return config;
    },
    async configureEngine(input) {
      calls.push(["interact", input]);
      return { ...config, engine: input.engine, engineVersion: input.version };
    },
  };
  const port = adapter.createGameStudioRuntimeV2ExternalPort(service);
  const signal = new AbortController().signal;
  await port.launch({ action: action("launch"), signal });
  await port.observe({ action: action("observe"), signal });
  await port.interact({
    action: action("interact", { engine: "godot", engineVersion: "4.4" }),
    signal,
  });
  assert.deepEqual(calls, [
    ["launch", "studio_auto"],
    ["observe"],
    ["interact", {
      engine: "godot",
      version: "4.4",
      activeStudioAgent: "godot-specialist",
    }],
  ]);
});

test("Studio v2 files keep lifecycle and UI ownership out of the adapter", () => {
  const coreSource = fs.readFileSync(
    path.join(workspaceRoot, "src/lib/runtime-v2/studio.ts"),
    "utf8",
  );
  const adapterSource = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/studioAdapter.ts"),
    "utf8",
  );
  assert.doesNotMatch(coreSource, /WorkflowEngine|AgentOrchestrator|legacy|zustand|react/i);
  assert.doesNotMatch(adapterSource, /WorkflowEngine|AgentOrchestrator|legacy recovery/i);
  assert.doesNotMatch(adapterSource, /run\.completed|turn\.completed|assistant_final|useAppStore/);
  assert.match(adapterSource, /cold_resume_missing_receipt/);
  assert.match(adapterSource, /\?\s*"indeterminate"\s*:\s*"failed"/);
});

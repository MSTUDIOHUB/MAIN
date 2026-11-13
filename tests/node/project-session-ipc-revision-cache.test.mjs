import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadCommonJs(relativePath, dependencies = {}) {
  const sourcePath = path.join(workspaceRoot, relativePath);
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const loadTs = createTsModuleLoader();
  const localRequire = (id) => Object.hasOwn(dependencies, id) ? dependencies[id]
    : ["./runtime-v2/checkpoint", "./runtime-v2/checkpointMerge"].includes(id)
      ? loadTs("src/lib/" + id.slice(2) + ".ts")
      : require(id);
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function loadIpcWithInvoke(invoke, coordinatorOptions = null) {
  const keyedAsyncQueue = await loadCommonJs("src/lib/keyedAsyncQueue.ts");
  const projectSessionMutationCoordinator = await loadCommonJs(
    "src/lib/projectSessionMutationCoordinator.ts",
    { "./keyedAsyncQueue": keyedAsyncQueue },
  );
  const coordinatorDependency = coordinatorOptions
    ? {
        ...projectSessionMutationCoordinator,
        createProjectSessionMutationCoordinator: () =>
          projectSessionMutationCoordinator.createProjectSessionMutationCoordinator(
            undefined,
            coordinatorOptions,
          ),
      }
    : projectSessionMutationCoordinator;
  return loadCommonJs("src/lib/ipc.ts", {
    "@tauri-apps/api/core": { invoke },
    "@tauri-apps/api/event": {
      listen: async () => () => {},
    },
    "./projectSessionMutationCoordinator": coordinatorDependency,
  });
}

test("workspace discovery IPC adapters fail closed on malformed nullable payloads", async () => {
  const calls = [];
  const ipc = await loadIpcWithInvoke(async (command) => {
    calls.push(command);
    return null;
  });

  assert.deepEqual(await ipc.listDirectory("src", "/workspace/ipc-contract"), []);
  assert.deepEqual(await ipc.globSearch("src/**/*.ts", "/workspace/ipc-contract"), []);
  assert.equal(await ipc.getProjectSkeleton(3, "/workspace/ipc-contract"), "");
  assert.deepEqual(calls, ["list_directory", "glob_search", "get_project_skeleton"]);
});

test("workspace discovery IPC adapters retain only values from their declared contract", async () => {
  const ipc = await loadIpcWithInvoke(async (command) => {
    if (command === "list_directory") {
      return [null, "src/main.ts", { name: "src", path: "src", is_dir: true }];
    }
    if (command === "glob_search") {
      return ["src/main.ts", null, 7, "src/App.tsx"];
    }
    if (command === "get_project_skeleton") return { unexpected: true };
    throw new Error(`Unexpected IPC command: ${command}`);
  });

  assert.deepEqual(await ipc.listDirectory(".", "/workspace/ipc-contract"), [
    { name: "src", path: "src", is_dir: true },
  ]);
  assert.deepEqual(await ipc.globSearch("src/**/*", "/workspace/ipc-contract"), [
    "src/main.ts",
    "src/App.tsx",
  ]);
  assert.equal(await ipc.getProjectSkeleton(3, "/workspace/ipc-contract"), "");
});

test("partial Project Session saves merge transcript rows by id at the TypeScript queue head", async () => {
  const workspace = "/workspace/partial-transcript";
  const sessionId = 31;
  const calls = [];
  let persisted = null;
  const existing = {
    id: sessionId,
    storageRevision: 8,
    messages: [
      { id: 1, content: "old one" },
      { id: 2, content: "old two" },
      { id: 3, content: "old three" },
    ],
    runtimeSnapshot: {
      conversationTurns: [
        { id: "turn-1", summary: "old one" },
        { id: "turn-2", summary: "old two" },
      ],
    },
  };
  const ipc = await loadIpcWithInvoke(async (command, args) => {
    calls.push(command);
    if (command === "load_project_session") return existing;
    if (command === "save_project_session") {
      persisted = args.session;
      return { ...args.session, storageRevision: args.session.storageRevision + 1 };
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  });

  await ipc.saveProjectSession(workspace, {
    id: sessionId,
    storageRevision: 8,
    messages: [
      { id: "2", content: "new two" },
      { id: 4, content: "new four" },
    ],
    runtimeSnapshot: {
      transcriptPartial: true,
      conversationTurns: [
        { id: "turn-2", summary: "new two" },
        { id: "turn-3", summary: "new three" },
      ],
    },
  });

  assert.deepEqual(calls, ["load_project_session", "save_project_session"]);
  assert.equal(persisted.storageRevision, 8);
  assert.deepEqual(persisted.messages.map((row) => row.content), [
    "old one",
    "new two",
    "old three",
    "new four",
  ]);
  assert.deepEqual(persisted.runtimeSnapshot.conversationTurns.map((row) => row.summary), [
    "old one",
    "new two",
    "new three",
  ]);
  assert.deepEqual(persisted.runtimeSnapshot.taskFlow, persisted.messages);
  assert.equal(persisted.messageCount, 4);
  assert.equal(persisted.turnCount, 3);
});

test("full Project Session saves replace the transcript without loading an old snapshot", async () => {
  const workspace = "/workspace/full-transcript";
  const sessionId = 32;
  let persisted = null;
  const ipc = await loadIpcWithInvoke(async (command, args) => {
    if (command === "load_project_session") {
      throw new Error("full transcript replacement must not load an old snapshot");
    }
    if (command === "save_project_session") {
      persisted = args.session;
      return { ...args.session, storageRevision: args.session.storageRevision + 1 };
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  });
  const incomingMessages = [{ id: 9, content: "replacement" }];
  const incomingTurns = [{ id: "turn-9", summary: "replacement" }];

  await ipc.saveProjectSession(workspace, {
    id: sessionId,
    storageRevision: 4,
    messages: incomingMessages,
    runtimeSnapshot: {
      transcriptPartial: false,
      conversationTurns: incomingTurns,
    },
  });

  assert.deepEqual(persisted.messages, incomingMessages);
  assert.deepEqual(persisted.runtimeSnapshot.conversationTurns, incomingTurns);
  assert.deepEqual(persisted.runtimeSnapshot.taskFlow, incomingMessages);
  assert.equal(persisted.messageCount, 1);
  assert.equal(persisted.turnCount, 1);
  assert.equal(persisted.storageRevision, 4);
});

test("an empty incoming transcript preserves the durable history before CAS", async () => {
  const workspace = "/workspace/empty-transcript";
  const sessionId = 33;
  let persisted = null;
  const existing = {
    id: sessionId,
    storageRevision: 12,
    messages: [{ id: 1, content: "durable message" }],
    runtimeSnapshot: {
      conversationTurns: [{ id: "turn-1", summary: "durable turn" }],
    },
  };
  const ipc = await loadIpcWithInvoke(async (command, args) => {
    if (command === "load_project_session") return existing;
    if (command === "save_project_session") {
      persisted = args.session;
      return { ...args.session, storageRevision: args.session.storageRevision + 1 };
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  });

  await ipc.saveProjectSession(workspace, {
    id: sessionId,
    storageRevision: 12,
    messages: [],
    runtimeSnapshot: {
      transcriptPartial: false,
      conversationTurns: [],
    },
  });

  assert.deepEqual(persisted.messages, existing.messages);
  assert.deepEqual(
    persisted.runtimeSnapshot.conversationTurns,
    existing.runtimeSnapshot.conversationTurns,
  );
  assert.equal(persisted.storageRevision, 12);
  assert.equal(persisted.messageCount, 1);
  assert.equal(persisted.turnCount, 1);
});

test("queued Project Session saves resolve the latest SQLite revision at queue head", async () => {
  const workspace = "/workspace/revision-cache";
  const sessionId = 41;
  const capturedRevision = 7;
  const firstSaveStarted = deferred();
  const releaseFirstSave = deferred();
  const invokedRevisions = [];

  const keyedAsyncQueue = await loadCommonJs("src/lib/keyedAsyncQueue.ts");
  const projectSessionMutationCoordinator = await loadCommonJs(
    "src/lib/projectSessionMutationCoordinator.ts",
    { "./keyedAsyncQueue": keyedAsyncQueue },
  );
  const ipc = await loadCommonJs("src/lib/ipc.ts", {
    "@tauri-apps/api/core": {
      invoke: async (command, args) => {
        if (command === "load_project_session") {
          return {
            id: sessionId,
            title: "loaded",
            storageRevision: capturedRevision,
          };
        }
        if (command === "save_project_session") {
          const revision = args.session.storageRevision;
          invokedRevisions.push(revision);
          if (invokedRevisions.length === 1) {
            firstSaveStarted.resolve();
            await releaseFirstSave.promise;
          }
          return {
            ...args.session,
            storageRevision: revision + 1,
          };
        }
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    },
    "@tauri-apps/api/event": {
      listen: async () => () => {},
    },
    "./projectSessionMutationCoordinator": projectSessionMutationCoordinator,
  });

  await ipc.loadProjectSession(workspace, sessionId);
  const staleSnapshot = {
    id: sessionId,
    title: "captured at revision 7",
    storageRevision: capturedRevision,
    runtimeSnapshot: {
      conversationTurns: [{ id: "turn-1" }],
    },
  };
  const firstSave = ipc.saveProjectSession(workspace, {
    ...staleSnapshot,
    messages: [{ id: 1 }],
  });
  await firstSaveStarted.promise;
  const secondSave = ipc.saveProjectSession(workspace, {
    ...staleSnapshot,
    messages: [{ id: 1 }, { id: 2 }],
  });
  releaseFirstSave.resolve();

  const [firstSaved, secondSaved] = await Promise.all([firstSave, secondSave]);

  assert.deepEqual(invokedRevisions, [capturedRevision, capturedRevision + 1]);
  assert.equal(firstSaved.storageRevision, capturedRevision + 1);
  assert.equal(secondSaved.storageRevision, capturedRevision + 2);
});

test("queued stale autosave cannot erase turn.completed or replace the same Turn with a fork", async () => {
  const runtime = createTsModuleLoader()("src/lib/runtime-v2/index.ts");
  const workspace = "/workspace/terminal-prefix", sessionId = 52, turnId = "turn-52";
  const owner = { workspaceKey: workspace, sessionKey: `${workspace}:${sessionId}`, sessionEpoch: "epoch", clientSubmissionId: "submission", turnId };
  const run = { sessionKey: owner.sessionKey, sessionEpoch: owner.sessionEpoch, turnId, runId: "run", attemptId: "attempt", parentRunId: null };
  let state = null;
  const append = (type, payload) => {
    const sequence = state?.nextSequence ?? 0;
    state = runtime.transition(state, { type, sequence, eventId: `e${sequence}`, at: sequence + 1,
      schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, ...payload });
  };
  append("turn.admitted", { turn: owner, strategy: "execute", objective: "Repair the fixture", constraints: [], acceptanceCriteria: [] });
  append("run.started", { run, phase: "finalizing" });
  const final = runtime.buildRuntimeV2FinalProjection(state, "final", "partial", "Verified changes pending", "Existing final text");
  const outcome = { resultKind: "partial", reason: "Verified changes pending", completedAt: 3, finalProjectionId: final.id };
  append("run.completed", { run, outcome, finalProjection: final });
  const missingProjection = runtime.createRuntimeV2Checkpoint({ aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt });
  append("projection.published", { run, audience: "final", projectionId: final.id, projection: final });
  const old = runtime.createRuntimeV2Checkpoint({ aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt });
  const newest = runtime.recoverRuntimeV2TerminalCheckpoint(old);
  for (const prefix of [missingProjection, old]) {
    const recovered = runtime.recoverRuntimeV2TerminalCheckpoint(prefix);
    assert.equal(runtime.isRuntimeV2TurnTerminallyClosed(recovered.aggregate), true);
    assert.equal(runtime.recoverRuntimeV2TerminalCheckpoint(recovered), recovered);
    assert.equal(recovered.events.filter(item => item.type === "projection.published").length, 1);
    assert.equal(recovered.events.filter(item => item.type === "turn.completed").length, 1);
    assert.equal(runtime.runtimeV2TerminalProjection(recovered.aggregate).markdown, final.markdown);
  }
  const row = (checkpoint) => ({ id: sessionId, storageRevision: 8, messages: [{ id: 1 }], runtimeSnapshot: {
    conversationTurns: [{ id: turnId }], runtimeV2Checkpoints: { [turnId]: checkpoint },
  } });
  let durable = row(old);
  const began = deferred(), release = deferred();
  const writes = [];
  const ipc = await loadIpcWithInvoke(async (command, args) => {
    if (command === "load_project_session" || command === "load_project_session_meta") return durable;
    assert.equal(command, "save_project_session");
    assert.equal(args.session.storageRevision, durable.storageRevision);
    writes.push(args.session.runtimeSnapshot.runtimeV2Checkpoints[turnId].revision);
    if (writes.length === 1) { began.resolve(); await release.promise; }
    durable = { ...args.session, storageRevision: durable.storageRevision + 1 };
    return durable;
  });
  await ipc.loadProjectSession(workspace, sessionId);
  const close = ipc.saveProjectSession(workspace, row(newest));
  await began.promise;
  const autosave = ipc.saveProjectSession(workspace, row(old));
  release.resolve();
  await Promise.all([close, autosave]);
  assert.deepEqual(writes, [newest.revision, newest.revision]);

  const forkedEvents = old.events.map((item, index) => index === 0 ? { ...item, objective: "Different admitted task" } : item);
  const forked = runtime.replayRuntimeV2Events(forkedEvents);
  const fork = runtime.createRuntimeV2Checkpoint({ aggregate: forked, revision: old.revision, updatedAt: forked.updatedAt });
  await assert.rejects(ipc.saveProjectSession(workspace, { ...row(fork), storageRevision: durable.storageRevision }), { code: "runtime_v2_checkpoint_fork" });
  assert.equal(writes.length, 2);
});

test("an explicitly stale caller revision is not upgraded from the owner cache", async () => {
  const workspace = "/workspace/revision-conflict";
  const sessionId = 42;
  const cachedRevision = 8;
  const staleCallerRevision = 7;
  let invokedRevision = null;

  const keyedAsyncQueue = await loadCommonJs("src/lib/keyedAsyncQueue.ts");
  const projectSessionMutationCoordinator = await loadCommonJs(
    "src/lib/projectSessionMutationCoordinator.ts",
    { "./keyedAsyncQueue": keyedAsyncQueue },
  );
  const ipc = await loadCommonJs("src/lib/ipc.ts", {
    "@tauri-apps/api/core": {
      invoke: async (command, args) => {
        if (command === "load_project_session_meta") {
          return {
            id: sessionId,
            storageRevision: cachedRevision,
          };
        }
        if (command === "save_project_session") {
          invokedRevision = args.session.storageRevision;
          const conflict = new Error("Session snapshot revision conflict");
          conflict.code = "revision_conflict";
          throw conflict;
        }
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    },
    "@tauri-apps/api/event": {
      listen: async () => () => {},
    },
    "./projectSessionMutationCoordinator": projectSessionMutationCoordinator,
  });

  await ipc.loadProjectSessionMeta(workspace, sessionId);
  await assert.rejects(
    ipc.saveProjectSession(workspace, {
      id: sessionId,
      storageRevision: staleCallerRevision,
      messages: [{ id: 1 }],
      runtimeSnapshot: {
        conversationTurns: [{ id: "turn-1" }],
      },
    }),
    (error) => error?.code === "revision_conflict",
  );

  assert.equal(invokedRevision, staleCallerRevision);
});

test("a lost save response cannot poison the IPC owner queue or reuse its stale CAS revision", async () => {
  const workspace = "/workspace/lost-save-response";
  const sessionId = 43;
  const never = new Promise(() => {});
  let durableRevision = 9;
  let saveInvocations = 0;
  const invokedRevisions = [];
  const mutationDeadlines = [];
  const commands = [];
  const ipc = await loadIpcWithInvoke(async (command, args) => {
    commands.push(command);
    if (command === "load_project_session_meta") {
      return { id: sessionId, storageRevision: durableRevision };
    }
    if (command === "save_project_session") {
      saveInvocations += 1;
      invokedRevisions.push(args.session.storageRevision);
      mutationDeadlines.push(args.mutationDeadlineMs);
      durableRevision = args.session.storageRevision + 1;
      if (saveInvocations === 1) return never;
      return { ...args.session, storageRevision: durableRevision };
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  }, {
    saveSettlementTimeoutMs: 30,
    deadlineLeadMs: 5,
  });

  await ipc.loadProjectSessionMeta(workspace, sessionId);
  const captured = {
    id: sessionId,
    storageRevision: 9,
    messages: [{ id: 1 }],
    runtimeSnapshot: { conversationTurns: [{ id: "turn-1" }] },
  };
  await assert.rejects(
    ipc.saveProjectSession(workspace, captured, { settlementTimeoutMs: 30 }),
    (error) => error?.code === "project_session_save_timed_out",
  );

  const saved = await ipc.saveProjectSession(workspace, {
    ...captured,
    messages: [{ id: 1 }, { id: 2 }],
    runtimeSnapshot: {
      conversationTurns: [{ id: "turn-1" }, { id: "turn-2" }],
    },
  }, { settlementTimeoutMs: 30 });

  assert.equal(saved.storageRevision, 11);
  assert.deepEqual(invokedRevisions, [9, 10]);
  assert.equal(mutationDeadlines.length, 2);
  assert.ok(mutationDeadlines.every(Number.isSafeInteger));
  assert.deepEqual(commands, [
    "load_project_session_meta",
    "save_project_session",
    "load_project_session_meta",
    "save_project_session",
  ]);
});

import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", transpiled)(module.exports, module, localRequire);
  return module.exports;
}

const { persistSubmitRuntimeProjection } = loadTranspiledModuleSync(
  path.join(process.cwd(), "src/store/persistSubmitRuntimeProjection.ts"),
);

function state(overrides = {}) {
  return {
    config: { sessionRecordingEnabled: true },
    taskFlow: [{ id: 1, type: "agent", content: "Done", ephemeral: true }],
    sessionsByWorkspace: {
      workspace: [{
        id: 7,
        title: "Session",
        storageStatus: "ok",
        recordingDisabled: false,
      }],
    },
    runtimeEvents: [{ type: "turn.completed" }],
    ...overrides,
  };
}

test("durable submission projection persists sanitized runtime before returning publishable state", async () => {
  const calls = [];
  const initial = state();
  const projected = await persistSubmitRuntimeProjection({
    state: initial,
    scopeKey: "workspace",
    sessionId: 7,
    sanitizeTaskBlocksForPersist(blocks) {
      calls.push("sanitize");
      return blocks.map(({ ephemeral: _ephemeral, ...block }) => block);
    },
    buildRuntimeSnapshot(snapshotState) {
      calls.push("snapshot");
      assert.equal(snapshotState.taskFlow[0].ephemeral, undefined);
      return { events: snapshotState.runtimeEvents.length };
    },
    async persistSessionRecord(scopeKey, sessionRecord) {
      calls.push("persist");
      assert.equal(scopeKey, "workspace");
      assert.equal(sessionRecord.storageStatus, "temporary");
      assert.deepEqual(sessionRecord.messages, [{ id: 1, type: "agent", content: "Done" }]);
      assert.deepEqual(sessionRecord.runtimeSnapshot, { events: 1 });
      return { storagePath: "/sessions/7.json" };
    },
    nowMs: () => 1_000,
  });

  assert.deepEqual(calls, ["sanitize", "snapshot", "persist"]);
  assert.notEqual(projected, initial);
  assert.equal(initial.sessionsByWorkspace.workspace[0].storagePath, undefined);
  assert.deepEqual(projected.sessionsByWorkspace.workspace[0], {
    id: 7,
    title: "Session",
    storageStatus: "ok",
    recordingDisabled: false,
    updatedAt: "1970-01-01T00:00:01.000Z",
    updatedAtMs: 1_000,
    messages: [{ id: 1, type: "agent", content: "Done" }],
    runtimeSnapshot: { events: 1 },
    storagePath: "/sessions/7.json",
  });
});

test("recording-disabled sessions remain temporary without external persistence", async () => {
  let persisted = false;
  const initial = state({ config: { sessionRecordingEnabled: false } });
  const projected = await persistSubmitRuntimeProjection({
    state: initial,
    scopeKey: "workspace",
    sessionId: 7,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    buildRuntimeSnapshot: () => ({ ok: true }),
    persistSessionRecord: async () => {
      persisted = true;
    },
    nowMs: () => 2_000,
  });

  assert.equal(persisted, false);
  assert.equal(projected.sessionsByWorkspace.workspace[0].storageStatus, "temporary");
  assert.equal(projected.sessionsByWorkspace.workspace[0].recordingDisabled, true);
});

test("enabled persistence rejects a missing exact session record", async () => {
  await assert.rejects(
    persistSubmitRuntimeProjection({
      state: state({ sessionsByWorkspace: { workspace: [] } }),
      scopeKey: "workspace",
      sessionId: 7,
      sanitizeTaskBlocksForPersist: (blocks) => blocks,
      buildRuntimeSnapshot: () => ({}),
      persistSessionRecord: async () => ({}),
    }),
    /SESSION_RUNTIME_RECORD_MISSING: workspace:7/,
  );
});

test("a submission without a session id is returned untouched", async () => {
  const initial = state();
  const projected = await persistSubmitRuntimeProjection({
    state: initial,
    scopeKey: "workspace",
    sessionId: null,
    sanitizeTaskBlocksForPersist: () => {
      throw new Error("must not sanitize");
    },
    buildRuntimeSnapshot: () => {
      throw new Error("must not snapshot");
    },
    persistSessionRecord: async () => {
      throw new Error("must not persist");
    },
  });
  assert.equal(projected, initial);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();
function load(sourcePath) {
  sourcePath = path.resolve(sourcePath);
  if (cache.has(sourcePath)) return cache.get(sourcePath);
  const module = { exports: {} };
  cache.set(sourcePath, module.exports);
  const js = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const localRequire = createRequire(sourcePath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(sourcePath), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return load(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", js)(module.exports, module, runtimeRequire);
  cache.set(sourcePath, module.exports);
  return module.exports;
}

const root = process.cwd();
const queueRuntime = load(path.join(root, "src/store/workspaceTurnQueue.ts"));
const migrationRuntime = load(path.join(root, "src/store/workspaceLegacyQueueMigration.ts"));

test("workspace legacy slot migrates once into a committed FIFO receipt", () => {
  const queue = queueRuntime.createWorkspaceTurnQueueState({
    sessionKey: "/workspace:7",
    sessionEpoch: "epoch-7",
    updatedAt: 100,
  });
  const result = migrationRuntime.migrateLegacyQueuedMessageToWorkspaceTurn({
    legacy: {
      id: "queued-old",
      sessionKey: "/workspace:7",
      text: "inspect both failures",
      images: ["data:image/png;base64,AA=="],
      runtimeIntentOverride: "analyze",
      createdAt: 90,
      status: "queued",
    },
    queue,
    sessionKey: "/workspace:7",
    sessionEpoch: "epoch-7",
    clientSubmissionId: "legacy-queued-old",
    receiptId: "receipt-old",
    turnId: "turn-old",
    userBlockId: 41,
    at: 100,
  });
  assert.equal(result.disposition, "migrated");
  assert.equal(result.queue.entries.length, 1);
  assert.equal(result.queue.entries[0].status, "queued");
  assert.equal(result.queue.entries[0].receipt.turnId, "turn-old");
  assert.equal(result.queue.entries[0].instruction.payload.dispatchHints.resolvedIntent, "analyze");
  assert.equal(result.ledgerEntry.receipt.receiptId, "receipt-old");
});

test("workspace legacy migration fences stale Session owners", () => {
  const queue = queueRuntime.createWorkspaceTurnQueueState({
    sessionKey: "/workspace:7",
    sessionEpoch: "epoch-7",
    updatedAt: 100,
  });
  assert.deepEqual(migrationRuntime.migrateLegacyQueuedMessageToWorkspaceTurn({
    legacy: {
      id: "queued-stale",
      sessionKey: "/workspace:old",
      text: "do not replay",
      createdAt: 90,
      status: "queued",
    },
    queue,
    sessionKey: "/workspace:7",
    sessionEpoch: "epoch-7",
    clientSubmissionId: "legacy-stale",
    receiptId: "receipt-stale",
    turnId: "turn-stale",
    userBlockId: 42,
    at: 100,
  }), { disposition: "error", reason: "legacy_queue_owner_mismatch" });
});

test("workspace production surfaces never count or replay the legacy slot", () => {
  const composer = fs.readFileSync(path.join(root, "src/components/Composer.tsx"), "utf8");
  const workflow = fs.readFileSync(path.join(root, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const store = fs.readFileSync(path.join(root, "src/store/useAppStore.ts"), "utf8");
  assert.match(composer, /visibleLegacyQueuedMessage = workspaceComposer \? null : queuedUserMessage/);
  assert.match(workflow, /runSessionKey\.startsWith\(`\$\{GLOBAL_CHAT_KEY\}:`\)/);
  assert.match(store, /workspace_legacy_queue_write_rejected/);
  assert.match(store, /queuedUserMessage: canRestoreWorkspaceQueue \? null : restoredQueuedUserMessage/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(normalizedPath);
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

const proxy = loadTranspiledModuleSync(
  path.join(workspaceRoot, "tests/e2e/realOmlxWorkspaceProxy.ts"),
);

async function createTempWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "real-omlx-proxy-"));
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });
  return workspace;
}

async function writeFixtureFile(workspace, relativePath, content) {
  const absolutePath = path.join(workspace, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

test("real OMLX workspace inventory prunes dependency/build/hidden trees before recursion", async (t) => {
  const workspace = await createTempWorkspace(t);
  await Promise.all([
    writeFixtureFile(workspace, "README.md", "fixture\n"),
    writeFixtureFile(workspace, "src/main.ts", "export const ready = true;\n"),
    writeFixtureFile(workspace, "src-tauri/src/main.rs", "fn main() {}\n"),
    writeFixtureFile(workspace, "node_modules/pkg/index.js", "dependency\n"),
    writeFixtureFile(workspace, "src-tauri/target/release/main", "compiled\n"),
    writeFixtureFile(workspace, "target/debug/cache.bin", "compiled\n"),
    writeFixtureFile(workspace, "build/assets/app.js", "built\n"),
    writeFixtureFile(workspace, ".git/objects/aa/object", "object\n"),
    writeFixtureFile(workspace, ".MAIN/plans/plan.md", "generated\n"),
    writeFixtureFile(workspace, ".hidden/cache/value.txt", "hidden\n"),
    writeFixtureFile(workspace, "src-tauri/gen/schema.json", "{}\n"),
    writeFixtureFile(workspace, "src-tauri/icons/icon.png", Buffer.from([0, 1, 2, 3])),
  ]);

  const inventory = await proxy.collectBoundedRealOmlxWorkspaceFiles(workspace);
  assert.deepEqual(inventory.files, [
    "README.md",
    "src/main.ts",
    "src-tauri/src/main.rs",
  ]);
  assert.equal(inventory.truncated, false);
  assert.ok(inventory.prunedDirectories >= 8);
  assert.ok(inventory.visitedDirectories < 10);
});

test("real OMLX workspace inventory stops at a deterministic hard file limit", async (t) => {
  const workspace = await createTempWorkspace(t);
  await Promise.all([
    writeFixtureFile(workspace, "a.ts", "a\n"),
    writeFixtureFile(workspace, "b.ts", "b\n"),
    writeFixtureFile(workspace, "c.ts", "c\n"),
  ]);

  const inventory = await proxy.collectBoundedRealOmlxWorkspaceFiles(workspace, { maxFiles: 2 });
  assert.deepEqual(inventory.files, ["a.ts", "b.ts"]);
  assert.equal(inventory.maxFiles, 2);
  assert.equal(inventory.truncated, true);
});

test("real OMLX command verification executes against final workspace bytes", async (t) => {
  const workspace = await createTempWorkspace(t);
  await writeFixtureFile(workspace, "broken.js", "function broken( {\\n");

  const failed = await proxy.runRealOmlxWorkspaceCommand(
    workspace,
    `"${process.execPath}" --check broken.js`,
  );
  assert.notEqual(failed.exitCode, 0);
  assert.match(failed.stderr, /SyntaxError|Unexpected token/);

  await writeFixtureFile(workspace, "broken.js", "export const ready = true;\\n");
  const passed = await proxy.runRealOmlxWorkspaceCommand(
    workspace,
    `"${process.execPath}" --check broken.js`,
  );
  assert.equal(passed.exitCode, 0, passed.stderr);
  assert.equal(passed.cwd, path.resolve(workspace));
  assert.equal(passed.timedOut, false);
});

test("real OMLX search selection admits only bounded text paths", () => {
  const selection = proxy.selectBoundedRealOmlxSearchFiles([
    "src/main.ts",
    "src/style.css",
    "src/helper.rs",
    "assets/photo.png",
    "Cargo.lock",
    ".env",
  ], { maxFiles: 2 });

  assert.deepEqual(selection.files, ["src/main.ts", "src/style.css"]);
  assert.equal(selection.eligibleFiles, 3);
  assert.equal(selection.skippedNonTextFiles, 3);
  assert.equal(selection.truncated, true);
});

test("real OMLX bounded text reads reject binary, oversized, and out-of-workspace files", async (t) => {
  const workspace = await createTempWorkspace(t);
  const outsidePath = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside.txt`);
  t.after(async () => {
    await fs.rm(outsidePath, { force: true });
  });
  await Promise.all([
    writeFixtureFile(workspace, "src/small.ts", "export const value = 1;\n"),
    writeFixtureFile(workspace, "src/large.ts", "x".repeat(4_096)),
    writeFixtureFile(workspace, "src/binary.ts", Buffer.from([65, 66, 0, 67, 68])),
    fs.writeFile(outsidePath, "outside\n"),
  ]);

  const small = await proxy.readBoundedRealOmlxWorkspaceTextFile(workspace, "src/small.ts", { maxBytes: 1_024 });
  assert.equal(small.ok, true);
  assert.match(small.content, /value = 1/);

  const large = await proxy.readBoundedRealOmlxWorkspaceTextFile(workspace, "src/large.ts", { maxBytes: 1_024 });
  assert.deepEqual({ ok: large.ok, reason: large.reason }, { ok: false, reason: "too_large" });

  const binary = await proxy.readBoundedRealOmlxWorkspaceTextFile(workspace, "src/binary.ts", { maxBytes: 1_024 });
  assert.deepEqual({ ok: binary.ok, reason: binary.reason }, { ok: false, reason: "binary" });

  const outside = await proxy.readBoundedRealOmlxWorkspaceTextFile(workspace, outsidePath, { maxBytes: 1_024 });
  assert.deepEqual({ ok: outside.ok, reason: outside.reason }, { ok: false, reason: "outside_workspace" });
});

test("real OMLX batch reads bound per-file bytes, aggregate bytes, and retained results", async (t) => {
  const workspace = await createTempWorkspace(t);
  const paths = [];
  for (let index = 0; index < 8; index += 1) {
    const relativePath = `src/file-${index}.ts`;
    paths.push(relativePath);
    await writeFixtureFile(workspace, relativePath, String(index).repeat(400));
  }

  const batch = await proxy.readBoundedRealOmlxWorkspaceTextFiles(workspace, paths, {
    concurrency: 2,
    maxFileBytes: 512,
    maxFiles: 8,
    maxTotalBytes: 1_000,
  });

  assert.equal(batch.files.length, 2);
  assert.ok(batch.totalBytes <= 1_000);
  assert.ok(batch.skipped.some((entry) => entry.reason === "total_budget"));
  assert.equal(batch.truncated, true);
});

test("real OMLX file windows honor line/character bounds without full-file decoding", async (t) => {
  const workspace = await createTempWorkspace(t);
  const numberedLines = Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join("\n");
  await writeFixtureFile(workspace, "src/lines.ts", numberedLines);

  const window = await proxy.readRealOmlxWorkspaceFileWindow(workspace, "src/lines.ts", {
    startLine: 10,
    maxLines: 3,
    maxChars: 1_000,
    maxScanBytes: 64 * 1024,
  });
  assert.equal(window.content, "line-10\nline-11\nline-12");
  assert.equal(window.startLine, 10);
  assert.equal(window.endLine, 12);
  assert.equal(window.nextStartLine, 13);
  assert.equal(window.truncated, true);
  assert.equal(window.scanTruncated, false);
  assert.match(window.contentVersion, /^sha256-[a-f0-9]{64}$/);

  await writeFixtureFile(workspace, "src/long.ts", "x\n".repeat(100_000));
  const scannedWindow = await proxy.readRealOmlxWorkspaceFileWindow(workspace, "src/long.ts", {
    maxLines: 5,
    maxChars: 64,
    maxScanBytes: 1_024,
  });
  assert.equal(scannedWindow.scanTruncated, true);
  assert.equal(scannedWindow.scannedBytes, 1_024);
  assert.ok(scannedWindow.content.length <= 64);
});

test("real OMLX tail windows never advertise a line past EOF", async (t) => {
  const workspace = await createTempWorkspace(t);
  const numberedLines = Array.from(
    { length: 100 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  await writeFixtureFile(workspace, "src/tail.ts", numberedLines);

  const window = await proxy.readRealOmlxWorkspaceFileWindow(
    workspace,
    "src/tail.ts",
    {
      startLine: 90,
      endLine: 100,
      maxLines: 100,
      maxChars: 10_000,
      maxScanBytes: 64 * 1024,
    },
  );

  assert.equal(window.startLine, 90);
  assert.equal(window.endLine, 100);
  assert.equal(window.totalLines, 100);
  assert.equal(window.truncated, true);
  assert.equal(window.nextStartLine, null);
});

test("real OMLX file windows reject large binary files from a bounded prefix sample", async (t) => {
  const workspace = await createTempWorkspace(t);
  const binary = Buffer.alloc(8_192, 65);
  binary[128] = 0;
  await writeFixtureFile(workspace, "assets/large.bin", binary);

  await assert.rejects(
    proxy.readRealOmlxWorkspaceFileWindow(workspace, "assets/large.bin", { maxScanBytes: 1_024 }),
    /E2E_WORKSPACE_READ_BINARY/,
  );
});

test("real OMLX syntax checks preserve duplicate module-export safety", () => {
  const checked = proxy.checkRealOmlxSourceSyntax(
    "src/toolbar.js",
    [
      "export function updateTheme(theme) { return theme; }",
      "export function updateTheme(theme) { return theme; }",
    ].join("\n"),
  );

  assert.equal(checked.applicable, true);
  assert.equal(checked.hasErrors, true);
  assert.ok(checked.errorCount > 0);
  assert.equal(checked.firstErrorLine, 2);
  assert.deepEqual(checked.errors, [{
    line: 2,
    column: 17,
    kind: "duplicate_export",
  }]);
  assert.equal(checked.errorsTruncated, false);
});

test("real OMLX debug entries retain structured identity while bounding message size", () => {
  const entry = proxy.compactRealOmlxDebugEntry({
    timestamp: "2026-07-22T00:00:00.000Z",
    level: "info",
    source: "agent.test",
    message: "x".repeat(100),
    unbounded: "not retained",
  }, 20);

  assert.equal(entry.source, "agent.test");
  assert.equal(entry.level, "info");
  assert.match(entry.message, /^x{20}\.\.\.<e2e-debug-truncated:100>$/);
  assert.equal("unbounded" in entry, false);
});

test("real OMLX acceptance ledger retains contract and collaboration facts independently of debug-tail volume", () => {
  let state = proxy.createRealOmlxAcceptanceState();
  state = proxy.recordRealOmlxAcceptanceDebugEvent(
    state,
    "agent.plan_authoring_contract_injected",
    JSON.stringify({ contractId: "contract-1" }),
  );
  state = proxy.recordRealOmlxAcceptanceDebugEvent(
    state,
    "agent.plan_evidence_bundle_ready",
    JSON.stringify({ evidenceBundleHash: "bundle-1" }),
  );
  state = proxy.recordRealOmlxAcceptanceDebugEvent(
    state,
    "agent.task_orchestrator_phase",
    JSON.stringify({ subagentPreference: "preferred" }),
  );
  state = proxy.recordRealOmlxAcceptanceDebugEvent(
    state,
    "agent.semantic_collaboration_task_spawned",
    JSON.stringify({ scopeKey: "src", subagentId: "child-src" }),
  );
  for (let index = 0; index < 1_000; index += 1) {
    state = proxy.recordRealOmlxAcceptanceDebugEvent(
      state,
      "agent.unrelated_recovery_diagnostic",
      JSON.stringify({ index }),
    );
  }
  state = proxy.recordRealOmlxAcceptanceDebugEvent(
    state,
    "agent.semantic_collaboration_evidence_consumed",
    JSON.stringify({
      outcomes: [{
        subagentId: "child-src",
        scopeKey: "src",
        status: "completed",
        closureState: "satisfied",
        adoptedEvidenceCount: 1,
        consumed: true,
      }],
    }),
  );

  assert.deepEqual(state.authoringContractIds, ["contract-1"]);
  assert.deepEqual(state.evidenceBundleHashes, ["bundle-1"]);
  assert.deepEqual(state.observedSubagentPreferences, ["preferred"]);
  assert.deepEqual(state.spawnedScopes, [{ scopeKey: "src", subagentIds: ["child-src"] }]);
  assert.deepEqual(state.joinedSubagentIds, ["child-src"]);
  assert.deepEqual(state.joinedScopeKeys, ["src"]);
  assert.deepEqual(state.consumedScopeKeys, ["src"]);
});

test("real OMLX collaboration projection requires every expected scope to spawn, join, and consume", () => {
  let state = proxy.createRealOmlxAcceptanceState();
  for (const [scopeKey, subagentId] of [["src", "child-src"], ["src-tauri", "child-rust"]]) {
    state = proxy.recordRealOmlxAcceptanceDebugEvent(
      state,
      "agent.semantic_collaboration_task_spawned",
      JSON.stringify({ scopeKey, subagentId }),
    );
  }
  state = proxy.recordRealOmlxAcceptanceDebugEvent(
    state,
    "parent_join_injected",
    JSON.stringify({ resultIds: ["child-src", "child-rust"] }),
  );
  state = proxy.recordRealOmlxAcceptanceDebugEvent(
    state,
    "agent.semantic_collaboration_evidence_consumed",
    JSON.stringify({ consumedScopeKeys: ["src"] }),
  );

  const partial = proxy.projectRealOmlxCollaborationScopes({
    acceptance: state,
    runs: [
      { id: "child-src", scopeKey: "src" },
      { id: "child-rust", scopeKey: "src-tauri" },
    ],
    expectedScopeKeys: ["src", "src-tauri"],
  });
  assert.deepEqual(partial.map((entry) => ({
    scopeKey: entry.scopeKey,
    spawned: entry.spawned,
    joined: entry.joined,
    consumed: entry.consumed,
  })), [
    { scopeKey: "src", spawned: true, joined: true, consumed: true },
    { scopeKey: "src-tauri", spawned: true, joined: true, consumed: false },
  ]);

  state = proxy.recordRealOmlxAcceptanceDebugEvent(
    state,
    "agent.semantic_collaboration_evidence_consumed",
    JSON.stringify({ consumedScopeKeys: ["src", "src-tauri"] }),
  );
  assert.equal(proxy.projectRealOmlxCollaborationScopes({
    acceptance: state,
    runs: [
      { id: "child-src", scopeKey: "src" },
      { id: "child-rust", scopeKey: "src-tauri" },
    ],
    expectedScopeKeys: ["src", "src-tauri"],
  }).every((entry) => entry.spawned && entry.joined && entry.consumed), true);
});

test("real OMLX collaboration projection rejects arbitrary sibling reviewers for required subsystems", () => {
  let state = proxy.createRealOmlxAcceptanceState();
  const siblingScopes = [
    ["src/components/editor.js", "child-editor"],
    ["src/components/preview.js", "child-preview"],
    ["src/components/toolbar.js", "child-toolbar"],
  ];
  for (const [scopeKey, subagentId] of siblingScopes) {
    state = proxy.recordRealOmlxAcceptanceDebugEvent(
      state,
      "agent.semantic_collaboration_task_spawned",
      JSON.stringify({ scopeKey, subagentId }),
    );
    state = proxy.recordRealOmlxAcceptanceDebugEvent(
      state,
      "agent.semantic_collaboration_evidence_consumed",
      JSON.stringify({
        outcomes: [{
          scopeKey,
          subagentId,
          status: "completed",
          closureState: "satisfied",
          adoptedEvidenceCount: 1,
          consumed: true,
        }],
      }),
    );
  }

  const requiredSubsystems = proxy.projectRealOmlxCollaborationScopes({
    acceptance: state,
    runs: siblingScopes.map(([scopeKey, id]) => ({ id, scopeKey })),
    expectedScopeKeys: ["src", "src-tauri"],
  });
  assert.deepEqual(requiredSubsystems.map((entry) => ({
    scopeKey: entry.scopeKey,
    spawned: entry.spawned,
    joined: entry.joined,
    consumed: entry.consumed,
  })), [
    { scopeKey: "src", spawned: false, joined: false, consumed: false },
    { scopeKey: "src-tauri", spawned: false, joined: false, consumed: false },
  ]);
});

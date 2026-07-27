import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
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
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

const presentation = loadTs(path.join(workspaceRoot, "src/lib/runtimeV2Presentation.ts"));

function progress({ timestampMs, runId, tool, target, status, summary = "" }) {
  return {
    schemaVersion: 2,
    type: "progress.updated",
    threadId: "session-a",
    turnId: "turn-a",
    timestampMs,
    runId,
    parentRunId: null,
    progress: {
      phase: "editing",
      title: "修改代码",
      tool,
      target,
      canonicalTarget: target,
      status,
      summary,
      audience: "user",
    },
  };
}

test("Capsule uses the newest active structured action and preserves the full target without Run Status summary", () => {
  const longPath = "src/features/very-long-directory-name/another-long-directory-name/components/editor/EditorInteractionCoordinator.ts";
  const result = presentation.buildRuntimeV2CompatibleCapsuleProjection({
    events: [
      progress({ timestampMs: 10, runId: "run-a", tool: "read_file", target: "src/main.js", status: "running" }),
      progress({ timestampMs: 11, runId: "run-a", tool: "read_file", target: "src/main.js", status: "done" }),
      progress({ timestampMs: 12, runId: "run-a", tool: "apply_patch", target: longPath, status: "running", summary: "已确认事件消费路径，正在写入最小修复。" }),
    ],
    turnId: "turn-a",
    runId: "run-a",
    language: "zh",
  });
  assert.ok(result);
  assert.match(result.markdown, /正在修改/);
  assert.match(result.markdown, new RegExp(longPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.markdown, /\.\.\./);
  assert.doesNotMatch(result.markdown, /正在写入最小修复/);
});

test("an explicit public action remains complete Markdown and is not duplicated by its summary", () => {
  const event = progress({
    timestampMs: 12,
    runId: "run-a",
    tool: "apply_patch",
    target: "src/main.js",
    status: "running",
    summary: "Run Status owns this duplicate.",
  });
  event.progress.action = "我已确认事件入口；现在修改 **src/main.js**。";
  const result = presentation.buildRuntimeV2CompatibleCapsuleProjection({
    events: [event],
    turnId: "turn-a",
    runId: "run-a",
    language: "zh",
  });
  assert.ok(result);
  assert.equal(result.markdown, "我已确认事件入口；现在修改 **src/main.js**。");
  assert.doesNotMatch(result.markdown, /Run Status/);
});

test("completed structured activity clears instead of freezing Capsule on an old action", () => {
  const result = presentation.buildRuntimeV2CompatibleCapsuleProjection({
    events: [
      progress({ timestampMs: 10, runId: "run-a", tool: "apply_patch", target: "src/main.js", status: "running" }),
      progress({ timestampMs: 11, runId: "run-a", tool: "apply_patch", target: "src/main.js", status: "done" }),
    ],
    turnId: "turn-a",
    runId: "run-a",
    language: "zh",
  });
  assert.equal(result, null);
});

test("different run events cannot replace the active run Capsule", () => {
  const result = presentation.buildRuntimeV2CompatibleCapsuleProjection({
    events: [
      progress({ timestampMs: 10, runId: "run-a", tool: "read_file", target: "src/main.js", status: "running" }),
      progress({ timestampMs: 20, runId: "run-old", tool: "apply_patch", target: "src/old.js", status: "running" }),
    ],
    turnId: "turn-a",
    runId: "run-a",
    language: "zh",
  });
  assert.ok(result);
  assert.match(result.markdown, /src\/main\.js/);
  assert.doesNotMatch(result.markdown, /src\/old\.js/);
});

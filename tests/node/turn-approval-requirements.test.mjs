import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const root = process.cwd();
const cache = new Map();
const ipc = { shellPermissionPreflight: async () => { throw new Error("Unexpected preflight"); } };
function loadTs(sourcePath) {
  const source = path.resolve(sourcePath);
  if (source === path.join(root, "src/lib/ipc.ts")) return ipc;
  if (cache.has(source)) return cache.get(source);
  const module = { exports: {} };
  cache.set(source, module.exports);
  const output = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: source,
  }).outputText;
  const require = createRequire(source);
  new Function("exports", "module", "require", output)(module.exports, module, (name) => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(source), name);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate)) return loadTs(candidate);
      }
    }
    return require(name);
  });
  return module.exports;
}

const runtime = loadTs(path.join(root, "src/lib/runtime-v2/index.ts"));
const { resolveRuntimeV2ObjectiveAdmission } = loadTs(path.join(root, "src/store/runtimeV2/submissionContext.ts"));

test("manual capability review survives canonical admission and cold replay without granting scope", async () => {
  let checkpoint = null; let ordinal = 0;
  const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" };
  const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: { append: async (input) => { const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input }); if (result.checkpoint) checkpoint = result.checkpoint; return result; } },
    projection: { publish: async () => {} }, clockId: { now: () => ++ordinal, nextId: () => `event-${++ordinal}` },
  });
  const context = { approvalRequiredCapabilities: ["command", "command"], capabilityRestrictions: [], executeAdmission: { objective: "Run after review", acceptanceCriteria: [{ id: "C1", text: "Exact invocation reviewed" }] } };
  const admission = resolveRuntimeV2ObjectiveAdmission(context, "fallback");
  assert.deepEqual(admission.approvalRequiredCapabilities, ["command"]);
  await controller.admit({ turn, run, strategy: "execute", ...admission, acceptanceCriteria: ["Exact invocation reviewed"] });
  assert.deepEqual(checkpoint.events[0].approvalRequiredCapabilities, ["command"]);
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(checkpoint)));
  assert.deepEqual(restored.aggregate.objective.approvalRequiredCapabilities, ["command"]);
  assert.deepEqual(restored.aggregate.objective.capabilityRestrictions, []);
  assert.equal(restored.aggregate.approved, undefined);
  assert.equal(restored.aggregate.objective.pathScope, undefined);
});

test("legacy admission omits manual review without accepting malformed new contracts", () => {
  const legacy = resolveRuntimeV2ObjectiveAdmission({}, "Legacy request");
  assert.deepEqual(legacy.approvalRequiredCapabilities || [], []);
  for (const value of [null, "command", ["unknown"]]) {
    assert.throws(() => resolveRuntimeV2ObjectiveAdmission({ approvalRequiredCapabilities: value }, "Invalid"), /TURN_APPROVAL_CAPABILITIES_INVALID/);
  }
});

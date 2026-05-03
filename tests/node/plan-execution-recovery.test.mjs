import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
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
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  PLAN_MAX_AUTO_RESUME_LIMIT,
  buildPlanExecutionProgressUpdate,
  buildPlanMaxIterationsCheckpoint,
  buildPlanMaxIterationsPauseNotice,
  buildPlanMaxIterationsResumePrompt,
  formatPlanExecutionProgressSnapshot,
  normalizePlanExecutionProgressSnapshot,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionRecovery.ts"));

const tasks = [
  {
    id: "1",
    text: "Update orchestrator recovery handling",
    status: "completed",
    evidenceStatus: "satisfied",
    evidence: [{ kind: "file", value: "src/lib/orchestrator.ts" }],
  },
  {
    id: "2",
    text: "Add resume guard tests",
    status: "in_progress",
    evidenceStatus: "partial",
    evidence: [{ kind: "file", value: "tests/node/plan-execution-recovery.test.mjs" }],
  },
];

const evidenceLedger = [
  {
    id: "plan",
    kind: "file",
    value: ".MAIN/plans/tasks.md",
    target: ".MAIN/plans/tasks.md",
    sourceTool: "write_file",
    createdAt: 1,
  },
  {
    id: "source",
    kind: "file",
    value: "src/lib/orchestrator.ts",
    target: "src/lib/orchestrator.ts",
    sourceTool: "replace_in_file",
    createdAt: 2,
  },
];

test("max-iteration checkpoint keeps internal plan files out of project-source evidence", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/lib/orchestrator.ts", status: "succeeded" }],
    lastAssistantText: "Continuing with tests.",
  });

  assert.equal(checkpoint.reason, "max_iterations_checkpoint");
  assert.equal(checkpoint.currentTask.includes("Add resume guard tests"), true);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes("src/lib/orchestrator.ts")), true);
  assert.equal(checkpoint.completedEvidence.some((line) => line.includes(".MAIN/plans")), false);
});

test("pause notice is structured and points to manual resume after one auto-resume", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: PLAN_MAX_AUTO_RESUME_LIMIT,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "run_command", target: "npm test", status: "failed", detail: "exitCode 1" }],
    unresolvedBlockers: ["Agent loop reached maximum iterations (50)."],
  });
  const notice = buildPlanMaxIterationsPauseNotice(checkpoint, "en");

  assert.match(notice, /RecoveryDetails:/);
  assert.match(notice, /autoResumeCount: 1\/1/);
  assert.match(notice, /Resume Execution/);
  assert.match(notice, /Add resume guard tests/);
});

test("resume prompt requires fresh workspace reads and treats .MAIN plans as internal state", () => {
  const checkpoint = buildPlanMaxIterationsCheckpoint({
    iterationCount: 50,
    maxIterations: 50,
    autoResumeCount: 1,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/store/useAppStore.ts", status: "succeeded" }],
  });
  const prompt = buildPlanMaxIterationsResumePrompt({
    language: "en",
    checkpoint,
    hasTasksArtifact: true,
    tasks,
    artifacts: [{ kind: "tasks", path: ".MAIN/plans/tasks.md", title: "Tasks", content: "- [ ] Add resume guard tests", updatedAt: 1 }],
    evidenceLedger,
  });

  assert.match(prompt, /fresh recovery context/);
  assert.match(prompt, /Do not treat `\.MAIN\/plans` as project-source evidence/);
  assert.match(prompt, /First reread current workspace state/);
  assert.match(prompt, /Add resume guard tests/);
});

test("plan execution progress snapshot is structured and ignores internal plan evidence", () => {
  const update = buildPlanExecutionProgressUpdate({
    language: "en",
    phase: "tool_done",
    iterationCount: 7,
    maxIterations: 50,
    autoResumeCount: 0,
    tasks,
    evidenceLedger,
    recentToolActivity: [{ name: "replace_in_file", target: "src/lib/orchestrator.ts", status: "succeeded" }],
  });
  const snapshot = normalizePlanExecutionProgressSnapshot({
    turnId: "turn-1",
    update,
    now: 123,
  });
  const text = formatPlanExecutionProgressSnapshot(snapshot, "en");

  assert.equal(snapshot.turnId, "turn-1");
  assert.equal(snapshot.phase, "tool_done");
  assert.equal(snapshot.iteration, 7);
  assert.match(snapshot.currentTask, /Add resume guard tests/);
  assert.match(snapshot.latestEvidence, /src\/lib\/orchestrator\.ts/);
  assert.doesNotMatch(snapshot.latestEvidence, /\.MAIN\/plans/);
  assert.match(text, /Tool done/);
  assert.match(text, /Current task:/);
});

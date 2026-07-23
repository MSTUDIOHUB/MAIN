import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  adaptPlanExecutionEvidenceForValidationSpec,
  buildPlanTaskEvidenceAudit,
  reconcilePlanTaskCompletion,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));
const {
  createPlanExecutionEvidenceEntry,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planEvidence.ts"));
const {
  evaluateApprovedPlanExecution,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionEvaluation.ts"));

function typedTask(validation, overrides = {}) {
  return {
    id: "plan-contract:v1",
    text: "Execute reviewed validation V1",
    status: "pending",
    claimedStatus: "pending",
    executionKind: "validation",
    requirementRef: "G1",
    validationRef: "V1",
    evidence: validation.kind === "finite_command"
      ? [{ kind: "cmd", value: validation.command }]
      : validation.kind === "browser_interaction"
      ? [{ kind: "browser_dom", value: validation.assertions[0]?.target || "browser", requiresInteraction: true }]
      : validation.kind === "desktop_interaction"
      ? [{ kind: "tauri_required", value: validation.assertions[0]?.target || "desktop" }]
      : [{ kind: "text", value: validation.target || validation.note || "validation" }],
    validation: [{ ...validation, id: validation.id || "V1" }],
    evidenceStatus: "missing",
    ...overrides,
  };
}

function bindValidationEvidence(entry, task, createdAt = 1) {
  return {
    ...entry,
    phase: "validation",
    operationId: task.validationRef,
    obligationIds: [task.validationRef],
    planTaskId: task.id,
    requirementRef: task.requirementRef,
    createdAt,
  };
}

function finiteSpec(overrides = {}) {
  const command = overrides.command || "npm test";
  return {
    id: "V1",
    kind: "finite_command",
    acceptance: "required",
    command,
    cwd: ".",
    capability: "test",
    segments: [{ command, connector: "start", role: "validator", capability: "test" }],
    ...overrides,
  };
}

function browserSpec(kind = "browser_interaction") {
  return {
    id: "V1",
    kind,
    acceptance: "required",
    actions: [{ id: "save", kind: "click", target: "#save-button" }],
    assertions: [{ kind: "text", target: "#status", afterActionId: "save", expected: "saved" }],
    requireCausalAssertion: true,
  };
}

function interactionResult({ actionTarget = "#save-button", assertionTarget = "#status", actual = "saved" } = {}) {
  return JSON.stringify({
    ok: true,
    actions: [{ id: "save", kind: "click", target: actionTarget, ok: true, interaction: true }],
    assertions: [{
      kind: "text",
      target: assertionTarget,
      actual,
      passed: true,
      afterActionId: "save",
      beforePassed: false,
      changedAfterAction: true,
      causallyLinked: true,
    }],
    pageErrors: [],
    consoleErrors: [],
  });
}

test("typed finite validation requires the exact command, cwd, completion, and zero exit", () => {
  const spec = finiteSpec();
  const task = typedTask(spec);
  const wrongCwd = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: spec.command,
    result: JSON.stringify({ command: spec.command, exitCode: 0, timedOut: false, success: true }),
    executedArgs: { command: spec.command, cwd: "frontend" },
  }), task);
  const failed = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: spec.command,
    result: JSON.stringify({ command: spec.command, exitCode: 1, timedOut: false, success: false }),
    executedArgs: { command: spec.command, cwd: "." },
  }), task);
  const passed = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: spec.command,
    result: JSON.stringify({ command: spec.command, exitCode: 0, timedOut: false, success: true }),
    executedArgs: { command: spec.command, cwd: "." },
  }), task);

  assert.equal(reconcilePlanTaskCompletion([], [task], [wrongCwd])[0].status, "pending");
  assert.equal(reconcilePlanTaskCompletion([], [task], [failed])[0].evidenceStatus, "blocked");
  const completed = reconcilePlanTaskCompletion([], [task], [passed])[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.evidenceStatus, "satisfied");
});

test("similar browser prose cannot replace the exact reviewed action and causal assertion", () => {
  const spec = browserSpec();
  const task = typedTask(spec);
  const wrongAction = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420",
    result: interactionResult({ actionTarget: "#save-button-secondary" }),
  }), task);
  const wrongExpectedValue = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420",
    result: interactionResult({ actual: "saving" }),
  }), task);
  const exact = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420",
    result: interactionResult(),
  }), task);

  assert.equal(adaptPlanExecutionEvidenceForValidationSpec({
    task,
    spec,
    evidenceLedger: [wrongAction],
  }).length, 1, JSON.stringify(wrongAction));
  assert.equal(reconcilePlanTaskCompletion([], [task], [wrongAction])[0].evidenceStatus, "blocked");
  assert.equal(reconcilePlanTaskCompletion([], [task], [wrongExpectedValue])[0].evidenceStatus, "blocked");
  assert.equal(reconcilePlanTaskCompletion([], [task], [exact])[0].status, "completed");
});

test("desktop evidence is surface-specific and exact target mismatches fail", () => {
  const spec = browserSpec("desktop_interaction");
  const task = typedTask(spec);
  const browserOnly = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420",
    result: interactionResult(),
  }), task);
  const wrongDesktop = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "computer_use",
    target: "MAIN",
    result: interactionResult({ actionTarget: "Open menu" }),
  }), task);
  const exactDesktop = bindValidationEvidence(createPlanExecutionEvidenceEntry({
    toolName: "computer_use",
    target: "MAIN",
    result: interactionResult(),
  }), task);

  assert.equal(reconcilePlanTaskCompletion([], [task], [browserOnly])[0].status, "pending");
  assert.equal(reconcilePlanTaskCompletion([], [task], [wrongDesktop])[0].evidenceStatus, "blocked");
  assert.equal(reconcilePlanTaskCompletion([], [task], [exactDesktop])[0].status, "completed");
});

test("arbitrary text never becomes a trusted generic assertion result", () => {
  const spec = {
    id: "V1",
    kind: "assertion",
    acceptance: "required",
    target: "runtime:V1",
    matcher: "runtime_result",
    producer: "runtime_evidence_ledger",
  };
  const task = typedTask(spec);
  const arbitraryText = {
    id: "text-1",
    kind: "text",
    value: "runtime:V1 passed",
    target: "runtime:V1",
    sourceTool: "assistant_text",
    phase: "validation",
    operationId: "V1",
    obligationIds: ["V1"],
    outcome: { status: "succeeded" },
    createdAt: 1,
  };

  assert.deepEqual(adaptPlanExecutionEvidenceForValidationSpec({
    task,
    spec,
    evidenceLedger: [arbitraryText],
  }), []);
  const audited = reconcilePlanTaskCompletion([], [task], [arbitraryText])[0];
  assert.notEqual(audited.status, "completed");
  assert.notEqual(audited.evidenceStatus, "satisfied");
});

test("advisory typed validation remains visible without blocking automation", () => {
  const task = typedTask({
    id: "V1",
    kind: "advisory",
    acceptance: "advisory",
    note: "Review optional visual polish",
    owner: "user",
  });
  const audit = buildPlanTaskEvidenceAudit({ tasks: [task], evidenceLedger: [] });

  assert.equal(audit.acceptedCompletion, true);
  assert.equal(audit.allTrustedComplete, false);
  assert.equal(audit.pendingExternalValidation, true);
  assert.equal(audit.remainingTasks.length, 0);
});

test("approved execution completes only after its exact typed validation obligation", () => {
  const spec = finiteSpec({ command: "npm run test:typed" });
  const validationTask = typedTask(spec);
  const mutationTask = {
    id: "plan-contract:c1",
    text: "Update src/runtime.ts",
    status: "pending",
    claimedStatus: "pending",
    executionKind: "mutation",
    requirementRef: "G1",
    changeRef: "C1",
    evidence: [{ kind: "file", value: "src/runtime.ts" }],
    evidenceStatus: "missing",
  };
  const mutation = {
    id: "mutation-1",
    kind: "file",
    value: "src/runtime.ts",
    target: "src/runtime.ts",
    sourceTool: "apply_patch",
    planTaskId: mutationTask.id,
    requirementRef: mutationTask.requirementRef,
    phase: "mutation",
    operationId: "C1",
    outcome: { status: "succeeded" },
    createdAt: 1,
  };
  const genericPass = {
    ...bindValidationEvidence(createPlanExecutionEvidenceEntry({
      toolName: "run_command",
      target: spec.command,
      result: JSON.stringify({ command: spec.command, exitCode: 0, success: true }),
      executedArgs: { command: spec.command, cwd: "." },
    }), validationTask, 2),
    obligationIds: [],
  };
  const exactPass = {
    ...genericPass,
    obligationIds: [validationTask.validationRef],
    createdAt: 3,
  };

  const beforeExact = evaluateApprovedPlanExecution({
    tasks: [mutationTask, validationTask],
    evidenceLedger: [mutation, genericPass],
  });
  assert.equal(beforeExact.evidenceClosure.completionAllowed, true);
  assert.equal(beforeExact.taskAudit.acceptedCompletion, false);
  assert.equal(beforeExact.completionAllowed, false);

  const afterExact = evaluateApprovedPlanExecution({
    tasks: [mutationTask, validationTask],
    evidenceLedger: [mutation, exactPass],
  });
  assert.equal(afterExact.taskAudit.acceptedCompletion, true);
  assert.equal(afterExact.completionAllowed, true);
  assert.equal(afterExact.gap.kind, "none");
});

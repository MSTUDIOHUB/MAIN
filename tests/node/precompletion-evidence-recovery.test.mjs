import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTsModule(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (!fs.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return loadTsModule(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const planEvidence = loadTsModule(path.join(workspaceRoot, "src/lib/planEvidence.ts"));
const verification = loadTsModule(path.join(workspaceRoot, "src/lib/verificationEvidence.ts"));
const precompletion = loadTsModule(path.join(
  workspaceRoot,
  "src/lib/orchestrator/loop/preCompletionEvidenceRecovery.ts",
));

function mutation() {
  return {
    id: "mutation",
    kind: "file",
    value: "src/main.js",
    target: "src/main.js",
    sourceTool: "apply_patch",
    changedIdentifiers: ["addEventListener", "new-btn", "toolbarButton"],
    createdAt: 1,
  };
}

function nonInteractionMutation() {
  return {
    ...mutation(),
    id: "non-interaction-mutation",
    changedIdentifiers: ["formatDocument"],
  };
}

function launchAndReady() {
  return [
    {
      id: "launch",
      kind: "cmd",
      value: "npm run dev",
      target: "npm run dev",
      sourceTool: "execute_command",
      observationStatus: "pending",
      foregroundGeneration: 4,
      createdAt: 2,
    },
    {
      id: "ready",
      kind: "dev_server_url",
      value: "http://localhost:1420/",
      target: "pty-1",
      sourceTool: "read_pty_since",
      observationStatus: "ready",
      foregroundGeneration: 4,
      createdAt: 3,
    },
  ];
}

test("page load alone cannot satisfy an interaction mutation", () => {
  const pageLoad = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: JSON.stringify({ ok: true, actions: [], assertions: [] }),
  });
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [mutation(), ...launchAndReady(), pageLoad],
    validationExpected: true,
  });

  assert.equal(pageLoad.kind, "browser_dom");
  assert.equal(audit.gap, "browser_validation_required");
  assert.equal(audit.unsatisfiedObligationCount, 1);
  assert.equal(audit.validationObligations[0].kind, "browser_interaction");
});

test("successful action plus post-action assertion closes the interaction obligation", () => {
  const interaction = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: JSON.stringify({
      ok: true,
      actions: [{
        id: "action-1",
        kind: "click",
        value: "#new-btn",
        ok: true,
        stateChanged: true,
        changedFields: ["bodyText"],
        nativeChangedFields: [],
        effectStateChanged: true,
        effectChangedFields: ["bodyText"],
        beforeState: { bodyText: "Existing note" },
        afterState: { bodyText: "Untitled" },
      }],
      assertions: [{
        kind: "text",
        value: "Untitled",
        passed: true,
        detail: "new document visible",
        afterActionId: "action-1",
        beforePassed: false,
        changedAfterAction: true,
        causallyLinked: true,
      }],
      pageErrors: [],
      consoleErrors: [],
    }),
  });
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [mutation(), ...launchAndReady(), interaction],
    validationExpected: true,
  });

  assert.equal(interaction.browserInteraction.actions[0].target, "#new-btn");
  assert.equal(audit.gap, "none");
  assert.equal(audit.completionAllowed, true);
  assert.equal(audit.validationObligations[0].satisfiedByEvidenceId, interaction.id);
});

test("interaction obligations exist before a browser or dev server has run", () => {
  const build = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm test",
    result: JSON.stringify({ exitCode: 0, stdout: "passed" }),
  });
  const mutationOnly = verification.buildExecuteEvidenceClosureAudit({
    ledger: [mutation()],
    validationExpected: true,
  });
  const afterBuild = verification.buildExecuteEvidenceClosureAudit({
    ledger: [mutation(), build],
    validationExpected: true,
  });

  assert.equal(mutationOnly.gap, "browser_validation_required");
  assert.equal(afterBuild.gap, "browser_validation_required");
  assert.equal(afterBuild.validationObligations[0].kind, "browser_interaction");
});

test("an unrelated assertion or unchanged click cannot close an interaction obligation", () => {
  const unrelated = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: JSON.stringify({
      ok: true,
      actions: [{
        id: "action-1",
        kind: "click",
        value: "#new-btn",
        ok: true,
        stateChanged: false,
        beforeState: { bodyText: "same" },
        afterState: { bodyText: "same" },
      }],
      assertions: [{
        kind: "selector",
        value: "#unrelated-footer",
        passed: true,
        afterActionId: "action-1",
      }],
      pageErrors: [],
      consoleErrors: [],
    }),
  });
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [mutation(), ...launchAndReady(), unrelated],
    validationExpected: true,
  });

  assert.equal(audit.completionAllowed, false);
  assert.equal(audit.gap, "browser_validation_required");
});

test("native input changes and pre-existing assertions cannot prove a business interaction", () => {
  const nativeOnly = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: JSON.stringify({
      ok: true,
      actions: [{
        id: "action-1",
        kind: "fill",
        value: "#new-btn => draft",
        ok: true,
        stateChanged: true,
        changedFields: ["target.value"],
        nativeChangedFields: ["target.value"],
        effectChangedFields: [],
        effectStateChanged: false,
      }],
      assertions: [{
        kind: "selector",
        value: "#new-btn:valid",
        passed: true,
        beforePassed: false,
        changedAfterAction: true,
        causallyLinked: false,
        afterActionId: "action-1",
      }],
      pageErrors: [],
      consoleErrors: [],
    }),
  });
  const unrelatedGlobalChange = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: JSON.stringify({
      ok: true,
      actions: [{
        id: "action-2",
        kind: "click",
        value: "#new-btn",
        ok: true,
        stateChanged: true,
        changedFields: ["bodyText", "externalDomFingerprint"],
        effectChangedFields: ["bodyText", "externalDomFingerprint"],
        effectStateChanged: true,
      }],
      assertions: [{
        kind: "text",
        value: "Ready",
        passed: true,
        beforePassed: true,
        changedAfterAction: false,
        causallyLinked: false,
        afterActionId: null,
      }],
      pageErrors: [],
      consoleErrors: [],
    }),
  });
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [mutation(), ...launchAndReady(), nativeOnly, unrelatedGlobalChange],
    validationExpected: true,
  });

  assert.equal(audit.completionAllowed, false);
  assert.equal(audit.gap, "browser_validation_required");
});

test("a changed referenced event-handler body creates an interaction obligation", () => {
  const oldSource = [
    "function handleNew() {",
    "  editor.setValue('');",
    "}",
    "document.querySelector('#new-btn').addEventListener('click', handleNew);",
  ].join("\n");
  const newSource = [
    "function handleNew() {",
    "  editor.clearDocument();",
    "}",
    "document.querySelector('#new-btn').addEventListener('click', handleNew);",
  ].join("\n");
  const handlerMutation = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "apply_patch",
    target: "src/main.js",
    result: JSON.stringify({ success: true }),
    diff: {
      old: oldSource,
      new: newSource,
      path: "src/main.js",
      fullFile: true,
    },
  });
  assert.equal(handlerMutation.interactionMutation, true);
  assert.ok(handlerMutation.interactionBehaviorTargets.includes("#new-btn"));

  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [handlerMutation],
    validationExpected: true,
  });
  assert.equal(audit.validationObligations.length, 1);
  assert.equal(audit.validationObligations[0].mutationEvidenceId, handlerMutation.id);
  assert.equal(audit.gap, "browser_validation_required");
});

test("changing an interactive control id creates an action-bound browser obligation", () => {
  const toolbarMutation = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "apply_patch",
    target: "src/components/toolbar.js",
    result: JSON.stringify({ success: true }),
    diff: {
      old: "root.innerHTML = '<button id=\"btn-new\">New</button>';",
      new: "root.innerHTML = '<button id=\"new-btn\">New</button>';",
      path: "src/components/toolbar.js",
      fullFile: true,
    },
  });

  assert.equal(toolbarMutation.interactionMutation, true);
  assert.ok(toolbarMutation.interactionBehaviorTargets.includes("#new-btn"));

  const pageLoad = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: JSON.stringify({ ok: true, actions: [], assertions: [] }),
  });
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [toolbarMutation, ...launchAndReady(), pageLoad],
    validationExpected: true,
  });

  assert.equal(audit.gap, "browser_validation_required");
  assert.equal(audit.validationObligations[0].kind, "browser_interaction");
});

test("all interaction mutations in one epoch keep independent obligations", () => {
  const first = {
    ...mutation(),
    id: "mutation-new",
    interactionMutation: true,
    interactionBehaviorTargets: ["#new-btn"],
  };
  const second = {
    ...mutation(),
    id: "mutation-theme",
    interactionMutation: true,
    interactionBehaviorTargets: ["#theme-btn"],
    createdAt: 2,
  };
  const browserEvidence = (id, selector, text) => ({
    id,
    kind: "browser_dom",
    value: "http://localhost:1420/",
    target: "http://localhost:1420/",
    sourceTool: "browser_evaluate",
    createdAt: 10,
    browserInteraction: {
      actions: [{
        id: `${id}-action`,
        kind: "click",
        target: selector,
        succeeded: true,
        stateChanged: true,
        changedFields: ["bodyText"],
        effectChangedFields: ["bodyText"],
        effectStateChanged: true,
      }],
      assertions: [{
        kind: "text",
        target: text,
        passed: true,
        beforePassed: false,
        changedAfterAction: true,
        causallyLinked: true,
        afterActionId: `${id}-action`,
      }],
      pageErrors: [],
      consoleErrors: [],
    },
  });
  const newEvidence = browserEvidence("browser-new", "#new-btn", "Untitled");
  const partialAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [first, second, ...launchAndReady(), newEvidence],
    validationExpected: true,
  });
  assert.equal(partialAudit.validationObligations.length, 2);
  assert.equal(partialAudit.validationObligations.find((item) => item.mutationEvidenceId === first.id).status, "satisfied");
  assert.equal(partialAudit.validationObligations.find((item) => item.mutationEvidenceId === second.id).status, "open");
  assert.equal(partialAudit.gap, "browser_validation_required");

  const completeAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [first, second, ...launchAndReady(), newEvidence, browserEvidence("browser-theme", "#theme-btn", "Dark")],
    validationExpected: true,
  });
  assert.equal(completeAudit.validationObligations.every((item) => item.status === "satisfied"), true);
  assert.equal(completeAudit.gap, "none");
});

test("one mutation with several changed controls requires one browser proof per control", () => {
  const toolbarMutation = {
    ...mutation(),
    id: "mutation-toolbar-controls",
    interactionMutation: true,
    interactionBehaviorTargets: [
      "new-btn", "#new-btn",
      "open-btn", "#open-btn",
      "save-btn", "#save-btn",
    ],
  };
  const browserEvidence = (names) => ({
    id: `browser-${names.join("-").toLowerCase()}`,
    kind: "browser_dom",
    value: "http://localhost:1420/",
    target: "http://localhost:1420/",
    sourceTool: "browser_evaluate",
    createdAt: 10,
    browserInteraction: {
      actions: names.map((name, index) => ({
        id: `action-${index + 1}`,
        kind: "click",
        target: `#${name.toLowerCase()}-btn`,
        succeeded: true,
        stateChanged: true,
        changedFields: ["bodyText"],
        effectChangedFields: ["bodyText"],
        effectStateChanged: true,
      })),
      assertions: names.map((name, index) => ({
        kind: "text",
        target: name.toLowerCase(),
        passed: true,
        beforePassed: false,
        changedAfterAction: true,
        causallyLinked: true,
        afterActionId: `action-${index + 1}`,
      })),
      pageErrors: [],
      consoleErrors: [],
    },
  });

  const partial = verification.buildExecuteEvidenceClosureAudit({
    ledger: [toolbarMutation, ...launchAndReady(), browserEvidence(["New"])],
    validationExpected: true,
  });
  assert.equal(partial.validationObligations.length, 3);
  assert.deepEqual(
    partial.validationObligations.map((item) => item.status).sort(),
    ["open", "open", "satisfied"],
  );
  assert.equal(partial.gap, "browser_validation_required");

  const complete = verification.buildExecuteEvidenceClosureAudit({
    ledger: [toolbarMutation, ...launchAndReady(), browserEvidence(["New", "Open", "Save"])],
    validationExpected: true,
  });
  assert.equal(complete.validationObligations.length, 3);
  assert.equal(complete.validationObligations.every((item) => item.status === "satisfied"), true);
  assert.equal(complete.gap, "none");
});

test("a newer failed browser interaction invalidates an older success", () => {
  const browserEvidence = (id, succeeded, effectStateChanged) => ({
    id,
    kind: "browser_dom",
    value: "http://localhost:1420/",
    target: "http://localhost:1420/",
    sourceTool: "browser_evaluate",
    createdAt: id === "browser-success" ? 10 : 11,
    observationStatus: succeeded ? "passed" : "failed",
    browserInteraction: {
      actions: [{
        id: `${id}-action`,
        kind: "click",
        target: "#new-btn",
        succeeded,
        stateChanged: effectStateChanged,
        changedFields: effectStateChanged ? ["bodyText"] : [],
        effectChangedFields: effectStateChanged ? ["bodyText"] : [],
        effectStateChanged,
      }],
      assertions: [{
        kind: "text",
        target: "Untitled",
        passed: succeeded,
        beforePassed: false,
        changedAfterAction: effectStateChanged,
        causallyLinked: effectStateChanged,
        afterActionId: `${id}-action`,
      }],
      pageErrors: [],
      consoleErrors: [],
    },
  });
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [
      mutation(),
      ...launchAndReady(),
      browserEvidence("browser-success", true, true),
      browserEvidence("browser-failed", false, false),
    ],
    validationExpected: true,
  });

  assert.equal(audit.validationObligations[0].status, "failed");
  assert.equal(audit.validationObligations[0].satisfiedByEvidenceId, undefined);
  assert.equal(audit.gap, "unreconciled_failure");
  assert.equal(audit.completionAllowed, false);
});

test("an unassociated interaction mutation cannot be satisfied by an arbitrary browser action", () => {
  const unassociated = {
    ...mutation(),
    id: "mutation-unassociated",
    interactionMutation: true,
    interactionBehaviorTargets: [],
  };
  const unrelated = {
    id: "browser-unrelated",
    kind: "browser_dom",
    value: "http://localhost:1420/",
    target: "http://localhost:1420/",
    sourceTool: "browser_evaluate",
    createdAt: 10,
    browserInteraction: {
      actions: [{
        id: "action-theme",
        kind: "click",
        target: "#theme-btn",
        succeeded: true,
        stateChanged: true,
        changedFields: ["bodyText"],
        effectChangedFields: ["bodyText"],
        effectStateChanged: true,
      }],
      assertions: [{
        kind: "text",
        target: "Dark",
        passed: true,
        beforePassed: false,
        changedAfterAction: true,
        causallyLinked: true,
        afterActionId: "action-theme",
      }],
      pageErrors: [],
      consoleErrors: [],
    },
  };
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [unassociated, ...launchAndReady(), unrelated],
    validationExpected: true,
  });

  assert.equal(audit.validationObligations[0].status, "open");
  assert.equal(audit.gap, "browser_validation_required");
});

test("page runtime errors become durable negative evidence", () => {
  const failed = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    result: JSON.stringify({
      ok: false,
      actions: [],
      assertions: [],
      pageErrors: ["editor.renderEditor is not a function"],
      consoleErrors: [],
    }),
  });
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [mutation(), ...launchAndReady(), failed],
    validationExpected: true,
  });

  assert.equal(failed.observationStatus, "failed");
  assert.equal(failed.browserInteraction.pageErrors.length, 1);
  assert.equal(audit.gap, "unreconciled_failure");
});

test("a browser runtime failure with a source reference returns to mutation instead of server reconciliation", () => {
  const browserPayload = JSON.stringify({
    ok: false,
    screenshotPath: ".MAIN/browser-validation/browser-1784254183346-20946.png",
    actions: [{ kind: "click", target: "#new-btn", ok: true }],
    assertions: [],
    pageErrors: [
      "ReferenceError: handleFileOpen is not defined at http://localhost:1420/src/main.js:92:42",
    ],
    consoleErrors: [],
  });
  const failed = planEvidence.createPlanExecutionFailureEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    error: `BROWSER_VALIDATION_FAILED: runtime error\n${browserPayload}`,
  });
  const ledger = [mutation(), ...launchAndReady(), failed];
  const failure = verification.resolveLatestUnreconciledFailureSignal({ ledger });
  assert.equal(failed.browserInteraction.pageErrors.length, 1);
  assert.ok(failed.references.includes(".MAIN/browser-validation/browser-1784254183346-20946.png"));
  assert.equal(failure.domain, "browser");
  assert.equal(failure.sourceTarget, "src/main.js");

  const recovery = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger,
    validationExpected: true,
    currentRecoveryMode: "validation_only",
    currentRequiredCapability: "browser_validation",
    availableToolNames: new Set([
      "browser_evaluate",
      "read_file",
      "replace_in_file",
      "apply_patch",
      "run_command",
      "get_pty_status",
    ]),
  });

  assert.equal(recovery.mode, "mutation_first");
  assert.equal(recovery.nextRequiredCapability, "mutation");
  assert.equal(recovery.expectedTarget, "src/main.js");
  assert.match(recovery.reason, /unreconciled_failure:browser/);
});

test("a browser screenshot receipt is never promoted to a source repair target", () => {
  const failed = planEvidence.createPlanExecutionFailureEntry({
    toolName: "browser_evaluate",
    target: "http://localhost:1420/",
    error: `BROWSER_VALIDATION_FAILED: runtime error\n${JSON.stringify({
      ok: false,
      screenshotPath: ".MAIN/browser-validation/browser-receipt.png",
      pageErrors: ["Application closed before the assertion completed"],
      consoleErrors: [],
      actions: [],
      assertions: [],
    })}`,
  });

  const failure = verification.resolveLatestUnreconciledFailureSignal({ ledger: [failed] });
  assert.equal(failure.domain, "browser");
  assert.equal(failure.sourceTarget, null);
});

test("external review markers are advisory while actual automation is explicit evidence", () => {
  const markerAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [nonInteractionMutation(), {
      id: "manual-tauri",
      kind: "tauri_required",
      value: "Open dialog",
      sourceTool: "runtime_marker",
      createdAt: 2,
    }],
    validationExpected: true,
  });
  assert.equal(markerAudit.gap, "validation_after_mutation_required");

  const automationAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [nonInteractionMutation(), {
      id: "automated-tauri",
      kind: "tool",
      value: "Open dialog",
      sourceTool: "tauri_driver",
      automaticValidation: true,
      createdAt: 2,
    }],
    validationExpected: true,
  });
  assert.equal(automationAudit.gap, "none");

  const screenshotOnly = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "computer_use",
    target: "MAIN window",
    result: "opened screenshot without interaction",
  });
  const structuredDesktop = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "tauri_driver",
    target: "Open dialog",
    result: JSON.stringify({
      ok: true,
      actions: [{ kind: "click", target: "open", ok: true }],
      assertions: [{ kind: "dialog", target: "file picker", passed: true }],
    }),
  });
  assert.equal(screenshotOnly.automaticValidation, undefined);
  assert.equal(structuredDesktop.automaticValidation, true);
});

test("pre-completion audit selects the exact next capability", () => {
  const finite = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [nonInteractionMutation()],
    validationExpected: true,
    currentRecoveryMode: "normal",
    availableToolNames: new Set(["run_command"]),
  });
  assert.equal(finite.mode, "finite_validation_only");
  assert.equal(finite.nextRequiredCapability, "validation");

  const launch = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [mutation()],
    validationExpected: true,
    currentRecoveryMode: "normal",
    availableToolNames: new Set(["execute_command", "browser_evaluate"]),
  });
  assert.equal(launch.mode, "validation_only");
  assert.equal(launch.nextRequiredCapability, "launch_long_process");

  const observe = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [mutation(), launchAndReady()[0]],
    validationExpected: true,
    currentRecoveryMode: "normal",
    availableToolNames: new Set(["get_pty_status"]),
  });
  assert.equal(observe.nextRequiredCapability, "observe_pty");

  const browser = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [mutation(), ...launchAndReady()],
    validationExpected: true,
    currentRecoveryMode: "normal",
    availableToolNames: new Set(["browser_evaluate"]),
  });
  assert.equal(browser.nextRequiredCapability, "browser_validation");

  const failedProcess = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [mutation(), launchAndReady()[0], {
      id: "failed-process",
      kind: "tool",
      value: "pty-1",
      target: "pty-1",
      sourceTool: "read_pty_tail",
      observationStatus: "failed",
      foregroundGeneration: 4,
      createdAt: 3,
    }],
    validationExpected: true,
    currentRecoveryMode: "normal",
    availableToolNames: new Set([
      "read_pty_tail",
      "read_file",
      "apply_patch",
      "run_command",
      "execute_command",
    ]),
  });
  assert.equal(failedProcess.gap, "unreconciled_failure");
  assert.equal(failedProcess.nextRequiredCapability, "recover_process");

  const alreadyRecovering = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [mutation()],
    validationExpected: true,
    currentRecoveryMode: "mutation_first",
    availableToolNames: new Set(["run_command"]),
  });
  assert.equal(alreadyRecovering, null);
});

test("ready browser evidence supersedes a stale finite-validation recovery contract", () => {
  const staleFiniteRecovery = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [mutation(), ...launchAndReady()],
    validationExpected: true,
    currentRecoveryMode: "finite_validation_only",
    currentRequiredCapability: "validation",
    availableToolNames: new Set(["run_command", "browser_evaluate"]),
  });

  assert.equal(staleFiniteRecovery.gap, "browser_validation_required");
  assert.equal(staleFiniteRecovery.mode, "validation_only");
  assert.equal(staleFiniteRecovery.nextRequiredCapability, "browser_validation");

  const alreadyBrowserRecovery = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [mutation(), ...launchAndReady()],
    validationExpected: true,
    currentRecoveryMode: "validation_only",
    currentRequiredCapability: "browser_validation",
    availableToolNames: new Set(["run_command", "browser_evaluate"]),
  });
  assert.equal(
    alreadyBrowserRecovery,
    null,
    "the same evidence/capability must not reactivate recovery and reset its budget",
  );
});

test("a successful validation cannot replace a required mutation", () => {
  const commandOnlyLedger = [{
    id: "command-only",
    kind: "cmd",
    value: "npm test",
    target: "npm test",
    sourceTool: "run_command",
    observationStatus: "ready",
    createdAt: 1,
  }];
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: commandOnlyLedger,
    mutationExpected: true,
    validationExpected: true,
  });
  assert.equal(audit.mutationCount, 0);
  assert.equal(audit.validationCount, 1);
  assert.equal(audit.gap, "mutation_required");
  assert.equal(audit.completionAllowed, false);

  const recovery = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: commandOnlyLedger,
    mutationExpected: true,
    validationExpected: true,
    currentRecoveryMode: "normal",
    availableToolNames: new Set(["apply_patch", "run_command"]),
  });
  assert.equal(recovery.mode, "mutation_first");
  assert.equal(recovery.nextRequiredCapability, "mutation");
});

test("command-only completion is bound to the structured requested command", () => {
  const unrelated = {
    id: "unrelated",
    kind: "cmd",
    value: "npm test",
    target: "npm test",
    sourceTool: "run_command",
    createdAt: 1,
  };
  const wrongAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [unrelated],
    mutationExpected: false,
    validationExpected: true,
    requiredCommandEvidence: ["git status"],
  });
  assert.equal(wrongAudit.gap, "validation_required");
  assert.equal(wrongAudit.completionAllowed, false);

  const matching = {
    ...unrelated,
    id: "matching",
    value: "git status --short",
    target: "git status --short",
  };
  const matchingAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [matching],
    mutationExpected: false,
    validationExpected: true,
    requiredCommandEvidence: ["git status"],
  });
  assert.equal(matchingAudit.gap, "none");
  assert.equal(matchingAudit.completionAllowed, true);
});

test("natural-language shell targets are not treated as exact command evidence", () => {
  const naturalRequirements = verification.resolveCommandEvidenceRequirements({
    commandDirective: {
      kind: "shell",
      action: "test",
      target: "运行软件测试",
      source: "natural_language",
    },
  });
  assert.deepEqual(naturalRequirements, ["capability:test"]);

  const exactRequirements = verification.resolveCommandEvidenceRequirements({
    commandDirective: {
      kind: "shell",
      action: "test",
      target: "run the requested tests",
      exactCommand: "npm test",
      source: "natural_language",
    },
  });
  assert.deepEqual(exactRequirements, ["npm test"]);

  const successfulCommand = {
    id: "successful-command",
    kind: "cmd",
    value: "npm run test",
    target: "npm run test",
    sourceTool: "run_command",
    createdAt: 1,
  };
  const genericAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [successfulCommand],
    mutationExpected: false,
    validationExpected: true,
    requiredCommandEvidence: naturalRequirements,
  });
  assert.equal(genericAudit.gap, "none");
  assert.equal(genericAudit.completionAllowed, true);

  const unrelatedCommand = {
    ...successfulCommand,
    id: "unrelated-command",
    value: "pwd",
    target: "pwd",
  };
  const unrelatedAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [unrelatedCommand],
    mutationExpected: false,
    validationExpected: true,
    requiredCommandEvidence: naturalRequirements,
  });
  assert.equal(unrelatedAudit.gap, "validation_required");
  assert.equal(unrelatedAudit.completionAllowed, false);

  const wrongCapabilityAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [{
      ...successfulCommand,
      id: "wrong-capability-command",
      value: "npm run build",
      target: "npm run build",
    }],
    mutationExpected: false,
    validationExpected: true,
    requiredCommandEvidence: naturalRequirements,
  });
  assert.equal(wrongCapabilityAudit.gap, "validation_required");
  assert.equal(wrongCapabilityAudit.completionAllowed, false);

  const deployRequirements = verification.resolveCommandEvidenceRequirements({
    commandDirective: {
      kind: "shell",
      action: "deploy",
      target: "deploy to the configured production server",
      source: "natural_language",
    },
  });
  assert.deepEqual(deployRequirements, ["capability:operational"]);
  const deployAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [{
      ...successfulCommand,
      id: "deploy-command",
      value: "./scripts/deploy.sh",
      target: "./scripts/deploy.sh",
    }],
    mutationExpected: false,
    validationExpected: true,
    requiredCommandEvidence: deployRequirements,
  });
  assert.equal(deployAudit.completionAllowed, true);
});

test("an invocation failure remains negative evidence until a finite validation succeeds", () => {
  const failed = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm test",
    result: JSON.stringify({ exitCode: 1, success: false, stderr: 'Missing script: "test"' }),
    transactionId: "turn-command-repair",
  });
  assert.equal(failed?.observationStatus, "failed");

  const failedAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [failed],
    mutationExpected: false,
    validationExpected: true,
    transactionId: "turn-command-repair",
  });
  assert.equal(failedAudit.gap, "unreconciled_failure");
  assert.equal(failedAudit.completionAllowed, false);

  const buildPassed = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm run build",
    result: JSON.stringify({ exitCode: 0, success: true, stdout: "built" }),
    transactionId: "turn-command-repair",
  });
  const wrongCapability = verification.buildExecuteEvidenceClosureAudit({
    ledger: [failed, buildPassed],
    mutationExpected: false,
    validationExpected: true,
    transactionId: "turn-command-repair",
    requiredCommandEvidence: ["capability:test"],
  });
  assert.equal(wrongCapability.gap, "unreconciled_failure");
  assert.equal(wrongCapability.completionAllowed, false);

  const passed = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm run test:unit",
    result: JSON.stringify({ exitCode: 0, success: true, stdout: "passed" }),
    transactionId: "turn-command-repair",
  });
  const reconciled = verification.buildExecuteEvidenceClosureAudit({
    ledger: [failed, passed],
    mutationExpected: false,
    validationExpected: true,
    transactionId: "turn-command-repair",
    requiredCommandEvidence: ["capability:test"],
  });
  assert.equal(reconciled.gap, "none");
  assert.equal(reconciled.completionAllowed, true);
});

test("PTY_BUSY is running process evidence rather than a failed tool operation", () => {
  const payload = JSON.stringify({
    success: false,
    stderr: "PTY_BUSY: foreground generation=4",
    foregroundGeneration: 4,
  });
  assert.equal(planEvidence.classifyCommandResultOutcome("execute_command", payload), "running");
  const entry = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "execute_command",
    target: "npm run dev",
    result: payload,
    transactionId: "turn-pty-running",
  });
  assert.equal(entry?.observationStatus, "running");
  assert.equal(entry?.terminalBusy, true);
});

test("exploratory read failures do not poison a later real repair closure", () => {
  const exploratoryFailure = planEvidence.createPlanExecutionFailureEntry({
    toolName: "read_file",
    target: ".goals/progress.md",
    error: "file not found",
    transactionId: "turn-exploration-repair",
  });
  const repair = {
    id: "source-repair",
    kind: "file",
    value: "src/config.ts",
    target: "src/config.ts",
    sourceTool: "apply_patch",
    transactionId: "turn-exploration-repair",
    createdAt: 2,
  };
  const validation = planEvidence.createPlanExecutionEvidenceEntry({
    toolName: "run_command",
    target: "npm run test",
    result: JSON.stringify({ exitCode: 0, success: true, stdout: "passed" }),
    transactionId: "turn-exploration-repair",
  });
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [exploratoryFailure, repair, validation],
    mutationExpected: true,
    validationExpected: true,
    transactionId: "turn-exploration-repair",
  });
  assert.equal(audit.gap, "none");
  assert.equal(audit.completionAllowed, true);
});

test("command-only completion satisfies multiple requirements across the command evidence set", () => {
  const lint = {
    id: "lint",
    kind: "cmd",
    value: "npm run lint",
    target: "npm run lint",
    sourceTool: "run_command",
    createdAt: 1,
  };
  const tests = {
    id: "tests",
    kind: "cmd",
    value: "npm test",
    target: "npm test",
    sourceTool: "run_command",
    createdAt: 2,
  };
  const requiredCommandEvidence = ["npm run lint", "npm test"];

  const partialAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [lint],
    mutationExpected: false,
    validationExpected: true,
    requiredCommandEvidence,
  });
  assert.equal(partialAudit.gap, "validation_required");
  assert.equal(partialAudit.validationCount, 0);

  const completeAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [lint, tests],
    mutationExpected: false,
    validationExpected: true,
    requiredCommandEvidence,
  });
  assert.equal(completeAudit.gap, "none");
  assert.equal(completeAudit.validationCount, 2);
  assert.equal(completeAudit.completionAllowed, true);
});

test("precompletion recovery never inherits a mutation target from another transaction", () => {
  const oldMutation = {
    ...nonInteractionMutation(),
    value: "src/old.js",
    target: "src/old.js",
    transactionId: "turn-old",
  };
  const mutationDecision = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [oldMutation],
    transactionId: "turn-current",
    mutationExpected: true,
    validationExpected: true,
    currentRecoveryMode: "normal",
    availableToolNames: new Set(["apply_patch", "run_command"]),
  });
  assert.equal(mutationDecision.gap, "mutation_required");
  assert.equal(mutationDecision.expectedTarget, null);

  const currentMutation = {
    ...oldMutation,
    id: "current-mutation",
    value: "src/current.js",
    target: "src/current.js",
    transactionId: "turn-current",
  };
  const validationDecision = precompletion.resolvePreCompletionEvidenceRecoveryDecision({
    ledger: [oldMutation, currentMutation],
    transactionId: "turn-current",
    mutationExpected: true,
    validationExpected: true,
    currentRecoveryMode: "normal",
    availableToolNames: new Set(["apply_patch", "run_command"]),
  });
  assert.equal(validationDecision.gap, "validation_after_mutation_required");
  assert.equal(validationDecision.expectedTarget, "src/current.js");
});

test("completion evidence cannot cross logical execution transactions", () => {
  const oldMutation = {
    ...nonInteractionMutation(),
    transactionId: "turn-old",
  };
  const currentValidation = {
    id: "current-validation",
    transactionId: "turn-current",
    kind: "cmd",
    value: "npm test",
    target: "npm test",
    sourceTool: "run_command",
    createdAt: 2,
  };
  const audit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [oldMutation, currentValidation],
    transactionId: "turn-current",
    mutationExpected: true,
    validationExpected: true,
  });
  assert.equal(audit.mutationCount, 0);
  assert.equal(audit.gap, "mutation_required");

  const resumedMutation = { ...oldMutation, transactionId: "turn-current" };
  const resumedAudit = verification.buildExecuteEvidenceClosureAudit({
    ledger: [resumedMutation, currentValidation],
    transactionId: "turn-current",
    mutationExpected: true,
    validationExpected: true,
  });
  assert.equal(resumedAudit.gap, "none");
});

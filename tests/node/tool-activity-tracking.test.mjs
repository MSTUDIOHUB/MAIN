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
  extractDelegatedSubagentActivities,
  extractSubagentParentRereadObligations,
  isEditProgressResult,
  isVerificationEvidenceResult,
  rememberToolActivity,
  toolResultCountsAsExecutionEvidence,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolActivityTracking.ts"));
const {
  handleToolResultPostProcessing,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultPostProcessing.ts"));

const {
  formatToolFeedbackEnvelope,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolFeedbackEnvelope.ts"));
const {
  assessPlanClosureEvidence,
  buildPlanEvidenceBundle,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planEvidence.ts"));
const {
  createPlanEvidenceReceipt,
  validatePlanEvidenceReceipt,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planEvidenceReceipt.ts"));
const {
  createRuntimePlanStructuredEvidenceFacts,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planStructuredEvidence.ts"));
const {
  isProjectSourceWriteResult,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"));
const {
  hasObservedWorkspaceMutationEffect,
  hasVerifiedWorkspaceMutationEffect,
  mayHaveWorkspaceSideEffects,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolResultEffect.ts"));
const {
  buildBrowserValidationCacheSignature,
  buildBrowserValidationFailureContent,
  isBrowserValidationResultCacheable,
  parseBrowserValidationOutcome,
  resolvePersistentBrowserFailureCallSignature,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/browserValidation.ts"));

function result(overrides) {
  const value = {
    toolCallId: "call_1",
    name: "replace_in_file",
    catalogIdentity: { source: "built_in", canonicalName: "replace_in_file" },
    target: "src/App.tsx",
    content: "patched file",
    isError: false,
    ...overrides,
  };
  if (
    /^(?:read_file|read_file_window)$/.test(value.name) &&
    !value.readFileObservation
  ) {
    const lines = String(value.runtimeEvidenceContent || value.content || "").split("\n").length;
    value.readFileObservation = {
      key: `${value.target}::${value.toolCallId}::test-version`,
      path: value.target,
      requestSignature: value.toolCallId,
      versionToken: `test-version:${value.target}`,
      source: "fresh",
      window: { startLine: 1, endLine: lines, totalLines: lines, truncated: false },
    };
  }
  return value;
}

function toolObservationProvenance(sourceToolCallId, overrides = {}) {
  return {
    source: "tool_observation",
    owner: {
      agentKind: "subagent",
      subagentId: "subagent-a",
    },
    sourceToolCallId,
    ...overrides,
  };
}

function createPostProcessingInput(overrides = {}) {
  const digests = [];
  const taskPhases = [];
  const executeEvidenceMarks = [];
  const clearRecoveryCalls = [];
  const unityFallbacks = [];
  const planRuntimePhases = [];
  const recentToolActivity = [];
  const recentPlanToolActivity = [];
  const taskTargetingEvidence = new Set();
  const input = {
    callbacks: {
      getPreferredLanguage: () => "en",
      getPlanTasks: () => [{
        id: "task_1",
        text: "Run validation",
        status: "pending",
      }],
      getIsPlanApproved: () => false,
      onExecutionDigestUpdate: (digest) => digests.push(digest),
    },
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    iteration: 1,
    results: [result({ toolCallId: "call_1" })],
    toolArgsByCallId: new Map([["call_1", { path: "src/App.tsx" }]]),
    taskTargetingEvidence,
    recentToolActivity,
    recentPlanToolActivity,
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
    planRuntimePhase: "drafting",
    planEvidenceRecoveryObjective: "none",
    planDraftingRecoveryReadCount: 0,
    hasPlanDecisionOutput: false,
    unityConsoleDiagnosticsRequested: false,
    unityConsoleFinalVerificationRequired: false,
    unityConsoleRefreshObservedAfterWrite: false,
    unityMcpForceConsoleFirstPending: false,
    unityConsoleMissingFirstToolRepromptIssued: false,
    forceXmlTools: false,
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: true,
    markExecuteOperationEvidence: () => executeEvidenceMarks.push(true),
    activateUnityMcpFallback: (reason) => unityFallbacks.push(reason),
    setPlanRuntimePhase: (phase, reason, status = "running") => planRuntimePhases.push({ phase, reason, status }),
    emitTaskOrchestratorPhase: (phase, extra = {}) => taskPhases.push({ phase, extra }),
    clearExecuteRecovery: (reason, resetTarget) => clearRecoveryCalls.push({ reason, resetTarget }),
    ...overrides,
  };
  return {
    input,
    digests,
    taskPhases,
    executeEvidenceMarks,
    clearRecoveryCalls,
    unityFallbacks,
    planRuntimePhases,
    recentToolActivity,
    recentPlanToolActivity,
    taskTargetingEvidence,
  };
}

test("tool activity tracking excludes no-op cached and plan-artifact writes from execution evidence", () => {
  assert.equal(toolResultCountsAsExecutionEvidence(result({
    content: formatToolFeedbackEnvelope({
      status: "no_op",
      toolCallId: "call_noop",
      tool: "replace_in_file",
      target: "src/App.tsx",
      content: "already matched requested content",
    }),
  }), {}), false);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    content: JSON.stringify({
      success: true,
      noOp: true,
      message: "File already matched requested content.",
    }),
  }), { path: "src/App.tsx" }), false, "raw no-op writes reuse the canonical classifier");

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "read_file",
    target: "src/App.tsx",
    content: formatToolFeedbackEnvelope({
      status: "cached",
      toolCallId: "call_cached",
      tool: "read_file",
      target: "src/App.tsx",
      content: "FILE_UNCHANGED_STUB",
    }),
  }), {}), false);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "write_file",
    target: ".MAIN/plans/plan.md",
    content: "PLAN_ARTIFACT_WRITE path: .MAIN/plans/plan.md",
  }), { path: ".MAIN/plans/plan.md" }), false);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    lifecycleState: "declined",
    content: "User rejected the tool call. Try a different approach.",
  }), { path: "src/App.tsx" }), false, "review rejection is not execution evidence");
});

test("dynamic script inspection cannot masquerade as a project source write", () => {
  const inspected = result({
    toolCallId: "call_inspect",
    name: "manage_script",
    target: "Assets/Scripts/Player.cs",
    content: "Inspected Player.cs",
    lifecycleState: "completed",
  });
  assert.equal(
    isProjectSourceWriteResult(inspected, { action: "inspect", path: "Assets/Scripts", name: "Player" }),
    false,
  );

  const created = result({
    toolCallId: "call_create",
    name: "manage_script",
    target: "Assets/Scripts/Player.cs",
    content: "Created Player.cs",
    lifecycleState: "completed",
  });
  assert.equal(
    isProjectSourceWriteResult(created, { action: "create", path: "Assets/Scripts", name: "Player" }),
    false,
    "external success prose without a runtime-observed diff is not a durable write",
  );
  assert.equal(
    isProjectSourceWriteResult({
      ...created,
      executionAttempted: true,
      workspaceEffect: "verified",
      workspaceMutationEvidence: {
        changedPaths: ["Assets/Scripts/Player.cs"],
      },
    }, { action: "create", path: "Assets/Scripts", name: "Player" }),
    true,
  );
});

test("tool activity tracking counts only successful commands browser checks and source edits as execution evidence", () => {
  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "run_command",
    target: "npm test",
    content: JSON.stringify({ exitCode: 1, stderr: "failed" }),
  }), {}), false);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "run_command",
    target: "npm test",
    content: JSON.stringify({ exitCode: 0, stdout: "ok" }),
  }), {}), true);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "run_command",
    target: "npm test",
    content: JSON.stringify({
      exitCode: 0,
      stdout: "tests passed for FILE_UNCHANGED_STUB and READ_FILE_REPEAT_LIMIT",
    }),
  }), {}), true, "source marker text in command output is not cached-read feedback");

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "browser_evaluate",
    target: "http://localhost:5173",
    content: JSON.stringify({ ok: false, error: "assertion failed" }),
  }), {}), false);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "browser_evaluate",
    target: "http://localhost:5173",
    content: JSON.stringify({ ok: true, assertions: [{ passed: true }] }),
  }), {}), true);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "replace_in_file",
    target: "src/App.tsx",
    content: "updated source file",
  }), {}), true);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "send_pty_input",
    target: "CTRL_C",
    content: JSON.stringify({ accepted: true, controlAction: "interrupt" }),
  }), { control: "interrupt" }), false);

  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "spawn_subagent",
    target: "toolbar-investigation",
    content: JSON.stringify({ status: "queued", subagentId: "child-1" }),
  }), {}), false, "queuing a child is coordination, not execution evidence");
  assert.equal(toolResultCountsAsExecutionEvidence(result({
    name: "wait_subagents",
    target: "child-1",
    content: JSON.stringify({ status: "completed", subagentId: "child-1" }),
  }), {}), false, "joining a child is coordination, not execution evidence");
});

test("tool activity records a nonzero command as failed even when transport completed", () => {
  const activities = [];
  rememberToolActivity(activities, result({
    name: "run_command",
    target: "npm test",
    content: JSON.stringify({ exitCode: 1, success: false, stdout: "failed" }),
    isError: false,
  }));
  assert.equal(activities.length, 1);
  assert.equal(activities[0].status, "failed");

  rememberToolActivity(activities, result({
    toolCallId: "call_2",
    name: "run_command",
    target: "npm run build",
    content: JSON.stringify({ exitCode: 0, success: true, stdout: "built" }),
    isError: false,
  }));
  assert.equal(activities.at(-1).status, "succeeded");

  rememberToolActivity(activities, result({
    toolCallId: "call_3",
    name: "execute_command",
    target: "npm run dev",
    content: JSON.stringify({ success: false, stderr: "PTY_BUSY: foreground generation=4" }),
    isError: false,
  }));
  assert.equal(activities.at(-1).status, "called");
});

test("declined and no-effect mutations cannot become successful mutation activity", () => {
  const activities = [];
  const declined = result({
    lifecycleState: "declined",
    content: "User rejected the tool call. Try a different approach.",
  });
  rememberToolActivity(activities, declined);
  assert.equal(activities.at(-1).status, "failed");
  assert.equal(isEditProgressResult(declined), false);

  const noEffect = result({
    lifecycleState: "completed",
    content: JSON.stringify({ success: true, noOp: true }),
  });
  rememberToolActivity(activities, noEffect);
  assert.equal(activities.at(-1).status, "called");
  assert.equal(isEditProgressResult(noEffect), false);
});

test("mutation activity carries runtime-observed truth instead of inferring from the tool name", () => {
  const activities = [];
  rememberToolActivity(activities, result({
    toolCallId: "external-no-diff",
    name: "manage_script",
    executionName: "manage_script",
    catalogIdentity: { source: "mcp", canonicalName: "mcp__unity__manage_script__1234" },
    target: "Assets/Scripts/Player.cs",
    content: "Created Player.cs",
    executionAttempted: true,
  }), { args: { action: "create", path: "Assets/Scripts", name: "Player" } });
  assert.equal(activities.at(-1).status, "called");
  assert.equal(activities.at(-1).mutationObserved, false);

  rememberToolActivity(activities, result({
    toolCallId: "external-with-diff",
    name: "mcp__unity__manage_script__1234",
    executionName: "manage_script",
    catalogIdentity: { source: "mcp", canonicalName: "mcp__unity__manage_script__1234" },
    target: "Assets/Scripts/Player.cs",
    content: "Created Player.cs",
    executionAttempted: true,
    workspaceEffect: "verified",
    workspaceMutationEvidence: { changedPaths: ["Assets/Scripts/Player.cs"] },
  }), { args: { action: "create", path: "Assets/Scripts", name: "Player" } });
  assert.equal(activities.at(-1).status, "succeeded");
  assert.equal(activities.at(-1).mutationObserved, true);
});

test("execution success and possible workspace side effects remain orthogonal", () => {
  const failedAfterInvocation = result({
    name: "run_command",
    target: "npm test",
    content: JSON.stringify({ exitCode: 1 }),
    isError: true,
    lifecycleState: "failed",
    executionAttempted: true,
  });
  assert.equal(hasVerifiedWorkspaceMutationEffect(failedAfterInvocation, {}), false);
  assert.equal(mayHaveWorkspaceSideEffects(failedAfterInvocation, {}), true);

  const checkedNoEffect = result({
    content: "NO_EFFECT_MUTATION",
    isError: true,
    lifecycleState: "failed",
    executionAttempted: true,
    workspaceEffect: "none",
  });
  assert.equal(mayHaveWorkspaceSideEffects(checkedNoEffect, { path: "src/App.tsx" }), false);
});

test("failed partial mutations remain failed while retaining observed workspace change", () => {
  const activities = [];
  const failedAfterWrite = result({
    toolCallId: "partial-write",
    executionName: "replace_in_file",
    executedArgs: { path: "src/App.tsx", search: "old", replace: "new" },
    content: "Error: verification failed after write",
    isError: true,
    lifecycleState: "failed",
    executionAttempted: true,
    workspaceEffect: "partial",
    workspaceMutationEvidence: { changedPaths: ["src/App.tsx"] },
  });

  rememberToolActivity(activities, failedAfterWrite);

  assert.equal(hasObservedWorkspaceMutationEffect(failedAfterWrite), true);
  assert.equal(hasVerifiedWorkspaceMutationEffect(failedAfterWrite), false);
  assert.equal(toolResultCountsAsExecutionEvidence(failedAfterWrite, failedAfterWrite.executedArgs), false);
  assert.equal(activities.at(-1).status, "failed");
  assert.equal(activities.at(-1).mutationObserved, true);
  assert.equal(isEditProgressResult(failedAfterWrite, failedAfterWrite.executedArgs), false);
});

test("browser validation cache ignores timeout-only retries while preserving meaningful checks", () => {
  const first = buildBrowserValidationCacheSignature({
    url: "http://localhost:1420",
    wait_for_text: "Ready",
    timeout_ms: 60_000,
  });
  const timeoutRetry = buildBrowserValidationCacheSignature({
    url: "http://localhost:1420/",
    waitForText: "Ready",
    timeoutMs: 10_000,
    screenshot: true,
    failOnConsoleError: true,
  });
  const differentCheck = buildBrowserValidationCacheSignature({
    url: "http://localhost:1420",
    wait_for_text: "Ready",
    checks: "selector: #app",
  });

  assert.equal(first, timeoutRetry);
  assert.notEqual(first, differentCheck);
});

test("only deterministic browser failures produce a persistent exact-call signature", () => {
  const args = {
    url: "http://localhost:1420/",
    actions: [{ kind: "click", selector: "#open" }],
    checks: [{ kind: "text", value: "Opened" }],
  };
  const deterministicFailure = JSON.stringify({
    ok: false,
    failureReasons: ["validation_spec_error"],
    failureSummary: "selector #open was not found",
    validationSpecError: {
      code: "selector_not_found",
      message: "selector #open was not found",
      fingerprint: "selector-open",
    },
  });
  const transientFailure = JSON.stringify({
    ok: false,
    failureReasons: ["runtime_error"],
    failureSummary: "net::ERR_CONNECTION_REFUSED",
    error: "page.goto: net::ERR_CONNECTION_REFUSED",
  });

  assert.equal(
    resolvePersistentBrowserFailureCallSignature(args, deterministicFailure),
    buildBrowserValidationCacheSignature(args),
  );
  assert.equal(
    resolvePersistentBrowserFailureCallSignature(args, transientFailure),
    null,
  );
  assert.notEqual(
    buildBrowserValidationCacheSignature({
      ...args,
      actions: [{ kind: "click", selector: "#open-document" }],
    }),
    buildBrowserValidationCacheSignature(args),
  );
});

test("browser validation outcome keeps concise diagnostics for failed tool feedback", () => {
  const raw = JSON.stringify({
    ok: false,
    failureSummary: "page_error: Cannot set properties of null",
    failureReasons: ["page_error", "blank_page"],
    blankPage: true,
    screenshotPath: ".MAIN/browser-validation/browser-1.png",
    pageErrors: ["Cannot set properties of null"],
    consoleErrors: [],
    assertions: [{ passed: false }],
    durationMs: 812,
    error: null,
  });
  const outcome = parseBrowserValidationOutcome(raw);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.blankPage, true);
  assert.equal(outcome.failedAssertionCount, 1);
  assert.equal(outcome.screenshotPath, ".MAIN/browser-validation/browser-1.png");
  assert.match(buildBrowserValidationFailureContent(raw), /^BROWSER_VALIDATION_FAILED: page_error/);
  assert.equal(isBrowserValidationResultCacheable(buildBrowserValidationFailureContent(raw)), true);
  assert.equal(isBrowserValidationResultCacheable(JSON.stringify({
    ok: false,
    failureReasons: ["runtime_error", "blank_page"],
    blankPage: true,
    failureSummary: "runtime_error: net::ERR_CONNECTION_REFUSED",
    error: "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1420/",
  })), false);
});

test("browser validation outcome parses and caches deterministic specification failures", () => {
  const raw = JSON.stringify({
    ok: false,
    failureReasons: ["validation_spec_error", "action_failed"],
    failureSummary: "validation_spec_error: selector_not_found",
    failureFingerprint: "validation-spec-stable",
    validationSpecError: {
      code: "selector_not_found",
      message: "Selector #missing matched no elements.",
      phase: "action",
      actionId: "action-1",
      actionIndex: 1,
      actionKind: "click",
      selector: "#missing",
      expectedText: null,
      actionFingerprint: "action-stable",
      selectorFingerprint: "selector-stable",
      fingerprint: "validation-spec-stable",
    },
    failedAction: {
      id: "action-1",
      index: 1,
      kind: "click",
      value: "#missing",
      selector: "#missing",
      error: "Selector #missing matched no elements.",
      actionFingerprint: "action-stable",
      selectorFingerprint: "selector-stable",
    },
    interactiveElements: [{
      tag: "button",
      type: "button",
      role: "",
      id: "new-btn",
      name: "",
      text: "New",
      ariaLabel: "New document",
      placeholder: "",
      testId: "",
      selectorCandidates: ["#new-btn", "button[aria-label=\"New document\"]"],
      fingerprint: "interactive-stable",
    }],
  });
  const outcome = parseBrowserValidationOutcome(raw);

  assert.equal(outcome.failureFingerprint, "validation-spec-stable");
  assert.equal(outcome.validationSpecError.code, "selector_not_found");
  assert.equal(outcome.validationSpecError.selector, "#missing");
  assert.equal(outcome.failedAction.actionFingerprint, "action-stable");
  assert.deepEqual(outcome.interactiveElements[0].selectorCandidates, [
    "#new-btn",
    "button[aria-label=\"New document\"]",
  ]);
  assert.equal(isBrowserValidationResultCacheable(raw), true);

  const reused = [
    "REUSED_BROWSER_VALIDATION: identical browser_evaluate already ran.",
    "Use the captured diagnostic instead of retrying unchanged.",
    "",
    `BROWSER_VALIDATION_FAILED: selector missing\n${raw}`,
  ].join("\n");
  const reusedOutcome = parseBrowserValidationOutcome(reused);
  assert.equal(reusedOutcome.validationSpecError.code, "selector_not_found");
  assert.equal(reusedOutcome.failedAction.selector, "#missing");
  assert.equal(isBrowserValidationResultCacheable(reused), true);
});

test("tool activity tracking records bounded recent activity and helper classifications", () => {
  const activity = [];
  rememberToolActivity(activity, result({
    name: "read_file",
    target: "src/App.tsx",
    content: "READ_FILE_RESULT path: src/App.tsx",
    readFileObservation: {
      key: "src/App.tsx::1-80::v3",
      path: "src/App.tsx",
      requestSignature: "1:80",
      versionToken: "v3",
      source: "fresh",
    },
  }));
  rememberToolActivity(activity, result({
    name: "apply_patch",
    target: "src/App.tsx",
    displayContent: "Applied patch to src/App.tsx\nwith many details",
  }));
  rememberToolActivity(activity, result({
    name: "write_file",
    target: "src/Hidden.ts",
    internalFeedback: true,
  }));

  assert.equal(activity.length, 2);
  assert.deepEqual(activity.map((item) => item.name), ["read_file", "apply_patch"]);
  assert.equal(activity[0].detail, undefined);
  assert.deepEqual(activity[0].readFileObservation, {
    key: "src/App.tsx::1-80::v3",
    path: "src/App.tsx",
    requestSignature: "1:80",
    versionToken: "v3",
    source: "fresh",
  });
  assert.match(activity[1].detail, /Applied patch/);
  assert.equal(isEditProgressResult(result({ name: "apply_patch" })), true);
  assert.equal(isEditProgressResult(result({
    name: "apply_patch",
    content: JSON.stringify({ success: true, noOp: true }),
  })), false, "a no-op edit is not mutation progress");
  assert.equal(isEditProgressResult(result({ name: "run_command", target: "shell-write:npm test" })), true);
  assert.equal(isVerificationEvidenceResult(result({ name: "run_command", isError: false })), true);
  assert.equal(isVerificationEvidenceResult(result({
    name: "execute_command",
    isError: false,
    content: JSON.stringify({ command: "npm run dev", output: "starting" }),
  })), false);
  assert.equal(isVerificationEvidenceResult(result({
    name: "read_pty_tail",
    isError: false,
    content: JSON.stringify({ running: true, text: "Waiting for your frontend dev server to start" }),
  })), false);
  assert.equal(isVerificationEvidenceResult(result({
    name: "read_pty_since",
    isError: false,
    content: JSON.stringify({ running: true, text: "VITE ready in 812 ms\nLocal: http://localhost:1420/" }),
  })), true);
  assert.equal(isVerificationEvidenceResult(result({
    name: "run_command",
    isError: false,
    content: JSON.stringify({ exitCode: 1, stderr: "failed" }),
  })), false);
  assert.equal(isVerificationEvidenceResult(result({
    name: "browser_evaluate",
    isError: false,
    content: JSON.stringify({ ok: false, error: "assertion failed" }),
  })), false);
  assert.equal(isVerificationEvidenceResult(result({ name: "run_command", isError: true })), false);
  assert.equal(isVerificationEvidenceResult(result({
    name: "run_command",
    isError: false,
    content: formatToolFeedbackEnvelope({
      status: "failed",
      toolCallId: "run_structured_failed",
      tool: "run_command",
      target: "npm test",
      content: JSON.stringify({ exitCode: 0, stdout: "passed" }),
    }),
  })), false, "structured failure status must override success-looking command output");
  assert.equal(isVerificationEvidenceResult(result({ name: "git_diff", isError: false })), false);
  assert.equal(isVerificationEvidenceResult(result({ name: "clear_pty_buffer", isError: false })), false);
});

test("code_ast_query activity retains parser-backed declaration ranges and file version", () => {
  const activity = [];
  rememberToolActivity(activity, result({
    name: "code_ast_query",
    target: "src/main.js",
    content: JSON.stringify({
      path: "src/main.js",
      language: "javascript",
      rootKind: "program",
      hasErrors: false,
      errorCount: 0,
      sizeBytes: 9000,
      modifiedMs: 100,
      versionToken: "9000:100",
      query: "inittoolbar",
      exactMatchCount: 1,
      truncated: false,
      note: "Tree-sitter syntax tree query.",
      symbols: [{
        name: "initToolbar",
        kind: "function",
        syntaxKind: "function_declaration",
        startLine: 600,
        startColumn: 1,
        endLine: 650,
        signature: "function initToolbar()",
      }],
    }),
  }));

  assert.deepEqual(activity[0].astObservation, {
    path: "src/main.js",
    language: "javascript",
    versionToken: "9000:100",
    query: "inittoolbar",
    exactMatchCount: 1,
    hasErrors: false,
    truncated: false,
    symbols: [{
      name: "initToolbar",
      kind: "function",
      syntaxKind: "function_declaration",
      startLine: 600,
      endLine: 650,
    }],
  });
});

test("Plan evidence activity outlives the short loop-detection window and merges rereads", () => {
  const recent = [];
  const ledger = [];
  for (let index = 0; index < 15; index += 1) {
    const readResult = result({
      toolCallId: `read_${index}`,
      name: "read_file",
      target: `src/module-${index}.ts`,
      content: `export function module${index}() { return ${index}; }`,
    });
    rememberToolActivity(recent, readResult);
    rememberToolActivity(ledger, readResult, { evidenceLedger: true });
  }

  assert.equal(recent.length, 12);
  assert.equal(recent.some((item) => item.target === "src/module-0.ts"), false);
  assert.equal(ledger.length, 15);
  assert.equal(ledger[0].target, "src/module-0.ts");

  rememberToolActivity(ledger, result({
    toolCallId: "read_0_window",
    name: "read_file",
    target: "src/module-0.ts",
    content: "export const additionalBoundary = true;",
  }), { evidenceLedger: true });
  assert.equal(ledger.length, 15);
  assert.match(ledger[0].detail || "", /module0/);
  assert.match(ledger[0].detail || "", /additionalBoundary/);
});

test("Plan source evidence replaces stale fields across versions and merges same-version windows", () => {
  const ledger = [];
  const observedRead = ({ toolCallId, versionToken, requestSignature, content }) => result({
    toolCallId,
    name: "read_file",
    target: "src/runtime.ts",
    content,
    readFileObservation: {
      key: `src/runtime.ts::${requestSignature}::${versionToken}`,
      path: "src/runtime.ts",
      requestSignature,
      versionToken,
      source: "fresh",
      window: { startLine: 1, endLine: content.split("\n").length, totalLines: 20, truncated: true },
    },
  });

  rememberToolActivity(ledger, observedRead({
    toolCallId: "read-v1",
    versionToken: "version-v1",
    requestSignature: "1-20",
    content: "await invoke('legacy_save', { file_path: path });",
  }), { evidenceLedger: true });
  assert.match((ledger[0].facts || []).join(" "), /legacy_save/);

  rememberToolActivity(ledger, observedRead({
    toolCallId: "read-v2",
    versionToken: "version-v2",
    requestSignature: "1-20",
    content: "document.dispatchEvent(new Event('document-ready'));",
  }), { evidenceLedger: true });
  assert.equal(ledger.length, 1);
  assert.doesNotMatch((ledger[0].facts || []).join(" "), /legacy_save/);
  assert.match((ledger[0].facts || []).join(" "), /document-ready/);
  assert.ok((ledger[0].sourceObservations || []).every((item) =>
    item.versionToken === "version-v2"
  ));

  rememberToolActivity(ledger, observedRead({
    toolCallId: "read-v2-window",
    versionToken: "version-v2",
    requestSignature: "21-40",
    content: "window.addEventListener('document-ready', () => scheduleSave());",
  }), { evidenceLedger: true });
  assert.match((ledger[0].facts || []).join(" "), /document-ready/);
  assert.match(
    (ledger[0].sourceObservations || []).map((item) => item.excerpt).join(" "),
    /scheduleSave/,
  );
  assert.equal(ledger[0].readFileObservation.versionToken, "version-v2");
});

test("same-version source pagination retains atomic provenance for decisive exact windows", () => {
  const sourceLines = Array.from({ length: 420 }, (_, index) => `// context ${index + 1}`);
  for (const [line, event] of [[20, "alpha"], [90, "beta"], [160, "gamma"], [230, "delta"]]) {
    sourceLines[line - 1] = `function bind${event}() {`;
    sourceLines[line] = `  document.addEventListener('${event}', () => refresh${event}());`;
    sourceLines[line + 1] = "}";
  }
  sourceLines[349] = "await invoke('persist_record', {";
  sourceLines[350] = "  record_path: record.path,";
  sourceLines[351] = "  content: record.content";
  sourceLines[352] = "});";
  const source = sourceLines.join("\n");
  const ledger = [];
  const observedRead = ({ toolCallId, content, startLine, endLine }) => result({
    toolCallId,
    name: "read_file",
    target: "src/runtime.js",
    content,
    readFileObservation: {
      key: `src/runtime.js::${startLine}-${endLine}::source-v1`,
      path: "src/runtime.js",
      requestSignature: `${startLine}-${endLine}`,
      versionToken: "source-v1",
      source: "fresh",
      window: {
        startLine,
        endLine,
        totalLines: sourceLines.length,
        truncated: startLine !== 1 || endLine !== sourceLines.length,
      },
    },
  });

  rememberToolActivity(ledger, observedRead({
    toolCallId: "full-source",
    content: source,
    startLine: 1,
    endLine: sourceLines.length,
  }), { evidenceLedger: true });
  assert.equal(ledger[0].sourceObservations.length, 4);
  assert.equal(
    ledger[0].sourceObservations.some((item) => item.startLine <= 350 && item.endLine >= 350),
    false,
  );

  rememberToolActivity(ledger, observedRead({
    toolCallId: "exact-command-window",
    content: sourceLines.slice(339, 360).join("\n"),
    startLine: 340,
    endLine: 360,
  }), { evidenceLedger: true });

  assert.equal(ledger[0].sourceObservations.length, 4);
  assert.ok(ledger[0].sourceObservations.some((item) =>
    item.startLine === 340 && item.endLine === 360
  ));
  assert.ok(ledger[0].structuredFacts.some((fact) =>
    fact.kind === "command_contract" &&
    fact.relation === "invoke" &&
    fact.command === "persist_record" &&
    fact.arguments?.includes("record_path")
  ));

  const bundle = buildPlanEvidenceBundle({
    objective: "Repair the observed persistence contract.",
    evidenceRecords: ledger.map((item) => ({
      tool: item.name,
      target: item.target,
      status: item.status,
      summary: item.detail,
      facts: item.facts,
      structuredFacts: item.structuredFacts,
      sourceObservations: item.sourceObservations,
    })),
  });
  assert.deepEqual(validatePlanEvidenceReceipt(createPlanEvidenceReceipt(bundle)), []);
});

test("Plan source evidence uses model content instead of the shorter UI projection", () => {
  const activity = [];
  rememberToolActivity(activity, result({
    toolCallId: "read-contract-after-display-cutoff",
    name: "read_file",
    target: "src/main.js",
    displayContent: "import { invoke } from '@tauri-apps/api/core';",
    content: [
      "import { invoke } from '@tauri-apps/api/core';",
      "editor.addEventListener('input', () => {",
      "  markDirty();",
      "  scheduleAutoSave();",
      "});",
      "await invoke('save_file_content', {",
      "  file_path: file.path,",
      "  content: editor.value",
      "});",
    ].join("\n"),
  }), { evidenceLedger: true });

  assert.ok(activity[0].facts.includes(
    "command_invoke_argument_contract(save_file_content,file_path,content)",
  ));
  assert.ok(activity[0].facts.includes("listener_calls(markDirty,scheduleAutoSave)"));
  assert.ok(
    activity[0].structuredFacts?.some((fact) =>
      fact.kind === "command_contract" &&
      fact.relation === "invoke" &&
      fact.command === "save_file_content" &&
      fact.arguments?.includes("file_path")
    ),
    JSON.stringify(activity[0].structuredFacts),
  );
  assert.match(activity[0].sourceObservations?.[0]?.excerpt || "", /scheduleAutoSave/);
  assert.match(activity[0].sourceObservations?.[0]?.excerptHash || "", /^source-sha256-/);

  const noisyHandlers = Array.from({ length: 12 }, (_, index) => [
    "#[tauri::command]",
    `fn auxiliary_command_${index}(value_${index}: String) -> Result<(), String> { Ok(()) }`,
  ].join("\n"));
  rememberToolActivity(activity, result({
    toolCallId: "read-handler-after-summary-budget",
    name: "read_file",
    target: "src-tauri/src/main.rs",
    displayContent: noisyHandlers.slice(0, 2).join("\n"),
    content: [
      ...noisyHandlers,
      "#[tauri::command]",
      "fn save_file_content(content: String, file_path: Option<String>) -> Result<(), String> {",
      "  let path = file_path.ok_or_else(|| \"missing path\".to_string())?;",
      "  std::fs::write(path, content).map_err(|error| error.to_string())",
      "}",
    ].join("\n"),
  }), { evidenceLedger: true });

  assert.doesNotMatch(activity[1].detail || "", /save_file_content/);
  assert.ok(activity[1].facts.includes(
    "command_handler_argument_contract(save_file_content,content,filePath)",
  ));
  assert.ok(
    activity[1].structuredFacts?.some((fact) =>
      fact.kind === "command_contract" &&
      fact.relation === "handler" &&
      fact.command === "save_file_content" &&
      fact.arguments?.includes("filePath")
    ),
    JSON.stringify(activity[1].structuredFacts),
  );
  const bundle = buildPlanEvidenceBundle({
    objective: "修复打开文件后自动保存时提示缺少保存路径的问题。",
    evidenceRecords: activity.map((item) => ({
      tool: item.name,
      target: item.target,
      status: item.status,
      summary: item.detail,
      facts: item.facts,
      structuredFacts: item.structuredFacts,
      sourceObservations: item.sourceObservations,
    })),
  });
  assert.match(
    bundle.facts.find((fact) => fact.target === "src/main.js")
      ?.sourceObservations?.[0]?.excerpt || "",
    /file_path: file\.path/,
  );
  assert.doesNotMatch(
    bundle.facts.find((fact) => fact.target === "src-tauri/src/main.rs")?.summary || "",
    /save_file_content/,
    "the bounded display summary should stay noisy enough to prove structured facts are independent",
  );
  assert.ok(assessPlanClosureEvidence(bundle).contractMismatchKinds.includes(
    "command_argument_case:save_file_content:file_path->filePath",
  ));
});

test("real four-owner Plan evidence keeps causal and command-contract components independent", () => {
  const ledger = [];
  const sources = new Map([
    ["src/components/toolbar.js", [
      "export function setCurrentFile(filePath) {",
      "  const filePathEl = document.getElementById('file-path');",
      "  filePathEl.textContent = filePath ? filePath.split('/').pop() : '';",
      "}",
    ].join("\n")],
    ["src/components/editor.js", [
      "editor.setValue = function(value) {",
      "  this.value = value;",
      "  this.dispatchEvent(new Event('input'));",
      "};",
    ].join("\n")],
    ["src/main.js", [
      "editorEl.addEventListener('input', () => {",
      "  if (activeTab >= 0) {",
      "    activeFiles[activeTab].isDirty = true;",
      "    scheduleAutoSave();",
      "  }",
      "});",
      "await invoke('save_file_content', {",
      "  file_path: file.path,",
      "  content: editorEl.value",
      "});",
    ].join("\n")],
    ["src-tauri/src/main.rs", [
      "#[tauri::command]",
      "fn save_file_content(content: String, file_path: Option<String>) -> Result<(), String> {",
      "  std::fs::write(file_path.unwrap(), content).map_err(|error| error.to_string())",
      "}",
    ].join("\n")],
  ]);
  for (const [target, content] of sources) {
    rememberToolActivity(ledger, result({
      toolCallId: `four-owner-${target}`,
      name: "read_file",
      target,
      content,
    }), { evidenceLedger: true });
  }
  const bundle = buildPlanEvidenceBundle({
    objective: [
      "1. Remove the duplicate filename presentation.",
      "2. Stop programmatic file opening from entering dirty autosave and the invalid save call.",
    ].join("\n"),
    evidenceRecords: ledger.map((item) => ({
      tool: item.name,
      target: item.target,
      status: item.status,
      summary: item.detail,
      facts: item.facts,
      structuredFacts: item.structuredFacts,
      sourceObservations: item.sourceObservations,
    })),
  });
  const causal = bundle.coverageObligations.find((item) => item.kind === "causal_relation");
  const mismatch = bundle.coverageObligations.find((item) => item.kind === "contract_mismatch");
  assert.deepEqual(causal?.targetRefs.sort(), ["src/components/editor.js", "src/main.js"]);
  assert.deepEqual(mismatch?.targetRefs.sort(), ["src-tauri/src/main.rs", "src/main.js"]);
  assert.ok(bundle.evidenceComponents.some((item) =>
    item.requiredForClosure && item.relationRefs.includes(causal.id)
  ));
  assert.ok(bundle.evidenceComponents.some((item) =>
    item.requiredForClosure && item.relationRefs.includes(mismatch.id)
  ));
  assert.ok(bundle.evidenceComponents.some((item) =>
    item.requiredForClosure === false && item.ownerRefs.includes("src/components/toolbar.js")
  ));
  assert.deepEqual(validatePlanEvidenceReceipt(createPlanEvidenceReceipt(bundle)), []);
});

test("wait_subagents promotes child file evidence instead of recording orchestration noise", () => {
  const waitResult = result({
    toolCallId: "wait_1",
    name: "wait_subagents",
    target: "subagent-a,subagent-b",
    content: formatToolFeedbackEnvelope({
      status: "completed",
      toolCallId: "wait_1",
      tool: "wait_subagents",
      target: "subagent-a,subagent-b",
      content: JSON.stringify({
        results: [{
          subagentId: "subagent-a",
          status: "completed",
          evidence: [{
            tool: "read_file",
            target: "src/lib/subagents.ts",
            detail: "The resolveSubagentCapacityPolicy function incorrectly limits local child workflows before model-lane admission.",
            facts: ["event_dom_listener_contract(DOMContentLoaded)", "listener_calls(initToolbar)"],
            provenance: toolObservationProvenance("subagent-a-read-1", {
              factReferences: [
                { fact: "event_dom_listener_contract(DOMContentLoaded)", sourceToolCallId: "subagent-a-read-1" },
                { fact: "listener_calls(initToolbar)", sourceToolCallId: "subagent-a-read-1" },
              ],
            }),
          }, {
            tool: "read_file",
            target: "src/lib/subagents.ts",
            detail: `${"implementation context ".repeat(16)} | L90: server port: 1420`,
            provenance: toolObservationProvenance("subagent-a-read-2"),
          }],
        }, {
          subagentId: "subagent-b",
          status: "completed",
          evidence: [{
            tool: "read_file",
            target: "src/lib/modelLaneCoordinator.ts",
            detail: "The acquireModelLane function enforces the shared parent and child model-stream limit.",
            provenance: toolObservationProvenance("subagent-b-read-1", {
              owner: {
                agentKind: "subagent",
                subagentId: "subagent-b",
              },
            }),
          }],
        }],
        pendingIds: [],
      }),
    }),
  });

  const promoted = extractDelegatedSubagentActivities(waitResult);
  assert.deepEqual(promoted.map((item) => item.target), [
    "src/lib/subagents.ts",
    "src/lib/modelLaneCoordinator.ts",
  ]);
  assert.ok(promoted.every((item) => item.status === "succeeded"));
  assert.match(promoted[0].detail || "", /resolveSubagentCapacityPolicy/);
  assert.match(promoted[0].detail || "", /port:\s*1420/);
  assert.ok(promoted[0].facts?.includes("event_dom_listener_contract(DOMContentLoaded)"));
  assert.ok(promoted[0].facts?.includes("listener_calls(initToolbar)"));
  assert.equal(promoted[0].readFileObservation, undefined);
  assert.equal(promoted[0].delegatedObservation.owner.subagentId, "subagent-a");
  assert.equal(promoted[0].delegatedObservation.parentContextState, "reference_only");

  const debugEvents = [];
  const harness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "grounding",
    results: [waitResult],
    toolArgsByCallId: new Map([["wait_1", { subagent_ids: "subagent-a,subagent-b" }]]),
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
  harness.input.callbacks = {
    ...harness.input.callbacks,
    getMessages: () => [{
      role: "user",
      content: "Prepare a plan for local subagent capacity and shared model-lane admission.",
    }],
    getCurrentTurnId: () => "turn-subagent-plan",
    getContextMemoryState: () => null,
    onDebugEvent: (event, data) => debugEvents.push({ event, data }),
  };

  const post = handleToolResultPostProcessing(harness.input);
  assert.equal(post.planRuntimePhase, "drafting");
  assert.deepEqual(harness.recentPlanToolActivity.map((item) => item.name), ["read_file", "read_file"]);
  assert.ok([...harness.taskTargetingEvidence].includes("path:src/lib/subagents.ts"));
  assert.ok(debugEvents.some((entry) =>
    entry.event === "subagent_evidence_promoted" && entry.data.evidenceCount === 2
  ));

  const unobservedVisualHarness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "grounding",
    results: [waitResult],
    toolArgsByCallId: new Map([["wait_1", { subagent_ids: "subagent-a,subagent-b" }]]),
    turnInputContextSignals: {
      imageParts: 1,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "preferred",
    },
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
  unobservedVisualHarness.input.callbacks = {
    ...unobservedVisualHarness.input.callbacks,
    getMessages: () => [{
      role: "user",
      content: [{ type: "text", text: "Use the screenshot and source evidence to prepare a plan." }, {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AA==" },
      }],
    }],
    getCurrentTurnId: () => "turn-subagent-plan-visual",
    getContextMemoryState: () => null,
  };

  const unobservedVisualPost = handleToolResultPostProcessing(
    unobservedVisualHarness.input,
  );
  assert.equal(unobservedVisualPost.planRuntimePhase, "grounding");
  assert.deepEqual(unobservedVisualHarness.planRuntimePhases, []);

  const executionHarness = createPostProcessingInput({
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    planRuntimePhase: "idle",
    results: [waitResult],
    toolArgsByCallId: new Map([["wait_1", { subagent_ids: "subagent-a,subagent-b" }]]),
  });
  handleToolResultPostProcessing(executionHarness.input);
  assert.deepEqual(executionHarness.recentToolActivity.map((item) => item.target), [
    "src/lib/subagents.ts",
    "src/lib/modelLaneCoordinator.ts",
  ]);
  assert.equal(executionHarness.executeEvidenceMarks.length, 0);
  assert.match(executionHarness.digests[0], /read_file src\/lib\/modelLaneCoordinator\.ts/);
});

test("child summary prose and unprovenanced evidence are not promoted as trusted evidence", () => {
  const waitResult = result({
    toolCallId: "wait_untrusted",
    name: "wait_subagents",
    target: "subagent-untrusted",
    content: JSON.stringify({
      results: [{
        subagentId: "subagent-untrusted",
        status: "completed",
        summary: "The callback definitely exists and is wired correctly.",
        summaryTrust: "unverified_hypothesis",
        evidence: [{
          tool: "read_file",
          target: "src/main.js",
          detail: "The callback definitely exists and is wired correctly.",
        }],
      }],
      pendingIds: [],
    }),
  });

  assert.deepEqual(extractDelegatedSubagentActivities(waitResult), []);
});

test("delegated evidence owner must match the enclosing child result", () => {
  const waitResult = result({
    toolCallId: "wait_owner_mismatch",
    name: "wait_subagents",
    target: "subagent-a",
    content: JSON.stringify({
      results: [{
        subagentId: "subagent-a",
        status: "completed",
        evidence: [{
          tool: "read_file",
          target: "src/main.js",
          detail: "source detail",
          provenance: toolObservationProvenance("child-read", {
            owner: {
              agentKind: "subagent",
              subagentId: "subagent-b",
            },
          }),
        }],
      }],
      pendingIds: [],
    }),
  });

  assert.deepEqual(extractDelegatedSubagentActivities(waitResult), []);
});

test("structured non-substantive child observations stay out of the parent evidence ledger", () => {
  const waitResult = result({
    toolCallId: "wait_empty_outline",
    name: "wait_subagents",
    target: "subagent-a",
    content: JSON.stringify({
      results: [{
        subagentId: "subagent-a",
        status: "blocked",
        evidence: [{
          tool: "get_file_outline",
          target: "src/main.js",
          detail: "No symbols found.",
          observation: {
            kind: "structure",
            sourcePath: "src/main.js",
            contentChars: 17,
            negative: true,
            substantive: false,
          },
          provenance: toolObservationProvenance("child-outline-empty"),
        }],
      }],
      pendingIds: [],
    }),
  });

  assert.deepEqual(extractDelegatedSubagentActivities(waitResult), []);
});

test("a partial child can promote an independently accepted planning observation", () => {
  const waitResult = result({
    toolCallId: "wait_partial_closure",
    name: "wait_subagents",
    target: "subagent-a",
    content: JSON.stringify({
      results: [{
        subagentId: "subagent-a",
        status: "completed",
        closureAudit: {
          state: "partial",
          observationCount: 1,
          substantiveEvidenceCount: 1,
          acceptedEvidenceToolCallIds: ["child-read-partial"],
          reason: "More requested work remains.",
        },
        evidence: [{
          tool: "read_file",
          target: "src/main.js",
          detail: "Observed implementation context.",
          observation: {
            kind: "source",
            sourcePath: "src/main.js",
            contentChars: 32,
            negative: false,
            substantive: true,
          },
          provenance: toolObservationProvenance("child-read-partial"),
        }],
      }],
      pendingIds: [],
    }),
  });

  const promoted = extractDelegatedSubagentActivities(waitResult);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].target, "src/main.js");
  assert.equal(promoted[0].delegatedObservation.planningEvidenceState, "reusable");
  assert.equal(promoted[0].delegatedObservation.requiresParentReread, true);
});

test("a satisfied structured closure promotes only substantive observations", () => {
  const waitResult = result({
    toolCallId: "wait_satisfied_closure",
    name: "wait_subagents",
    target: "subagent-a",
    content: JSON.stringify({
      results: [{
        subagentId: "subagent-a",
        status: "completed",
        closureAudit: {
          state: "satisfied",
          observationCount: 2,
          substantiveEvidenceCount: 1,
          acceptedEvidenceToolCallIds: ["child-read-source"],
          reason: "Requested source evidence was collected.",
        },
        evidence: [{
          tool: "get_file_outline",
          target: "src/main.js",
          detail: "No symbols found.",
          observation: {
            kind: "structure",
            sourcePath: "src/main.js",
            contentChars: 17,
            negative: true,
            substantive: false,
          },
          provenance: toolObservationProvenance("child-outline-empty"),
        }, {
          tool: "read_file",
          target: "src/main.js",
          detail: "Observed implementation context.",
          observation: {
            kind: "source",
            sourcePath: "src/main.js",
            contentChars: 32,
            negative: false,
            substantive: true,
          },
          provenance: toolObservationProvenance("child-read-source"),
        }],
      }],
      pendingIds: [],
    }),
  });

  const promoted = extractDelegatedSubagentActivities(waitResult);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].name, "read_file");
  assert.equal(promoted[0].delegatedObservation.sourceToolCallId, "child-read-source");
});

test("delegated evidence uses the exact runtime payload when the model-facing join result is truncated", () => {
  const runtimeEvidenceContent = JSON.stringify({
    results: [{
      subagentId: "subagent-a",
      status: "completed",
      closureAudit: {
        state: "satisfied",
        observationCount: 1,
        substantiveEvidenceCount: 1,
        acceptedEvidenceToolCallIds: ["child-read-runtime"],
        requiredPaths: ["src/runtime.ts"],
        coveredPaths: ["src/runtime.ts"],
        failedPaths: [],
        uncoveredPaths: [],
        reason: "The scoped source was observed.",
      },
      evidence: [{
        tool: "read_file",
        target: "src/runtime.ts",
        detail: "Observed the runtime-owned source payload.",
        observation: {
          kind: "source",
          sourcePath: "src/runtime.ts",
          contentChars: 43,
          negative: false,
          substantive: true,
        },
        provenance: toolObservationProvenance("child-read-runtime"),
      }],
    }],
    pendingIds: [],
  });
  const waitResult = result({
    toolCallId: "wait_runtime_payload",
    name: "wait_subagents",
    target: "subagent-a",
    content: '{"results":[',
    runtimeEvidenceContent,
  });

  const promoted = extractDelegatedSubagentActivities(waitResult);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].target, "src/runtime.ts");
  assert.equal(promoted[0].delegatedObservation.planningEvidenceState, "reusable");
  assert.deepEqual(extractSubagentParentRereadObligations(waitResult), []);
});

test("partial path coverage promotes only covered evidence and preserves the unresolved obligation", () => {
  const waitResult = result({
    toolCallId: "wait_incomplete_coverage",
    name: "wait_subagents",
    target: "subagent-a",
    content: JSON.stringify({
      results: [{
        subagentId: "subagent-a",
        scopeKey: "src/main.js,src/components/editor.js",
        status: "degraded",
        closureAudit: {
          schemaVersion: 1,
          owner: {
            agentKind: "subagent",
            threadId: "thread-parent",
            parentTurnId: "turn-parent",
            subagentId: "subagent-a",
            runId: "run-subagent-a",
            parentRunId: "run-parent",
          },
          scopeKey: "src/main.js,src/components/editor.js",
          status: "degraded",
          state: "partial",
          remainingWork: "Read src/components/editor.js",
          observationCount: 1,
          substantiveEvidenceCount: 1,
          acceptedEvidenceToolCallIds: ["child-read-main"],
          requiredPaths: ["src/main.js", "src/components/editor.js"],
          coveredPaths: ["src/main.js"],
          failedPaths: ["src/components/editor.js"],
          uncoveredPaths: ["src/components/editor.js"],
          reasonCode: "incomplete_required_path_coverage",
          reason: "Inconsistent fixture that must be rejected defensively.",
        },
        evidence: [{
          tool: "read_file",
          target: "src/main.js",
          detail: "Observed implementation context.",
          observation: {
            kind: "source",
            sourcePath: "src/main.js",
            contentChars: 32,
            negative: false,
            substantive: true,
          },
          provenance: toolObservationProvenance("child-read-main"),
        }],
      }],
      pendingIds: [],
    }),
  });

  const promoted = extractDelegatedSubagentActivities(waitResult);
  assert.deepEqual(promoted.map((item) => item.target), ["src/main.js"]);
  assert.equal(promoted[0].delegatedObservation.planningEvidenceState, "reusable");
  const obligations = extractSubagentParentRereadObligations(waitResult);
  assert.deepEqual(obligations.map((item) => item.target), ["src/components/editor.js"]);
  assert.equal(obligations[0].delegatedObservation.planningEvidenceState, "unresolved");
});

test("a nominally covered path without substantive evidence becomes an unresolved obligation", () => {
  const waitResult = result({
    toolCallId: "wait_non_substantive_coverage",
    name: "wait_subagents",
    target: "subagent-a",
    content: JSON.stringify({
      results: [{
        subagentId: "subagent-a",
        scopeKey: "src/main.js,src/components/editor.js",
        status: "completed",
        closureAudit: {
          schemaVersion: 1,
          owner: {
            agentKind: "subagent",
            threadId: "thread-parent",
            parentTurnId: "turn-parent",
            subagentId: "subagent-a",
            runId: "run-subagent-a",
            parentRunId: "run-parent",
          },
          scopeKey: "src/main.js,src/components/editor.js",
          status: "completed",
          state: "satisfied",
          remainingWork: null,
          observationCount: 2,
          substantiveEvidenceCount: 1,
          acceptedEvidenceToolCallIds: ["child-read-main"],
          requiredPaths: ["src/main.js", "src/components/editor.js"],
          coveredPaths: ["src/main.js", "src/components/editor.js"],
          failedPaths: [],
          uncoveredPaths: [],
          reasonCode: "runtime_completed",
          reason: "Inconsistent fixture that must be rejected defensively.",
        },
        evidence: [{
          tool: "read_file",
          target: "src/main.js",
          detail: "Observed implementation context.",
          observation: {
            kind: "source",
            sourcePath: "src/main.js",
            contentChars: 32,
            negative: false,
            substantive: true,
          },
          provenance: toolObservationProvenance("child-read-main"),
        }, {
          tool: "get_file_outline",
          target: "src/components/editor.js",
          detail: "(No recognizable symbols found)",
          observation: {
            kind: "structure",
            sourcePath: "src/components/editor.js",
            contentChars: 31,
            negative: true,
            substantive: false,
          },
          provenance: toolObservationProvenance("child-empty-outline"),
        }],
      }],
      pendingIds: [],
    }),
  });

  assert.deepEqual(
    extractDelegatedSubagentActivities(waitResult).map((item) => item.target),
    ["src/main.js"],
  );
  assert.deepEqual(
    extractSubagentParentRereadObligations(waitResult).map((item) => item.target),
    ["src/components/editor.js"],
  );
});

test("tool result post-processing records source-write evidence without clearing recovery before validation", () => {
  const harness = createPostProcessingInput();

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(post.recentSuccessfulProjectWrite?.target, "src/App.tsx");
  assert.equal(post.recoveringFromEmptyAssistantReplyAfterWrite, false);
  assert.ok(harness.executeEvidenceMarks.length >= 1);
  assert.deepEqual(harness.clearRecoveryCalls, []);
  assert.equal(post.remainingTaskText, "Run validation");
  assert.equal(post.nonReadOnlySuccessfulResultCount, 1);
  assert.equal(post.successfulReadOnlyExplorationResultCount, 0);
  assert.equal(post.isUnapprovedPlanReadOnlyBatch, false);
  assert.equal(harness.recentToolActivity.length, 1);
  assert.match(harness.digests[0], /Execution digest: goal=advance implementation and verification/);
  assert.deepEqual(harness.taskPhases.map((item) => item.phase), ["EVIDENCE_RECONCILE"]);
});

test("tool result post-processing tracks plan read-only batches for convergence", () => {
  const harness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    results: [result({
      toolCallId: "read_1",
      name: "read_file",
      target: "src/App.tsx",
      content: "READ_FILE_RESULT path: src/App.tsx",
    })],
    toolArgsByCallId: new Map([["read_1", { path: "src/App.tsx" }]]),
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(post.planDraftingRecoveryReadCount, 1);
  assert.equal(post.successfulReadOnlyExplorationResultCount, 1);
  assert.equal(post.nonReadOnlySuccessfulResultCount, 0);
  assert.equal(post.isUnapprovedPlanReadOnlyBatch, true);
  assert.equal(harness.recentToolActivity.length, 1);
  assert.equal(harness.recentPlanToolActivity.length, 1);
  assert.deepEqual([...harness.taskTargetingEvidence], ["path:src/App.tsx"]);
});

test("tool result post-processing keeps an explicit target read-only until runtime evidence covers it", () => {
  const harness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "explore_structure",
    results: [result({
      toolCallId: "impact_1",
      name: "repo_map_impact",
      target: "src/hooks/useCsvParser.ts",
      content: "normalizeCsvOrder never assigns creatorName although Dashboard consumes that field",
    })],
    toolArgsByCallId: new Map([["impact_1", { path: "src/hooks/useCsvParser.ts" }]]),
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
  harness.input.callbacks = {
    ...harness.input.callbacks,
    getMessages: () => [{
      role: "user",
      content: "Fix creatorName mapping in src/hooks/useCsvParser.ts and prepare a plan.",
    }],
    getCurrentTurnId: () => "turn-plan-1",
    getContextMemoryState: () => null,
  };

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(post.planRuntimePhase, "grounding");
  assert.deepEqual(harness.planRuntimePhases, [{
    phase: "grounding",
    reason: "confirmed_change_rationale_available",
    status: "running",
  }]);
});

test("structural evidence keeps targeted reads open until a diagnosis rationale is confirmed", () => {
  const harness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "explore_structure",
    results: [result({
      toolCallId: "impact_structural",
      name: "repo_map_impact",
      target: "src-tauri/src/main.rs",
      content: "main registers Tauri builder handlers and emits file-open events to the frontend",
    })],
    toolArgsByCallId: new Map([["impact_structural", { path: "src-tauri/src/main.rs" }]]),
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
  harness.input.callbacks = {
    ...harness.input.callbacks,
    getMessages: () => [{
      role: "user",
      content: "Find why opening a Markdown file shows a blank window and prepare a repair plan.",
    }],
    getCurrentTurnId: () => "turn-plan-structural",
    getContextMemoryState: () => null,
  };

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(post.planRuntimePhase, "grounding");
  assert.deepEqual(harness.planRuntimePhases, [{
    phase: "grounding",
    reason: "change_targets_lack_confirmed_rationale",
    status: "running",
  }]);
});

test("targeted evidence recovery still waits for confirmed closure rationale", () => {
  const harness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "deterministic_closure",
    results: [result({
      toolCallId: "impact_recovery_structural",
      name: "repo_map_impact",
      target: "src-tauri/src/main.rs",
      content: "main registers Tauri builder handlers and emits file-open events to the frontend",
    })],
    toolArgsByCallId: new Map([["impact_recovery_structural", { path: "src-tauri/src/main.rs" }]]),
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
  harness.input.callbacks = {
    ...harness.input.callbacks,
    getMessages: () => [{
      role: "user",
      content: "Find why opening a Markdown file shows a blank window and prepare a repair plan.",
    }],
    getCurrentTurnId: () => "turn-plan-targeted-recovery",
    getContextMemoryState: () => null,
  };

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(post.planRuntimePhase, "needs_evidence");
  assert.deepEqual(harness.planRuntimePhases, []);
});

test("deterministic multi-facet recovery does not draft from one confirmed rationale", () => {
  const seededSourceEvidence = [
    {
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      detail: "command_transport_contract(tauri,save_file_content) command_invoke_argument_contract(save_file_content,file_path,content)",
      facts: [
        "command_transport_contract(tauri,save_file_content)",
        "command_invoke_argument_contract(save_file_content,file_path,content)",
      ],
    },
    {
      name: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      detail: "command_handler_argument_contract(save_file_content,content,filePath)",
      facts: ["command_handler_argument_contract(save_file_content,content,filePath)"],
    },
    {
      name: "read_file",
      target: "src/components/editor.js",
      status: "succeeded",
      detail: "event_dom_dispatch_contract(input) field_read_contract(value)",
      facts: ["event_dom_dispatch_contract(input)", "field_read_contract(value)"],
    },
    {
      name: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      detail: "field_read_contract(textContent) field_read_contract(filePath)",
      facts: ["field_read_contract(textContent)", "field_read_contract(filePath)"],
    },
  ];
  const seededPlanEvidence = [];
  for (const [index, entry] of seededSourceEvidence.entries()) {
    rememberToolActivity(seededPlanEvidence, result({
      toolCallId: `seeded-source-${index + 1}`,
      name: "read_file",
      target: entry.target,
      content: entry.detail,
    }), { evidenceLedger: true });
  }
  const harness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "deterministic_closure",
    results: [],
    toolArgsByCallId: new Map(),
    recentPlanToolActivity: seededPlanEvidence,
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
  harness.input.callbacks = {
    ...harness.input.callbacks,
    getMessages: () => [{
      role: "user",
      content: [
        "问题：",
        "1、编辑界面同时显示文件名和未保存文档名。",
        "2、打开本地 Markdown 后意外进入保存流程。",
      ].join("\n"),
    }],
    getCurrentTurnId: () => "turn-plan-partial-multi-facet",
    getContextMemoryState: () => null,
  };

  const bundle = buildPlanEvidenceBundle({
    objective: harness.input.callbacks.getMessages()[0].content,
    evidenceRecords: seededPlanEvidence.map((entry) => ({
      tool: entry.name,
      target: entry.target,
      status: entry.status,
      summary: entry.detail,
      facts: entry.facts,
      structuredFacts: entry.structuredFacts,
    })),
  });
  assert.equal(assessPlanClosureEvidence(bundle).ready, true, "the rationale gate alone is satisfied");

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(post.planRuntimePhase, "needs_evidence");
  assert.deepEqual(harness.planRuntimePhases, []);
});

test("Plan readiness telemetry projects the deterministic materialization contract", () => {
  const postProcessingSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultPostProcessing.ts"),
    "utf8",
  );
  const streamPreparationSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"),
    "utf8",
  );
  const runtimeOrchestratorSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator.ts"),
    "utf8",
  );

  assert.match(postProcessingSource, /closureReady: deterministicMaterializationReady/);
  assert.match(postProcessingSource, /rationaleReady: closureAssessment\.ready/);
  assert.doesNotMatch(postProcessingSource, /deterministicMaterializationReady:\s*closureAssessment\.ready/);
  assert.match(streamPreparationSource, /ready: deterministicMaterializationReady/);
  assert.match(streamPreparationSource, /closureReady: deterministicMaterializationReady/);
  assert.match(streamPreparationSource, /rationaleReady: closureAssessment\.ready/);
  assert.match(runtimeOrchestratorSource, /closureReady: hasDeterministicEvidence/);
  assert.match(runtimeOrchestratorSource, /deterministicMaterializationReady: hasDeterministicEvidence/);
});

test("model-draft evidence recovery also waits for confirmed closure rationale", () => {
  const harness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "needs_evidence",
    planEvidenceRecoveryObjective: "model_draft",
    results: [result({
      toolCallId: "impact_model_draft_recovery",
      name: "repo_map_impact",
      target: "src-tauri/src/main.rs",
      content: "main registers Tauri builder handlers and emits file-open events to the frontend",
    })],
    toolArgsByCallId: new Map([["impact_model_draft_recovery", { path: "src-tauri/src/main.rs" }]]),
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
  harness.input.callbacks = {
    ...harness.input.callbacks,
    getMessages: () => [{
      role: "user",
      content: "Find why opening a Markdown file shows a blank window and prepare a repair plan.",
    }],
    getCurrentTurnId: () => "turn-plan-model-draft-recovery",
    getContextMemoryState: () => null,
  };

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(post.planRuntimePhase, "needs_evidence");
  assert.equal(post.planEvidenceRecoveryObjective, "model_draft");
  assert.deepEqual(harness.planRuntimePhases, []);
});

test("a targeted read leaves structure exploration even before semantic evidence is ready", () => {
  const harness = createPostProcessingInput({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    planRuntimePhase: "explore_structure",
    results: [result({
      toolCallId: "read_weak",
      name: "read_file",
      target: "src/App.tsx",
      content: "READ_FILE_RESULT path: src/App.tsx",
    })],
    toolArgsByCallId: new Map([["read_weak", { path: "src/App.tsx" }]]),
    recentSuccessfulProjectWrite: null,
    recoveringFromEmptyAssistantReplyAfterWrite: false,
  });
  harness.input.callbacks = {
    ...harness.input.callbacks,
    getMessages: () => [{ role: "user", content: "Prepare a focused plan." }],
    getCurrentTurnId: () => "turn-plan-weak",
    getContextMemoryState: () => null,
  };

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(post.planRuntimePhase, "grounding");
  assert.deepEqual(harness.planRuntimePhases, [{
    phase: "grounding",
    reason: "targeted evidence read completed",
    status: "running",
  }]);
});

test("failed command validation does not become execution evidence or clear recovery", () => {
  const harness = createPostProcessingInput({
    results: [result({
      toolCallId: "run_1",
      name: "run_command",
      target: "npm test",
      content: JSON.stringify({ exitCode: 1, stderr: "tests failed" }),
      isError: false,
    })],
    toolArgsByCallId: new Map([["run_1", { command: "npm test" }]]),
    recentSuccessfulProjectWrite: {
      name: "replace_in_file",
      target: "src/App.tsx",
    },
    recoveringFromEmptyAssistantReplyAfterWrite: true,
  });

  const post = handleToolResultPostProcessing(harness.input);

  assert.equal(harness.executeEvidenceMarks.length, 0);
  assert.equal(post.nonReadOnlySuccessfulResultCount, 0);
  assert.deepEqual(post.recentSuccessfulProjectWrite, {
    name: "replace_in_file",
    target: "src/App.tsx",
  });
  assert.equal(post.recoveringFromEmptyAssistantReplyAfterWrite, true);
  assert.equal(harness.clearRecoveryCalls.length, 0);
  assert.equal(harness.taskPhases[0].extra.successfulResults, 0);
  assert.equal(harness.taskPhases[0].extra.failedResults, 1);
});

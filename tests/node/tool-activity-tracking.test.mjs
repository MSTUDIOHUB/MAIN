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
  buildBrowserValidationCacheSignature,
  buildBrowserValidationFailureContent,
  isBrowserValidationResultCacheable,
  parseBrowserValidationOutcome,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/browserValidation.ts"));

function result(overrides) {
  return {
    toolCallId: "call_1",
    name: "replace_in_file",
    target: "src/App.tsx",
    content: "patched file",
    isError: false,
    ...overrides,
  };
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
    planRuntimePhase: "drafting",
    planEvidenceRecoveryObjective: "none",
    planDraftingRecoveryReadCount: 0,
    hasPlanDecisionOutput: false,
    unityConsoleDiagnosticsRequested: false,
    unityConsoleFinalVerificationRequired: false,
    unityConsoleRefreshObservedAfterWrite: false,
    unityMcpForceConsoleFirstPending: false,
    unityConsoleMissingFirstToolRepromptIssued: false,
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
    failureReasons: ["runtime_error"],
    failureSummary: "runtime_error: net::ERR_CONNECTION_REFUSED",
  })), false);
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

test("tool result post-processing freezes a semantic evidence bundle before repeat guards", () => {
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

  assert.equal(post.planRuntimePhase, "drafting");
  assert.deepEqual(harness.planRuntimePhases, [{
    phase: "drafting",
    reason: "plan closure evidence ready",
    status: "running",
  }]);
});

test("structural evidence can enter model-authored drafting without enabling deterministic materialization", () => {
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

  assert.equal(post.planRuntimePhase, "drafting");
  assert.deepEqual(harness.planRuntimePhases, [{
    phase: "drafting",
    reason: "model-authored plan evidence ready",
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

test("model-draft evidence recovery accepts the same structural bundle threshold", () => {
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

  assert.equal(post.planRuntimePhase, "drafting");
  assert.equal(post.planEvidenceRecoveryObjective, "model_draft");
  assert.deepEqual(harness.planRuntimePhases, [{
    phase: "drafting",
    reason: "model-authored plan evidence ready",
    status: "running",
  }]);
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

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

const runtimeTools = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/runtimeTools.ts"));
const turnEvents = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnEvents.ts"));
const toolFeedbackEnvelope = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolFeedbackEnvelope.ts"));

const {
  planRuntimeToolCall,
  initialLifecycleStateForPlanAction,
} = runtimeTools;
const {
  MAIN_THREAD_EVENT_SCHEMA_VERSION,
  withEventSchema,
  appendRuntimeEvent,
  isTerminalTurnEvent,
} = turnEvents;
const {
  TOOL_FEEDBACK_ENVELOPE_PREFIX,
  formatToolFeedbackEnvelope,
  parseToolFeedbackEnvelope,
} = toolFeedbackEnvelope;

const defaultToolPolicy = {
  autoExecuteRiskLevels: ["read_only", "external_read"],
  approvalRequiredRiskLevels: [
    "local_file_read",
    "workspace_write",
    "shell",
    "external_write",
    "browser_control",
    "destructive",
  ],
  disabledRiskLevels: [],
};

function createPlanInput(overrides = {}) {
  return {
    toolCall: { id: "call-default", name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx" }) },
    workspace: "/Users/michael/Documents/GitHub/MAIN",
    availableToolNames: new Set(["read_file", "write_file"]),
    capabilityRegistry: { tools: {}, policy: defaultToolPolicy },
    toolPermissionPolicy: defaultToolPolicy,
    approvedLocalFileReadPaths: [],
    workflowMode: "edit",
    runtimeIntent: "execute",
    isPlanApproved: false,
    planTaskCount: 0,
    getToolTarget: (_name, args) => String(args.path || args.command || ""),
    isPreApprovalPlanDraftWrite: (name, args) =>
      name === "write_file" && String(args.path || "").replace(/\\/g, "/").toLowerCase().includes(".main/plans/plan.md"),
    isExecutionPlanArtifactWrite: (name, args) =>
      name === "write_file" && String(args.path || "").replace(/\\/g, "/").toLowerCase().includes(".main/plans/tasks.md"),
    isTasksPlanWrite: (name, args) =>
      name === "write_file" && String(args.path || "").replace(/\\/g, "/").toLowerCase().endsWith("/tasks.md"),
    ...overrides,
  };
}

test("runtime tool planner classifies lifecycle actions and initial states", () => {
  const blockedUnavailable = planRuntimeToolCall(createPlanInput({
    toolCall: { id: "a", name: "write_file", arguments: JSON.stringify({ path: "src/a.ts", content: "x" }) },
    availableToolNames: new Set(["read_file"]),
  }));
  assert.equal(blockedUnavailable.action, "blocked_unavailable");
  assert.equal(initialLifecycleStateForPlanAction(blockedUnavailable.action), "blocked");

  const localReadNeedsReview = planRuntimeToolCall(createPlanInput({
    toolCall: { id: "b", name: "read_file", arguments: JSON.stringify({ path: "/tmp/outside.txt" }) },
  }));
  assert.equal(localReadNeedsReview.action, "local_file_read_review");
  assert.equal(localReadNeedsReview.localFileReadPath, "/tmp/outside.txt");
  assert.equal(initialLifecycleStateForPlanAction(localReadNeedsReview.action), "awaiting_review");

  const autoRead = planRuntimeToolCall(createPlanInput({
    toolCall: { id: "c", name: "read_file", arguments: JSON.stringify({ path: "src/main.ts" }) },
  }));
  assert.equal(autoRead.action, "auto_execute");
  assert.equal(initialLifecycleStateForPlanAction(autoRead.action), "queued");

  const specAutoApproved = planRuntimeToolCall(createPlanInput({
    toolCall: { id: "d", name: "write_file", arguments: JSON.stringify({ path: ".MAIN/plans/plan.md", content: "# design" }) },
    workflowMode: "plan",
    runtimeIntent: "plan",
    isPlanApproved: false,
  }));
  assert.equal(specAutoApproved.action, "spec_file_auto_approved");
  assert.equal(initialLifecycleStateForPlanAction(specAutoApproved.action), "queued");

  const blockedPlanGate = planRuntimeToolCall(createPlanInput({
    toolCall: { id: "e", name: "write_file", arguments: JSON.stringify({ path: "src/core.ts", content: "x" }) },
    workflowMode: "plan",
    runtimeIntent: "plan",
    isPlanApproved: false,
  }));
  assert.equal(blockedPlanGate.action, "blocked_plan_gate");
  assert.equal(blockedPlanGate.reason, "pre_approval_source_write");
  assert.equal(initialLifecycleStateForPlanAction(blockedPlanGate.action), "blocked");

  const reviewRequired = planRuntimeToolCall(createPlanInput({
    toolCall: { id: "f", name: "write_file", arguments: JSON.stringify({ path: "src/core.ts", content: "x" }) },
    workflowMode: "edit",
    runtimeIntent: "execute",
  }));
  assert.equal(reviewRequired.action, "review_required");
  assert.equal(initialLifecycleStateForPlanAction(reviewRequired.action), "awaiting_review");
});

test("approved plan execution blocks shell and source writes until runtime tasks exist", () => {
  const base = {
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    planTaskCount: 0,
    availableToolNames: new Set(["read_file", "write_file", "run_command"]),
  };

  const shellBlocked = planRuntimeToolCall(createPlanInput({
    ...base,
    toolCall: {
      id: "shell-before-tasks",
      name: "run_command",
      arguments: JSON.stringify({ command: "npm create vite@latest . -- --template react-ts", cwd: "." }),
    },
  }));
  assert.equal(shellBlocked.action, "blocked_plan_gate");
  assert.equal(shellBlocked.reason, "missing_tasks_before_source");

  const sourceBlocked = planRuntimeToolCall(createPlanInput({
    ...base,
    toolCall: {
      id: "source-before-tasks",
      name: "write_file",
      arguments: JSON.stringify({ path: "src/main.ts", content: "export {};" }),
    },
  }));
  assert.equal(sourceBlocked.action, "blocked_plan_gate");
  assert.equal(sourceBlocked.reason, "missing_tasks_before_source");

  const sourceReadBlocked = planRuntimeToolCall(createPlanInput({
    ...base,
    toolCall: {
      id: "source-read-before-tasks",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/main.ts" }),
    },
  }));
  assert.equal(sourceReadBlocked.action, "blocked_plan_gate");
  assert.equal(sourceReadBlocked.reason, "missing_tasks_before_source");

  const planReadAllowed = planRuntimeToolCall(createPlanInput({
    ...base,
    toolCall: {
      id: "plan-read-before-tasks",
      name: "read_file",
      arguments: JSON.stringify({ path: ".MAIN/plans/plan.md" }),
    },
  }));
  assert.equal(planReadAllowed.action, "auto_execute");

  const tasksAllowed = planRuntimeToolCall(createPlanInput({
    ...base,
    toolCall: {
      id: "tasks-before-source",
      name: "write_file",
      arguments: JSON.stringify({ path: ".MAIN/plans/tasks.md", content: "- [ ] Implement [evidence: pending]" }),
    },
  }));
  assert.equal(tasksAllowed.action, "spec_file_auto_approved");
});

test("approved plan execution allows source work when runtime tasks exist", () => {
  const base = {
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    planTaskCount: 2,
    availableToolNames: new Set(["read_file", "write_file", "run_command"]),
  };

  const sourceWrite = planRuntimeToolCall(createPlanInput({
    ...base,
    toolCall: {
      id: "source-with-runtime-tasks",
      name: "write_file",
      arguments: JSON.stringify({ path: "src/main.ts", content: "export {};" }),
    },
  }));
  assert.equal(sourceWrite.action, "review_required");

  const shellRun = planRuntimeToolCall(createPlanInput({
    ...base,
    toolCall: {
      id: "shell-with-runtime-tasks",
      name: "run_command",
      arguments: JSON.stringify({ command: "npm test", cwd: "." }),
    },
  }));
  assert.equal(shellRun.action, "review_required");
});

test("approved plan execution can route browser validation tools when runtime tasks exist", () => {
  const browserRun = planRuntimeToolCall(createPlanInput({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    planTaskCount: 2,
    availableToolNames: new Set(["read_file", "browser_evaluate"]),
    capabilityRegistry: {
      tools: {
        browser_evaluate: {
          name: "browser_evaluate",
          source: "built_in",
          risk: "browser_control",
          autoExecutable: false,
          enabled: true,
        },
      },
      policy: defaultToolPolicy,
    },
    toolCall: {
      id: "browser-with-runtime-tasks",
      name: "browser_evaluate",
      arguments: JSON.stringify({ url: "http://localhost:5173", checks: "selector: #root" }),
    },
    getToolTarget: (_name, args) => String(args.url || ""),
  }));

  assert.equal(browserRun.action, "review_required");
  assert.equal(browserRun.target, "http://localhost:5173");
});

test("thread event helpers stamp schema, detect terminal events, and keep ring buffer", () => {
  const started = withEventSchema({
    type: "turn.started",
    threadId: "thread-1",
    turnId: "turn-1",
    timestampMs: 1,
  });
  assert.equal(started.schemaVersion, MAIN_THREAD_EVENT_SCHEMA_VERSION);
  assert.equal(isTerminalTurnEvent(started), false);

  const completed = withEventSchema({
    type: "turn.completed",
    threadId: "thread-1",
    turnId: "turn-1",
    timestampMs: 2,
  });
  assert.equal(isTerminalTurnEvent(completed), true);

  const failed = withEventSchema({
    type: "turn.failed",
    threadId: "thread-1",
    turnId: "turn-2",
    timestampMs: 3,
    error: { message: "boom" },
  });
  assert.equal(isTerminalTurnEvent(failed), true);

  const buffered = appendRuntimeEvent(
    appendRuntimeEvent(
      appendRuntimeEvent([], started, 2),
      completed,
      2,
    ),
    failed,
    2,
  );
  assert.equal(buffered.length, 2);
  assert.deepEqual(
    buffered.map((event) => event.type),
    ["turn.completed", "turn.failed"],
  );

  const slash = withEventSchema({
    type: "slash.command.started",
    threadId: "thread-1",
    turnId: "turn-1",
    timestampMs: 4,
    command: "/help",
    executionMode: "local_fast",
  });
  assert.equal(slash.type, "slash.command.started");

  const alias = withEventSchema({
    type: "path_alias_hit",
    threadId: "thread-1",
    turnId: "turn-1",
    timestampMs: 5,
    tool: "read_file",
    field: "path",
    from: ".claude/docs/workflow-catalog.yaml",
    to: ".protocols/game-studio/docs/workflow-catalog.yaml",
    rule: "docs",
  });
  assert.equal(alias.type, "path_alias_hit");
});

test("tool feedback envelope v1 supports parse/format roundtrip", () => {
  const formatted = formatToolFeedbackEnvelope({
    status: "cached",
    toolCallId: "call-123",
    tool: "read_file",
    target: "src/App.tsx",
    content: "FILE_UNCHANGED_STUB: reuse prior read",
    summary: "Reused cached read result.",
    hints: ["Open another file range if needed."],
  });
  assert.match(formatted, new RegExp(`^\\${TOOL_FEEDBACK_ENVELOPE_PREFIX}`));

  const parsed = parseToolFeedbackEnvelope(formatted);
  assert.ok(parsed);
  assert.equal(parsed.envelope.version, 1);
  assert.equal(parsed.envelope.status, "cached");
  assert.equal(parsed.envelope.tool_call_id, "call-123");
  assert.equal(parsed.envelope.tool, "read_file");
  assert.equal(parsed.envelope.target, "src/App.tsx");
  assert.equal(parsed.body, "FILE_UNCHANGED_STUB: reuse prior read");

  assert.equal(parseToolFeedbackEnvelope("plain-text"), null);
});

test("tool feedback envelope v1 supports no_effect_mutation status", () => {
  const formatted = formatToolFeedbackEnvelope({
    status: "no_effect_mutation",
    toolCallId: "call-999",
    tool: "apply_text_edits",
    target: "Assets/Scripts/Player.cs",
    content: "NO_EFFECT_MUTATION: apply_text_edits reported success but no file change.",
  });
  const parsed = parseToolFeedbackEnvelope(formatted);
  assert.ok(parsed);
  assert.equal(parsed.envelope.status, "no_effect_mutation");
});

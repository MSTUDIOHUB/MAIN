import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isFinitePlanValidationCommand,
} from "../../src/lib/workflowModels";
import { isWorkspaceMutationToolName } from "../../src/lib/workspaceMutationTools";
import {
  validateWorkPlanDraftV1,
} from "../../src/lib/runtime-v2";
import {
  validateSealedWorkPlanV1Integrity,
} from "../../src/store/runtimeV2/workPlanAdapter";
import {
  hashPlanCandidate,
  PLAN_CANDIDATE_SCHEMA_VERSION,
  validateSealedPlanCandidate,
} from "../../src/lib/planContract";
import { PLAN_AUTHORING_CONTRACT_VERSION } from "../../src/lib/planAuthoringContract";
import { isAcceptanceCapableValidationSpec } from "../../src/lib/validationContract";
import {
  collectBoundedRealOmlxWorkspaceFiles,
  createRealOmlxAcceptanceState,
  readBoundedRealOmlxWorkspaceTextFile,
  readBoundedRealOmlxWorkspaceTextFiles,
  readRealOmlxWorkspaceFileWindow,
  recordRealOmlxAcceptanceDebugEvent,
  REAL_OMLX_WORKSPACE_PROXY_LIMITS,
  runRealOmlxWorkspaceCommand,
  selectBoundedRealOmlxSearchFiles,
  shouldPruneRealOmlxWorkspaceDirectory,
  type RealOmlxWorkspaceInventory,
} from "./realOmlxWorkspaceProxy";
import {
  getMdViewerExecutionGaps,
  getMdViewerFinalSummaryGaps,
  getNewUndeclaredCallGaps,
  getMdViewerWorkPlanGaps,
} from "./realOmlxMdViewerPlanOracle";
import { expectRuntimeV2ReadOnlyCollaboration } from "./runtimeV2StructuralAssertions";

const runRealOmlx = process.env.MAIN_REAL_OMLX_E2E === "1";
const omlxEndpoint = String(
  process.env.OMLX_ENDPOINT || process.env.OMLX_BASE_URL || "http://127.0.0.1:8000/v1",
).replace(/\/+$/, "");
const omlxApiKey = String(process.env.OMLX_API_KEY || "mmnn");
const models = (process.env.OMLX_MODELS || (runRealOmlx ? "" : "e2e-placeholder-model"))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
if (runRealOmlx && models.length !== 1) {
  throw new Error(
    `Real OMLX validation requires exactly one explicit OMLX_MODELS id; received ${models.length}.`,
  );
}
const realOmlxFixture = String(
  process.env.REAL_OMLX_FIXTURE || "csv",
).trim().toLowerCase();
const realOmlxRequest =
  process.env.REAL_OMLX_REQUEST ||
  (
    realOmlxFixture === "md-viewer"
      ? "问题：1、在编辑界面显示了文件名和未保存的文档名字，这是不合理的。2、打开本地 md 文件后随后会弹出窗口，看起来是文件保存执行路径有关的问题。找到这些问题的根本原因并修复。"
      : "请修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。先生成可审批计划，批准后真实修改并验证。"
  );
const realOmlxPlanOnly = process.env.REAL_OMLX_PLAN_ONLY === "1";
const realOmlxPreferSubagents = process.env.REAL_OMLX_PREFER_SUBAGENTS === "1";
const realOmlxImagePath = String(process.env.REAL_OMLX_IMAGE_PATH || "").trim();
const runDirectEditRecovery = process.env.REAL_OMLX_DIRECT_EDIT_RECOVERY === "1";
const runExecuteIncidentReplay = process.env.REAL_OMLX_EXECUTE_INCIDENT === "1";
const realOmlxMutationFile = String(
  process.env.REAL_OMLX_MUTATION_FILE ||
  (realOmlxFixture === "md-viewer" ? "src/main.js" : "src/hooks/useCsvParser.ts"),
).replace(/^[/\\]+/, "");
const realOmlxMutationExpectation = new RegExp(
  process.env.REAL_OMLX_MUTATION_EXPECT ||
  (realOmlxFixture === "md-viewer" ? "btn-new" : "creatorName\\s*:"),
  "i",
);
const realOmlxDevServerUrl = String(
  process.env.REAL_OMLX_DEV_SERVER_URL ||
  (realOmlxFixture === "md-viewer" ? "http://localhost:1420/" : "http://localhost:5173/"),
);
const realOmlxPlanExpectation = new RegExp(
  process.env.REAL_OMLX_PLAN_EXPECT || (
    realOmlxFixture === "md-viewer"
      ? "src/main\\.js|未保存|保存|打开"
      : "useCsvParser\\.ts|CSV|creator"
  ),
  "i",
);
const realOmlxPlanExpectAll = String(process.env.REAL_OMLX_PLAN_EXPECT_ALL || "")
  .split(";;")
  .map((pattern) => pattern.trim())
  .filter(Boolean)
  .map((pattern) => new RegExp(pattern, "i"));
const realOmlxPlanEvidenceTargets = String(
  process.env.REAL_OMLX_PLAN_EVIDENCE_TARGETS || (
    realOmlxFixture === "csv" ? "src/hooks/useCsvParser.ts" : ""
  ),
).split(";;").map((target) => target.trim()).filter(Boolean);
const requireSemanticTaskQuality =
  process.env.REAL_OMLX_REQUIRE_TASK_QUALITY === "1";
if (
  runRealOmlx &&
  realOmlxFixture === "md-viewer" &&
  !String(process.env.REAL_OMLX_WORKSPACE || "").trim()
) {
  throw new Error(
    "The md-viewer real-model fixture requires a caller-prepared REAL_OMLX_WORKSPACE copy.",
  );
}
if (
  runRealOmlx &&
  requireSemanticTaskQuality &&
  realOmlxPlanEvidenceTargets.length === 0
) {
  throw new Error(
    "Task-quality validation requires explicit REAL_OMLX_PLAN_EVIDENCE_TARGETS for non-default fixtures.",
  );
}
const realOmlxPlanTimeoutMs = Math.max(
  30_000,
  Number(process.env.REAL_OMLX_PLAN_TIMEOUT_MS || 600_000),
);
const realOmlxExecutionTimeoutMs = Math.max(
  30_000,
  // Runtime v2 owns a 12-minute lifecycle deadline. The outer replay must
  // outlive that boundary so it observes the canonical partial/success
  // terminal instead of killing the page while the Run still says "running".
  Number(process.env.REAL_OMLX_EXECUTION_TIMEOUT_MS || 780_000),
);
const expectAgentExplanation = process.env.REAL_OMLX_EXPECT_AGENT_TEXT === "1";
const forbiddenChatNoise = /<tool_use>|<user_options>|\[PROPOSAL START\]|append_debug_log|ContextMemoryState|MAIN TOOL FEEDBACK|^\s*कल\s*$/m;
const completedTurnStatuses = new Set([
  "done",
  "completed",
  "completed_with_changes",
]);
const reviewablePlanStages = new Set(["plan", "design", "bugfix", "ready_to_execute"]);
const isMdViewerSavePathIncident =
  realOmlxFixture === "md-viewer" &&
  /(?:未保存|保存路径|打开本地|save\s*path|unsaved)/i.test(realOmlxRequest);
if (
  runRealOmlx &&
  runExecuteIncidentReplay &&
  realOmlxFixture === "md-viewer" &&
  !isMdViewerSavePathIncident
) {
  throw new Error(
    "The MD Viewer Execute incident lane requires an MD Viewer save/open request; fixture and objective are inconsistent.",
  );
}

const useSemanticMdViewerMutationOracle =
  realOmlxFixture === "md-viewer" &&
  process.env.REAL_OMLX_MUTATION_ORACLE !== "exact";
const realOmlxMutationOracleFiles = useSemanticMdViewerMutationOracle
  ? [
      "src/main.js",
      "src/components/editor.js",
      "src/components/statusbar.js",
      "src/components/toolbar.js",
      "src-tauri/src/main.rs",
    ]
  : [realOmlxMutationFile];

type FixtureMutationState = {
  satisfied: boolean;
  changedFiles: string[];
  contents: Record<string, string>;
  detail: string;
};

function runtimeV2FailureDiagnostic(runtimeV2: any) {
  const diagnosticDebug = (runtimeV2?.debug || []).filter((entry: any) =>
    /(?:tool_execution_(?:failed|blocked|rejected)|recovery|phase_transition|plan_source_freshness|execute_terminal|provider_transport_failed)/i
      .test(String(entry?.source || ""))
  ).slice(-80);
  return {
    debug: diagnosticDebug,
    strategy: runtimeV2?.strategy || null,
    phase: runtimeV2?.phase || null,
    terminalOutcome: runtimeV2?.terminalOutcome || null,
    terminal: runtimeV2?.terminal || null,
    workPlan: runtimeV2?.workPlan || null,
    events: runtimeV2?.events || [],
    evidence: runtimeV2?.evidence || [],
    receipts: runtimeV2?.receipts || [],
    commands: runtimeV2?.commands || [],
    subagents: runtimeV2?.subagents || [],
    subagentConcurrency: runtimeV2?.subagentConcurrency || null,
  };
}

async function readFixtureMutationContents(workspace: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(realOmlxMutationOracleFiles.map(async (relativePath) => [
    relativePath,
    await fs.readFile(path.join(workspace, relativePath), "utf8"),
  ])));
}

const PLAN_ONLY_FINGERPRINT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".MAIN",
  "node_modules",
  "target",
  "dist",
  "build",
]);

async function fingerprintPlanOnlyWorkspace(workspace: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && PLAN_ONLY_FINGERPRINT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(workspace, absolutePath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(await fs.readFile(absolutePath));
        hash.update("\0");
      }
    }
  };
  await visit(workspace);
  return hash.digest("hex");
}

async function loadRealOmlxReplayImages(): Promise<string[]> {
  if (!realOmlxImagePath) return [];
  const extension = path.extname(realOmlxImagePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".gif"
      ? "image/gif"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
  const body = await fs.readFile(realOmlxImagePath);
  return [`data:${mime};base64,${body.toString("base64")}`];
}

async function inspectFixtureMutation(
  workspace: string,
  baseline?: Record<string, string>,
): Promise<FixtureMutationState> {
  const contents = await readFixtureMutationContents(workspace);
  const changedFiles = baseline
    ? realOmlxMutationOracleFiles.filter((relativePath) => contents[relativePath] !== baseline[relativePath])
    : [];
  const executionGaps = useSemanticMdViewerMutationOracle
    ? getMdViewerExecutionGaps({
        caller: contents["src/main.js"] || "",
        editor: contents["src/components/editor.js"] || "",
        handler: contents["src-tauri/src/main.rs"] || "",
        toolbar: contents["src/components/toolbar.js"] || "",
      })
    : [];
  if (useSemanticMdViewerMutationOracle && baseline) {
    const allowedMutationFiles = new Set([
      "src/main.js",
      "src/components/editor.js",
    ]);
    for (const relativePath of allowedMutationFiles) {
      executionGaps.push(...getNewUndeclaredCallGaps({
        path: relativePath,
        before: baseline[relativePath] || "",
        after: contents[relativePath] || "",
      }));
    }
    for (const relativePath of changedFiles) {
      if (allowedMutationFiles.has(relativePath)) continue;
      executionGaps.push(
        `${relativePath}:1:1 - this file is not a root-cause owner for the verified incident; restore its pre-run content and leave it unchanged`,
      );
    }
  }
  const satisfied = useSemanticMdViewerMutationOracle
    ? executionGaps.length === 0
    : realOmlxMutationExpectation.test(contents[realOmlxMutationFile] || "");
  return {
    satisfied,
    changedFiles,
    contents,
    detail: useSemanticMdViewerMutationOracle
      ? executionGaps.length === 0
        ? "the pristine initial tab is replaced on open, programmatic loading stays clean, and save_file_content uses the active filePath"
        : executionGaps.join("\n")
      : `${realOmlxMutationFile} matches ${realOmlxMutationExpectation.source}`,
  };
}

type RealOmlxActionRequest = {
  kind?: string;
  requestId?: string;
  toolName?: string;
  target?: string;
  risk?: string;
};

function isPathInsideWorkspace(candidate: string, workspace: string): boolean {
  const relative = path.relative(path.resolve(workspace), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isInScopeBrowserPermission(
  request: RealOmlxActionRequest | null | undefined,
  workspace: string,
): boolean {
  if (
    request?.kind !== "tool_permission" ||
    request.toolName !== "browser_evaluate" ||
    !request.requestId ||
    !request.target
  ) {
    return false;
  }
  try {
    const targetUrl = new URL(request.target);
    if (targetUrl.origin === new URL(realOmlxDevServerUrl).origin) return true;
    return targetUrl.protocol === "file:" && isPathInsideWorkspace(fileURLToPath(targetUrl), workspace);
  } catch {
    return false;
  }
}

async function approveInScopeBrowserPermission(
  page: Page,
  request: RealOmlxActionRequest | null | undefined,
  workspace: string,
): Promise<boolean> {
  if (!isInScopeBrowserPermission(request, workspace)) return false;
  return await page.evaluate((expectedRequestId) => {
    const bridge = (window as any).__CODELY_E2E__;
    const current = bridge?.getSnapshot?.().activeActionRequest;
    if (
      current?.kind !== "tool_permission" ||
      current.requestId !== expectedRequestId ||
      current.toolName !== "browser_evaluate"
    ) {
      return false;
    }
    bridge?.approvePendingTool?.();
    return true;
  }, request?.requestId);
}

function summarizePlanDebugTail(entries: unknown[]): string[] {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return String(entry || "");
      const record = entry as Record<string, unknown>;
      const source = String(record.source || record.target || "");
      if (!/(?:^agent\.(?:plan_|loop_stop$|agent_loop_)|^store\.(?:runtime_v2_|non_actionable_stop|agent_loop_stop_summary|agent_loop_crashed|parent_subagents_finalized|terminal_|workflow_|harness_close_|stale_run_error_)|^app\.instance\.closed$|stream_(?:error|timeout|watchdog))/i.test(source)) {
        return "";
      }
      return [record.level, source, record.message]
        .filter((value) => value != null && String(value).trim())
        .map(String)
        .join(" ");
    })
    .filter(Boolean)
    .slice(-12)
    .map((line) => line.slice(0, 1_200));
}

function summarizeSubagentPlanFailureDebug(entries: unknown[]): unknown[] {
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const source = String(record.source || record.target || "");
    if (!/(?:plan_|subagent_evidence|parent_(?:wait|resume|join)|tool_surface|loop_stop|non_actionable)/i.test(source)) {
      return [];
    }
    let message: unknown = record.message;
    if (typeof message === "string") {
      try {
        message = JSON.parse(message);
      } catch {
        message = message.slice(0, 2_400);
      }
    }
    return [{ source, level: record.level, message }];
  }).slice(-80);
}

function summarizeTaskFlowForFailure(entries: unknown[]): unknown[] {
  return (Array.isArray(entries) ? entries : []).slice(-50).map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return {
      type: record.type,
      toolName: record.toolName,
      target: record.target,
      status: record.status,
      content: String(record.content || "").slice(0, 800),
    };
  });
}

type StructuredDebugEntry = Record<string, unknown> & { source: string };

function parseStructuredDebugEntries(entries: unknown[]): StructuredDebugEntry[] {
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    let payload: Record<string, unknown> = {};
    if (record.message && typeof record.message === "object") {
      payload = record.message as Record<string, unknown>;
    } else if (typeof record.message === "string") {
      try {
        const parsed = JSON.parse(record.message);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // Human-readable debug text is intentionally excluded from assertions.
      }
    }
    return [{ ...payload, source: String(record.source || "") }];
  });
}

function expectCanonicalRuntimeV2Terminal(
  snapshot: any,
  expected: {
    turnId: string;
    resultKind: "success" | "partial" | "blocked" | "error" | "canceled";
    strategy?: "execute" | "plan";
  },
): any {
  const runtime = snapshot?.runtimeV2;
  expect(runtime, "The turn must expose its durable Runtime v2 checkpoint.").not.toBeNull();
  expect(runtime?.schemaVersion).toBe("turn-aggregate.v1");
  expect(runtime?.strategy).toBe(expected.strategy || "execute");
  expect(runtime?.turnId).toBe(expected.turnId);
  expect(runtime?.turnIdentity?.turnId).toBe(expected.turnId);
  expect(runtime?.runIdentity?.turnId).toBe(expected.turnId);
  expect(String(runtime?.runId || "")).not.toBe("");
  expect(runtime?.phase).toBe("completed");
  expect(runtime?.terminalOutcome?.resultKind).toBe(expected.resultKind);
  expect(runtime?.terminal).toMatchObject({
    runCompletedCount: 1,
    turnCompletedCount: 1,
    finalProjectionCount: 1,
    runResultKind: expected.resultKind,
    turnResultKind: expected.resultKind,
    exactlyOnce: true,
  });

  const events = Array.isArray(runtime?.events) ? runtime.events : [];
  const sequences = events.map((event: { sequence?: number }) => Number(event.sequence));
  expect(sequences.length).toBeGreaterThan(0);
  expect(sequences.every(Number.isFinite)).toBe(true);
  for (let index = 1; index < sequences.length; index += 1) {
    expect(sequences[index]).toBe(sequences[index - 1] + 1);
  }
  expect(new Set(events.map((event: { eventId?: string }) => event.eventId)).size)
    .toBe(events.length);
  expect(events[0]?.type).toBe("turn.admitted");
  expect(events.filter((event: { type?: string }) => event.type === "run.started"))
    .toHaveLength(1);
  expect(events.filter((event: { type?: string }) => event.type === "run.completed"))
    .toHaveLength(1);
  expect(events.filter((event: { type?: string }) => event.type === "turn.completed"))
    .toHaveLength(1);

  const commands = Array.isArray(runtime?.commands) ? runtime.commands : [];
  const receipts = Array.isArray(runtime?.receipts) ? runtime.receipts : [];
  expect(commands.length).toBeGreaterThan(0);
  expect(new Set(commands.map((command: { idempotencyKey?: string }) =>
    command.idempotencyKey
  )).size).toBe(commands.length);
  expect(new Set(receipts.map((receipt: { idempotencyKey?: string }) =>
    receipt.idempotencyKey
  )).size).toBe(receipts.length);
  expect(commands.map((command: { idempotencyKey?: string }) => command.idempotencyKey).sort())
    .toEqual(receipts.map((receipt: { idempotencyKey?: string }) => receipt.idempotencyKey).sort());
  expect(commands.every((command: { status?: string; completedAt?: number }) =>
    ["succeeded", "failed", "canceled"].includes(String(command.status || "")) &&
    Number.isFinite(command.completedAt)
  )).toBe(true);
  expect(commands.every((command: { turnId?: string; runId?: string }) =>
    command.turnId === expected.turnId && command.runId === runtime.runId
  )).toBe(true);

  const projections = Array.isArray(runtime?.projections) ? runtime.projections : [];
  const finalProjection = projections.filter(
    (projection: { audience?: string; kind?: string }) =>
      projection.audience === "final" && projection.kind === "final",
  );
  expect(finalProjection).toHaveLength(1);
  expect(finalProjection[0]?.projectionId).toBe(runtime?.terminalOutcome?.finalProjectionId);
  expect(runtime?.presentation?.finals || []).toHaveLength(1);
  const threadTerminalEvents = runtime?.presentation?.threadEvents || [];
  const projectedRunCompleted = threadTerminalEvents.filter(
    (event: { type?: string }) => event.type === "run.completed",
  );
  const projectedTurnCompleted = threadTerminalEvents.filter(
    (event: { type?: string }) => event.type === "turn.completed",
  );
  expect(projectedRunCompleted).toHaveLength(1);
  expect(projectedTurnCompleted).toHaveLength(1);
  expect(projectedRunCompleted[0]?.resultKind).toBe(expected.resultKind);
  expect(projectedTurnCompleted[0]?.resultKind).toBe(expected.resultKind);
  expect(Number(projectedRunCompleted[0]?.timestampMs))
    .toBeLessThanOrEqual(Number(projectedTurnCompleted[0]?.timestampMs));
  return runtime;
}

function expectSuccessfulPlanExecutionOrder(runtime: any): void {
  const events = Array.isArray(runtime?.events) ? runtime.events : [];
  const approvalIndex = events.findIndex(
    (event: { type?: string }) => event.type === "work_plan.approved",
  );
  const mutationIndex = events.findIndex(
    (event: {
      type?: string;
      status?: string;
      evidence?: Array<{ kind?: string }>;
    }, index: number) =>
      index > approvalIndex &&
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      (event.evidence || []).some((entry) => entry.kind === "mutation"),
  );
  const validationIndex = events.findIndex(
    (event: { type?: string; passed?: boolean }, index: number) =>
      index > mutationIndex &&
      event.type === "validation.completed" &&
      event.passed === true,
  );
  const runCompletedIndex = events.findIndex(
    (event: { type?: string }, index: number) =>
      index > validationIndex && event.type === "run.completed",
  );
  const turnCompletedIndex = events.findIndex(
    (event: { type?: string }, index: number) =>
      index > runCompletedIndex && event.type === "turn.completed",
  );

  expect(approvalIndex, "Plan execution must begin after the sealed plan is approved.")
    .toBeGreaterThanOrEqual(0);
  expect(mutationIndex, "A successful plan run must commit mutation evidence after approval.")
    .toBeGreaterThan(approvalIndex);
  expect(validationIndex, "A successful plan run must validate after its last accepted mutation.")
    .toBeGreaterThan(mutationIndex);
  expect(runCompletedIndex).toBeGreaterThan(validationIndex);
  expect(turnCompletedIndex).toBeGreaterThan(runCompletedIndex);
}

function expectRuntimeV2PlanReviewContract(
  snapshot: any,
  expected: { turnId: string },
): any {
  const runtime = snapshot?.runtimeV2;
  expect(runtime, "Plan must expose its durable Runtime v2 checkpoint.").not.toBeNull();
  expect(runtime?.schemaVersion).toBe("turn-aggregate.v1");
  expect(runtime?.strategy).toBe("plan");
  expect(runtime?.turnId).toBe(expected.turnId);
  expect(runtime?.turnIdentity?.turnId).toBe(expected.turnId);
  expect(runtime?.runIdentity?.turnId).toBe(expected.turnId);
  expect(String(runtime?.runId || "")).not.toBe("");
  expect(runtime?.phase).toBe("reviewing");
  expect(runtime?.terminalOutcome).toBeNull();

  const events = Array.isArray(runtime?.events) ? runtime.events : [];
  const sequences = events.map((event: { sequence?: number }) => Number(event.sequence));
  expect(sequences.length).toBeGreaterThan(0);
  expect(sequences.every(Number.isFinite)).toBe(true);
  for (let index = 1; index < sequences.length; index += 1) {
    expect(sequences[index]).toBe(sequences[index - 1] + 1);
  }
  expect(new Set(events.map((event: { eventId?: string }) => event.eventId)).size)
    .toBe(events.length);
  expect(events[0]?.type).toBe("turn.admitted");
  expect(events.filter((event: { type?: string }) => event.type === "run.started"))
    .toHaveLength(1);
  expect(events.filter((event: { type?: string }) => event.type === "work_plan.sealed"))
    .toHaveLength(1);
  expect(events.filter((event: { type?: string }) =>
    event.type === "run.completed" || event.type === "turn.completed"
  )).toHaveLength(0);

  const sealed = runtime?.sealedWorkPlan;
  const reference = runtime?.workPlan;
  const commit = runtime?.planReviewCommit;
  expect(sealed?.schemaVersion).toBe("work-plan.v1");
  expect(sealed?.status).toBe("pending_review");
  expect(reference?.status).toBe("pending_review");
  expect(validateWorkPlanDraftV1(
    sealed?.draft,
    (sealed?.evidence || []).map((item: { id?: string }) => String(item.id || "")),
    sealed?.evidence || [],
  )).toEqual([]);
  const integrity = validateSealedWorkPlanV1Integrity(sealed);
  expect(integrity.ok).toBe(true);
  const authority = {
    id: sealed.id,
    revision: sealed.revision,
    digest: sealed.digest,
    projectionHash: sealed.projectionHash,
  };
  expect(reference).toMatchObject(authority);
  expect(commit?.schemaVersion).toBe("runtime-v2-plan-review-commit.v1");
  expect(commit?.authority).toEqual(authority);
  expect(commit?.review?.authority).toEqual(authority);
  expect(commit?.review).toMatchObject({
    sessionKey: runtime.turnIdentity.sessionKey,
    sessionEpoch: runtime.turnIdentity.sessionEpoch,
    turnId: expected.turnId,
    runId: runtime.runId,
    parentRunId: runtime.runIdentity.parentRunId ?? null,
  });
  expect(String(commit?.review?.requestId || "")).not.toBe("");
  expect(commit?.artifact).toEqual({
    path: ".MAIN/plans/plan.md",
    content: sealed.markdown,
    projectionHash: sealed.projectionHash,
  });
  expect(commit?.panel).toMatchObject({
    audience: "plan_panel",
    status: "pending_review",
    authority,
    title: sealed.draft.objective,
    markdown: sealed.markdown,
    validationCount: sealed.draft.validations.length,
  });
  expect(commit?.chat).toMatchObject({
    audience: "chat_milestone",
    authority,
  });
  expect(String(commit?.chat?.markdown || "")).not.toBe("");
  expect(String(commit?.chat?.dedupeKey || "")).not.toBe("");

  expect(snapshot?.activeActionRequest).toMatchObject({
    kind: "plan_review",
    requestId: commit.review.requestId,
    sessionKey: commit.review.sessionKey,
    sessionEpoch: commit.review.sessionEpoch,
    turnId: expected.turnId,
    runId: runtime.runId,
    parentRunId: commit.review.parentRunId,
    planRevision: sealed.revision,
    artifactHash: sealed.projectionHash,
    artifactPaths: [".MAIN/plans/plan.md"],
  });

  const commands = Array.isArray(runtime?.commands) ? runtime.commands : [];
  const receipts = Array.isArray(runtime?.receipts) ? runtime.receipts : [];
  expect(commands.length).toBeGreaterThan(0);
  expect(new Set(commands.map((command: { idempotencyKey?: string }) =>
    command.idempotencyKey
  )).size).toBe(commands.length);
  expect(new Set(receipts.map((receipt: { idempotencyKey?: string }) =>
    receipt.idempotencyKey
  )).size).toBe(receipts.length);
  expect(commands.map((command: { idempotencyKey?: string }) => command.idempotencyKey).sort())
    .toEqual(receipts.map((receipt: { idempotencyKey?: string }) => receipt.idempotencyKey).sort());
  expect(commands.every((command: { status?: string; completedAt?: number }) =>
    ["succeeded", "failed", "canceled"].includes(String(command.status || "")) &&
    Number.isFinite(command.completedAt)
  )).toBe(true);
  expect(commands.every((command: { turnId?: string; runId?: string }) =>
    command.turnId === expected.turnId && command.runId === runtime.runId
  )).toBe(true);
  const artifactWrites = commands.filter((command: {
    kind?: string;
    toolName?: string;
    target?: string;
    runtimeOwnedPlanArtifact?: boolean;
  }) =>
    command.kind === "execute_tool" &&
    command.toolName === "write_file" &&
    command.target === ".MAIN/plans/plan.md"
  );
  expect(artifactWrites).toHaveLength(1);
  expect(artifactWrites[0]?.runtimeOwnedPlanArtifact).toBe(true);
  expect(commands.filter((command: {
    kind?: string;
    toolName?: string;
    runtimeOwnedPlanArtifact?: boolean;
    target?: string;
  }) =>
    command.kind === "execute_tool" &&
    isWorkspaceMutationToolName(String(command.toolName || "")) &&
    !(
      command.toolName === "write_file" &&
      command.target === ".MAIN/plans/plan.md" &&
      command.runtimeOwnedPlanArtifact === true
    )
  )).toHaveLength(0);

  const committedProjections = (runtime?.projections || []).filter(
    (projection: { audience?: string; dedupeKey?: string; markdown?: string }) =>
      projection.audience === "chat_milestone" &&
      projection.dedupeKey === commit.chat.dedupeKey &&
      projection.markdown === commit.chat.markdown,
  );
  expect(committedProjections).toHaveLength(1);
  const visibleMilestones = (runtime?.presentation?.chatMilestones || []).filter(
    (projection: { markdown?: string }) =>
      projection.markdown === commit.chat.markdown,
  );
  expect(visibleMilestones).toHaveLength(1);
  return runtime;
}

function assertFirstPlanWorkspaceTurnAdmission(snapshot: any): string {
  const acceptanceReceipt = snapshot?.lastWorkspaceInstructionAcceptance?.accepted
    ? snapshot.lastWorkspaceInstructionAcceptance.receipt
    : null;
  const admittedTurnId = String(acceptanceReceipt?.turnId || "");
  const admittedReceiptId = String(acceptanceReceipt?.receiptId || "");
  const admittedClientSubmissionId = String(acceptanceReceipt?.clientSubmissionId || "");
  const admittedTurn = (snapshot?.conversationTurnPreview || []).find(
    (turn: { id?: string }) => turn.id === admittedTurnId,
  );
  const ownedUserBlocks = (snapshot?.taskFlowPreview || []).filter(
    (block: { turnId?: string; type?: string }) =>
      block.type === "user" && block.turnId === admittedTurnId,
  );
  const receipt = (snapshot?.workspaceInstructionLedger || []).find(
    (entry: { receiptId?: string; turnId?: string; clientSubmissionId?: string }) =>
      entry.receiptId === admittedReceiptId &&
      entry.turnId === admittedTurnId &&
      entry.clientSubmissionId === admittedClientSubmissionId,
  );
  const admissionDiagnostic = JSON.stringify({
    admittedTurnId,
    activeTurnId: snapshot?.currentTurnId ?? null,
    currentWorkspace: snapshot?.currentWorkspace ?? null,
    currentSessionId: snapshot?.currentSessionId ?? null,
    dispatchError: snapshot?.dispatchError ?? null,
    acceptance: snapshot?.lastWorkspaceInstructionAcceptance ?? null,
    ledger: snapshot?.workspaceInstructionLedger ?? [],
    turns: snapshot?.conversationTurns ?? null,
  });
  expect(admittedTurnId, admissionDiagnostic).not.toBe("");
  expect(admittedReceiptId).not.toBe("");
  expect(admittedClientSubmissionId).not.toBe("");
  expect(admittedTurn?.workspaceInstructionSource).toBe("composer");
  expect(String(admittedTurn?.title || "").trim()).not.toBe("");
  expect(admittedTurn?.intent).toBe("plan");
  expect(admittedTurn?.displayIntent).toBe("plan");
  expect(admittedTurn?.userPrompt).toBe(realOmlxRequest);
  expect(String(admittedTurn?.status || "").trim()).not.toBe("");
  expect(snapshot?.conversationTurns).toBe(1);
  expect(ownedUserBlocks).toHaveLength(1);
  expect(receipt).toEqual(expect.objectContaining({
    receiptId: admittedReceiptId,
    turnId: admittedTurnId,
    clientSubmissionId: admittedClientSubmissionId,
    userBlockId: ownedUserBlocks[0]?.id,
  }));
  expect(admittedTurn?.blockIds).toContain(ownedUserBlocks[0]?.id);
  expect(snapshot?.lastWorkspaceInstructionAcceptance).toEqual(expect.objectContaining({
    accepted: true,
    receipt: expect.objectContaining({
      receiptId: admittedReceiptId,
      turnId: admittedTurnId,
      clientSubmissionId: admittedClientSubmissionId,
      userBlockId: ownedUserBlocks[0]?.id,
    }),
  }));
  return admittedTurnId;
}

test.describe.configure({
  timeout: Math.max(1_200_000, realOmlxExecutionTimeoutMs + 180_000),
});
test.skip(!runRealOmlx, "Set MAIN_REAL_OMLX_E2E=1 to run real local OMLX plan-flow validation.");

test.beforeEach(async ({ page }) => {
  const customWorkspace = process.env.REAL_OMLX_WORKSPACE;
  const workspace = customWorkspace
    ? path.resolve(customWorkspace)
    : await fs.mkdtemp(path.join(os.tmpdir(), "e2e-real-omlx-"));
  (page as any).__realOmlxWorkspace = workspace;
  const csvSeedFiles: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "csv-direct-edit-recovery-fixture",
      private: true,
      scripts: { test: "tsc --noEmit" },
    }, null, 2) + "\n",
    "src/hooks/useCsvParser.ts": [
      "export interface CsvOrder {",
      "  creator?: string;",
      "  creatorName?: string;",
      "}",
      "",
      "export function normalizeCsvOrder(row: Record<string, string>): CsvOrder {",
      "  return {",
      "    creator: row.creator || row['创建者'] || '',",
      "  };",
      "}",
      "",
    ].join("\n"),
    "src/store/dashboardStore.ts": "export const creatorField = 'creatorName';\n",
    "src/hooks/useChartData.ts": [
      "import type { CsvOrder } from './useCsvParser';",
      "export function buildCourseRanking(orders: CsvOrder[]) {",
      "  return orders.map((order) => ({ name: order.creatorName || order.creator || 'unknown', amount: 1 }));",
      "}",
    ].join("\n"),
    "src/types/order.ts": "export interface Order { creatorName: string; amount: number; status?: string; }\n",
    "src/App.tsx": "export function App() { return <main className=\"app-shell\"><section className=\"dashboard-panel\" /></main>; }\n",
    "src/index.css": [
      ":root { color-scheme: light; background: #ffffff; color: #111827; }",
      "[data-theme='dark'] { color-scheme: dark; background: #ffffff; color: #e5e7eb; }",
      ".dashboard-panel { background: #ffffff; border: 1px solid #e5e7eb; }",
    ].join("\n"),
    "src/components/Dashboard/CourseBarChart.tsx": "export function CourseBarChart() { return <div data-chart=\"course\" />; }\n",
    "src/components/Dashboard/TrendLineChart.tsx": "export function TrendLineChart() { return <div data-chart=\"trend\" />; }\n",
    "src/components/Dashboard/StatusPieChart.tsx": "export function StatusPieChart() { return <div data-chart=\"status\" />; }\n",
    "src/components/FileUploader/DragUpload.tsx": "export function DragUpload() { return <input type=\"file\" />; }\n",
    "cn_tutorial_orders_by_creator_20260512.csv": "creator,amount\nalice,12\n",
  };
  const mdViewerSeedFiles: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "md-viewer-recovery-fixture",
      private: true,
      scripts: {
        build: "tsc --noEmit",
        dev: "vite --port 1420",
      },
    }, null, 2) + "\n",
    "index.html": "<!doctype html><main><div id=\"toolbar\"></div><div id=\"status\"></div></main><script type=\"module\" src=\"/src/main.js\"></script>\n",
    "src/components/toolbar.js": [
      "export function renderToolbar(root) {",
      "  root.innerHTML = [",
      "    '<button id=\"btn-new\">New</button>',",
      "    '<button id=\"btn-open\">Open</button>',",
      "    '<button id=\"btn-save\">Save</button>',",
      "  ].join('');",
      "}",
      "",
    ].join("\n"),
    "src/main.js": [
      "import { renderToolbar } from './components/toolbar.js';",
      "",
      "const status = document.getElementById('status');",
      "renderToolbar(document.getElementById('toolbar'));",
      "",
      "export function initToolbar() {",
      "  const actions = {",
      "    'new-btn': () => { status.textContent = 'new'; },",
      "    'open-btn': () => { status.textContent = 'open'; },",
      "    'save-btn': () => { status.textContent = 'save'; },",
      "  };",
      "  for (const [id, handler] of Object.entries(actions)) {",
      "    document.getElementById(id)?.addEventListener('click', handler);",
      "  }",
      "}",
      "",
      "initToolbar();",
      "",
    ].join("\n"),
  };
  const seedFiles = realOmlxFixture === "md-viewer"
    ? mdViewerSeedFiles
    : csvSeedFiles;
  if (!customWorkspace) {
    for (const [relative, content] of Object.entries(seedFiles)) {
      const absolute = path.join(workspace, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");
    }
  }

  const resolveDiskPath = (rawPath: string) => {
    const candidate = path.isAbsolute(String(rawPath || ""))
      ? path.resolve(String(rawPath))
      : path.resolve(workspace, String(rawPath || "."));
    if (!isPathInsideWorkspace(candidate, workspace)) {
      throw new Error(`E2E_WORKSPACE_PATH_OUT_OF_SCOPE: ${rawPath}`);
    }
    return candidate;
  };

  let workspaceInventoryPromise: Promise<RealOmlxWorkspaceInventory> | null = null;
  const getWorkspaceInventory = () => {
    workspaceInventoryPromise ??= collectBoundedRealOmlxWorkspaceFiles(workspace, {
      maxFiles: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxWorkspaceFiles,
    });
    return workspaceInventoryPromise;
  };
  const invalidateWorkspaceInventory = () => {
    workspaceInventoryPromise = null;
  };
  let acceptanceState = createRealOmlxAcceptanceState();
  await page.exposeFunction("__MAIN_E2E_RECORD_ACCEPTANCE_EVENT", async (
    source: string,
    message: unknown,
  ) => {
    acceptanceState = recordRealOmlxAcceptanceDebugEvent(
      acceptanceState,
      source,
      message,
    );
    return acceptanceState;
  });

  await page.exposeFunction("__MAIN_E2E_DISK_READ", async (rawPath: string) => {
    const result = await readBoundedRealOmlxWorkspaceTextFile(workspace, rawPath, {
      maxBytes: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxExplicitReadBytes,
    });
    if (!result.ok) {
      throw new Error(
        `E2E_WORKSPACE_READ_BLOCKED: ${result.path || rawPath} (${result.reason}, ${result.sizeBytes} bytes)`,
      );
    }
    return result.content;
  });
  await page.exposeFunction("__MAIN_E2E_DISK_WRITE", async (rawPath: string, content: string) => {
    const absolute = resolveDiskPath(rawPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
    invalidateWorkspaceInventory();
    return null;
  });
  await page.exposeFunction("__MAIN_E2E_DISK_METADATA", async (rawPath: string) => {
    const absolute = resolveDiskPath(rawPath);
    const stat = await fs.stat(absolute);
    return { path: rawPath, sizeBytes: stat.size, modifiedMs: stat.mtimeMs };
  });
  await page.exposeFunction("__MAIN_E2E_DISK_GLOB", async () => await getWorkspaceInventory());
  await page.exposeFunction("__MAIN_E2E_DISK_SEARCH_FILES", async () => {
    const inventory = await getWorkspaceInventory();
    return {
      ...selectBoundedRealOmlxSearchFiles(inventory.files, {
        maxFiles: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFiles,
      }),
      inventoryTruncated: inventory.truncated,
    };
  });
  await page.exposeFunction("__MAIN_E2E_DISK_READ_TEXT_BATCH", async (rawPaths: string[]) =>
    await readBoundedRealOmlxWorkspaceTextFiles(workspace, rawPaths, {
      concurrency: REAL_OMLX_WORKSPACE_PROXY_LIMITS.searchReadConcurrency,
      maxFileBytes: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFileBytes,
      maxFiles: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFiles,
      maxTotalBytes: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchTotalBytes,
    })
  );
  await page.exposeFunction("__MAIN_E2E_DISK_READ_WINDOW", async (
    rawPath: string,
    options: Record<string, unknown>,
  ) => await readRealOmlxWorkspaceFileWindow(workspace, rawPath, {
    startLine: Number(options?.startLine) || undefined,
    endLine: Number(options?.endLine) || undefined,
    maxLines: Number(options?.maxLines) || undefined,
    maxChars: Number(options?.maxChars) || undefined,
    maxScanBytes: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxWindowScanBytes,
  }));
  await page.exposeFunction("__MAIN_E2E_DISK_LIST", async (rawPath: string) => {
    const absolute = resolveDiskPath(rawPath);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const child = path.join(absolute, entry.name);
      const relativePath = path.relative(workspace, child).replace(/\\/g, "/");
      if (entry.isDirectory() && shouldPruneRealOmlxWorkspaceDirectory(relativePath)) return [];
      if (!entry.isDirectory() && !entry.isFile()) return [];
      return [{
        name: entry.name,
        path: relativePath,
        is_dir: entry.isDirectory(),
      }];
    });
  });
  const initialWorkspaceInventory = await getWorkspaceInventory();
  if (customWorkspace && initialWorkspaceInventory.files.length === 0) {
    throw new Error(
      "E2E_REAL_OMLX_CUSTOM_WORKSPACE_EMPTY: copy the real fixture into REAL_OMLX_WORKSPACE before starting validation.",
    );
  }
  const leakedIgnoredPath = initialWorkspaceInventory.files.find((filePath) =>
    /(?:^|\/)(?:node_modules|target|dist|build|\.git|\.MAIN)(?:\/|$)/i.test(filePath) ||
    /^src-tauri\/(?:gen|icons)\//i.test(filePath)
  );
  if (leakedIgnoredPath) {
    throw new Error(`E2E_WORKSPACE_INVENTORY_PRUNE_FAILED: ${leakedIgnoredPath}`);
  }
  console.log(`[real-omlx-workspace-inventory] ${JSON.stringify({
    files: initialWorkspaceInventory.files.length,
    maxFiles: initialWorkspaceInventory.maxFiles,
    truncated: initialWorkspaceInventory.truncated,
    visitedDirectories: initialWorkspaceInventory.visitedDirectories,
    prunedDirectories: initialWorkspaceInventory.prunedDirectories,
    skippedEntries: initialWorkspaceInventory.skippedEntries,
  })}`);
  const fixtureMutationBaseline = await readFixtureMutationContents(workspace);
  await page.exposeFunction("__MAIN_E2E_INSPECT_FIXTURE_MUTATION", async () =>
    await inspectFixtureMutation(workspace, fixtureMutationBaseline)
  );
  let requireDirectEditRepair = false;
  await page.exposeFunction("__MAIN_E2E_REQUIRE_DIRECT_EDIT_REPAIR", async () => {
    requireDirectEditRepair = true;
  });
  await page.exposeFunction("__MAIN_E2E_RUN_VERIFICATION", async (rawCommand: string) => {
    const command = String(rawCommand || "").trim();
    const mutationState = await inspectFixtureMutation(
      workspace,
      fixtureMutationBaseline,
    );
    const isFiniteVerification = isFinitePlanValidationCommand(command);
    const commandResult = isFiniteVerification
      ? await runRealOmlxWorkspaceCommand(workspace, command)
      : null;
    const directEditSource = requireDirectEditRepair && realOmlxFixture === "csv"
      ? await fs.readFile(path.join(workspace, "src/hooks/useCsvParser.ts"), "utf8")
      : "";
    const directEditRepairSatisfied = !requireDirectEditRepair || (
      /\bsource\??\s*:\s*string\b/.test(directEditSource) &&
      /\bsource\s*:\s*["']csv["']/.test(directEditSource)
    );
    const exitCode = commandResult?.exitCode === 0 &&
      !commandResult.timedOut &&
      mutationState.satisfied &&
      isFiniteVerification &&
      directEditRepairSatisfied
      ? 0
      : commandResult?.exitCode || 1;
    const semanticSummary = exitCode === 0
      ? `Fresh fixture verification passed: ${mutationState.detail}.`
      : [
          "FRESH_FIXTURE_ACCEPTANCE_FAILED: the finite command ran, but the current source still violates these user-visible acceptance conditions:",
          mutationState.detail,
        ].join("\n");
    return JSON.stringify({
      command,
      cwd: workspace,
      exitCode,
      timedOut: commandResult?.timedOut || false,
      durationMs: commandResult?.durationMs || 0,
      success: exitCode === 0,
      stdout: [
        commandResult?.stdout || "",
        ...(exitCode === 0 ? [semanticSummary] : []),
      ].filter(Boolean).join("\n"),
      stderr: [
        commandResult?.stderr || "",
        ...(exitCode === 0 ? [] : [semanticSummary]),
        ...(requireDirectEditRepair && !directEditRepairSatisfied ? [[
            "src/hooks/useCsvParser.ts:8:3 - error TS2741: Property 'source' is missing in normalized CsvOrder.",
            "Declare source?: string on CsvOrder and return source: 'csv' from normalizeCsvOrder.",
          ].join("\n")] : []),
      ].filter(Boolean).join("\n"),
    });
  });

  await page.exposeFunction("__MAIN_E2E_PROXY_REQUEST", async (args: Record<string, unknown>) => {
    const url = String(args.url || "");
    const response = await fetch(url, {
      method: String(args.method || "POST"),
      headers: args.headers as Record<string, string>,
      body: String(args.body || ""),
    });
    const text = await response.text();
    console.log(`[real-omlx-proxy] ${response.status} ${url} ${text.slice(0, 240).replace(/\s+/g, " ")}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    return contentType.toLowerCase().includes("text/event-stream")
      ? `__CONTENT_TYPE__:${contentType}\n${text}`
      : text;
  });

  await page.exposeFunction("__MAIN_E2E_PROXY_REQUEST_DETAILED", async (args: Record<string, unknown>) => {
    const url = String(args.url || "");
    const response = await fetch(url, {
      method: String(args.method || "POST"),
      headers: args.headers as Record<string, string>,
      body: typeof args.body === "string" ? String(args.body) : undefined,
    });
    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    console.log(`[real-omlx-proxy-detailed] ${response.status} ${url} ${text.slice(0, 160).replace(/\s+/g, " ")}`);
    return {
      status: response.status,
      ok: response.ok,
      body: text,
      content_type: response.headers.get("content-type") || null,
      headers,
    };
  });

  type RealOmlxChatStream = {
    reader: ReadableStreamDefaultReader<Uint8Array> | null;
    decoder: TextDecoder;
    controller: AbortController;
    url: string;
    model: string;
    chars: number;
    chunks: number;
    preview: string;
    timeoutMs: number;
    deadlineAt: number;
  };
  const chatStreams = new Map<string, RealOmlxChatStream>();
  await page.exposeFunction("__MAIN_E2E_CHAT_STREAM_OPEN", async (args: Record<string, unknown>) => {
    const streamId = String(args.streamId || args.stream_id || "");
    const url = String(args.url || "");
    const bodyText = String(args.body || "");
    let model = "";
    try {
      model = String(JSON.parse(bodyText).model || "");
    } catch {
      // Keep logging best-effort; invalid JSON will fail at the endpoint.
    }
    const requestedTimeoutMs = Number(args.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.max(1_000, Math.min(600_000, Math.trunc(requestedTimeoutMs)))
      : 180_000;
    const controller = new AbortController();
    const stream: RealOmlxChatStream = {
      reader: null,
      decoder: new TextDecoder(),
      controller,
      url,
      model,
      chars: 0,
      chunks: 0,
      preview: "",
      timeoutMs,
      deadlineAt: Date.now() + timeoutMs,
    };
    // Register the lease before waiting for response headers. OMLX can spend
    // substantial time in prefill, and cancellation must still reach that
    // in-flight fetch instead of becoming a no-op before a reader exists.
    chatStreams.set(streamId, stream);
    let responseHeaderTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = await Promise.race([
        fetch(url, {
          method: "POST",
          headers: args.headers as Record<string, string>,
          body: bodyText,
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          responseHeaderTimer = setTimeout(() => {
            reject(new Error(
              `STREAM_REQUEST_TIMEOUT: response_headers exceeded ${timeoutMs}ms`,
            ));
          }, Math.max(1, stream.deadlineAt - Date.now()));
        }),
      ]);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      if (!response.body) throw new Error(`HTTP ${response.status}: response body is not streamable`);
      if (!chatStreams.has(streamId)) {
        controller.abort();
        throw new Error("chat_stream_canceled_before_headers");
      }
      stream.reader = response.body.getReader();
      return { status: response.status };
    } catch (error) {
      chatStreams.delete(streamId);
      controller.abort();
      throw error;
    } finally {
      if (responseHeaderTimer !== null) clearTimeout(responseHeaderTimer);
    }
  });
  await page.exposeFunction("__MAIN_E2E_CHAT_STREAM_READ", async (streamId: string) => {
    const stream = chatStreams.get(String(streamId));
    if (!stream?.reader) return { done: true, chunk: "" };
    const phase = stream.chunks === 0 ? "first_chunk" : "idle_chunk";
    const remainingMs = stream.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      chatStreams.delete(String(streamId));
      stream.controller.abort();
      void stream.reader.cancel("runtime_v2_stream_request_timeout").catch(() => {});
      throw new Error(
        `STREAM_REQUEST_TIMEOUT: ${phase} exceeded the ${stream.timeoutMs}ms request deadline`,
      );
    }
    let chunkTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const { done, value } = await Promise.race([
        stream.reader.read(),
        new Promise<never>((_resolve, reject) => {
          chunkTimer = setTimeout(() => {
            reject(new Error(
              `STREAM_REQUEST_TIMEOUT: ${phase} exceeded the ${stream.timeoutMs}ms request deadline`,
            ));
          }, Math.max(1, remainingMs));
        }),
      ]);
      const chunk = stream.decoder.decode(value || new Uint8Array(), { stream: !done });
      stream.chars += chunk.length;
      stream.chunks += 1;
      if (stream.preview.length < 180) stream.preview = `${stream.preview}${chunk}`.slice(0, 180);
      if (done) {
        chatStreams.delete(String(streamId));
        console.log(`[real-omlx-stream] 200 ${stream.url} model=${stream.model} chars=${stream.chars} ${stream.preview.replace(/\s+/g, " ")}`);
      }
      return { done, chunk };
    } catch (error) {
      chatStreams.delete(String(streamId));
      stream.controller.abort();
      void stream.reader.cancel("runtime_v2_stream_request_timeout").catch(() => {});
      throw error;
    } finally {
      if (chunkTimer !== null) clearTimeout(chunkTimer);
    }
  });
  await page.exposeFunction("__MAIN_E2E_CHAT_STREAM_CANCEL", async (streamId: string) => {
    const stream = chatStreams.get(String(streamId));
    if (!stream) return false;
    stream.controller.abort();
    chatStreams.delete(String(streamId));
    return true;
  });

  await page.addInitScript(({ workspace, endpoint, apiKey, devServerUrl, fixture, limits }) => {
    const debugEntries = ((window as any).__REAL_OMLX_DEBUG_LOGS__ ??= []);
    (window as any).__REAL_OMLX_ACCEPTANCE_STATE__ ??= {
      authoringContractIds: [],
      evidenceBundleHashes: [],
      observedSubagentPreferences: [],
      spawnedScopes: [],
      joinedSubagentIds: [],
      joinedScopeKeys: [],
      consumedScopeKeys: [],
    };
    const acceptanceEventSources = new Set([
      "agent.plan_authoring_contract_injected",
      "agent.plan_evidence_bundle_ready",
      "agent.plan_evidence_bundle_injected",
      "agent.task_orchestrator_phase",
      "agent.semantic_collaboration_task_spawned",
      "agent.semantic_collaboration_evidence_consumed",
      "parent_join_injected",
      "parent_resume",
    ]);
    const canceledStreamIds = new Set<string>();
    const readText = async (path: string) => {
      return await (window as any).__MAIN_E2E_DISK_READ(path);
    };
    const readWorkspaceInventory = async () => {
      const inventory = await (window as any).__MAIN_E2E_DISK_GLOB();
      return Array.isArray(inventory)
        ? { files: inventory, truncated: false, maxFiles: inventory.length }
        : inventory;
    };
    const readSearchFileSelection = async () => {
      const selection = await (window as any).__MAIN_E2E_DISK_SEARCH_FILES();
      return Array.isArray(selection)
        ? { files: selection, truncated: false, inventoryTruncated: false }
        : selection;
    };
    const readTextBatch = async (paths: string[]) =>
      await (window as any).__MAIN_E2E_DISK_READ_TEXT_BATCH(paths);
    const normalizedWorkspacePath = (value: unknown) => String(value || ".")
      .replace(/\\/g, "/")
      .replace(String(workspace).replace(/\\/g, "/"), "")
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "");
    const isPathInRequestedScope = (filePath: string, requestedPath: unknown) => {
      const normalizedFile = normalizedWorkspacePath(filePath);
      const normalizedScope = normalizedWorkspacePath(requestedPath);
      return !normalizedScope || normalizedScope === "." ||
        normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`);
    };
    const writeText = async (path: string, content: string) => {
      await (window as any).__MAIN_E2E_DISK_WRITE(path, content);
    };
    (window as any).__REAL_OMLX_WORKSPACE__ = workspace;
    (window as any).__REAL_OMLX_CONFIG__ = { endpoint, apiKey };

    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    const callbacks = new Map<number, unknown>();
    const eventListeners = new Map<number, { event: string; handlerId: number }>();
    let callbackId = 1;
    const emitTauriEvent = (event: string, payload: unknown) => {
      for (const listener of eventListeners.values()) {
        if (listener.event !== event) continue;
        const callback = callbacks.get(listener.handlerId);
        if (typeof callback === "function") {
          callback({ event, id: listener.handlerId, payload });
        }
      }
    };
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.transformCallback = (callback: unknown) => {
      const id = callbackId++;
      callbacks.set(id, callback);
      return id;
    };
    internals.unregisterCallback = (id: number) => {
      callbacks.delete(Number(id));
    };
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    let ptyActive = false;
    let ptyBuffer = "";
    let ptyForegroundPid: number | null = null;
    let ptyShellAvailable = true;
    let ptyForegroundState: "busy" | "idle" | "unknown" | "stopped" = "idle";
    let ptyForegroundGeneration = 0;
    const deliveredControlIds = new Set<string>();
    const appendPtyOutput = (value: string) => {
      ptyBuffer += value;
      emitTauriEvent("pty-data", { chunk: value });
    };
    const ptyReadResult = (startOffset: number, maxCharsRaw?: unknown) => {
      const boundedStart = Math.max(0, Math.min(Math.floor(startOffset), ptyBuffer.length));
      const maxChars = Math.max(100, Math.min(Number(maxCharsRaw) || 8_000, 200_000));
      const available = ptyBuffer.slice(boundedStart);
      const text = available.slice(0, maxChars);
      return {
        text,
        startOffset: boundedStart,
        endOffset: boundedStart + text.length,
        truncated: text.length < available.length,
        bufferStartOffset: 0,
        bufferEndOffset: ptyBuffer.length,
      };
    };
    const ptyStatus = () => ({
      active: ptyActive,
      running: ptyActive,
      pid: ptyActive ? 4100 : null,
      foregroundPid: ptyForegroundPid,
      shellAvailable: ptyShellAvailable,
      foregroundState: ptyForegroundState,
      foregroundGeneration: ptyForegroundGeneration,
      exitCode: null,
      bufferStartOffset: 0,
      bufferEndOffset: ptyBuffer.length,
      bufferBytes: ptyBuffer.length,
      tail: ptyBuffer.slice(-8_000),
    });
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "append_debug_log") {
        const raw = args || {};
        const message = String(raw.message || "");
        debugEntries.push({
          timestamp: String(raw.timestamp || ""),
          level: String(raw.level || ""),
          source: String(raw.source || ""),
          message: message.length <= limits.maxDebugMessageChars
            ? message
            : `${message.slice(0, limits.maxDebugMessageChars)}...<e2e-debug-truncated:${message.length}>`,
        });
        if (debugEntries.length > limits.maxDebugEntries) {
          debugEntries.splice(0, debugEntries.length - limits.maxDebugEntries);
        }
        if (acceptanceEventSources.has(String(raw.source || ""))) {
          (window as any).__REAL_OMLX_ACCEPTANCE_STATE__ = await (
            window as any
          ).__MAIN_E2E_RECORD_ACCEPTANCE_EVENT(String(raw.source || ""), raw.message);
        }
        return null;
      }
      if (cmd === "plugin:event|listen") {
        const handlerId = Number(args?.handler ?? callbackId++);
        eventListeners.set(handlerId, {
          event: String(args?.event || ""),
          handlerId,
        });
        return handlerId;
      }
      if (cmd === "plugin:event|unlisten") {
        eventListeners.delete(Number(args?.eventId ?? args?.handler));
        return null;
      }
      if (cmd === "get_system_memory") return {
        total_gb: 64,
        available_gb: 48,
        total_bytes: 64 * 1024 ** 3,
        available_bytes: 48 * 1024 ** 3,
      };
      if (cmd === "list_project_sessions") return [];
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path || workspace);
      if (cmd === "spawn_pty") {
        ptyActive = true;
        ptyForegroundPid = null;
        ptyShellAvailable = true;
        ptyForegroundState = "idle";
        ptyForegroundGeneration = 0;
        deliveredControlIds.clear();
        return null;
      }
      if (cmd === "resize_pty") return null;
      if (cmd === "get_pty_status") return ptyStatus();
      if (cmd === "write_pty") {
        if (!ptyActive) throw new Error("PTY not started");
        const input = String(args?.input || "");
        const controlId = String(args?.controlId || "");
        if (controlId && deliveredControlIds.has(controlId)) {
          return {
            accepted: false,
            duplicate: true,
            deliveryState: "duplicate",
            foregroundPid: ptyForegroundPid,
            foregroundState: ptyForegroundState,
            foregroundGeneration: ptyForegroundGeneration,
          };
        }
        if (controlId) deliveredControlIds.add(controlId);
        if (input.includes("\u0003")) {
          appendPtyOutput("^C\n");
          ptyForegroundPid = null;
          ptyShellAvailable = true;
          ptyForegroundState = "idle";
          return {
            accepted: true,
            duplicate: false,
            deliveryState: "delivered",
            foregroundPid: ptyForegroundPid,
            foregroundState: ptyForegroundState,
            foregroundGeneration: ptyForegroundGeneration,
          };
        }
        if (args?.allowForegroundInput !== true && args?.userTerminal !== true) {
          ptyForegroundGeneration += 1;
          deliveredControlIds.clear();
        }
        appendPtyOutput(input);
        if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|preview|start|serve)\b|\bvite\b/i.test(input)) {
          appendPtyOutput(`\nVITE v6.0.0 ready in 120 ms\n\n  Local: ${devServerUrl}\n`);
          ptyForegroundPid = 4102;
          ptyShellAvailable = false;
          ptyForegroundState = "busy";
        }
        return {
          accepted: true,
          duplicate: false,
          deliveryState: "delivered",
          foregroundPid: ptyForegroundPid,
          foregroundState: ptyForegroundState,
          foregroundGeneration: ptyForegroundGeneration,
        };
      }
      if (cmd === "read_pty_buffer") {
        const maxChars = Math.max(100, Math.min(Number(args?.maxChars) || ptyBuffer.length || 8_000, 200_000));
        return ptyBuffer.slice(-maxChars);
      }
      if (cmd === "read_pty_since") {
        return ptyReadResult(Number(args?.offset) || 0, args?.maxChars);
      }
      if (cmd === "read_pty_tail") {
        const maxChars = Math.max(100, Math.min(Number(args?.maxChars) || 8_000, 200_000));
        const startOffset = Math.max(0, ptyBuffer.length - maxChars);
        return ptyReadResult(startOffset, maxChars);
      }
      if (cmd === "clear_pty_buffer") {
        ptyBuffer = "";
        return ptyReadResult(0, args?.maxChars);
      }
      if (cmd === "cancel_proxy_request") return null;
      if (cmd === "cancel_chat_stream") {
        const streamId = String(args?.streamId || args?.stream_id || "");
        canceledStreamIds.add(streamId);
        await (window as any).__MAIN_E2E_CHAT_STREAM_CANCEL(streamId);
        return null;
      }
      if (cmd === "proxy_request") return await (window as any).__MAIN_E2E_PROXY_REQUEST(args || {});
      if (cmd === "proxy_request_detailed") return await (window as any).__MAIN_E2E_PROXY_REQUEST_DETAILED(args || {});
      if (cmd === "start_chat_stream") {
        const streamId = String(args?.streamId || args?.stream_id || "");
        canceledStreamIds.delete(streamId);
        try {
          await (window as any).__MAIN_E2E_CHAT_STREAM_OPEN(args || {});
          while (!canceledStreamIds.has(streamId)) {
            const next = await (window as any).__MAIN_E2E_CHAT_STREAM_READ(streamId);
            if (next?.chunk) {
              emitTauriEvent("chat-stream-chunk", { stream_id: streamId, chunk: next.chunk });
            }
            if (next?.done) break;
          }
          emitTauriEvent("chat-stream-done", {
            stream_id: streamId,
            status: canceledStreamIds.has(streamId) ? "cancelled" : "ok",
            error: null,
          });
        } catch (error) {
          emitTauriEvent("chat-stream-done", {
            stream_id: streamId,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }
      if (cmd === "get_project_skeleton") {
        const inventory = await readWorkspaceInventory();
        const filePaths = Array.isArray(inventory?.files) ? inventory.files : [];
        const visiblePaths = filePaths
          .filter((filePath: string) =>
            !/(?:^|\/)\.[^/]+(?:\/|$)/.test(filePath) &&
            !/(?:^|\/)package-lock\.json$/.test(filePath)
          )
          .slice(0, 120);
        return [
          ".",
          ...visiblePaths.map((filePath: string) => `- ${filePath}`),
          ...(inventory?.truncated ? [`... (workspace inventory capped at ${inventory.maxFiles} files)`] : []),
        ].join("\n");
      }
      if (cmd === "list_directory") {
        const path = String(args?.path || ".");
        try {
          return await (window as any).__MAIN_E2E_DISK_LIST(path === workspace ? "." : path);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error || "unknown error");
          throw new Error(
            `E2E_${String(fixture || "workspace").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_LIST_DIRECTORY_FAILED: ${path}: ${detail}`,
          );
        }
      }
      if (cmd === "glob_search") {
        const requestedGlob = String(args?.glob || args?.pattern || args?.query || args?.path || "**/*")
          .replace(/\\/g, "/")
          .replace(/^\.\//, "");
        const escapeRegexChar = (char: string) => /[\\^$.[\]()+|]/.test(char) ? `\\${char}` : char;
        const globToRegex = (pattern: string) => {
          let source = "^";
          for (let index = 0; index < pattern.length; index += 1) {
            const char = pattern[index];
            const next = pattern[index + 1];
            if (char === "*" && next === "*") {
              if (pattern[index + 2] === "/") {
                source += "(?:.*/)?";
                index += 2;
              } else {
                source += ".*";
                index += 1;
              }
            } else if (char === "*") {
              source += "[^/]*";
            } else if (char === "?") {
              source += "[^/]";
            } else if (char === "{") {
              const close = pattern.indexOf("}", index + 1);
              if (close > index) {
                source += `(?:${pattern.slice(index + 1, close).split(",").map((part) =>
                  part.split("").map(escapeRegexChar).join("")
                ).join("|")})`;
                index = close;
              } else {
                source += "\\{";
              }
            } else {
              source += escapeRegexChar(char);
            }
          }
          return new RegExp(`${source}$`, "i");
        };
        const matcher = globToRegex(requestedGlob || "**/*");
        const inventory = await readWorkspaceInventory();
        return (Array.isArray(inventory?.files) ? inventory.files : [])
          .filter((filePath: string) => !/(?:^|\/)\.[^/]+(?:\/|$)/.test(filePath))
          .filter((filePath: string) => matcher.test(filePath))
          .slice(0, limits.maxGlobResults);
      }
      if (cmd === "grep_search") {
        const query = String(args?.query || args?.pattern || "");
        const selection = await readSearchFileSelection();
        const requestedPath = args?.path || ".";
        const scopedFiles = (Array.isArray(selection?.files) ? selection.files : [])
          .filter((filePath: string) => isPathInRequestedScope(filePath, requestedPath));
        const batch = await readTextBatch(scopedFiles);
        let matcher: RegExp | null = null;
        try {
          matcher = query ? new RegExp(query, "i") : null;
        } catch {
          matcher = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
        }
        const hits: string[] = [];
        let outputChars = 0;
        let truncated = Boolean(selection?.truncated || selection?.inventoryTruncated || batch?.truncated);
        for (const entry of Array.isArray(batch?.files) ? batch.files : []) {
          const lines = String(entry.content || "").split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (matcher && !matcher.test(line)) continue;
            const hit = `${entry.path}:${index + 1}:${line}`;
            if (
              hits.length >= limits.maxSearchResults ||
              outputChars + hit.length + 1 > limits.maxGrepOutputChars
            ) {
              truncated = true;
              break;
            }
            hits.push(hit);
            outputChars += hit.length + 1;
          }
          if (hits.length >= limits.maxSearchResults || outputChars >= limits.maxGrepOutputChars) break;
        }
        if (truncated) hits.push("... (E2E workspace search truncated at bounded file/result limits)");
        return hits.join("\n");
      }
      if (cmd === "code_ast_query") {
        const filePath = String(args?.path || "");
        const content = await readText(filePath);
        const symbols = String(content).split(/\r?\n/).flatMap((line, index) => {
          const match = line.match(/\b(?:export\s+)?(?:async\s+)?(interface|type|class|function|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
          if (!match) return [];
          return [{
            name: match[2],
            kind: match[1],
            syntaxKind: match[1] === "interface" ? "interface_declaration" : `${match[1]}_declaration`,
            startLine: index + 1,
            startColumn: 1,
            endLine: index + 1,
            signature: line.trim(),
          }];
        });
        return {
          path: filePath,
          language: filePath.endsWith(".tsx") ? "tsx" : "typescript",
          rootKind: "program",
          hasErrors: false,
          errorCount: 0,
          symbols,
          truncated: false,
          note: "E2E structured AST fixture",
        };
      }
      if (cmd === "find_symbol_references") {
        const symbol = String(args?.symbol || "");
        const requestedPath = String(args?.path || "");
        const selection = await readSearchFileSelection();
        const filePaths = (Array.isArray(selection?.files) ? selection.files : [])
          .filter((filePath: string) => /\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|cs)$/.test(filePath))
          .filter((filePath: string) => isPathInRequestedScope(filePath, requestedPath));
        const batch = await readTextBatch(filePaths);
        const occurrences: Array<Record<string, unknown>> = [];
        let totalOccurrences = 0;
        for (const entry of Array.isArray(batch?.files) ? batch.files : []) {
          const filePath = String(entry.path || "");
          const content = String(entry.content || "");
          String(content).split(/\r?\n/).forEach((line, index) => {
            const column = line.indexOf(symbol);
            if (column < 0) return;
            totalOccurrences += 1;
            if (occurrences.length >= limits.maxSearchResults) return;
            occurrences.push({
              path: filePath,
              language: filePath.endsWith(".tsx") ? "tsx" : "typescript",
              role: /\b(?:interface|type|class|function|const|let)\s+/.test(line) ? "definition" : "reference",
              syntaxKind: "identifier",
              line: index + 1,
              column: column + 1,
              context: line.trim(),
            });
          });
        }
        return {
          symbol,
          scope: requestedPath || workspace,
          scannedFiles: Array.isArray(batch?.files) ? batch.files.length : 0,
          skippedFiles: Array.isArray(batch?.skipped) ? batch.skipped.length : 0,
          parseFailures: 0,
          occurrences,
          truncated: Boolean(
            selection?.truncated || selection?.inventoryTruncated || batch?.truncated ||
            totalOccurrences > limits.maxSearchResults
          ),
          note: "E2E structured reference fixture with production-like file and result bounds",
        };
      }
      if (cmd === "build_repository_index") {
        const selection = await readSearchFileSelection();
        const sourceFiles = (Array.isArray(selection?.files) ? selection.files : [])
          .filter((filePath: string) => /\.(?:ts|tsx|js|jsx|mjs|cjs|css|rs|py|json|toml|md)$/.test(filePath));
        const batch = await readTextBatch(sourceFiles);
        const symbols: Array<Record<string, unknown>> = [];
        const imports: Array<Record<string, unknown>> = [];
        const calls: Array<Record<string, unknown>> = [];
        let indexTruncated = Boolean(selection?.truncated || selection?.inventoryTruncated || batch?.truncated);
        for (const entry of Array.isArray(batch?.files) ? batch.files : []) {
          const filePath = String(entry.path || "");
          const content = String(entry.content || "");
          const lines = String(content).split(/\r?\n/);
          lines.forEach((line, index) => {
            const symbol = line.match(/\b(?:export\s+)?(?:function|const|interface|type|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
            if (symbol) {
              if (symbols.length < limits.maxIndexEntries) {
                symbols.push({
                  name: symbol[1],
                  kind: line.includes("interface") ? "interface" : line.includes("type") ? "type" : line.includes("class") ? "class" : line.includes("function") ? "function" : "constant",
                  file: filePath,
                  line: index + 1,
                  signature: line.trim(),
                });
              } else {
                indexTruncated = true;
              }
            }
            const imported = line.match(/from\s+['"]([^'"]+)['"]/);
            if (imported) {
              if (imports.length < limits.maxIndexEntries) {
                imports.push({ from: filePath, to: imported[1], kind: "import", line: index + 1 });
              } else {
                indexTruncated = true;
              }
            }
            for (const call of line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
              if (calls.length < limits.maxIndexEntries) {
                calls.push({ from: filePath, symbol: call[1], line: index + 1 });
              } else {
                indexTruncated = true;
              }
            }
          });
        }
        return {
          root: workspace,
          generatedAtMs: Date.now(),
          symbols,
          imports,
          calls,
          dependencies: [],
          embeddings: [],
          truncated: indexTruncated,
        };
      }
      if (cmd === "read_file") return await readText(String(args?.path || ""));
      if (cmd === "read_file_window") {
        const path = String(args?.path || "");
        const windowResult = await (window as any).__MAIN_E2E_DISK_READ_WINDOW(path, {
          startLine: args?.startLine ?? args?.start_line,
          endLine: args?.endLine ?? args?.end_line,
          maxLines: args?.maxLines ?? args?.max_lines,
          maxChars: args?.maxChars ?? args?.max_chars,
        });
        return {
          path,
          content: String(windowResult?.content || ""),
          startLine: Number(windowResult?.startLine || 0),
          endLine: Number(windowResult?.endLine || 0),
          totalLines: Number(windowResult?.totalLines || 0),
          totalChars: Number(windowResult?.totalChars || 0),
          returnedChars: Number(windowResult?.returnedChars || 0),
          truncated: Boolean(windowResult?.truncated),
          nextStartLine: windowResult?.nextStartLine ?? null,
        };
      }
      if (cmd === "read_document") {
        const path = String(args?.path || "");
        return {
          path,
          documentType: "csv",
          title: null,
          sourceName: path,
          content: await readText(path),
          truncated: false,
          metadata: {},
        };
      }
      if (cmd === "analyze_tabular_document") {
        return {
          sourceName: String(args?.path || ""),
          documentType: "csv",
          metadata: {
            rowCount: 2,
            columnCount: 2,
            columns: ["creator", "amount"],
            numericColumns: ["amount"],
            categoricalColumns: ["creator"],
            datetimeColumns: [],
          },
          sampleRows: {
            head: [{ creator: "alice", amount: "12" }],
            tail: [{ creator: "alice", amount: "12" }],
          },
        };
      }
      if (cmd === "query_tabular_document") {
        return {
          path: String(args?.path || ""),
          columns: ["creator", "amount"],
          rows: [{ creator: "alice", amount: "12" }],
          totalRows: 1,
          returnedRows: 1,
        };
      }
      if (cmd === "get_file_metadata") {
        const path = String(args?.path || "");
        return await (window as any).__MAIN_E2E_DISK_METADATA(path);
      }
      if (cmd === "write_file" || cmd === "write_file_atomic") {
        await writeText(String(args?.path || ""), String(args?.content || ""));
        return null;
      }
      if (cmd === "shell_permission_preflight") {
        const command = String(args?.command || "");
        return {
          command,
          decision: "allow",
          source: "e2e",
          segmentDecisions: [{
            command,
            decision: "allow",
            riskLevel: "low",
          }],
          riskLevel: "low",
          requiresApproval: false,
        };
      }
      if (cmd === "browser_evaluate") {
        // This fixture validates MAIN's orchestration/evidence contract only.
        // Real HTTP navigation and action semantics are exercised separately
        // by browser-evaluate-script.test.mjs against an actual local server.
        const mutationState = await (window as any).__MAIN_E2E_INSPECT_FIXTURE_MUTATION();
        const splitDirectives = (value: unknown) => String(value || "")
          .split(/\r?\n|;;/g)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
        const parseDirective = (line: string, fallbackKind: string) => {
          const matched = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*([\s\S]*)$/);
          return matched
            ? { kind: String(matched[1]).toLowerCase().replace(/[\s-]+/g, "_"), value: String(matched[2] || "").trim() }
            : { kind: fallbackKind, value: line };
        };
        const roleFor = (value: string) => value.match(/(?:^|[^a-z])(new|open|save)(?:[^a-z]|$)/i)?.[1]?.toLowerCase() || "";
        const actionRows = splitDirectives(args?.actions).map((line, index) => {
          const directive = parseDirective(line, "click");
          const role = roleFor(directive.value);
          const stateful = ["click", "fill", "press", "select_file", "set_input_files", "upload"].includes(directive.kind);
          const ok = !stateful || (mutationState.satisfied === true && Boolean(role));
          return {
            id: `action-${index + 1}`,
            kind: directive.kind,
            value: directive.value,
            ok,
            beforeState: stateful ? { bodyText: "New Open Save", externalDomFingerprint: "before" } : null,
            afterState: stateful && ok
              ? { bodyText: `New Open Save ${role}`, externalDomFingerprint: `after-${role}` }
              : null,
            stateChanged: stateful && ok,
            changedFields: stateful && ok ? ["bodyText", "externalDomFingerprint"] : [],
            nativeChangedFields: [],
            effectChangedFields: stateful && ok ? ["bodyText", "externalDomFingerprint"] : [],
            effectStateChanged: stateful && ok,
          };
        });
        const assertionRows = splitDirectives(args?.checks).map((line) => {
          const directive = line.toLowerCase().replace(/[\s-]+/g, "_") === "no_console_errors"
            ? { kind: "no_console_errors", value: "" }
            : parseDirective(line, "text");
          if (directive.kind === "no_console_errors") {
            return {
              kind: directive.kind,
              value: directive.value,
              passed: true,
              detail: "no console errors",
              beforePassed: true,
              changedAfterAction: false,
              afterActionId: null,
              causallyLinked: false,
            };
          }
          const role = roleFor(directive.value);
          const linkedAction = actionRows.find((action) =>
            action.ok && role && roleFor(String(action.value || "")) === role
          );
          const effectKind = ["text", "not_text", "selector", "not_selector"].includes(directive.kind);
          const passed = Boolean(linkedAction && effectKind);
          return {
            kind: directive.kind,
            value: directive.value,
            passed,
            detail: passed ? "post-action fixture state observed" : "no matching successful fixture action",
            beforePassed: false,
            changedAfterAction: passed,
            afterActionId: linkedAction?.id || null,
            causallyLinked: passed,
          };
        });
        const ok = mutationState.satisfied === true &&
          actionRows.every((action) => action.ok) &&
          assertionRows.every((assertion) => assertion.passed);
        return {
          ok,
          url: String(args?.url || ""),
          finalUrl: String(args?.url || ""),
          status: 200,
          title: "Real OMLX fixture",
          actions: actionRows,
          assertions: assertionRows,
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          textPreview: fixture === "md-viewer" ? "New Open Save" : "creatorName",
          durationMs: 1,
        };
      }
      if (cmd === "run_command") {
        return await (window as any).__MAIN_E2E_RUN_VERIFICATION(String(args?.command || args?.cmd || ""));
      }
      return null;
    };
  }, {
    workspace,
    endpoint: omlxEndpoint,
    apiKey: omlxApiKey,
    devServerUrl: realOmlxDevServerUrl,
    fixture: realOmlxFixture,
    limits: REAL_OMLX_WORKSPACE_PROXY_LIMITS,
  });
});

async function attachRealOmlxFailureDiagnostics(
  page: Page,
  testInfo: TestInfo,
  workspace: string,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  let snapshot: any = null;
  let presentation: any = null;
  let fixture: any = null;
  try {
    ({ snapshot, presentation } = await page.evaluate(() => {
      const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.() || null;
      const capsule = document.querySelector<HTMLElement>(
        '[data-testid="agent-explanation-capsule"]',
      );
      const visibleProgress = [...document.querySelectorAll<HTMLElement>(
        '[data-testid="progress-block"]',
      )].map((node) => ({
        visible: node.getClientRects().length > 0,
        phase: node.dataset.phase || "",
        status: node.dataset.status || "",
        text: String(node.textContent || "").replace(/\s+/g, " ").trim(),
      }));
      return {
        snapshot,
        presentation: {
          capsule: capsule ? {
            visible: capsule.getClientRects().length > 0,
            text: String(capsule.textContent || "").replace(/\s+/g, " ").trim(),
            guidanceSource: capsule.dataset.guidanceSource || "",
            status: capsule.dataset.capsuleStatus || "",
            turnId: capsule.dataset.turnId || "",
            runId: capsule.dataset.runId || "",
            updatedAt: capsule.dataset.guidanceUpdatedAt || "",
          } : null,
          processTimelineVisible:
            document.querySelector<HTMLElement>('[data-testid="live-turn-process-timeline"]')
              ?.getClientRects().length > 0,
          progress: visibleProgress,
        },
      };
    }));
  } catch (error) {
    presentation = {
      pageInspectionError: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    await fs.access(workspace);
    const inspected = await inspectFixtureMutation(workspace);
    const fileHashes = Object.fromEntries(
      Object.entries(inspected.contents).map(([relativePath, content]) => [
        relativePath,
        {
          bytes: Buffer.byteLength(content, "utf8"),
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ]),
    );
    fixture = {
      workspace,
      satisfied: inspected.satisfied,
      detail: inspected.detail,
      fileHashes,
    };
  } catch (error) {
    fixture = {
      workspace,
      inspectionError: error instanceof Error ? error.message : String(error),
    };
  }
  const attachments = [
    {
      name: "runtime-v2-ledger",
      value: {
        testStatus: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        identity: {
          currentTurnId: snapshot?.currentTurnId || null,
          currentTurnStatus: snapshot?.currentTurnStatus || null,
          currentTurnIntent: snapshot?.currentTurnIntent || null,
          agentStatus: snapshot?.agentStatus || null,
          isGenerating: snapshot?.isGenerating ?? null,
        },
        admission: snapshot?.lastWorkspaceInstructionAcceptance || null,
        runtimeV2: snapshot?.runtimeV2 || null,
      },
    },
    {
      name: "runtime-v2-debug",
      value: {
        runtimeV2: snapshot?.runtimeV2?.debug || [],
        terminalAndErrors: (snapshot?.debugTail || []).filter((entry: { source?: string }) =>
          /runtime_v2|terminal|error|failed|crash|timeout|watchdog/i.test(
            String(entry?.source || ""),
          )
        ).slice(-400),
      },
    },
    {
      name: "runtime-v2-presentation",
      value: {
        ledgerProjection: snapshot?.runtimeV2?.presentation || null,
        browser: presentation,
        taskFlow: (snapshot?.taskFlowPreview || []).filter((block: { turnId?: string }) =>
          block.turnId === snapshot?.currentTurnId
        ),
      },
    },
    {
      name: "fixture-state",
      value: fixture,
    },
  ];
  for (const attachment of attachments) {
    await testInfo.attach(`${attachment.name}.json`, {
      body: Buffer.from(JSON.stringify(attachment.value, null, 2), "utf8"),
      contentType: "application/json",
    });
  }
}

// A caller-provided fixture is never owned by this test. Generated fixtures
// are removed by default so repeated real-model runs do not leave a growing
// collection of stale workspaces; opt in when a failed case needs inspection.
test.afterEach(async ({ page }, testInfo) => {
  const workspace = String((page as any).__realOmlxWorkspace || "").trim();
  if (workspace) {
    await attachRealOmlxFailureDiagnostics(page, testInfo, workspace);
  }
  if (String(process.env.REAL_OMLX_WORKSPACE || "").trim()) return;
  if (process.env.MAIN_KEEP_REAL_OMLX_FIXTURE === "1") return;
  if (!workspace) return;
  await fs.rm(workspace, { recursive: true, force: true });
});

for (const model of models) {
  test(`real OMLX MAIN plan/approve/execute reaches one structural terminal outcome with ${model}`, async ({ page }) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    const originalMutationContents = await readFixtureMutationContents(workspace);
    const originalPlanOnlyWorkspaceFingerprint = realOmlxPlanOnly
      ? await fingerprintPlanOnlyWorkspace(workspace)
      : "";
    const replayImages = await loadRealOmlxReplayImages();
    const approvedBrowserRequestIds = new Set<string>();
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[real-omlx-invoke] append_debug_log")) return;
      console.log(`[browser:${message.type()}] ${text}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[browser:pageerror] ${error.message}`);
    });
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);

    const immediateAdmissionSnapshot = await page.evaluate(async ({ text, images, preferSubagents }) => {
      const bridge = (window as any).__CODELY_E2E__;
      if (preferSubagents) bridge?.setPreferSubagents?.(true);
      try {
        await Promise.resolve(bridge?.sendCloudMessage?.(text, images));
      } catch (error) {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      }
      return bridge?.getSnapshot?.();
    }, {
      text: realOmlxRequest,
      images: replayImages,
      preferSubagents: realOmlxPreferSubagents,
    });

    const admittedPlanTurnId = assertFirstPlanWorkspaceTurnAdmission(
      immediateAdmissionSnapshot,
    );
    expect((immediateAdmissionSnapshot?.conversationTurnPreview || []).find(
      (turn: { id?: string }) => turn.id === admittedPlanTurnId,
    )?.runtimeEngineVersion).toBe("v2");

    let lastPlanPollSignature = "";
    let lastPlanTerminalSignature = "";
    let lastPlanDebugSignature = "";
    try {
      await expect
        .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        const planPollDiagnostic = {
          agentStatus: snapshot?.agentStatus,
          isGenerating: snapshot?.isGenerating,
          currentTurnStatus: snapshot?.currentTurnStatus,
          planStage: snapshot?.planStage,
          runtimePhase: snapshot?.runtimeV2?.phase || null,
          workPlanStatus: snapshot?.runtimeV2?.workPlan?.status || null,
          hasReviewCommit: Boolean(snapshot?.runtimeV2?.planReviewCommit),
        };
        const planPollSignature = JSON.stringify(planPollDiagnostic);
        if (planPollSignature !== lastPlanPollSignature) {
          console.log(`[real-omlx-plan-poll:${model}] ${planPollSignature.slice(0, 1_000)}`);
          lastPlanPollSignature = planPollSignature;
        }
        const debugDigest = summarizePlanDebugTail(snapshot?.debugTail || []);
        const debugSignature = JSON.stringify(debugDigest);
        if (debugSignature && debugSignature !== "[]" && debugSignature !== lastPlanDebugSignature) {
          console.log(`[real-omlx-plan-runtime:${model}] ${debugSignature.slice(-6_000)}`);
          lastPlanDebugSignature = debugSignature;
        }
        if (snapshot?.dispatchError) throw new Error(`dispatch_error:${snapshot.dispatchError}`);
        if (
          snapshot?.runtimeV2?.phase === "reviewing" &&
          snapshot?.runtimeV2?.workPlan?.status === "pending_review" &&
          snapshot?.runtimeV2?.sealedWorkPlan?.status === "pending_review" &&
          snapshot?.runtimeV2?.planReviewCommit &&
          snapshot?.isGenerating === false &&
          snapshot?.agentStatus === "pending_review" &&
          snapshot?.currentTurnStatus === "awaiting_approval" &&
          reviewablePlanStages.has(String(snapshot?.planStage || ""))
        ) {
          return "artifact_ready";
        }
        if (
          snapshot?.isGenerating === false &&
          snapshot?.runtimeV2?.terminal?.exactlyOnce === true &&
          !snapshot?.runtimeV2?.planReviewCommit
        ) {
          const terminal =
            `terminal_without_v2_review:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}`;
          if (terminal !== lastPlanTerminalSignature) {
            console.log(`[real-omlx-plan-terminal:${model}] ${terminal}`);
            console.log(`[real-omlx-plan-debug:${model}] ${JSON.stringify(summarizePlanDebugTail(snapshot?.debugTail || []))}`);
            console.log(`[real-omlx-plan-flow:${model}] ${JSON.stringify(snapshot?.taskFlowPreview || [])}`);
            lastPlanTerminalSignature = terminal;
          }
          throw new Error(terminal);
        }
        return "running";
      }, { timeout: realOmlxPlanTimeoutMs })
      .toBe("artifact_ready");
    } catch (error) {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      console.log(`[real-omlx-plan-timeout-debug:${model}] ${JSON.stringify(summarizePlanDebugTail(snapshot?.debugTail || [])).slice(-12_000)}`);
      console.log(`[real-omlx-plan-timeout-runtime-v2:${model}] ${JSON.stringify(snapshot?.runtimeV2?.debug || []).slice(-12_000)}`);
      console.log(`[real-omlx-plan-timeout-flow:${model}] ${JSON.stringify(snapshot?.taskFlowPreview || []).slice(-12_000)}`);
      throw error;
    }

    const planSnapshot = await page.evaluate(() =>
      (window as any).__CODELY_E2E__?.getSnapshot?.()
    );
    const planRuntime = expectRuntimeV2PlanReviewContract(planSnapshot, {
      turnId: admittedPlanTurnId,
    });
    const sealedWorkPlan = planRuntime.sealedWorkPlan;
    const reviewCommit = planRuntime.planReviewCommit;
    const plan = String(sealedWorkPlan.markdown || "");
    const planTaskQualityGaps = isMdViewerSavePathIncident
      ? getMdViewerWorkPlanGaps(sealedWorkPlan)
      : [
          ...(realOmlxPlanExpectation.test(plan)
            ? []
            : [`plan does not match ${realOmlxPlanExpectation.source}`]),
          ...realOmlxPlanExpectAll.flatMap((expectation) =>
            expectation.test(plan)
              ? []
              : [`plan does not match ${expectation.source}`]
          ),
        ];
    console.log(`[real-omlx-task-quality-plan:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      gaps: planTaskQualityGaps,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(
        planTaskQualityGaps,
        "Optional task-quality oracle rejected the model-authored plan.",
      ).toEqual([]);
    }
    expect(plan).not.toMatch(/用户目标：\s*(?:\n|$)/);
    expect(plan).not.toMatch(/以落实已批准目标|落实已批准方案中涉及|Apply the approved plan change/i);
    expect(plan).not.toMatch(/直接相关的最小改动|写入前先用证据确认|依据证据：已搜索文件|依据证据：已查看目录/i);
    expect(plan).not.toMatch(/(?:已读证据|证据引用|Read Evidence)[\s\S]{0,800}\.MAIN\/plans\/plan\.md/i);
    expect(planSnapshot?.planArtifacts || []).toHaveLength(0);
    expect(sealedWorkPlan.draft.validations.some(
      (validation: { kind?: string; required?: boolean }) =>
        validation.required === true &&
        ["finite_command", "browser", "desktop"].includes(
          String(validation.kind || ""),
        ),
    )).toBe(true);
    if (requireSemanticTaskQuality) {
      expect(sealedWorkPlan.draft.validations.some(
        (validation: { command?: string; kind?: string; required?: boolean }) =>
          validation.kind === "finite_command" &&
          validation.required === true &&
          isFinitePlanValidationCommand(String(validation.command || "")),
      )).toBe(true);
    }
    const workPlanEvidenceTargets = new Set(
      sealedWorkPlan.evidence.map(
        (entry: { target: string }) => String(entry.target || "").trim(),
      ),
    );
    expect(sealedWorkPlan.evidence.some(
      (entry: { target?: string; version?: string }) =>
        String(entry.target || "").trim().length > 0 &&
        String(entry.version || "").trim().length > 0,
    )).toBe(true);
    const missingConfiguredEvidenceTargets = realOmlxPlanEvidenceTargets.filter(
      (target) => !workPlanEvidenceTargets.has(target),
    );
    console.log(`[real-omlx-task-quality-evidence:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      missingTargets: missingConfiguredEvidenceTargets,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(
        missingConfiguredEvidenceTargets,
        "Optional task-quality oracle requires exact configured evidence targets.",
      ).toEqual([]);
    }
    const persistedPlan = await fs.readFile(
      path.join(workspace, reviewCommit.artifact.path),
      "utf8",
    );
    expect(persistedPlan).toBe(plan);
    expect(reviewCommit.artifact.content).toBe(plan);
    await expect(page.getByTestId("plan-review-panel")).toBeVisible();
    await expect(page.getByTestId("plan-review-panel")).toContainText(
      sealedWorkPlan.draft.objective,
    );
    const planMilestoneHeading = String(reviewCommit.chat.markdown || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
      .find(Boolean) || sealedWorkPlan.draft.objective;
    const visiblePlanMilestone = page.locator(
      `[data-testid="assistant-update"][data-turn-id="${admittedPlanTurnId}"]`,
    ).filter({ hasText: planMilestoneHeading }).last();
    await expect(visiblePlanMilestone).toBeVisible();
    expect(reviewablePlanStages.has(String(planSnapshot?.planStage || ""))).toBe(true);
    const planChatText = (planRuntime.presentation?.chatMilestones || [])
      .map((milestone: { markdown?: string }) => String(milestone.markdown || ""))
      .join("\n");
    console.log(`[real-omlx-plan-artifact:${model}]\n${plan}`);
    console.log(`[real-omlx-chat-plan:${model}] ${planChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(planChatText.trim().length).toBeGreaterThan(0);
    if (requireSemanticTaskQuality) {
      expect(planChatText).toMatch(realOmlxPlanOnly
        ? /read_file|grep_search|code_ast_query|读取|搜索|计划|根因|修复/i
        : realOmlxFixture === "md-viewer"
        ? /read_file|list_directory|读取|计划|main\.js|toolbar|按钮/i
        : /read_file|list_directory|读取|计划|CSV|useCsvParser|creator/i);
    }
    expect(planChatText).not.toMatch(forbiddenChatNoise);
    if (expectAgentExplanation) {
      expect((planSnapshot?.agentTexts || []).join("\n")).toMatch(
        realOmlxFixture === "md-viewer"
          ? /问题|分析|修复|toolbar|按钮|main\.js/i
          : /问题|分析|修复|Dashboard|CSV|深色|creator/i,
      );
    }

    if (realOmlxPlanOnly) {
      await expect.poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
        if (snapshot?.isGenerating === false && snapshot?.agentStatus === "pending_review") {
          return "pending_review";
        }
        if (snapshot?.isGenerating === false) {
          return `terminal_without_review:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}`;
        }
        return "running";
      }, { timeout: 120_000 }).toBe("pending_review");
      const finalPlanSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      expect(finalPlanSnapshot?.agentStatus).toBe("pending_review");
      expect(finalPlanSnapshot?.currentTurnStatus).toBe("awaiting_approval");
      expect(finalPlanSnapshot?.currentTurnId).toBe(admittedPlanTurnId);
      expect(String(finalPlanSnapshot?.currentTurnTitle || "").trim()).not.toBe("");
      expect(finalPlanSnapshot?.currentTurnIntent).toBe("plan");
      expect(finalPlanSnapshot?.planArtifacts || []).toHaveLength(0);
      const finalPlanRuntime = expectRuntimeV2PlanReviewContract(finalPlanSnapshot, {
        turnId: admittedPlanTurnId,
      });
      expect(finalPlanRuntime.sealedWorkPlan.digest).toBe(sealedWorkPlan.digest);
      expect(finalPlanRuntime.planReviewCommit).toEqual(reviewCommit);
      expect(reviewablePlanStages.has(String(finalPlanSnapshot?.planStage || ""))).toBe(true);
      expect(JSON.stringify(finalPlanSnapshot?.debugTail || [])).not.toMatch(
        /plan_generation_failed|plan_evidence_materialization_exhausted/i,
      );
      expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(originalPlanOnlyWorkspaceFingerprint);
      if (requireSemanticTaskQuality && isMdViewerSavePathIncident) {
        expect(
          getMdViewerWorkPlanGaps(finalPlanRuntime.sealedWorkPlan),
          "Optional task-quality oracle requires the review authority to retain the expected repair graph.",
        ).toEqual([]);
        if (/\bopenFile\b/.test(plan)) {
          expect(plan).toMatch(/openFile[^\n]{0,180}(?:未被调用|无调用|无引用|非主因|死代码|not\s+(?:called|referenced|the\s+cause)|dead\s+code)/i);
        }
      }
      return;
    }

    const approvalDispatch = await page.evaluate(() => {
      const bridge = (window as any).__CODELY_E2E__;
      const result = bridge?.approvePlan?.();
      Promise.resolve(result).catch((error) => {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      });
      return result;
    });
    console.log(`[real-omlx-approval-dispatch:${model}] ${JSON.stringify(approvalDispatch).slice(0, 2_000)}`);

    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
      const runtime = snapshot?.runtimeV2;
      return (
        snapshot?.isPlanApproved === true &&
        runtime?.turnId === admittedPlanTurnId &&
        runtime?.workPlan?.status === "approved" &&
        runtime?.eventTypes?.includes("work_plan.approved") &&
        [
          "preparing",
          "observing",
          "acting",
          "validating",
          "finalizing",
          "completed",
        ].includes(String(runtime?.phase || ""))
      )
        ? "execution_started"
        : `waiting:${runtime?.phase}:${runtime?.workPlan?.status}:${snapshot?.isGenerating}`;
    }, { timeout: 30_000 }).toBe("execution_started");

    let earlyExecutionSnapshot: any = null;
    try {
      await expect
        .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        earlyExecutionSnapshot = snapshot;
        if (snapshot?.dispatchError) throw new Error(`dispatch_error:${snapshot.dispatchError}`);
        if (
          isInScopeBrowserPermission(snapshot?.activeActionRequest, workspace) &&
          await approveInScopeBrowserPermission(page, snapshot.activeActionRequest, workspace)
        ) {
          const requestId = String(snapshot.activeActionRequest.requestId);
          if (!approvedBrowserRequestIds.has(requestId)) {
            approvedBrowserRequestIds.add(requestId);
            console.log(`[real-omlx-browser-approval:${model}] ${requestId}`);
          }
          return "running";
        }
        const mutationState = await inspectFixtureMutation(workspace, originalMutationContents);
        if (mutationState.changedFiles.length > 0) return "mutated";
        if (snapshot?.runtimeV2?.terminal?.exactlyOnce === true) {
          console.log(
            `[real-omlx-execute-safe-pause:${model}] ${
              JSON.stringify(runtimeV2FailureDiagnostic(snapshot?.runtimeV2))
            }`,
          );
          return "safe_pause";
        }
        return "running";
        }, { timeout: realOmlxExecutionTimeoutMs })
        .toMatch(/^(?:mutated|safe_pause)$/);
    } catch (error) {
      const snapshot = earlyExecutionSnapshot || await page.evaluate(() =>
        (window as any).__CODELY_E2E__?.getSnapshot?.()
      );
      console.log(`[real-omlx-execute-timeout:${model}] ${JSON.stringify({
        agentStatus: snapshot?.agentStatus,
        currentTurnStatus: snapshot?.currentTurnStatus,
        planStage: snapshot?.planStage,
        activeActionRequest: snapshot?.activeActionRequest,
        runtimeV2: snapshot?.runtimeV2,
      }).slice(-40_000)}`);
      throw error;
    }

    const mutationAfterEarlyOutcome = await inspectFixtureMutation(workspace, originalMutationContents);
    if (realOmlxPreferSubagents) {
      expectRuntimeV2ReadOnlyCollaboration(
        earlyExecutionSnapshot?.runtimeV2,
      );
    }
    if (mutationAfterEarlyOutcome.changedFiles.length === 0) {
      expect(mutationAfterEarlyOutcome.contents).toEqual(originalMutationContents);
      const resultKind = String(
        earlyExecutionSnapshot?.runtimeV2?.terminalOutcome?.resultKind || "",
      ) as "success" | "partial" | "blocked" | "error" | "canceled";
      expect(resultKind).not.toBe("success");
      expectCanonicalRuntimeV2Terminal(earlyExecutionSnapshot, {
        turnId: admittedPlanTurnId,
        resultKind,
        strategy: "plan",
      });
      console.log(`[real-omlx-task-quality-execute:${model}] ${JSON.stringify({
        required: requireSemanticTaskQuality,
        resultKind,
        gaps: [mutationAfterEarlyOutcome.detail],
      })}`);
      return;
    }

    expect(mutationAfterEarlyOutcome.changedFiles.length).toBeGreaterThan(0);
    console.log(`[real-omlx-task-quality-execute:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      satisfied: mutationAfterEarlyOutcome.satisfied,
      changedFiles: mutationAfterEarlyOutcome.changedFiles,
      detail: mutationAfterEarlyOutcome.detail,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(
        mutationAfterEarlyOutcome.satisfied,
        `Optional task-quality oracle rejected the workspace outcome:\n${mutationAfterEarlyOutcome.detail}`,
      ).toBe(true);
    }

    let terminalExecutionSnapshot: any = null;
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        if (
          isInScopeBrowserPermission(snapshot?.activeActionRequest, workspace) &&
          await approveInScopeBrowserPermission(page, snapshot.activeActionRequest, workspace)
        ) {
          const requestId = String(snapshot.activeActionRequest.requestId);
          if (!approvedBrowserRequestIds.has(requestId)) {
            approvedBrowserRequestIds.add(requestId);
            console.log(`[real-omlx-browser-approval:${model}] ${requestId}`);
          }
          return "running";
        }
        if (snapshot?.runtimeV2?.terminal?.exactlyOnce === true) {
          terminalExecutionSnapshot = snapshot;
          return "completed";
        }
        return "running";
      }, { timeout: 300_000 })
      .toBe("completed");

    const executionResultKind = String(
      terminalExecutionSnapshot?.runtimeV2?.terminalOutcome?.resultKind || "",
    ) as "success" | "partial" | "blocked" | "error" | "canceled";
    if (executionResultKind !== "success") {
      console.log(
        `[real-omlx-execute-terminal:${model}] ${
          JSON.stringify(runtimeV2FailureDiagnostic(terminalExecutionSnapshot?.runtimeV2))
        }`,
      );
      expectCanonicalRuntimeV2Terminal(terminalExecutionSnapshot, {
        turnId: admittedPlanTurnId,
        resultKind: executionResultKind,
        strategy: "plan",
      });
      return;
    }

    const bodyText = await page.locator("body").innerText();
    const executionSnapshot = terminalExecutionSnapshot;
    const executionRuntime = expectCanonicalRuntimeV2Terminal(executionSnapshot, {
      turnId: admittedPlanTurnId,
      resultKind: "success",
      strategy: "plan",
    });
    expectSuccessfulPlanExecutionOrder(executionRuntime);
    expect(executionRuntime.workPlan).toMatchObject({
      ...reviewCommit.authority,
      status: "approved",
    });
    expect(executionRuntime.sealedWorkPlan).toEqual(sealedWorkPlan);
    expect(executionRuntime.planReviewCommit).toEqual(reviewCommit);
    const executionChatText = [
      ...(executionRuntime.presentation?.chatMilestones || []).map(
        (entry: { markdown?: string }) => String(entry.markdown || ""),
      ),
      ...(executionRuntime.presentation?.finals || []).map(
        (entry: { markdown?: string }) => String(entry.markdown || ""),
      ),
    ].join("\n");
    console.log(`[real-omlx-chat-execute:${model}] ${executionChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(executionChatText.trim().length).toBeGreaterThan(0);
    if (requireSemanticTaskQuality) {
      expect(executionChatText).toMatch(/已完成|完成|修改|修复|验证|completed|validated/i);
    }
    const mutationCommands = (executionRuntime.commands || []).filter(
      (command: { kind?: string; toolName?: string; status?: string }) =>
        command.kind === "execute_tool" &&
        ["apply_patch", "replace_in_file", "write_file", "write_file_atomic"].includes(
          String(command.toolName || ""),
        ) &&
        command.status === "succeeded",
    );
    expect(mutationCommands.length).toBeGreaterThan(0);
    expect(mutationCommands.every((command: { idempotencyKey?: string }) =>
      (executionRuntime.receipts || []).some((receipt: {
        idempotencyKey?: string;
        kind?: string;
        status?: string;
      }) =>
        receipt.idempotencyKey === command.idempotencyKey &&
        receipt.kind === "execute_tool" &&
        receipt.status === "succeeded"
      )
    )).toBe(true);
    expect(executionRuntime.evidence.some((entry: { kind?: string; target?: string }) =>
      entry.kind === "mutation" &&
      mutationAfterEarlyOutcome.changedFiles.some((file) =>
        String(entry.target || "").includes(file)
      )
    )).toBe(true);
    const successfulValidations = (executionRuntime.commands || []).filter(
      (command: { kind?: string; status?: string }) =>
        command.kind === "execute_validation" && command.status === "succeeded",
    );
    expect(successfulValidations.length).toBeGreaterThan(0);
    expect(successfulValidations.every((command: { idempotencyKey?: string }) =>
      (executionRuntime.receipts || []).some((receipt: {
        idempotencyKey?: string;
        kind?: string;
        status?: string;
      }) =>
        receipt.idempotencyKey === command.idempotencyKey &&
        receipt.kind === "execute_validation" &&
        receipt.status === "succeeded"
      )
    )).toBe(true);
    expect(executionRuntime.events.some(
      (event: { type?: string; passed?: boolean }) =>
        event.type === "validation.completed" && event.passed === true,
    )).toBe(true);
    expect(executionRuntime.evidence.some(
      (entry: { kind?: string }) => entry.kind === "validation",
    )).toBe(true);
    const finiteValidation = [...successfulValidations].reverse().find(
      (command: { toolName?: string; target?: string }) =>
        command.toolName === "run_command" &&
        isFinitePlanValidationCommand(String(command.target || "")),
    );
    if (requireSemanticTaskQuality) expect(finiteValidation).toBeTruthy();
    if (finiteValidation) {
      const validationCommand = String(finiteValidation.target || "");
      const independentValidation = await runRealOmlxWorkspaceCommand(
        workspace,
        validationCommand,
      );
      expect(
        independentValidation.exitCode,
        [
          `Independent replay validation failed: ${validationCommand}`,
          independentValidation.stdout,
          independentValidation.stderr,
        ].filter(Boolean).join("\n"),
      ).toBe(0);
    }
    if (requireSemanticTaskQuality && realOmlxFixture === "md-viewer") {
      expect(successfulValidations.some(
        (command: { toolName?: string }) => command.toolName === "browser_evaluate",
      )).toBe(true);
      expect(getMdViewerExecutionGaps({
        caller: await fs.readFile(path.join(workspace, "src/main.js"), "utf8"),
        editor: await fs.readFile(path.join(workspace, "src/components/editor.js"), "utf8"),
        handler: await fs.readFile(path.join(workspace, "src-tauri/src/main.rs"), "utf8"),
        toolbar: await fs.readFile(path.join(workspace, "src/components/toolbar.js"), "utf8"),
      })).toEqual([]);
    }
    expect(JSON.stringify(executionRuntime.debug || [])).not.toMatch(
      /READ_FILE_NOT_AVAILABLE_IN_RECOVERY|DEV_SERVER_NOT_READY|server (?:is )?occupied/i,
    );
    expect(executionChatText).not.toMatch(forbiddenChatNoise);
    const terminalTurnId = String(executionSnapshot?.currentTurnId || "");
    expect(terminalTurnId).toBe(admittedPlanTurnId);
    expect(executionRuntime.presentation?.finals || []).toHaveLength(1);
    const finalMarkdown = String(
      executionRuntime.presentation.finals[0]?.markdown || "",
    );
    expect(finalMarkdown.trim().length).toBeGreaterThan(0);
    if (requireSemanticTaskQuality) {
      expect(finalMarkdown).toMatch(
        /完成|修改|修复|验证|passed|updated|fixed|implemented|validated/i,
      );
    }
    expect(finalMarkdown).not.toContain("agent_loop_completed");
    await expect(page.locator(
      `[data-testid="assistant-final"][data-turn-id="${terminalTurnId}"]`,
    )).toBeVisible();
    expect(bodyText).not.toMatch(forbiddenChatNoise);
  });

  test(`real OMLX Direct Edit repairs a failed finite validation with ${model}`, async ({ page }) => {
    test.skip(!runDirectEditRecovery || realOmlxFixture !== "csv");
    const workspace = (page as any).__realOmlxWorkspace as string;
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    await page.evaluate(async () => {
      await (window as any).__MAIN_E2E_REQUIRE_DIRECT_EDIT_REPAIR?.();
      const bridge = (window as any).__CODELY_E2E__;
      Promise.resolve(bridge?.sendDirectEditMessage?.(
        "直接修改 src/hooks/useCsvParser.ts，把 CSV creator 映射为 Dashboard 使用的 creatorName，并用 npm test 验证直到通过。不要生成计划。",
      )).catch((error) => {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      });
    });

    let terminalSnapshot: any = null;
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
      if (snapshot?.isGenerating === false) {
        terminalSnapshot = snapshot;
        return "terminal";
      }
      return "running";
    }, { timeout: realOmlxExecutionTimeoutMs }).toBe("terminal");
    console.log(`[real-omlx-direct-edit:${model}] ${JSON.stringify({
      currentTurnStatus: terminalSnapshot?.currentTurnStatus,
      agentStatus: terminalSnapshot?.agentStatus,
      toolBlocks: terminalSnapshot?.toolBlocks,
      debugTail: terminalSnapshot?.debugTail,
    }).slice(-40_000)}`);
    expect(completedTurnStatuses.has(String(terminalSnapshot?.currentTurnStatus || ""))).toBe(true);
    const terminalTurnId = String(terminalSnapshot?.currentTurnId || "");
    expect(terminalTurnId).not.toBe("");
    const finalAssistantMessage = page.locator(
      `[data-testid="assistant-final"][data-turn-id="${terminalTurnId}"]`,
    );
    await expect(finalAssistantMessage).toBeVisible();
    const finalAssistantText = String(await finalAssistantMessage.textContent() || "").trim();
    expect(finalAssistantText.length).toBeGreaterThan(0);
    expect(finalAssistantText).not.toContain("agent_loop_completed");
    expect((terminalSnapshot?.taskFlowPreview || []).some((block: { turnId?: string; type?: string; visibility?: string; content?: string }) =>
      block.turnId === terminalTurnId &&
      block.type === "agent" &&
      block.visibility === "assistant_final" &&
      String(block.content || "").trim().length > 0
    )).toBe(true);

    const source = await fs.readFile(
      path.join(workspace, "src/hooks/useCsvParser.ts"),
      "utf8",
    );
    expect(source).toMatch(/\bcreatorName\s*:/);
    expect(source).toMatch(/\bsource\??\s*:\s*string\b/);
    expect(source).toMatch(/\bsource\s*:\s*["']csv["']/);

    const snapshot = terminalSnapshot;
    const runtimeEvents = (snapshot?.debugTail || []).map((entry: { source?: string; message?: string }) => {
      try {
        return { source: entry.source, ...JSON.parse(String(entry.message || "{}")) };
      } catch {
        return { source: entry.source, message: entry.message };
      }
    });
    const failedValidationIndex = runtimeEvents.findIndex((entry: Record<string, unknown>) =>
      entry.source === "store.tool_result" &&
      entry.toolName === "run_command" &&
      entry.isError === true
    );
    const repairMutationIndex = runtimeEvents.findIndex((entry: Record<string, unknown>, index: number) =>
      index > failedValidationIndex &&
      entry.source === "store.tool_result" &&
      ["apply_patch", "replace_in_file", "write_file"].includes(String(entry.toolName || "")) &&
      entry.isError === false
    );
    const successfulValidationIndex = runtimeEvents.findIndex((entry: Record<string, unknown>, index: number) =>
      index > repairMutationIndex &&
      entry.source === "store.tool_result" &&
      entry.toolName === "run_command" &&
      entry.isError === false
    );
    expect(failedValidationIndex).toBeGreaterThanOrEqual(0);
    expect(repairMutationIndex).toBeGreaterThan(failedValidationIndex);
    expect(successfulValidationIndex).toBeGreaterThan(repairMutationIndex);
    expect(runtimeEvents.some((entry: Record<string, unknown>) =>
      entry.source === "agent.tool_calls_detected" &&
      Array.isArray(entry.names) &&
      entry.names.includes("execute_command")
    )).toBe(false);

    const debugText = JSON.stringify(snapshot?.debugTail || []);
    expect(debugText).toMatch(/direct_edit_finite_validation_requires_repair/);
    expect(debugText).toMatch(/recovery_mutation_observed/);
    expect(debugText).not.toMatch(/repeated_failure_policy_no_progress/);
  });

  test(`real OMLX Execute completes the MD Viewer incident with ${model}`, async ({ page }) => {
    test.skip(!runExecuteIncidentReplay || realOmlxFixture !== "md-viewer");
    const workspace = (page as any).__realOmlxWorkspace as string;
    const originalMutationContents = await readFixtureMutationContents(workspace);
    const originalMainSource = originalMutationContents["src/main.js"] || "";
    const replayImages = await loadRealOmlxReplayImages();
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);

    const immediateSnapshot = await page.evaluate(async ({
      text,
      images,
      preferSubagents,
    }) => {
      const bridge = (window as any).__CODELY_E2E__;
      if (preferSubagents) bridge?.setPreferSubagents?.(true);
      try {
        await bridge?.sendDirectEditMessage?.(text, images);
      } catch (error) {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      }
      return bridge?.getSnapshot?.();
    }, {
      text: realOmlxRequest,
      images: replayImages,
      // This incident is the production collaboration acceptance lane. It
      // deliberately enables the Runtime v2 read-only scheduler rather than
      // leaving overlap coverage to an optional environment flag.
      preferSubagents: true,
    });

    expect(immediateSnapshot?.dispatchError).toBeNull();
    expect(immediateSnapshot?.lastWorkspaceInstructionAcceptance?.accepted).toBe(true);
    expect(immediateSnapshot?.conversationTurns).toBe(1);
    const admittedTurnId = String(
      immediateSnapshot?.lastWorkspaceInstructionAcceptance?.receipt?.turnId || "",
    );
    const admittedTurn = (immediateSnapshot?.conversationTurnPreview || []).find(
      (turn: { id?: string }) => turn.id === admittedTurnId,
    );
    expect(admittedTurnId).not.toBe("");
    expect(admittedTurn?.intent).toBe("execute");
    expect(admittedTurn?.displayIntent).toBe("execute");
    expect(admittedTurn?.userPrompt).toBe(realOmlxRequest);
    expect(String(admittedTurn?.title || "").trim()).not.toBe("");
    expect(admittedTurn?.runtimeEngineVersion).toBe("v2");

    let observedRuntimeStart = false;
    let terminalSnapshot: any = null;
    let latestRuntimeSnapshot: any = immediateSnapshot;
    let latestActiveRuntimeSnapshot: any =
      immediateSnapshot?.runtimeV2 ? immediateSnapshot : null;
    const capsuleTimeline: Array<{
      text: string;
      source: string;
      status: string;
      runId: string;
      turnId: string;
      updatedAt: string;
    }> = [];
    const visibleTimeline: Array<{
      phase: string;
      status: string;
      text: string;
    }> = [];
    const admissionStartedAt = Date.now();
    try {
      await expect.poll(async () => {
        const observation = await page.evaluate(() => {
          const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
          const shell = document.querySelector<HTMLElement>(
            '[data-testid="agent-explanation-capsule"]',
          );
          const guidance = shell?.querySelector<HTMLElement>(
            '[data-testid="capsule-guidance-label"]',
          );
          const status = shell?.querySelector<HTMLElement>(
            '[data-testid="capsule-status-label"]',
          );
          const progress = [...document.querySelectorAll<HTMLElement>(
            [
              '[data-testid="progress-block"]',
              '[data-testid="live-turn-step"]',
              '[data-testid="turn-archive-step"]',
            ].join(','),
          )].filter((node) => node.getClientRects().length > 0).map((node) => ({
            phase: node.dataset.phase || node.dataset.kind || "",
            status: node.dataset.status || "",
            text: String(node.textContent || "").replace(/\s+/g, " ").trim(),
          }));
          return {
            snapshot,
            capsule: shell ? {
              text: String(guidance?.textContent || status?.textContent || "")
                .replace(/\s+/g, " ")
                .trim(),
              source: shell.dataset.guidanceSource || "",
              status: shell.dataset.capsuleStatus || "",
              runId: shell.dataset.runId || "",
              turnId: shell.dataset.turnId || "",
              updatedAt: shell.dataset.guidanceUpdatedAt || "",
            } : null,
            progress,
          };
        });
        const snapshot = observation?.snapshot;
        const capsule = observation?.capsule;
        if (
          capsule?.text &&
          (
            capsuleTimeline.length === 0 ||
            capsuleTimeline[capsuleTimeline.length - 1]?.text !== capsule.text ||
            capsuleTimeline[capsuleTimeline.length - 1]?.updatedAt !== capsule.updatedAt
          )
        ) {
          capsuleTimeline.push(capsule);
        }
        for (const progress of observation?.progress || []) {
          if (
            progress.text &&
            !visibleTimeline.some((entry) =>
              entry.phase === progress.phase &&
              entry.status === progress.status &&
              entry.text === progress.text
            )
          ) {
            visibleTimeline.push(progress);
          }
        }
        latestRuntimeSnapshot = snapshot;
        if (snapshot?.runtimeV2) {
          latestActiveRuntimeSnapshot = snapshot;
        }
        if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
        if (snapshot?.runtimeV2?.eventTypes?.includes("run.started")) {
          observedRuntimeStart = true;
        }
        if (
          observedRuntimeStart &&
          snapshot?.runtimeV2?.terminal?.exactlyOnce === true
        ) {
          terminalSnapshot = snapshot;
          return "terminal";
        }
        if (!observedRuntimeStart && Date.now() - admissionStartedAt > 15_000) {
          return "admitted_without_runtime_start";
        }
        return "running";
      }, { timeout: realOmlxExecutionTimeoutMs }).toBe("terminal");
    } catch (error) {
      const activeSnapshot =
        latestActiveRuntimeSnapshot || latestRuntimeSnapshot;
      console.log(`[real-omlx-execute-timeout:${model}] ${JSON.stringify({
        currentTurnStatus: latestRuntimeSnapshot?.currentTurnStatus,
        currentTurnIntent: latestRuntimeSnapshot?.currentTurnIntent,
        currentTurnTitle: latestRuntimeSnapshot?.currentTurnTitle,
        agentStatus: latestRuntimeSnapshot?.agentStatus,
        isGenerating: latestRuntimeSnapshot?.isGenerating,
        activeRuntimeV2: activeSnapshot?.runtimeV2,
        capsuleTimeline: capsuleTimeline.slice(-40),
        visibleTimeline: visibleTimeline.slice(-80),
        debugTail: (activeSnapshot?.debugTail || [])
          .filter((entry: { source?: string }) =>
            /runtime_v2|terminal|error|failed|recovery|timeout|watchdog/i.test(
              String(entry?.source || ""),
            )
          )
          .slice(-120),
      }).slice(-120_000)}`);
      throw error;
    }

    const finalFixtureState = await inspectFixtureMutation(
      workspace,
      originalMutationContents,
    );
    console.log(`[real-omlx-capsule-timeline:${model}] ${JSON.stringify(
      capsuleTimeline.slice(-40),
    ).slice(0, 30_000)}`);
    console.log(`[real-omlx-acceptance-gaps:${model}] ${JSON.stringify({
      satisfied: finalFixtureState.satisfied,
      changedFiles: finalFixtureState.changedFiles,
      detail: finalFixtureState.detail,
    })}`);
    console.log(`[real-omlx-execute-incident:${model}] ${JSON.stringify({
      currentTurnStatus: terminalSnapshot?.currentTurnStatus,
      currentTurnIntent: terminalSnapshot?.currentTurnIntent,
      currentTurnTitle: terminalSnapshot?.currentTurnTitle,
      agentStatus: terminalSnapshot?.agentStatus,
      runtimeV2: terminalSnapshot?.runtimeV2,
      capsuleTimeline: capsuleTimeline.slice(-40),
      visibleTimeline: visibleTimeline.slice(-80),
    }).slice(-40_000)}`);

    expect(completedTurnStatuses.has(String(terminalSnapshot?.currentTurnStatus || ""))).toBe(true);
    expect(terminalSnapshot?.currentTurnIntent).toBe("execute");
    expect(String(terminalSnapshot?.currentTurnTitle || "").trim()).not.toBe("");
    const terminalTurnId = String(terminalSnapshot?.currentTurnId || "");
    expect(terminalTurnId).not.toBe("");
    expect(terminalTurnId).toBe(admittedTurnId);
    const runtimeV2 = expectCanonicalRuntimeV2Terminal(terminalSnapshot, {
      turnId: terminalTurnId,
      resultKind: "success",
    });
    const finalAssistantMessage = page.locator(
      `[data-testid="assistant-final"][data-turn-id="${terminalTurnId}"]`,
    );
    await expect(finalAssistantMessage).toBeVisible();
    const finalAssistantText = String(
      await finalAssistantMessage.textContent() || "",
    ).trim();
    expect(finalAssistantText.length).toBeGreaterThan(0);
    const finalSummaryTaskQualityGaps =
      getMdViewerFinalSummaryGaps(finalAssistantText);
    console.log(`[real-omlx-task-quality-summary:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      gaps: finalSummaryTaskQualityGaps,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(
        finalSummaryTaskQualityGaps,
        `Optional task-quality oracle rejected the final summary:\n${finalAssistantText}`,
      ).toEqual([]);
    }

    const mutationCommands = (runtimeV2.commands || []).filter(
      (command: { kind?: string; toolName?: string; status?: string }) =>
        command.kind === "execute_tool" &&
        ["apply_patch", "replace_in_file", "write_file", "write_file_atomic"].includes(
          String(command.toolName || ""),
        ) &&
        command.status === "succeeded",
    );
    expect(mutationCommands.length).toBeGreaterThan(0);
    expect(runtimeV2.evidence.some((evidence: { kind?: string }) =>
      evidence.kind === "mutation"
    )).toBe(true);
    const successfulValidations = (runtimeV2.commands || []).filter(
      (command: { kind?: string; status?: string }) =>
        command.kind === "execute_validation" &&
        command.status === "succeeded",
    );
    expect(successfulValidations.length).toBeGreaterThan(0);
    expect((runtimeV2.events || []).some(
      (event: { type?: string; passed?: boolean }) =>
        event.type === "validation.completed" && event.passed === true,
    )).toBe(true);
    expect(runtimeV2.evidence.some((evidence: { kind?: string }) =>
      evidence.kind === "validation"
    )).toBe(true);
    const finalValidationBlock = [...successfulValidations].reverse().find(
      (command: { toolName?: string; target?: string }) =>
        command.toolName === "run_command" &&
        isFinitePlanValidationCommand(String(command.target || "")),
    );
    const finalValidationCommand = String(finalValidationBlock?.target || "").trim();
    if (requireSemanticTaskQuality) {
      expect(isFinitePlanValidationCommand(finalValidationCommand)).toBe(true);
    }
    if (finalValidationCommand) {
      const independentFinalValidation = await runRealOmlxWorkspaceCommand(
        workspace,
        finalValidationCommand,
      );
      expect(
        independentFinalValidation.exitCode,
        [
          `Final replay validation failed: ${finalValidationCommand}`,
          independentFinalValidation.stdout,
          independentFinalValidation.stderr,
        ].filter(Boolean).join("\n"),
      ).toBe(0);
    }

    const finalMainSource = await fs.readFile(path.join(workspace, "src/main.js"), "utf8");
    expect(finalMainSource).not.toBe(originalMainSource);
    const incidentTaskQualityGaps = getMdViewerExecutionGaps({
      caller: finalMainSource,
      editor: await fs.readFile(path.join(workspace, "src/components/editor.js"), "utf8"),
      handler: await fs.readFile(path.join(workspace, "src-tauri/src/main.rs"), "utf8"),
      toolbar: await fs.readFile(path.join(workspace, "src/components/toolbar.js"), "utf8"),
    });
    console.log(`[real-omlx-task-quality-incident:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      gaps: incidentTaskQualityGaps,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(finalMainSource).toMatch(/\bfilePath\s*:/);
      expect(finalMainSource).not.toMatch(/\bfile_path\s*:/);
      expect(incidentTaskQualityGaps).toEqual([]);
    }

    const runtimeDebugText = JSON.stringify(runtimeV2.debug || []);
    expectRuntimeV2ReadOnlyCollaboration(runtimeV2);
    expect(runtimeV2.presentation?.timeline?.length || 0).toBeGreaterThan(0);
    expect((runtimeV2.presentation?.timeline || []).every(
      (entry: { title?: string; status?: string; toolCallId?: string }) =>
        String(entry.title || "").trim().length > 0 &&
        ["done", "failed"].includes(String(entry.status || "")) &&
        String(entry.toolCallId || "").trim().length > 0,
    )).toBe(true);
    expect(visibleTimeline.length).toBeGreaterThan(0);
    expect(visibleTimeline.some((entry) => entry.text.trim().length > 0)).toBe(true);
    const concreteCapsuleTimeline = capsuleTimeline.filter((entry) =>
      entry.source !== "status" &&
      entry.text !== "正在执行" &&
      entry.text !== "Executing"
    );
    expect(concreteCapsuleTimeline.length).toBeGreaterThan(0);
    expect(new Set(concreteCapsuleTimeline.map((entry) => entry.text)).size)
      .toBeGreaterThan(1);
    expect(concreteCapsuleTimeline.some((entry) => entry.source === "runtime_v2"))
      .toBe(true);
    const commandTokens = (runtimeV2.commands || []).flatMap((command: {
      toolName?: string;
      target?: string;
    }) => [
      String(command.toolName || "").trim(),
      path.basename(String(command.target || "").trim()),
    ]).filter((token: string) => token.length >= 4);
    expect(concreteCapsuleTimeline.some((entry) =>
      commandTokens.some((token: string) => entry.text.includes(token))
    )).toBe(true);
    expect(concreteCapsuleTimeline.every((entry) =>
      entry.turnId === terminalTurnId &&
      !/(?:\.\.\.|…)\s*$/.test(entry.text)
    )).toBe(true);
    expect(concreteCapsuleTimeline
      .filter((entry) => entry.source !== "phase")
      .every((entry) =>
        entry.runId.trim().length > 0 &&
        entry.updatedAt.trim().length > 0
      )).toBe(true);
    const projectedMutations = (runtimeV2.presentation?.timeline || []).filter(
      (entry: { toolName?: string; status?: string }) =>
        /^(?:replace_in_file|write_file|apply_patch)$/.test(
          String(entry.toolName || ""),
        ) &&
        entry.status === "done",
    );
    expect(projectedMutations.some((entry: {
      diff?: { old?: string; new?: string; path?: string } | null;
    }) =>
      !!entry.diff &&
      typeof entry.diff.old === "string" &&
      typeof entry.diff.new === "string" &&
      String(entry.diff.path || "").trim().length > 0
    )).toBe(true);
    expect(runtimeDebugText).not.toMatch(
      /RUNTIME_V2_STALE_RUN_CHECKPOINT|runtime_v2_checkpoint_projection_conflict|runtime_v2_checkpoint_persist_failed|runtime_v2_tool_execution_rejected/,
    );
  });

  test(`real OMLX Goal Runtime completes with evidence or pauses safely with ${model}`, async ({ page }) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[real-omlx-invoke] append_debug_log")) return;
      console.log(`[goal-browser:${message.type()}] ${text}`);
    });
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);

    const dispatchResult = await page.evaluate(() => (window as any).__CODELY_E2E__?.sendGoalMessage?.(
      "修改 src/hooks/useCsvParser.ts，将 CSV creator 字段映射到 Dashboard 使用的 creatorName。完成标准：源码已修改且运行测试或类型检查通过；约束：保持 creator 向后兼容。可以在存在不重叠范围时开启多个 subagent 协同工作。",
    ));
    await page.waitForTimeout(1_000);
    const dispatchSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    console.log(`[real-omlx-goal-dispatch:${model}] ${JSON.stringify({
      dispatchResult,
      goalStatus: dispatchSnapshot?.goalStatus,
      agentStatus: dispatchSnapshot?.agentStatus,
      currentTurnStatus: dispatchSnapshot?.currentTurnStatus,
      iterations: dispatchSnapshot?.goalIterations,
      debug: dispatchSnapshot?.debugTail,
    }).slice(0, 6000)}`);

    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      return ["completed", "paused", "failed", "budget_exceeded"].includes(snapshot?.goalStatus || "");
    }, { timeout: 600_000 }).toBe(true);

    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    console.log(`[real-omlx-goal:${model}] ${JSON.stringify({
      status: snapshot?.goalStatus,
      pauseReason: snapshot?.goalPauseReason,
      lastError: snapshot?.goalLastError,
      iterations: snapshot?.goalIterations,
      evidence: snapshot?.goalEvidence,
      taskFlow: snapshot?.taskFlowPreview,
      debug: snapshot?.debugTail,
    }).slice(0, 12000)}`);
    expect(snapshot?.activeGoal).not.toBeNull();
    expect(snapshot?.goalIterations).toBeGreaterThan(0);
    expect(snapshot?.goalIterations).toBeLessThanOrEqual(6);

    const goalDebug = ([
      ...(dispatchSnapshot?.debugTail || []),
      ...(snapshot?.debugTail || []),
    ] as Array<{ source?: string; message?: string }>).map((entry) => {
      try {
        return { eventSource: entry.source, ...JSON.parse(entry.message || "{}") };
      } catch {
        return { eventSource: entry.source, message: entry.message };
      }
    });
    const continuationStarts = goalDebug.filter((entry) => entry.eventSource === "goal_continuation_start");
    const turnContext = goalDebug.find((entry) => entry.eventSource === "agent.turn_context_sources");
    const intake = goalDebug.find((entry) =>
      entry.eventSource === "agent.task_orchestrator_phase" && entry.phase === "INTAKE_PARSE"
    );
    expect(continuationStarts.length).toBeGreaterThan(0);
    expect(continuationStarts.every((entry) => entry.phase === "execute")).toBe(true);
    expect(turnContext).toEqual(expect.objectContaining({
      source: "goal_contract_objective",
    }));
    expect(Number(turnContext?.goalObjectiveChars || 0)).toBeGreaterThan(0);
    expect(intake).toEqual(expect.objectContaining({ subagentPreference: "preferred" }));

    const hasGoalEvent = (name: string) => goalDebug.some((entry) =>
      entry.eventSource === name || entry.eventSource === `agent.${name}`
    );
    expect(hasGoalEvent("goal_tool_result_checkpoint_completed")).toBe(true);
    expect(hasGoalEvent("goal_inner_loop_evidence_boundary")).toBe(true);
    const taskFlow = snapshot?.taskFlowPreview || [];
    const validationIndex = taskFlow
      .map((block: { toolName?: string }) => block.toolName || "")
      .lastIndexOf("run_command");
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(taskFlow.slice(validationIndex + 1).some((block: { toolName?: string }) =>
      block.toolName === "read_file" || block.toolName === "grep_search"
    )).toBe(false);

    if (process.env.REAL_OMLX_GOAL_REQUIRE_COMPLETION === "1") {
      expect(snapshot?.goalStatus).toBe("completed");
    }

    const trigger = page.getByTestId("goal-capsule-trigger");
    if (snapshot?.goalStatus === "completed") {
      const parserOnDisk = await fs.readFile(path.join(workspace, "src/hooks/useCsvParser.ts"), "utf8");
      expect(parserOnDisk).toMatch(/creatorName\s*:/);
      expect(snapshot?.goalEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "file_change", status: "passed" }),
      ]));
      expect(snapshot?.goalEvidence.some((entry: { kind?: string; status?: string }) =>
        (entry.kind === "test" || entry.kind === "build" || entry.kind === "browser") && entry.status === "passed"
      )).toBe(true);
      await expect(trigger).toHaveAttribute("data-goal-status", "completed");
      await trigger.click();
      await expect(page.getByTestId("goal-popover-panel")).toContainText("已完成");
    } else {
      expect(snapshot?.goalStatus).toBe("paused");
      expect(`${snapshot?.goalPauseReason || ""} ${snapshot?.taskFlowPreview?.map((block: { content?: string }) => block.content).join(" ") || ""}`)
        .toMatch(/STREAM_NO_VISIBLE_PROGRESS_TIMEOUT|stopped_no_action|execution_evidence_required|read.*repeat|agent_loop_error/i);
      expect(snapshot?.goalEvidence.some((entry: { kind?: string; status?: string }) =>
        entry.kind === "user_validation" && entry.status === "passed"
      )).toBe(false);
      await expect(trigger).toHaveAttribute("data-goal-status", "paused");
      await trigger.click();
      await expect(page.getByTestId("goal-popover-panel")).toContainText("已暂停");
      await expect(page.getByTestId("goal-resume-button")).toBeVisible();
    }
  });
}

const explicitSubagentModel = String(process.env.OMLX_SUBAGENT_MODEL || "").trim();
if (runRealOmlx && explicitSubagentModel && explicitSubagentModel !== models[0]) {
  throw new Error(
    "Real OMLX validation requires parent and subagents to share the one explicitly loaded model.",
  );
}
const subagentModel = explicitSubagentModel || models[0];

test(`real OMLX starts semantic collaboration after runtime admission with ${subagentModel}`, async ({ page }) => {
  await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(subagentModel)}`);
  await page.evaluate(() => (window as any).__CODELY_E2E__?.setPreferSubagents?.(true));

  const prompt = [
    "请比较 src/hooks/useCsvParser.ts 与 src/hooks/useChartData.ts 的 creatorName 数据契约，并生成一份只读整改计划。",
    "先收集两个文件的独立证据，不修改工作区。",
  ].join("\n");
  await page.evaluate((text) => {
    const bridge = (window as any).__CODELY_E2E__;
    Promise.resolve(bridge?.sendCloudMessage?.(text)).catch((error) => {
      bridge.dispatchError = error instanceof Error ? error.message : String(error);
    });
  }, prompt);

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    const debugEntries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
    const parsedDebug = debugEntries.map((entry: { source?: string; message?: string }) => {
      try {
        return { source: entry.source, ...JSON.parse(entry.message || "{}") };
      } catch {
        return { source: entry.source };
      }
    });
    return {
      dispatchError: snapshot?.dispatchError || null,
      intakePreferred: parsedDebug.some((entry: { source?: string; subagentPreference?: string }) =>
        entry.source === "agent.task_orchestrator_phase" && entry.subagentPreference === "preferred"
      ),
      admissionPreferred: parsedDebug.some((entry: {
        source?: string;
        preference?: string;
        action?: string;
      }) =>
        entry.source === "agent.delegation_admission_decision" &&
        entry.preference === "preferred" &&
        entry.action === "admit"
      ),
      spawnToolExposed: parsedDebug.some((entry: {
        source?: string;
        preference?: string;
        spawnToolExposed?: boolean;
      }) =>
        entry.source === "agent.delegation_admission_decision" &&
        entry.preference === "preferred" &&
        entry.spawnToolExposed === true
      ),
      requiredStartBoundary: parsedDebug.some((entry: {
        source?: string;
        preference?: string;
        preferredDelegationRequired?: boolean;
      }) =>
        entry.source === "agent.delegation_admission_decision" &&
        entry.preference === "preferred" &&
        entry.preferredDelegationRequired === true
      ),
      childStarted: (snapshot?.subagentRuns || []).length > 0 &&
        parsedDebug.some((entry: { source?: string }) =>
          entry.source === "agent.semantic_collaboration_task_spawned" ||
          entry.source === "subagent_started"
        ),
      assignmentPublished: parsedDebug.some((entry: { source?: string }) =>
        entry.source === "store.collaboration_assignment_published"
      ),
      assignmentVisible: (snapshot?.taskFlowPreview || []).some(
        (block: { type?: string; visibility?: string; content?: string }) =>
          block.type === "agent" &&
          block.visibility === "assistant_update" &&
          /\*\*(?:分工|Assignment)\*\*/.test(String(block.content || "")) &&
          /\*\*(?:授权范围|Authorized scope)\*\*/.test(String(block.content || "")),
      ),
      legacyForcedContract: parsedDebug.some((entry: { source?: string }) =>
        entry.source === "agent.preferred_delegation_action_contract_injected" ||
        entry.source === "agent.preferred_delegation_spawned"
      ),
    };
  }), { timeout: 180_000 }).toEqual({
    dispatchError: null,
    intakePreferred: true,
    admissionPreferred: true,
    spawnToolExposed: true,
    requiredStartBoundary: true,
    childStarted: true,
    assignmentPublished: true,
    assignmentVisible: true,
    legacyForcedContract: false,
  });

  await page.evaluate(() => (window as any).__CODELY_E2E__?.stopGeneration?.());
  await expect.poll(async () => page.evaluate(() =>
    (window as any).__CODELY_E2E__?.getSnapshot?.().isGenerating === false
  ), { timeout: 30_000 }).toBe(true);
});

test(`real OMLX adaptively admits a third subagent with ${subagentModel}`, async ({ page }) => {
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("[real-omlx-invoke] append_debug_log")) return;
    console.log(`[subagent-browser:${message.type()}] ${text}`);
  });
  page.on("pageerror", (error) => {
    console.log(`[subagent-browser:pageerror] ${error.message}`);
  });
  await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(subagentModel)}`);

  const prompt = [
    "请为 CSV creatorName 数据链路生成一个可审批的整改计划。",
    "这个任务有三个实质性且路径互不重叠的分析范围。必须先连续调用 spawn_subagent 三次；前两个按默认并发启动，第三个交给 runtime 在安全采样后弹性放行。不要在委派前读取这些文件：",
    "1. Euler：scope_key=csv-parser，scope=只分析 CSV 字段归一化，allowed_paths=src/hooks/useCsvParser.ts，expected_output=指出字段映射缺口并给出文件证据。",
    "2. Mendel：scope_key=chart-consumer，scope=只分析图表消费 creatorName 的逻辑，allowed_paths=src/hooks/useChartData.ts,src/store/dashboardStore.ts，expected_output=说明消费端契约并给出文件证据。",
    "3. Herschel：scope_key=type-contract，scope=只分析订单类型中的 creatorName 契约，allowed_paths=src/types/order.ts，expected_output=说明类型约束并给出文件证据。",
    "主体只负责读取 cn_tutorial_orders_by_creator_20260512.csv、整合三个结果和形成计划；不要重读子智能体租约路径。",
    "在输出计划前必须调用 wait_subagents 汇合三个结果。此轮只做计划，不修改文件。",
  ].join("\n");
  await page.evaluate((text) => {
    const bridge = (window as any).__CODELY_E2E__;
    Promise.resolve(bridge?.sendCloudMessage?.(text)).catch((error) => {
      bridge.dispatchError = error instanceof Error ? error.message : String(error);
    });
  }, prompt);

  let maxActiveChildren = 0;
  let maxRunningChildren = 0;
  let terminalOutcome = "running";
  let stableTerminalPolls = 0;
  let sawRunActivity = false;
  const logTerminalFailure = (snapshot: any) => {
    console.log(`[real-omlx-subagents-terminal:${subagentModel}] ${JSON.stringify({
      terminalOutcome,
      agentStatus: snapshot?.agentStatus,
      currentTurnStatus: snapshot?.currentTurnStatus,
      planStage: snapshot?.planStage,
      isGenerating: snapshot?.isGenerating,
      runs: (snapshot?.subagentRuns || []).map((run: Record<string, unknown>) => ({
        id: run.id,
        scopeKey: run.scopeKey,
        status: run.status,
        evidenceCount: run.evidenceCount,
        substantiveEvidenceCount: run.substantiveEvidenceCount,
        closureState: run.closureState,
        remainingWork: run.remainingWork,
        parentHandoff: run.parentHandoff,
        error: run.error,
      })),
      taskFlow: summarizeTaskFlowForFailure(snapshot?.taskFlowPreview),
      debug: summarizeSubagentPlanFailureDebug(snapshot?.debugTail),
    }).slice(-60_000)}`);
  };
  try {
    await expect.poll(async () => {
    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    if (snapshot?.dispatchError) {
      terminalOutcome = `dispatch_error:${snapshot.dispatchError}`;
      return true;
    }
    const runs = snapshot?.subagentRuns || [];
    if (snapshot?.isGenerating === true || runs.length > 0) sawRunActivity = true;
    maxActiveChildren = Math.max(
      maxActiveChildren,
      runs.filter((run: { status?: string }) => ["queued", "starting", "running", "summarizing"].includes(String(run.status))).length,
    );
    maxRunningChildren = Math.max(
      maxRunningChildren,
      runs.filter((run: { status?: string }) => ["starting", "running", "summarizing"].includes(String(run.status))).length,
    );
    if (
      runs.length >= 3 &&
      snapshot?.planArtifacts?.length > 0 &&
      snapshot?.isGenerating === false &&
      snapshot?.agentStatus === "pending_review" &&
      snapshot?.currentTurnStatus === "awaiting_approval" &&
      reviewablePlanStages.has(String(snapshot?.planStage || "")) &&
      runs.every((run: { status?: string }) => !["queued", "starting", "running", "summarizing"].includes(String(run.status)))
    ) {
      terminalOutcome = "joined_plan_ready";
      return true;
    }
    let observedTerminal = "";
    if (sawRunActivity && snapshot?.isGenerating === false && runs.length < 3) {
      observedTerminal = `terminal_without_three_subagents:${runs.length}:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}`;
    } else if (sawRunActivity && snapshot?.isGenerating === false && !snapshot?.planArtifacts?.length) {
      observedTerminal = `terminal_without_plan:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}`;
    } else if (
      sawRunActivity &&
      snapshot?.isGenerating === false &&
      runs.length >= 3 &&
      snapshot?.planArtifacts?.length > 0 &&
      runs.every((run: { status?: string }) => !["queued", "starting", "running", "summarizing"].includes(String(run.status))) &&
      (
        snapshot?.agentStatus !== "pending_review" ||
        snapshot?.currentTurnStatus !== "awaiting_approval" ||
        !reviewablePlanStages.has(String(snapshot?.planStage || ""))
      )
    ) {
      observedTerminal = `terminal_invalid_plan_state:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}:${snapshot?.planStage}`;
    }
    if (observedTerminal) {
      stableTerminalPolls += 1;
      terminalOutcome = observedTerminal;
      return stableTerminalPolls >= 3;
    }
    stableTerminalPolls = 0;
    terminalOutcome = `running:${runs.length}:${maxActiveChildren}`;
    return false;
    }, { timeout: 600_000 }).toBe(true);
  } catch (error) {
    const timeoutSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    terminalOutcome = `poll_timeout:${timeoutSnapshot?.currentTurnStatus}:${timeoutSnapshot?.agentStatus}:${timeoutSnapshot?.planStage}`;
    logTerminalFailure(timeoutSnapshot);
    throw error;
  }
  const terminalSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  if (terminalOutcome !== "joined_plan_ready") {
    logTerminalFailure(terminalSnapshot);
  }
  expect(terminalOutcome).toBe("joined_plan_ready");

  const snapshot = terminalSnapshot;
  expect(snapshot.agentStatus).toBe("pending_review");
  expect(snapshot.currentTurnStatus).toBe("awaiting_approval");
  expect(reviewablePlanStages.has(String(snapshot.planStage || ""))).toBe(true);
  expect(snapshot.planArtifacts[0].candidate.ingress).toBe("typed_runtime");
  expect(snapshot.planArtifacts[0].candidate.validations.some(
    (validation: { primitive: Parameters<typeof isAcceptanceCapableValidationSpec>[0] }) =>
      isAcceptanceCapableValidationSpec(validation.primitive),
  )).toBe(true);
  expect(validateSealedPlanCandidate({
    candidate: snapshot.planArtifacts[0].candidate,
    expectedContent: snapshot.planArtifacts[0].content,
  })).toEqual([]);
  expect(snapshot.planArtifacts[0].candidateHash).toBe(
    hashPlanCandidate(snapshot.planArtifacts[0].candidate),
  );
  expect(snapshot.planArtifacts[0].authoringContractId).toBe(
    snapshot.planArtifacts[0].candidate.authoringContractId,
  );
  const candidateEvidenceTargets = new Set(
    snapshot.planArtifacts[0].candidate.evidence.map(
      (entry: { target: string }) => entry.target,
    ),
  );
  for (const target of [
    "src/hooks/useCsvParser.ts",
    "src/hooks/useChartData.ts",
    "src/store/dashboardStore.ts",
    "src/types/order.ts",
  ]) {
    expect(candidateEvidenceTargets.has(target)).toBe(true);
  }
  const runs = snapshot.subagentRuns as Array<{
    id: string;
    scopeKey: string;
    status: string;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    closedAt: number | null;
    summary: string;
    evidenceCount: number;
    observationCount: number;
    substantiveEvidenceCount: number;
    closureState: string;
    remainingWork: string;
    parentHandoff: string;
    error: string;
  }>;
  const expectedScopeKeys = new Set(["csv-parser", "chart-consumer", "type-contract"]);
  const selectedRuns = runs.filter((run) => expectedScopeKeys.has(run.scopeKey));
  const debugEntries = (snapshot.debugTail || []) as Array<{ source?: string; message?: string }>;
  const parsedDebugEntries = debugEntries.map((entry) => {
    try {
      return { source: entry.source, ...JSON.parse(entry.message || "{}") };
    } catch {
      return { source: entry.source, message: entry.message };
    }
  });
  const diagnosticDebug = parsedDebugEntries.filter((entry) =>
    /subagent|model_lane|parent_(?:wait|resume|join)/.test(String(entry.source || "")),
  );
  const debugText = JSON.stringify(debugEntries);
  console.log(`[real-omlx-subagents:${subagentModel}] ${JSON.stringify({
    maxActiveChildren,
    maxRunningChildren,
    runs: selectedRuns,
    plan: snapshot.planArtifacts?.[0]?.content,
    debug: diagnosticDebug,
  }).slice(0, 20_000)}`);

  expect(selectedRuns).toHaveLength(3);
  expect(new Set(selectedRuns.map((run) => run.scopeKey))).toEqual(expectedScopeKeys);
  expect(selectedRuns.every((run) => ["completed", "blocked", "degraded"].includes(run.status))).toBe(true);
  expect(selectedRuns.every((run) => (
    Number.isFinite(run.createdAt) &&
    run.createdAt > 0 &&
    !!run.startedAt &&
    !!run.completedAt &&
    run.createdAt <= run.startedAt &&
    run.startedAt <= run.completedAt &&
    (run.closedAt === null || run.completedAt <= run.closedAt) &&
    run.summary.trim().length > 0
  ))).toBe(true);
  expect(selectedRuns.every((run) => run.evidenceCount === run.substantiveEvidenceCount)).toBe(true);
  expect(selectedRuns.every((run) => (
    run.status === "completed" &&
    run.closureState === "satisfied" &&
    run.evidenceCount > 0 &&
    !run.remainingWork.trim()
  ))).toBe(true);
  expect(Math.max(...selectedRuns.map((run) => run.createdAt)))
    .toBeLessThan(Math.min(...selectedRuns.map((run) => run.completedAt || Number.MAX_SAFE_INTEGER)));
  expect(parsedDebugEntries.some((entry) =>
    entry.source === "parent_join_required" ||
    entry.source === "parent_wait" ||
    (entry.source === "store.agent_loop_stop_summary" && entry.latestTool === "wait_subagents")
  )).toBe(true);
  expect(debugText).toMatch(/parent_wait/);
  expect(debugText).toMatch(/parent_resume/);
  const selectedRunIds = new Set(selectedRuns.map((run) => run.id));
  expect(parsedDebugEntries.some((entry) => (
    entry.source === "model_lane_admission" &&
    Array.isArray(entry.liveRequests) &&
    entry.liveRequests.some((request: { agentKind?: string }) => (
      request.agentKind === "parent" || request.agentKind === "main"
    )) &&
    entry.liveRequests.some((request: { agentKind?: string }) => request.agentKind === "subagent")
  ))).toBe(true);
  expect(parsedDebugEntries.some((entry) => (
    entry.source === "model_lane_admission" &&
    Array.isArray(entry.liveRequests) &&
    entry.liveRequests.filter((request: { agentKind?: string }) => request.agentKind === "subagent").length >= 2
  ))).toBe(true);
  const elasticBurstObserved = parsedDebugEntries.some((entry) => (
    entry.source === "subagent_started" &&
    selectedRunIds.has(String(entry.subagentId || "")) &&
    entry.elasticAdmissionGranted === true &&
    entry.burstAdmission?.allowed === true &&
    Number(entry.burstAdmission?.safeOverlapSamples || 0) >= 2
  ));
  const safeCapacityFallbackObserved = parsedDebugEntries.some((entry) => (
    entry.source === "subagent_elastic_admission" &&
    selectedRunIds.has(String(entry.subagentId || "")) &&
    entry.decision === "started_after_base_slot_released"
  ));
  expect(elasticBurstObserved || safeCapacityFallbackObserved).toBe(true);
  expect(debugText).not.toMatch(/out of memory|\bOOM\b|uncaught|unhandled rejection/i);
  const planAuthoringContractSnapshots = parsedDebugEntries.filter((entry) => (
    entry.source === "agent.plan_authoring_contract_injected" &&
    entry.contractVersion === PLAN_AUTHORING_CONTRACT_VERSION
  )).map((entry) => ({
    iteration: entry.iteration,
    phase: entry.planRuntimePhase,
    reusableEvidenceTargets: Array.isArray(entry.reusableEvidenceTargets)
      ? entry.reusableEvidenceTargets
      : [],
  }));
  expect(planAuthoringContractSnapshots.some((entry) => (
    [
      "src/hooks/useCsvParser.ts",
      "src/hooks/useChartData.ts",
      "src/store/dashboardStore.ts",
      "src/types/order.ts",
    ].every((target) => entry.reusableEvidenceTargets.includes(target))
  )), `Plan contract snapshots: ${JSON.stringify(planAuthoringContractSnapshots)}`).toBe(true);
  expect(parsedDebugEntries.some((entry) => (
    ["agent.plan_evidence_bundle_ready", "agent.plan_evidence_bundle_injected"].includes(String(entry.source || "")) &&
    Array.isArray(entry.contractMismatchKinds) &&
    entry.contractMismatchKinds.includes("producer_missing_required_field:creatorName")
  ))).toBe(true);
  expect(snapshot.planArtifacts[0].content).toMatch(/useCsvParser|creatorName/);
  expect(snapshot.planArtifacts[0].content).toMatch(/useChartData|dashboardStore/);
  expect(snapshot.planArtifacts[0].content).toMatch(/src\/types\/order\.ts/);
  expect(snapshot.planArtifacts[0].content).toMatch(/(?:normalizeCsvOrder|归一化)[^\n]{0,180}creatorName|creatorName[^\n]{0,180}(?:normalizeCsvOrder|归一化)/i);
  expect(snapshot.planArtifacts[0].content).not.toMatch(/(?:移除|删除|去掉|remove|delete|drop)[^\n]{0,120}creatorName/i);
});

import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isFinitePlanValidationCommand,
} from "../../src/lib/workflowModels";
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
  projectRealOmlxCollaborationScopes,
  readBoundedRealOmlxWorkspaceTextFile,
  readBoundedRealOmlxWorkspaceTextFiles,
  readRealOmlxWorkspaceFileWindow,
  recordRealOmlxAcceptanceDebugEvent,
  REAL_OMLX_WORKSPACE_PROXY_LIMITS,
  selectBoundedRealOmlxSearchFiles,
  shouldPruneRealOmlxWorkspaceDirectory,
  type RealOmlxAcceptanceState,
  type RealOmlxWorkspaceInventory,
} from "./realOmlxWorkspaceProxy";
import {
  getMdViewerExecutionGaps,
  getMdViewerReadablePlanGaps,
  getMdViewerTypedPlanGaps,
} from "./realOmlxMdViewerPlanOracle";

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
const realOmlxRequest =
  process.env.REAL_OMLX_REQUEST ||
  "请修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。先生成可审批计划，批准后真实修改并验证。";
const realOmlxPlanOnly = process.env.REAL_OMLX_PLAN_ONLY === "1";
const realOmlxPreferSubagents = process.env.REAL_OMLX_PREFER_SUBAGENTS === "1";
const realOmlxImagePath = String(process.env.REAL_OMLX_IMAGE_PATH || "").trim();
const runDirectEditRecovery = process.env.REAL_OMLX_DIRECT_EDIT_RECOVERY === "1";
const runExecuteIncidentReplay = process.env.REAL_OMLX_EXECUTE_INCIDENT === "1";
const realOmlxFixture = String(process.env.REAL_OMLX_FIXTURE || "csv").trim().toLowerCase();
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
  process.env.REAL_OMLX_PLAN_EXPECT || "useCsvParser\\.ts|CSV|creator",
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
const realOmlxExpectedSubagentScopes = String(
  process.env.REAL_OMLX_EXPECT_SUBAGENT_SCOPES || "",
).split(";;").map((scope) => scope.trim()).filter(Boolean);
if (
  runRealOmlx &&
  realOmlxFixture === "md-viewer" &&
  !String(process.env.REAL_OMLX_WORKSPACE || "").trim()
) {
  throw new Error(
    "The md-viewer real-model fixture requires a caller-prepared REAL_OMLX_WORKSPACE copy.",
  );
}
if (runRealOmlx && realOmlxPlanEvidenceTargets.length === 0) {
  throw new Error(
    "Real OMLX validation requires explicit REAL_OMLX_PLAN_EVIDENCE_TARGETS for non-default fixtures.",
  );
}
if (runRealOmlx && realOmlxPreferSubagents && realOmlxExpectedSubagentScopes.length === 0) {
  throw new Error(
    "REAL_OMLX_PREFER_SUBAGENTS=1 requires explicit REAL_OMLX_EXPECT_SUBAGENT_SCOPES.",
  );
}
const realOmlxPlanTimeoutMs = Math.max(
  30_000,
  Number(process.env.REAL_OMLX_PLAN_TIMEOUT_MS || 600_000),
);
const realOmlxExecutionTimeoutMs = Math.max(
  30_000,
  Number(process.env.REAL_OMLX_EXECUTION_TIMEOUT_MS || 500_000),
);
const allowSafeExecutionPause = process.env.REAL_OMLX_ALLOW_SAFE_PAUSE === "1";
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

const useSemanticMdViewerMutationOracle =
  realOmlxFixture === "md-viewer" &&
  process.env.REAL_OMLX_MUTATION_ORACLE !== "exact";
const realOmlxMutationOracleFiles = useSemanticMdViewerMutationOracle
  ? [
      "src/main.js",
      "src/components/editor.js",
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
  const satisfied = useSemanticMdViewerMutationOracle
    ? executionGaps.length === 0
    : realOmlxMutationExpectation.test(contents[realOmlxMutationFile] || "");
  return {
    satisfied,
    changedFiles,
    contents,
    detail: useSemanticMdViewerMutationOracle
      ? executionGaps.length === 0
        ? "redundant filename UI is removed, programmatic open stays clean, and save_file_content uses filePath"
        : executionGaps.join("; ")
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
      if (!/(?:^agent\.(?:plan_|loop_stop$|agent_loop_)|^store\.(?:non_actionable_stop|agent_loop_stop_summary|agent_loop_crashed|parent_subagents_finalized|terminal_|workflow_|harness_close_|stale_run_error_)|^app\.instance\.closed$|stream_(?:error|timeout|watchdog))/i.test(source)) {
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

function inspectPreferredSubagentCollaboration(snapshot: any): {
  ready: boolean;
  detail: Record<string, unknown>;
} {
  const runs = (Array.isArray(snapshot?.subagentRuns) ? snapshot.subagentRuns : []) as Array<Record<string, unknown>>;
  const acceptance = snapshot?.acceptanceState && typeof snapshot.acceptanceState === "object"
    ? snapshot.acceptanceState as RealOmlxAcceptanceState
    : createRealOmlxAcceptanceState();
  const scopes = projectRealOmlxCollaborationScopes({
    acceptance,
    runs,
    expectedScopeKeys: realOmlxExpectedSubagentScopes,
  }).map((scope) => {
    const scopeRuns = runs.filter((run) => scope.subagentIds.includes(String(run.id || "")));
    const authoritativeRun = scopeRuns.some((run) =>
      String(run.status || "") === "completed" &&
      String(run.closureState || "") === "satisfied" &&
      Number(run.substantiveEvidenceCount || 0) > 0 &&
      Number.isFinite(run.startedAt) &&
      Number.isFinite(run.completedAt) &&
      Number(run.completedAt) >= Number(run.startedAt)
    );
    return { ...scope, authoritativeRun };
  });
  const intakePreferred = acceptance.observedSubagentPreferences.includes("preferred");
  const allExpectedScopesSatisfied = scopes.length > 0 && scopes.every((scope) =>
    scope.spawned && scope.joined && scope.consumed && scope.authoritativeRun
  );
  return {
    ready:
      snapshot?.preferSubagents === true &&
      intakePreferred &&
      allExpectedScopesSatisfied,
    detail: {
      preferSubagents: snapshot?.preferSubagents === true,
      intakePreferred,
      expectedScopeKeys: realOmlxExpectedSubagentScopes,
      scopes,
      acceptance,
    },
  };
}

async function assertPreferredSubagentCollaboration(page: Page): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    const inspection = inspectPreferredSubagentCollaboration(snapshot);
    return inspection.ready ? "joined" : JSON.stringify(inspection.detail);
  }, { timeout: 120_000 }).toBe("joined");
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

test.describe.configure({ timeout: 1_200_000 });
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
  await page.exposeFunction("__MAIN_E2E_INSPECT_FIXTURE_MUTATION", async () =>
    await inspectFixtureMutation(workspace)
  );
  let requireDirectEditRepair = false;
  await page.exposeFunction("__MAIN_E2E_REQUIRE_DIRECT_EDIT_REPAIR", async () => {
    requireDirectEditRepair = true;
  });
  await page.exposeFunction("__MAIN_E2E_RUN_VERIFICATION", async (rawCommand: string) => {
    const command = String(rawCommand || "").trim();
    const mutationState = await inspectFixtureMutation(workspace);
    const isFiniteVerification = isFinitePlanValidationCommand(command);
    const directEditSource = requireDirectEditRepair && realOmlxFixture === "csv"
      ? await fs.readFile(path.join(workspace, "src/hooks/useCsvParser.ts"), "utf8")
      : "";
    const directEditRepairSatisfied = !requireDirectEditRepair || (
      /\bsource\??\s*:\s*string\b/.test(directEditSource) &&
      /\bsource\s*:\s*["']csv["']/.test(directEditSource)
    );
    const exitCode = mutationState.satisfied &&
      isFiniteVerification &&
      directEditRepairSatisfied
      ? 0
      : 1;
    return JSON.stringify({
      command,
      cwd: workspace,
      exitCode,
      stdout: exitCode === 0
        ? `Fresh fixture verification passed: ${mutationState.detail}.`
        : `Fresh fixture verification failed: expected a finite command and ${mutationState.detail}.`,
      stderr: requireDirectEditRepair && !directEditRepairSatisfied
        ? [
            "src/hooks/useCsvParser.ts:8:3 - error TS2741: Property 'source' is missing in normalized CsvOrder.",
            "Declare source?: string on CsvOrder and return source: 'csv' from normalizeCsvOrder.",
          ].join("\n")
        : "",
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

  const chatStreams = new Map<string, {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    decoder: TextDecoder;
    controller: AbortController;
    url: string;
    model: string;
    chars: number;
    preview: string;
  }>();
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
    const controller = new AbortController();
    const response = await fetch(url, {
      method: "POST",
      headers: args.headers as Record<string, string>,
      body: bodyText,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!response.body) throw new Error(`HTTP ${response.status}: response body is not streamable`);
    chatStreams.set(streamId, {
      reader: response.body.getReader(),
      decoder: new TextDecoder(),
      controller,
      url,
      model,
      chars: 0,
      preview: "",
    });
    return { status: response.status };
  });
  await page.exposeFunction("__MAIN_E2E_CHAT_STREAM_READ", async (streamId: string) => {
    const stream = chatStreams.get(String(streamId));
    if (!stream) return { done: true, chunk: "" };
    const { done, value } = await stream.reader.read();
    const chunk = stream.decoder.decode(value || new Uint8Array(), { stream: !done });
    stream.chars += chunk.length;
    if (stream.preview.length < 180) stream.preview = `${stream.preview}${chunk}`.slice(0, 180);
    if (done) {
      chatStreams.delete(String(streamId));
      console.log(`[real-omlx-stream] 200 ${stream.url} model=${stream.model} chars=${stream.chars} ${stream.preview.replace(/\s+/g, " ")}`);
    }
    return { done, chunk };
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
      "agent.preferred_delegation_spawned",
      "agent.preferred_delegation_scope_outcomes",
      "agent.preferred_delegation_consumed",
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

for (const model of models) {
  test(`real OMLX MAIN plan/approve/execute reaches closure or bounded pause with ${model}`, async ({ page }) => {
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

    const admittedPlanTurnId = realOmlxPlanOnly
      ? assertFirstPlanWorkspaceTurnAdmission(immediateAdmissionSnapshot)
      : "";

    let lastPlanPollSignature = "";
    let lastPlanTerminalSignature = "";
    let lastPlanDebugSignature = "";
    let planTerminalSnapshot: any = null;
    try {
      await expect
        .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        const planPollDiagnostic = {
          agentStatus: snapshot?.agentStatus,
          isGenerating: snapshot?.isGenerating,
          currentTurnStatus: snapshot?.currentTurnStatus,
          planStage: snapshot?.planStage,
          artifactCount: snapshot?.planArtifacts?.length ?? 0,
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
        const artifactCount = snapshot?.planArtifacts?.length ?? 0;
        if (
          artifactCount > 0 &&
          snapshot?.isGenerating === false &&
          snapshot?.agentStatus === "pending_review" &&
          snapshot?.currentTurnStatus === "awaiting_approval" &&
          reviewablePlanStages.has(String(snapshot?.planStage || ""))
        ) {
          return "artifact_ready";
        }
        if (
          snapshot?.isGenerating === false &&
          (
            (snapshot?.taskFlowTypes || []).includes("user") ||
            ["error", "idle"].includes(String(snapshot?.agentStatus || ""))
          )
        ) {
          const terminal = `terminal_without_artifact:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}`;
          if (terminal !== lastPlanTerminalSignature) {
            console.log(`[real-omlx-plan-terminal:${model}] ${terminal}`);
            console.log(`[real-omlx-plan-debug:${model}] ${JSON.stringify(summarizePlanDebugTail(snapshot?.debugTail || []))}`);
            console.log(`[real-omlx-plan-flow:${model}] ${JSON.stringify(snapshot?.taskFlowPreview || [])}`);
            lastPlanTerminalSignature = terminal;
          }
          if (realOmlxPlanOnly || !allowSafeExecutionPause) throw new Error(terminal);
          planTerminalSnapshot = snapshot;
          return "safe_pause";
        }
        return "running";
      }, { timeout: realOmlxPlanTimeoutMs })
      .toMatch(/^(?:artifact_ready|safe_pause)$/);
    } catch (error) {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      console.log(`[real-omlx-plan-timeout-debug:${model}] ${JSON.stringify(summarizePlanDebugTail(snapshot?.debugTail || [])).slice(-12_000)}`);
      console.log(`[real-omlx-plan-timeout-flow:${model}] ${JSON.stringify(snapshot?.taskFlowPreview || []).slice(-12_000)}`);
      throw error;
    }

    if (planTerminalSnapshot) {
      const mutationAfterPlanPause = await readFixtureMutationContents(workspace);
      expect(mutationAfterPlanPause).toEqual(originalMutationContents);
      expect(planTerminalSnapshot?.planArtifacts || []).toHaveLength(0);
      expect(planTerminalSnapshot?.planStage).not.toBe("completed");
      expect(completedTurnStatuses.has(String(planTerminalSnapshot?.currentTurnStatus || ""))).toBe(false);
      const planTerminalSummary = [...(planTerminalSnapshot?.debugTail || [])]
        .reverse()
        .map((entry: { source?: string; message?: string }) => {
          if (entry.source !== "store.agent_loop_stop_summary") return null;
          try {
            return JSON.parse(String(entry.message || "{}"));
          } catch {
            return null;
          }
        })
        .find((payload: { runtimeIntent?: string } | null) => payload?.runtimeIntent === "plan");
      expect(planTerminalSummary?.status).toBe("paused");
      expect(planTerminalSummary?.reason).not.toBe("agent_loop_completed");
      console.log(`[real-omlx-plan-safe-pause:${model}] ${JSON.stringify({
        reason: planTerminalSummary?.reason,
        currentTurnStatus: planTerminalSnapshot?.currentTurnStatus,
        planStage: planTerminalSnapshot?.planStage,
      })}`);
      return;
    }

    const plan = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().planArtifacts?.[0]?.content || "");
    if (isMdViewerSavePathIncident) {
      expect(
        getMdViewerReadablePlanGaps(plan),
        "MD Viewer Markdown is a review projection and must expose readable R/C/V sections.",
      ).toEqual([]);
    } else {
      expect(plan).toMatch(realOmlxPlanExpectation);
      for (const expectation of realOmlxPlanExpectAll) {
        expect(plan).toMatch(expectation);
      }
    }
    expect(plan).not.toMatch(/用户目标：\s*(?:\n|$)/);
    expect(plan).not.toMatch(/以落实已批准目标|落实已批准方案中涉及|Apply the approved plan change/i);
    expect(plan).not.toMatch(/直接相关的最小改动|写入前先用证据确认|依据证据：已搜索文件|依据证据：已查看目录/i);
    expect(plan).not.toMatch(/(?:已读证据|证据引用|Read Evidence)[\s\S]{0,800}\.MAIN\/plans\/plan\.md/i);
    const planSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    expect(planSnapshot?.planArtifacts || []).toHaveLength(1);
    expect(planSnapshot?.planArtifacts?.[0]?.path).toBe(".MAIN/plans/plan.md");
    const typedPlanArtifact = planSnapshot?.planArtifacts?.[0];
    expect(typedPlanArtifact?.candidate).toBeTruthy();
    expect(typedPlanArtifact?.candidate?.schemaVersion).toBe(PLAN_CANDIDATE_SCHEMA_VERSION);
    expect(typedPlanArtifact?.candidate?.ingress).toBe("typed_runtime");
    expect(typedPlanArtifact?.candidate?.validations?.some(
      (validation: { primitive: Parameters<typeof isAcceptanceCapableValidationSpec>[0] }) =>
        isAcceptanceCapableValidationSpec(validation.primitive),
    )).toBe(true);
    expect(validateSealedPlanCandidate({
      candidate: typedPlanArtifact.candidate,
      expectedContent: typedPlanArtifact.content,
    })).toEqual([]);
    expect(typedPlanArtifact?.candidateHash).toBe(
      hashPlanCandidate(typedPlanArtifact.candidate),
    );
    expect(typedPlanArtifact?.authoringContractId).toBe(
      typedPlanArtifact?.candidate?.authoringContractId,
    );
    const candidateEvidenceTargets = new Set(
      typedPlanArtifact.candidate.evidence.map(
        (entry: { target: string }) => String(entry.target || "").trim(),
      ),
    );
    for (const target of realOmlxPlanEvidenceTargets) {
      expect(
        candidateEvidenceTargets.has(target),
        `Typed Plan evidence must contain exact required target: ${target}`,
      ).toBe(true);
    }
    const acceptanceState = planSnapshot?.acceptanceState as RealOmlxAcceptanceState | null;
    expect(acceptanceState?.authoringContractIds || []).toContain(
      typedPlanArtifact?.authoringContractId,
    );
    if (isMdViewerSavePathIncident) {
      expect(
        getMdViewerTypedPlanGaps(typedPlanArtifact.candidate),
        "MD Viewer acceptance is owned by the typed evidence/diagnosis/change/validation graph, not Markdown keywords.",
      ).toEqual([]);
    }
    expect(acceptanceState?.evidenceBundleHashes || []).toContain(
      typedPlanArtifact?.candidate?.bundleHash,
    );
    const persistedPlan = await fs.readFile(
      path.join(workspace, String(planSnapshot?.planArtifacts?.[0]?.path || "")),
      "utf8",
    );
    expect(persistedPlan.trim()).toBe(plan.trim());
    expect(reviewablePlanStages.has(String(planSnapshot?.planStage || ""))).toBe(true);
    if (realOmlxPreferSubagents) {
      await assertPreferredSubagentCollaboration(page);
    }
    const planChatText = JSON.stringify(planSnapshot?.taskFlowPreview || []);
    console.log(`[real-omlx-plan-artifact:${model}]\n${plan}`);
    console.log(`[real-omlx-chat-plan:${model}] ${planChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(planChatText).toMatch(realOmlxPlanOnly
      ? /read_file|grep_search|code_ast_query|读取|搜索|计划|根因|修复/i
      : realOmlxFixture === "md-viewer"
      ? /read_file|list_directory|读取|计划|main\.js|toolbar|按钮/i
      : /read_file|list_directory|读取|计划|CSV|useCsvParser|creator/i);
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
      expect(finalPlanSnapshot?.planArtifacts || []).toHaveLength(1);
      expect(finalPlanSnapshot?.planArtifacts?.[0]?.path).toBe(".MAIN/plans/plan.md");
      expect(reviewablePlanStages.has(String(finalPlanSnapshot?.planStage || ""))).toBe(true);
      expect(JSON.stringify(finalPlanSnapshot?.debugTail || [])).not.toMatch(
        /plan_generation_failed|plan_evidence_materialization_exhausted/i,
      );
      expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(originalPlanOnlyWorkspaceFingerprint);
      if (isMdViewerSavePathIncident) {
        expect(
          getMdViewerReadablePlanGaps(plan),
          "MD Viewer review projection must retain readable typed-node sections while awaiting approval.",
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
      return snapshot?.isPlanApproved === true && snapshot?.planApprovalExecutionStartedForTurnId
        ? "execution_started"
        : `waiting:${snapshot?.agentStatus}:${snapshot?.isGenerating}:${Boolean(snapshot?.pendingPlanApprovalHandoff)}`;
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
        if (mutationState.satisfied && mutationState.changedFiles.length > 0) return "mutated";
        const terminalWithoutMutation = snapshot?.isGenerating === false && (
          ["idle", "error"].includes(String(snapshot?.agentStatus || "")) ||
          ["paused", "stopped_no_action", "error"].includes(String(snapshot?.currentTurnStatus || "")) ||
          snapshot?.planStage === "paused"
        );
        if (terminalWithoutMutation) {
          console.log(`[real-omlx-execute-safe-pause:${model}] ${JSON.stringify({
            agentStatus: snapshot?.agentStatus,
            currentTurnStatus: snapshot?.currentTurnStatus,
            planStage: snapshot?.planStage,
            toolBlocks: (snapshot?.toolBlocks || []).slice(-8),
            debugTail: summarizePlanDebugTail(snapshot?.debugTail || []),
          }).slice(-12_000)}`);
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
        toolBlocks: (snapshot?.toolBlocks || []).slice(-20),
        debugTail: snapshot?.debugTail || [],
      }).slice(-40_000)}`);
      throw error;
    }

    const mutationAfterEarlyOutcome = await inspectFixtureMutation(workspace, originalMutationContents);
    if (!mutationAfterEarlyOutcome.satisfied || mutationAfterEarlyOutcome.changedFiles.length === 0) {
      expect(allowSafeExecutionPause, "Set REAL_OMLX_ALLOW_SAFE_PAUSE=1 when model incapability may be accepted as an honest bounded pause.").toBe(true);
      expect(mutationAfterEarlyOutcome.contents).toEqual(originalMutationContents);
      expect(earlyExecutionSnapshot?.planStage).not.toBe("completed");
      expect(completedTurnStatuses.has(String(earlyExecutionSnapshot?.currentTurnStatus || ""))).toBe(false);
      const executeTerminalSummary = [...(earlyExecutionSnapshot?.debugTail || [])]
        .reverse()
        .map((entry: { source?: string; message?: string }) => {
          if (entry.source !== "store.agent_loop_stop_summary") return null;
          try {
            return JSON.parse(String(entry.message || "{}"));
          } catch {
            return null;
          }
        })
        .find((payload: { runtimeIntent?: string } | null) => payload?.runtimeIntent === "execute");
      expect(executeTerminalSummary?.status).toBe("paused");
      expect(executeTerminalSummary?.reason).not.toBe("agent_loop_completed");
      return;
    }

    expect(mutationAfterEarlyOutcome.satisfied).toBe(true);
    expect(mutationAfterEarlyOutcome.changedFiles.length).toBeGreaterThan(0);

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
        if (
          snapshot?.isGenerating === false &&
          snapshot?.planStage === "completed" &&
          completedTurnStatuses.has(String(snapshot?.currentTurnStatus || ""))
        ) return "completed";
        if (snapshot?.isGenerating === false) {
          terminalExecutionSnapshot = snapshot;
          return "terminal";
        }
        return "running";
      }, { timeout: 300_000 })
      .toMatch(/^(?:completed|terminal)$/);

    if (terminalExecutionSnapshot) {
      console.log(`[real-omlx-execute-terminal:${model}] ${JSON.stringify({
        agentStatus: terminalExecutionSnapshot?.agentStatus,
        currentTurnStatus: terminalExecutionSnapshot?.currentTurnStatus,
        planStage: terminalExecutionSnapshot?.planStage,
        activeActionRequest: terminalExecutionSnapshot?.activeActionRequest,
        toolBlocks: (terminalExecutionSnapshot?.toolBlocks || []).slice(-20),
        debugTail: terminalExecutionSnapshot?.debugTail || [],
      }).slice(-40_000)}`);
      expect(
        allowSafeExecutionPause,
        "Set REAL_OMLX_ALLOW_SAFE_PAUSE=1 when model incapability may be accepted as an honest bounded pause.",
      ).toBe(true);
      expect(["paused", "stopped_no_action", "stopped_no_output"]).toContain(
        String(terminalExecutionSnapshot?.currentTurnStatus || ""),
      );
      expect(terminalExecutionSnapshot?.planStage).not.toBe("completed");
      const executeTerminalSummary = [...(terminalExecutionSnapshot?.debugTail || [])]
        .reverse()
        .map((entry: { source?: string; message?: string }) => {
          if (entry.source !== "store.agent_loop_stop_summary") return null;
          try {
            return JSON.parse(String(entry.message || "{}"));
          } catch {
            return null;
          }
        })
        .find((payload: { runtimeIntent?: string } | null) => payload?.runtimeIntent === "execute");
      expect(executeTerminalSummary?.status).toBe("paused");
      expect(executeTerminalSummary?.reason).not.toBe("agent_loop_completed");
      return;
    }

    const bodyText = await page.locator("body").innerText();
    const executionSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    const executionChatText = JSON.stringify(executionSnapshot?.taskFlowPreview || []);
    console.log(`[real-omlx-chat-execute:${model}] ${executionChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(executionChatText).toMatch(/apply_patch|write_file|replace_in_file|run_command|browser_evaluate|已完成|completed/i);
    const executionEvidence = executionSnapshot?.planExecutionEvidence || [];
    expect(executionEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "cmd" }),
    ]));
    expect(executionEvidence.some((entry: { kind?: string; target?: string }) =>
      entry.kind === "file" && mutationAfterEarlyOutcome.changedFiles.includes(String(entry.target || ""))
    )).toBe(true);
    if (realOmlxFixture === "md-viewer") {
      expect(executionEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "browser_dom" }),
      ]));
      const executionToolNames = (executionSnapshot?.taskFlowPreview || [])
        .map((block: { toolName?: string }) => block.toolName || "");
      const launchIndex = executionToolNames.lastIndexOf("execute_command");
      const ptyObservationIndex = Math.max(
        executionToolNames.lastIndexOf("get_pty_status"),
        executionToolNames.lastIndexOf("read_pty_since"),
        executionToolNames.lastIndexOf("read_pty_tail"),
      );
      const browserIndex = executionToolNames.lastIndexOf("browser_evaluate");
      expect(launchIndex).toBeGreaterThanOrEqual(0);
      expect(ptyObservationIndex).toBeGreaterThan(launchIndex);
      expect(browserIndex).toBeGreaterThan(ptyObservationIndex);
      expect(JSON.stringify(executionSnapshot?.debugTail || [])).not.toMatch(
        /READ_FILE_NOT_AVAILABLE_IN_RECOVERY|DEV_SERVER_NOT_READY|server (?:is )?occupied/i,
      );
    }
    expect(executionChatText).not.toMatch(forbiddenChatNoise);
    const terminalExecutionSummary = [...(executionSnapshot?.debugTail || [])]
      .reverse()
      .map((entry: { source?: string; message?: string }) => {
        if (entry.source !== "store.agent_loop_stop_summary") return null;
        try {
          return JSON.parse(String(entry.message || "{}"));
        } catch {
          return null;
        }
      })
      .find((payload: { runtimeIntent?: string } | null) => payload?.runtimeIntent === "execute");
    expect(terminalExecutionSummary).toMatchObject({
      status: "completed",
      reason: "agent_loop_completed",
      planStage: "completed",
    });
    const terminalTurnId = String(executionSnapshot?.currentTurnId || "");
    expect(terminalTurnId).not.toBe("");
    const finalAssistantBlocks = (executionSnapshot?.taskFlowPreview || []).filter(
      (block: { turnId?: string; type?: string; visibility?: string; content?: string }) =>
        block.turnId === terminalTurnId &&
        block.type === "agent" &&
        block.visibility === "assistant_final" &&
        String(block.content || "").trim().length > 0,
    );
    expect(finalAssistantBlocks).toHaveLength(1);
    expect(String(finalAssistantBlocks[0]?.content || "")).toMatch(
      /完成|修改|修复|验证|passed|updated|fixed|implemented|validated/i,
    );
    expect(String(finalAssistantBlocks[0]?.content || "")).not.toContain("agent_loop_completed");
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
    const originalMainSource = await fs.readFile(path.join(workspace, "src/main.js"), "utf8");
    const replayImages = await loadRealOmlxReplayImages();
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);

    const immediateSnapshot = await page.evaluate(async ({ text, images }) => {
      const bridge = (window as any).__CODELY_E2E__;
      try {
        await bridge?.sendDirectEditMessage?.(text, images);
      } catch (error) {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      }
      return bridge?.getSnapshot?.();
    }, {
      text: realOmlxRequest,
      images: replayImages,
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

    let observedRuntimeStart = false;
    let terminalSnapshot: any = null;
    let latestRuntimeSnapshot: any = immediateSnapshot;
    const admissionStartedAt = Date.now();
    try {
      await expect.poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        latestRuntimeSnapshot = snapshot;
        if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
        if (
          snapshot?.isGenerating === true ||
          snapshot?.agentStatus !== "idle" ||
          (snapshot?.toolBlocks || []).length > 0
        ) {
          observedRuntimeStart = true;
        }
        if (
          observedRuntimeStart &&
          snapshot?.isGenerating === false &&
          ["idle", "error"].includes(String(snapshot?.agentStatus || ""))
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
      console.log(`[real-omlx-execute-timeout:${model}] ${JSON.stringify({
        currentTurnStatus: latestRuntimeSnapshot?.currentTurnStatus,
        currentTurnIntent: latestRuntimeSnapshot?.currentTurnIntent,
        currentTurnTitle: latestRuntimeSnapshot?.currentTurnTitle,
        agentStatus: latestRuntimeSnapshot?.agentStatus,
        isGenerating: latestRuntimeSnapshot?.isGenerating,
        iteration: latestRuntimeSnapshot?.harness?.iteration,
        toolBlocks: latestRuntimeSnapshot?.toolBlocks,
        debugTail: latestRuntimeSnapshot?.debugTail,
      }).slice(-120_000)}`);
      throw error;
    }

    console.log(`[real-omlx-execute-incident:${model}] ${JSON.stringify({
      currentTurnStatus: terminalSnapshot?.currentTurnStatus,
      currentTurnIntent: terminalSnapshot?.currentTurnIntent,
      currentTurnTitle: terminalSnapshot?.currentTurnTitle,
      agentStatus: terminalSnapshot?.agentStatus,
      toolBlocks: terminalSnapshot?.toolBlocks,
      debugTail: terminalSnapshot?.debugTail,
    }).slice(-120_000)}`);

    expect(completedTurnStatuses.has(String(terminalSnapshot?.currentTurnStatus || ""))).toBe(true);
    expect(terminalSnapshot?.currentTurnIntent).toBe("execute");
    expect(String(terminalSnapshot?.currentTurnTitle || "").trim()).not.toBe("");
    const terminalTurnId = String(terminalSnapshot?.currentTurnId || "");
    expect(terminalTurnId).not.toBe("");
    const finalAssistantMessage = page.locator(
      `[data-testid="assistant-final"][data-turn-id="${terminalTurnId}"]`,
    );
    await expect(finalAssistantMessage).toBeVisible();
    expect(String(await finalAssistantMessage.textContent() || "").trim().length).toBeGreaterThan(0);

    const toolBlocks = terminalSnapshot?.toolBlocks || [];
    expect(toolBlocks.some((block: { name?: string; status?: string }) =>
      ["apply_patch", "replace_in_file", "write_file", "write_file_atomic"].includes(String(block.name || "")) &&
      block.status === "completed"
    )).toBe(true);
    expect(toolBlocks.some((block: { name?: string; status?: string }) =>
      block.name === "run_command" && block.status === "completed"
    )).toBe(true);

    const finalMainSource = await fs.readFile(path.join(workspace, "src/main.js"), "utf8");
    expect(finalMainSource).not.toBe(originalMainSource);
    expect(finalMainSource).toMatch(/\bfilePath\s*:/);
    expect(finalMainSource).not.toMatch(/\bfile_path\s*:/);
    expect(getMdViewerExecutionGaps({
      caller: finalMainSource,
      editor: await fs.readFile(path.join(workspace, "src/components/editor.js"), "utf8"),
      handler: await fs.readFile(path.join(workspace, "src-tauri/src/main.rs"), "utf8"),
      toolbar: await fs.readFile(path.join(workspace, "src/components/toolbar.js"), "utf8"),
    })).toEqual([]);

    const debugText = JSON.stringify(terminalSnapshot?.debugTail || []);
    expect(debugText).not.toMatch(
      /TURN_RUNTIME_PLANNING_CHECKPOINT_OWNER_MISMATCH|closure_ledger_owner_mismatch|repeated_failure_policy_no_progress|required_tool_protocol_violation/,
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

test(`real OMLX honors the captured collaboration toggle after runtime admission with ${subagentModel}`, async ({ page }) => {
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
      requirementInjected: parsedDebug.some((entry: { source?: string }) =>
        entry.source === "agent.preferred_delegation_action_contract_injected"
      ),
      requiredToolChoice: parsedDebug.some((entry: { source?: string; preferredDelegationRequired?: boolean; toolChoice?: string }) =>
        entry.source === "agent.llm_request_shape" &&
        entry.preferredDelegationRequired === true &&
        entry.toolChoice === "required"
      ),
      spawned: parsedDebug.some((entry: { source?: string }) =>
        entry.source === "agent.preferred_delegation_spawned"
      ),
      hasSubagent: (snapshot?.subagentRuns?.length || 0) >= 1,
    };
  }), { timeout: 180_000 }).toEqual({
    dispatchError: null,
    intakePreferred: true,
    requirementInjected: true,
    requiredToolChoice: true,
    spawned: true,
    hasSubagent: true,
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

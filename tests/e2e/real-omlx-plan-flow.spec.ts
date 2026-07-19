import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isFinitePlanValidationCommand,
  validateActionablePlanArtifact,
} from "../../src/lib/workflowModels";

const runRealOmlx = process.env.MAIN_REAL_OMLX_E2E === "1";
const omlxEndpoint = String(
  process.env.OMLX_ENDPOINT || process.env.OMLX_BASE_URL || "http://127.0.0.1:8000/v1",
).replace(/\/+$/, "");
const omlxApiKey = String(process.env.OMLX_API_KEY || "mmnn");
const models = (process.env.OMLX_MODELS || "gemma-4-26b-a4b-it-8bit,Qwen3.6-35B-A3B-6bit")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const realOmlxRequest =
  process.env.REAL_OMLX_REQUEST ||
  "请修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。先生成可审批计划，批准后真实修改并验证。";
const realOmlxPlanOnly = process.env.REAL_OMLX_PLAN_ONLY === "1";
const runDirectEditRecovery = process.env.REAL_OMLX_DIRECT_EDIT_RECOVERY === "1";
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
const completedTurnStatuses = new Set(["done", "completed", "completed_with_changes"]);
const reviewablePlanStages = new Set(["plan", "design", "bugfix", "ready_to_execute"]);

const useSemanticMdViewerMutationOracle =
  realOmlxFixture === "md-viewer" &&
  process.env.REAL_OMLX_MUTATION_ORACLE !== "exact";
const realOmlxMutationOracleFiles = useSemanticMdViewerMutationOracle
  ? ["src/main.js", "src/components/toolbar.js"]
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mdViewerToolbarAndListenerIdsAgree(contents: Record<string, string>): boolean {
  const mainSource = contents["src/main.js"] || "";
  const toolbarSource = contents["src/components/toolbar.js"] || "";
  return ["new", "open", "save"].every((role) =>
    [`${role}-btn`, `btn-${role}`].some((id) => {
      const escapedId = escapeRegExp(id);
      const rendered = new RegExp(`\\bid\\s*=\\s*["']${escapedId}["']`).test(toolbarSource);
      const observed = new RegExp(
        `(?:["']${escapedId}["']\\s*:|getElementById\\(\\s*["']${escapedId}["']\\s*\\))`,
      ).test(mainSource);
      return rendered && observed;
    })
  );
}

async function inspectFixtureMutation(
  workspace: string,
  baseline?: Record<string, string>,
): Promise<FixtureMutationState> {
  const contents = await readFixtureMutationContents(workspace);
  const changedFiles = baseline
    ? realOmlxMutationOracleFiles.filter((relativePath) => contents[relativePath] !== baseline[relativePath])
    : [];
  const satisfied = useSemanticMdViewerMutationOracle
    ? mdViewerToolbarAndListenerIdsAgree(contents)
    : realOmlxMutationExpectation.test(contents[realOmlxMutationFile] || "");
  return {
    satisfied,
    changedFiles,
    contents,
    detail: useSemanticMdViewerMutationOracle
      ? "toolbar render IDs and main listener IDs agree for New/Open/Save"
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
      if (!/(?:^agent\.plan_|^agent\.loop_stop$|^store\.(?:non_actionable_stop|agent_loop_stop_summary)$|^app\.instance\.closed$|stream_(?:error|timeout|watchdog))/i.test(source)) {
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
    const normalized = String(rawPath || ".")
      .replace(workspace, "")
      .replace(/^[/\\]+/, "")
      .replace(/\\/g, "/");
    return path.join(workspace, normalized || ".");
  };

  await page.exposeFunction("__MAIN_E2E_DISK_READ", async (rawPath: string) => {
    return await fs.readFile(resolveDiskPath(rawPath), "utf8");
  });
  await page.exposeFunction("__MAIN_E2E_DISK_WRITE", async (rawPath: string, content: string) => {
    const absolute = resolveDiskPath(rawPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
    return null;
  });
  await page.exposeFunction("__MAIN_E2E_DISK_METADATA", async (rawPath: string) => {
    const absolute = resolveDiskPath(rawPath);
    const stat = await fs.stat(absolute);
    return { path: rawPath, sizeBytes: stat.size, modifiedMs: stat.mtimeMs };
  });
  await page.exposeFunction("__MAIN_E2E_DISK_GLOB", async () => {
    const output: string[] = [];
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(workspace, absolute).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          await walk(absolute);
        } else {
          output.push(relative);
        }
      }
    };
    await walk(workspace);
    return output;
  });
  await page.exposeFunction("__MAIN_E2E_DISK_LIST", async (rawPath: string) => {
    const absolute = resolveDiskPath(rawPath);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return entries.map((entry) => {
      const child = path.join(absolute, entry.name);
      return {
        name: entry.name,
        path: path.relative(workspace, child).replace(/\\/g, "/"),
        is_dir: entry.isDirectory(),
      };
    });
  });
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

  await page.addInitScript(({ workspace, endpoint, apiKey, devServerUrl, fixture }) => {
    const debugEntries = ((window as any).__REAL_OMLX_DEBUG_LOGS__ ??= []);
    const canceledStreamIds = new Set<string>();
    const readText = async (path: string) => {
      return await (window as any).__MAIN_E2E_DISK_READ(path);
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
        debugEntries.push(args || {});
        if (debugEntries.length > 1_200) debugEntries.splice(0, debugEntries.length - 1_200);
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
        const filePaths = await (window as any).__MAIN_E2E_DISK_GLOB();
        const visiblePaths = filePaths
          .filter((filePath: string) =>
            !/(?:^|\/)(?:node_modules|target|dist|build|\.git|\.MAIN)(?:\/|$)/.test(filePath) &&
            !/(?:^|\/)\.[^/]+(?:\/|$)/.test(filePath) &&
            !/^src-tauri\/(?:gen|icons)\//.test(filePath) &&
            !/(?:^|\/)package-lock\.json$/.test(filePath)
          )
          .slice(0, 120);
        return [".", ...visiblePaths.map((filePath: string) => `- ${filePath}`)].join("\n");
      }
      if (cmd === "list_directory") {
        const path = String(args?.path || ".");
        try {
          return await (window as any).__MAIN_E2E_DISK_LIST(path === workspace ? "." : path);
        } catch {
          // Fall back to the deterministic fixture structure below.
        }
        if (path === "." || path.includes("e2e-real-omlx")) {
          return [
            { name: "src", path: "src", is_dir: true },
            { name: "cn_tutorial_orders_by_creator_20260512.csv", path: "cn_tutorial_orders_by_creator_20260512.csv", is_dir: false },
          ];
        }
        if (path === "src") {
          return [
            { name: "components", path: "src/components", is_dir: true },
            { name: "hooks", path: "src/hooks", is_dir: true },
            { name: "store", path: "src/store", is_dir: true },
            { name: "types", path: "src/types", is_dir: true },
            { name: "App.tsx", path: "src/App.tsx", is_dir: false },
            { name: "index.css", path: "src/index.css", is_dir: false },
          ];
        }
        if (path === "src/components") {
          return [
            { name: "Dashboard", path: "src/components/Dashboard", is_dir: true },
            { name: "FileUploader", path: "src/components/FileUploader", is_dir: true },
          ];
        }
        if (path === "src/components/Dashboard") {
          return [
            { name: "CourseBarChart.tsx", path: "src/components/Dashboard/CourseBarChart.tsx", is_dir: false },
            { name: "TrendLineChart.tsx", path: "src/components/Dashboard/TrendLineChart.tsx", is_dir: false },
            { name: "StatusPieChart.tsx", path: "src/components/Dashboard/StatusPieChart.tsx", is_dir: false },
          ];
        }
        if (path === "src/components/FileUploader") {
          return [{ name: "DragUpload.tsx", path: "src/components/FileUploader/DragUpload.tsx", is_dir: false }];
        }
        if (path === "src/hooks") {
          return [
            { name: "useChartData.ts", path: "src/hooks/useChartData.ts", is_dir: false },
            { name: "useCsvParser.ts", path: "src/hooks/useCsvParser.ts", is_dir: false },
          ];
        }
        if (path === "src/store") {
          return [{ name: "dashboardStore.ts", path: "src/store/dashboardStore.ts", is_dir: false }];
        }
        if (path === "src/types") {
          return [{ name: "order.ts", path: "src/types/order.ts", is_dir: false }];
        }
        return [];
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
        return (await (window as any).__MAIN_E2E_DISK_GLOB())
          .filter((filePath: string) =>
            !/(?:^|\/)(?:node_modules|target|dist|build|\.git|\.MAIN)(?:\/|$)/.test(filePath) &&
            !/(?:^|\/)\.[^/]+(?:\/|$)/.test(filePath)
          )
          .filter((filePath: string) => matcher.test(filePath));
      }
      if (cmd === "grep_search") {
        const query = String(args?.query || args?.pattern || "");
        const filePaths = await (window as any).__MAIN_E2E_DISK_GLOB();
        const entries = await Promise.all(filePaths.map(async (filePath: string) => [filePath, await readText(filePath)] as const));
        return entries
          .filter(([, content]) => !query || String(content).includes(query))
          .map(([path, content]) => `${path}:1:${String(content).split("\n")[0]}`)
          .join("\n");
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
        const allPaths = await (window as any).__MAIN_E2E_DISK_GLOB();
        const filePaths = requestedPath
          ? allPaths.filter((filePath: string) => filePath.startsWith(requestedPath))
          : allPaths;
        const occurrences: Array<Record<string, unknown>> = [];
        for (const filePath of filePaths) {
          const content = await readText(filePath);
          String(content).split(/\r?\n/).forEach((line, index) => {
            const column = line.indexOf(symbol);
            if (column < 0) return;
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
          scannedFiles: filePaths.length,
          skippedFiles: 0,
          parseFailures: 0,
          occurrences,
          truncated: false,
          note: "E2E structured reference fixture",
        };
      }
      if (cmd === "build_repository_index") {
        const filePaths = await (window as any).__MAIN_E2E_DISK_GLOB();
        const sourceFiles = filePaths.filter((filePath: string) => /\.(?:ts|tsx|js|jsx|css)$/.test(filePath));
        const symbols: Array<Record<string, unknown>> = [];
        const imports: Array<Record<string, unknown>> = [];
        const calls: Array<Record<string, unknown>> = [];
        for (const filePath of sourceFiles) {
          const content = await readText(filePath);
          const lines = String(content).split(/\r?\n/);
          lines.forEach((line, index) => {
            const symbol = line.match(/\b(?:export\s+)?(?:function|const|interface|type|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
            if (symbol) {
              symbols.push({
                name: symbol[1],
                kind: line.includes("interface") ? "interface" : line.includes("type") ? "type" : line.includes("class") ? "class" : line.includes("function") ? "function" : "constant",
                file: filePath,
                line: index + 1,
                signature: line.trim(),
              });
            }
            const imported = line.match(/from\s+['"]([^'"]+)['"]/);
            if (imported) imports.push({ from: filePath, to: imported[1], kind: "import", line: index + 1 });
            for (const call of line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
              calls.push({ from: filePath, symbol: call[1], line: index + 1 });
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
        };
      }
      if (cmd === "read_file") return await readText(String(args?.path || ""));
      if (cmd === "read_file_window") {
        const path = String(args?.path || "");
        const content = await readText(path);
        return {
          path,
          content,
          startLine: 1,
          endLine: content.split(/\r?\n/).length,
          totalLines: content.split(/\r?\n/).length,
          totalChars: content.length,
          returnedChars: content.length,
          truncated: false,
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
  });
});

for (const model of models) {
  test(`real OMLX MAIN plan/approve/execute reaches closure or bounded pause with ${model}`, async ({ page }) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    const originalMutationContents = await readFixtureMutationContents(workspace);
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

    await page.evaluate((text) => {
      const bridge = (window as any).__CODELY_E2E__;
      Promise.resolve(bridge?.sendCloudMessage?.(text)).catch((error) => {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      });
    }, realOmlxRequest);

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
        if (artifactCount > 0) return "artifact_ready";
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
    const planQuality = validateActionablePlanArtifact(plan);
    expect(planQuality.ok, planQuality.reason || "semantic plan validation failed").toBe(true);
    expect(plan).toMatch(realOmlxPlanExpectation);
    for (const expectation of realOmlxPlanExpectAll) {
      expect(plan).toMatch(expectation);
    }
    expect(plan).not.toMatch(/用户目标：\s*(?:\n|$)/);
    expect(plan).not.toMatch(/以落实已批准目标|落实已批准方案中涉及|Apply the approved plan change/i);
    expect(plan).not.toMatch(/直接相关的最小改动|写入前先用证据确认|依据证据：已搜索文件|依据证据：已查看目录/i);
    expect(plan).not.toMatch(/(?:已读证据|证据引用|Read Evidence)[\s\S]{0,800}\.MAIN\/plans\/plan\.md/i);
    const planSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    const planChatText = JSON.stringify(planSnapshot?.taskFlowPreview || []);
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
      expect(JSON.stringify(finalPlanSnapshot?.debugTail || [])).not.toMatch(
        /plan_generation_failed|plan_evidence_materialization_exhausted/i,
      );
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

const subagentModel = process.env.OMLX_SUBAGENT_MODEL ||
  models[0];

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
  const terminalSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  if (terminalOutcome !== "joined_plan_ready") {
    console.log(`[real-omlx-subagents-terminal:${subagentModel}] ${JSON.stringify({
      terminalOutcome,
      agentStatus: terminalSnapshot?.agentStatus,
      currentTurnStatus: terminalSnapshot?.currentTurnStatus,
      planStage: terminalSnapshot?.planStage,
      runs: terminalSnapshot?.subagentRuns,
      taskFlow: terminalSnapshot?.taskFlowPreview,
      debug: terminalSnapshot?.debugTail,
    }).slice(0, 40_000)}`);
  }
  expect(terminalOutcome).toBe("joined_plan_ready");

  const snapshot = terminalSnapshot;
  expect(snapshot.agentStatus).toBe("pending_review");
  expect(snapshot.currentTurnStatus).toBe("awaiting_approval");
  expect(reviewablePlanStages.has(String(snapshot.planStage || ""))).toBe(true);
  const planQuality = validateActionablePlanArtifact(snapshot.planArtifacts[0].content);
  expect(planQuality.ok, planQuality.reason || "plan should be actionable").toBe(true);
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
  expect(selectedRuns.every((run) => {
    if (run.status === "completed") {
      return run.closureState === "satisfied" && run.evidenceCount > 0 && !run.remainingWork.trim();
    }
    if (run.status === "degraded") {
      return run.closureState === "partial" && run.evidenceCount > 0 && run.remainingWork.trim().length > 0;
    }
    return run.closureState === "blocked" &&
      (run.error.trim().length > 0 || run.remainingWork.trim().length > 0);
  })).toBe(true);
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
  expect(snapshot.planArtifacts[0].content).toMatch(/useCsvParser|creatorName/);
  expect(snapshot.planArtifacts[0].content).toMatch(/useChartData|dashboardStore/);
  expect(snapshot.planArtifacts[0].content).toMatch(/src\/types\/order\.ts/);
});

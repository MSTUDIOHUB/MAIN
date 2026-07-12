import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
const expectAgentExplanation = process.env.REAL_OMLX_EXPECT_AGENT_TEXT === "1";
const forbiddenChatNoise = /<tool_use>|<user_options>|\[PROPOSAL START\]|append_debug_log|ContextMemoryState|MAIN TOOL FEEDBACK|^\s*कल\s*$/m;

test.describe.configure({ timeout: 1_200_000 });
test.skip(!runRealOmlx, "Set MAIN_REAL_OMLX_E2E=1 to run real local OMLX plan-flow validation.");

test.beforeEach(async ({ page }) => {
  const customWorkspace = process.env.REAL_OMLX_WORKSPACE;
  const workspace = customWorkspace
    ? path.resolve(customWorkspace)
    : await fs.mkdtemp(path.join(os.tmpdir(), "e2e-real-omlx-"));
  (page as any).__realOmlxWorkspace = workspace;
  const seedFiles: Record<string, string> = {
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
  for (const [relative, content] of Object.entries(seedFiles)) {
    const absolute = path.join(workspace, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    let fileExists = false;
    try {
      await fs.access(absolute);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    if (!fileExists) {
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
  await page.exposeFunction("__MAIN_E2E_RUN_VERIFICATION", async (rawCommand: string) => {
    const command = String(rawCommand || "").trim();
    const parser = await fs.readFile(path.join(workspace, "src/hooks/useCsvParser.ts"), "utf8");
    const hasCreatorNameAssignment = /creatorName\s*:\s*[^,}\n]+/.test(parser);
    const isFiniteVerification = /(?:test|typecheck|tsc|check|verify|lint|build|compile)/i.test(command);
    const exitCode = hasCreatorNameAssignment && isFiniteVerification ? 0 : 1;
    return JSON.stringify({
      command,
      cwd: workspace,
      exitCode,
      stdout: exitCode === 0
        ? "Fresh fixture verification passed: creatorName assignment is present."
        : "Fresh fixture verification failed: expected a finite verification command and creatorName assignment.",
      stderr: "",
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

  await page.exposeFunction("__MAIN_E2E_CHAT_STREAM_REQUEST", async (args: Record<string, unknown>) => {
    const url = String(args.url || "");
    const bodyText = String(args.body || "");
    let model = "";
    try {
      model = String(JSON.parse(bodyText).model || "");
    } catch {
      // Keep logging best-effort; invalid JSON will fail at the endpoint.
    }
    const response = await fetch(url, {
      method: "POST",
      headers: args.headers as Record<string, string>,
      body: bodyText,
    });
    const text = await response.text();
    console.log(`[real-omlx-stream] ${response.status} ${url} model=${model} chars=${text.length} ${text.slice(0, 180).replace(/\s+/g, " ")}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return text;
  });

  await page.addInitScript(({ workspace, endpoint, apiKey }) => {
    const debugEntries = ((window as any).__REAL_OMLX_DEBUG_LOGS__ ??= []);
    let streamCancelled = false;
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
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "append_debug_log") {
        debugEntries.push(args || {});
        if (debugEntries.length > 800) debugEntries.splice(0, debugEntries.length - 800);
        return null;
      }
      if (cmd !== "plugin:event|listen" && cmd !== "plugin:event|unlisten") {
        console.log(`[real-omlx-invoke] ${cmd}`);
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
      if (cmd === "get_system_memory") return { total_gb: 64, available_gb: 48 };
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path || workspace);
      if (cmd === "cancel_proxy_request") return null;
      if (cmd === "cancel_chat_stream") {
        streamCancelled = true;
        return null;
      }
      if (cmd === "proxy_request") return await (window as any).__MAIN_E2E_PROXY_REQUEST(args || {});
      if (cmd === "proxy_request_detailed") return await (window as any).__MAIN_E2E_PROXY_REQUEST_DETAILED(args || {});
      if (cmd === "start_chat_stream") {
        const streamId = String(args?.streamId || args?.stream_id || "");
        streamCancelled = false;
        try {
          const chunk = await (window as any).__MAIN_E2E_CHAT_STREAM_REQUEST(args || {});
          if (streamCancelled) {
            emitTauriEvent("chat-stream-done", { stream_id: streamId, status: "cancelled", error: null });
            return null;
          }
          if (chunk) {
            emitTauriEvent("chat-stream-chunk", { stream_id: streamId, chunk });
          }
          emitTauriEvent("chat-stream-done", { stream_id: streamId, status: "ok", error: null });
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
        return [
          ".",
          "├── src",
          "│   ├── components",
          "│   │   ├── Dashboard",
          "│   │   │   ├── CourseBarChart.tsx",
          "│   │   │   ├── StatusPieChart.tsx",
          "│   │   │   └── TrendLineChart.tsx",
          "│   │   └── FileUploader",
          "│   │       └── DragUpload.tsx",
          "│   ├── hooks",
          "│   │   ├── useChartData.ts",
          "│   │   └── useCsvParser.ts",
          "│   └── store",
          "│       └── dashboardStore.ts",
          "│   ├── App.tsx",
          "│   ├── index.css",
          "│   └── types",
          "│       └── order.ts",
          "└── cn_tutorial_orders_by_creator_20260512.csv",
        ].join("\n");
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
      if (cmd === "glob_search") return (await (window as any).__MAIN_E2E_DISK_GLOB()).filter((path: string) => /\.(?:ts|tsx|css|csv)$/.test(path));
      if (cmd === "grep_search") {
        const query = String(args?.query || args?.pattern || "");
        const filePaths = await (window as any).__MAIN_E2E_DISK_GLOB();
        const entries = await Promise.all(filePaths.map(async (filePath: string) => [filePath, await readText(filePath)] as const));
        return entries
          .filter(([, content]) => !query || String(content).includes(query))
          .map(([path, content]) => `${path}:1:${String(content).split("\n")[0]}`)
          .join("\n");
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
      if (cmd === "write_file") {
        await writeText(String(args?.path || ""), String(args?.content || ""));
        return null;
      }
      if (cmd === "shell_permission_preflight") {
        return { decision: "allow", requiresApproval: false, source: "e2e" };
      }
      if (cmd === "browser_evaluate") {
        return {
          ok: true,
          url: String(args?.url || ""),
          finalUrl: String(args?.url || ""),
          status: 200,
          title: "Real OMLX fixture",
          assertions: [{ passed: true, description: "creatorName mapping fixture is ready" }],
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          textPreview: "creatorName",
          durationMs: 1,
        };
      }
      if (cmd === "run_command") {
        return await (window as any).__MAIN_E2E_RUN_VERIFICATION(String(args?.command || args?.cmd || ""));
      }
      return null;
    };
  }, { workspace, endpoint: omlxEndpoint, apiKey: omlxApiKey });
});

for (const model of models) {
  test(`real OMLX MAIN plan/approve/execute closes with ${model}`, async ({ page }) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
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
        if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
        const artifactCount = snapshot?.planArtifacts?.length ?? 0;
        if (artifactCount > 0) return "artifact_ready";
        if (
          snapshot?.isGenerating === false &&
          (
            (snapshot?.taskFlowTypes || []).includes("user") ||
            ["error", "idle"].includes(String(snapshot?.agentStatus || ""))
          )
        ) {
          const debugTail = JSON.stringify(snapshot?.debugTail || []).slice(-2_000);
          return `terminal_without_artifact:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}:${debugTail}`;
        }
        return "running";
      }, { timeout: 600_000 })
      .toBe("artifact_ready");

    const plan = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().planArtifacts?.[0]?.content || "");
    expect(plan).toMatch(/用户目标|Summary|摘要/);
    expect(plan).toMatch(/useCsvParser\.ts|CSV|creator/);
    expect(plan).not.toMatch(/用户目标：\s*(?:\n|$)/);
    expect(plan).not.toMatch(/以落实已批准目标|落实已批准方案中涉及|Apply the approved plan change/i);
    expect(plan).not.toMatch(/直接相关的最小改动|写入前先用证据确认|依据证据：已搜索文件|依据证据：已查看目录/i);
    expect(plan).not.toMatch(/(?:已读证据|证据引用|Read Evidence)[\s\S]{0,800}\.MAIN\/plans\/plan\.md/i);
    const planSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    const planChatText = JSON.stringify(planSnapshot?.taskFlowPreview || []);
    console.log(`[real-omlx-chat-plan:${model}] ${planChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(planChatText).toMatch(/read_file|list_directory|读取|计划|CSV|useCsvParser|creator/i);
    expect(planChatText).not.toMatch(forbiddenChatNoise);
    if (expectAgentExplanation) {
      expect((planSnapshot?.agentTexts || []).join("\n")).toMatch(/问题|分析|修复|Dashboard|CSV|深色|creator/i);
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

    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
        const parser = await fs.readFile(path.join(workspace, "src/hooks/useCsvParser.ts"), "utf8");
        return {
          status: snapshot?.agentStatus,
          approved: snapshot?.isPlanApproved,
          hasCreatorName: /creatorName\s*:/.test(parser),
          hasToolFailureCard: (snapshot?.toolBlocks || []).some((block: { status?: string; error?: string }) =>
            block.status === "failed" && /search_text|content|空变更|identical/i.test(String(block.error || "")),
          ),
        };
      }, { timeout: 500_000 })
      .toMatchObject({
        approved: true,
        hasCreatorName: true,
        hasToolFailureCard: false,
      });

    const parserOnDisk = await fs.readFile(path.join(workspace, "src/hooks/useCsvParser.ts"), "utf8");
    expect(parserOnDisk).toMatch(/creatorName\s*:/);
    expect(parserOnDisk).not.toEqual([
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
    ].join("\n"));

    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        if (snapshot?.activeActionRequest?.kind === "tool_permission") {
          await expect(page.getByTestId("execution-capsule-tool-approve-once")).toBeVisible();
          await page.getByTestId("execution-capsule-tool-approve-once").click();
          return "running";
        }
        if (
          snapshot?.isGenerating === false &&
          snapshot?.planStage === "completed" &&
          ["done", "completed_with_changes"].includes(String(snapshot?.currentTurnStatus || ""))
        ) return "completed";
        if (snapshot?.isGenerating === false) {
          const debugTail = JSON.stringify(snapshot?.debugTail || []).slice(-2_000);
          return `terminal_without_completion:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}:${debugTail}`;
        }
        return "running";
      }, { timeout: 300_000 })
      .toBe("completed");

    const bodyText = await page.locator("body").innerText();
    const executionSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    const executionChatText = JSON.stringify(executionSnapshot?.taskFlowPreview || []);
    console.log(`[real-omlx-chat-execute:${model}] ${executionChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(executionChatText).toMatch(/apply_patch|write_file|replace_in_file|run_command|已完成|creatorName|useCsvParser/i);
    expect(executionSnapshot?.planExecutionEvidence || []).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file", target: "src/hooks/useCsvParser.ts" }),
      expect.objectContaining({ kind: "cmd" }),
    ]));
    expect(executionChatText).not.toMatch(forbiddenChatNoise);
    expect(JSON.stringify(executionSnapshot?.debugTail || [])).not.toMatch(/no_progress_cached_read_only_batch|store\.non_actionable_stop/i);
    expect(bodyText).not.toMatch(forbiddenChatNoise);
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
      "修改 src/hooks/useCsvParser.ts，将 CSV creator 字段映射到 Dashboard 使用的 creatorName。完成标准：源码已修改且运行测试或类型检查通过；约束：保持 creator 向后兼容。",
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

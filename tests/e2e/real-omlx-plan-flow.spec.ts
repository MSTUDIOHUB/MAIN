import { expect, test } from "@playwright/test";

const runRealOmlx = process.env.MAIN_REAL_OMLX_E2E === "1";
const models = (process.env.OMLX_MODELS || "gemma-4-26b-a4b-it-8bit,Qwen3.6-35B-A3B-6bit")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const forbiddenChatNoise = /<tool_use>|<user_options>|\[PROPOSAL START\]|append_debug_log|ContextMemoryState|MAIN TOOL FEEDBACK|^\s*कल\s*$/m;

test.describe.configure({ timeout: 600_000 });
test.skip(!runRealOmlx, "Set MAIN_REAL_OMLX_E2E=1 to run real local OMLX plan-flow validation.");

test.beforeEach(async ({ page }) => {
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

  await page.addInitScript(() => {
    const workspace = "/tmp/e2e-real-omlx";
    const debugEntries = ((window as any).__REAL_OMLX_DEBUG_LOGS__ ??= []);
    let streamCancelled = false;
    const files = ((window as any).__REAL_OMLX_FILES__ ??= {
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
      "cn_tutorial_orders_by_creator_20260512.csv": "creator,amount\nalice,12\n",
    });
    const readText = (path: string) => {
      const normalized = path.replace(`${workspace}/`, "").replace(/^\/tmp\/e2e-real-omlx-[^/]+\//, "");
      if (Object.prototype.hasOwnProperty.call(files, normalized)) return files[normalized];
      if (Object.prototype.hasOwnProperty.call(files, path)) return files[path];
      throw new Error(`ENOENT: ${path}`);
    };
    const writeText = (path: string, content: string) => {
      const normalized = path.replace(`${workspace}/`, "").replace(/^\/tmp\/e2e-real-omlx-[^/]+\//, "");
      files[normalized] = content;
    };

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
          "│   ├── hooks",
          "│   │   └── useCsvParser.ts",
          "│   └── store",
          "│       └── dashboardStore.ts",
          "└── cn_tutorial_orders_by_creator_20260512.csv",
        ].join("\n");
      }
      if (cmd === "list_directory") {
        const path = String(args?.path || ".");
        if (path === "." || path.includes("e2e-real-omlx")) {
          return [
            { name: "src", path: "src", is_dir: true },
            { name: "cn_tutorial_orders_by_creator_20260512.csv", path: "cn_tutorial_orders_by_creator_20260512.csv", is_dir: false },
          ];
        }
        if (path === "src") {
          return [
            { name: "hooks", path: "src/hooks", is_dir: true },
            { name: "store", path: "src/store", is_dir: true },
          ];
        }
        if (path === "src/hooks") {
          return [{ name: "useCsvParser.ts", path: "src/hooks/useCsvParser.ts", is_dir: false }];
        }
        return [];
      }
      if (cmd === "glob_search") return Object.keys(files).filter((path) => path.endsWith(".ts") || path.endsWith(".csv"));
      if (cmd === "grep_search") {
        const query = String(args?.query || args?.pattern || "");
        return Object.entries(files)
          .filter(([, content]) => !query || String(content).includes(query))
          .map(([path, content]) => `${path}:1:${String(content).split("\n")[0]}`)
          .join("\n");
      }
      if (cmd === "read_file") return readText(String(args?.path || ""));
      if (cmd === "read_file_window") {
        const path = String(args?.path || "");
        const content = readText(path);
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
          content: readText(path),
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
        return { path, sizeBytes: readText(path).length, modifiedMs: Date.now() };
      }
      if (cmd === "write_file") {
        writeText(String(args?.path || ""), String(args?.content || ""));
        return null;
      }
      if (cmd === "shell_permission_preflight") {
        return { decision: "allow", requiresApproval: false, source: "e2e" };
      }
      if (cmd === "run_command") return "ok";
      return null;
    };
  });
});

for (const model of models) {
  test(`real OMLX MAIN plan/approve/execute closes with ${model}`, async ({ page }) => {
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[real-omlx-invoke] append_debug_log")) return;
      console.log(`[browser:${message.type()}] ${text}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[browser:pageerror] ${error.message}`);
    });
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);

    await page.evaluate(() => (window as any).__CODELY_E2E__?.sendCloudMessage?.());

    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        return {
          status: snapshot?.agentStatus,
          approved: snapshot?.isPlanApproved,
          artifactCount: snapshot?.planArtifacts?.length ?? 0,
          planStage: snapshot?.planStage,
        };
      }, { timeout: 300_000 })
      .toMatchObject({ artifactCount: 1 });

    const plan = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().planArtifacts?.[0]?.content || "");
    expect(plan).toMatch(/用户目标|Summary|摘要/);
    expect(plan).toMatch(/useCsvParser\.ts|CSV|creator/);
    expect(plan).not.toMatch(/用户目标：\s*(?:\n|$)/);
    expect(plan).not.toMatch(/以落实已批准目标|落实已批准方案中涉及|Apply the approved plan change/i);
    expect(plan).not.toMatch(/(?:已读证据|证据引用|Read Evidence)[\s\S]{0,800}\.MAIN\/plans\/plan\.md/i);
    const planSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    const planChatText = JSON.stringify(planSnapshot?.taskFlowPreview || []);
    console.log(`[real-omlx-chat-plan:${model}] ${planChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(planChatText).toMatch(/read_file|list_directory|读取|计划|CSV|useCsvParser|creator/i);
    expect(planChatText).not.toMatch(forbiddenChatNoise);

    await page.evaluate(() => (window as any).__CODELY_E2E__?.approvePlan?.());

    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        const parser = await page.evaluate(() => (window as any).__REAL_OMLX_FILES__?.["src/hooks/useCsvParser.ts"] || "");
        return {
          status: snapshot?.agentStatus,
          approved: snapshot?.isPlanApproved,
          hasCreatorName: /creatorName/.test(parser),
          hasToolFailureCard: (snapshot?.toolBlocks || []).some((block: { status?: string; error?: string }) =>
            block.status === "failed" && /search_text|content|空变更|identical/i.test(String(block.error || "")),
          ),
        };
      }, { timeout: 240_000 })
      .toMatchObject({
        approved: true,
        hasCreatorName: true,
        hasToolFailureCard: false,
      });

    const bodyText = await page.locator("body").innerText();
    const executionSnapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
    const executionChatText = JSON.stringify(executionSnapshot?.taskFlowPreview || []);
    console.log(`[real-omlx-chat-execute:${model}] ${executionChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(executionChatText).toMatch(/write_file|replace_in_file|run_command|已完成|creatorName|useCsvParser/i);
    expect(executionChatText).not.toMatch(forbiddenChatNoise);
    expect(bodyText).not.toMatch(forbiddenChatNoise);
  });
}

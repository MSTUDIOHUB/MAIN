import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const WORKSPACE = "/tmp/e2e-cloud-tool-fallback";
const runRealOmlx = process.env.MAIN_REAL_OMLX_E2E === "1";
const omlxEndpoint = String(process.env.OMLX_ENDPOINT || "http://127.0.0.1:8000/v1").replace(/\/+$/, "");
const omlxApiKey = process.env.OMLX_API_KEY || "mmnn";
const omlxModel = process.env.OMLX_MODELS || "Qwen3.6-35B-A3B-6bit";
let mcpServer: Server;
let mcpUrl: string;
let nonce: string;
const rpcRequests: Array<{ method: string; params?: any }> = [];
const providerRequests: string[] = [];

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  const output = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(output, JSON.stringify(value ?? null, null, 2));
  await testInfo.attach(name, { path: output, contentType: "application/json" });
}

async function omlxCacheEvidence() {
  const response = await fetch(new URL("../admin/api/stats", `${omlxEndpoint}/`).href, {
    headers: { authorization: `Bearer ${omlxApiKey}`, "x-api-key": omlxApiKey }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return { available: false, status: response.status };
  const stats = await response.json();
  const cache = stats.runtime_cache || {};
  const countFiles = async (root: string, filter: (name: string) => boolean) => {
    let files = 0; let bytes = 0;
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && filter(entry.name)) { files += 1; bytes += (await fs.stat(path.join(root, entry.name))).size; }
    }
    return { files, bytes };
  };
  const responseStatePath = typeof cache.response_state_dir === "string" ? cache.response_state_dir : "";
  const ssdPath = typeof cache.ssd_cache_dir === "string" ? cache.ssd_cache_dir : "";
  let shardFiles = 0; let shardBytes = 0;
  if (ssdPath) for (const shard of await fs.readdir(ssdPath, { withFileTypes: true }).catch(() => [])) {
    if (!shard.isDirectory() || !/^[a-f0-9]+$/i.test(shard.name)) continue;
    const counted = await countFiles(path.join(ssdPath, shard.name), (name) => name.endsWith(".safetensors"));
    shardFiles += counted.files; shardBytes += counted.bytes;
  }
  return {
    responseState: { path: responseStatePath, ...(responseStatePath ? await countFiles(responseStatePath, (name) => name.endsWith(".json")) : {}) },
    ssdPrefix: { path: ssdPath, files: shardFiles, bytes: shardBytes },
    hotPrefix: { entries: cache.hot_cache_entries, bytes: cache.hot_cache_size_bytes, models: cache.models },
    prefixMetrics: { totalCachedTokens: stats.total_cached_tokens, cacheEfficiency: stats.cache_efficiency },
    note: "Read-only observations; no cache tier was cleared. This is a functional check, not a cold-cache performance comparison.",
  };
}

async function loadedOmlxStatus() {
  const response = await fetch(`${omlxEndpoint}/models/status`, {
    headers: { authorization: `Bearer ${omlxApiKey}`, "x-api-key": omlxApiKey },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.ok, "authenticated OMLX model status must be available").toBe(true);
  const status = await response.json();
  const loaded = status.models.filter((model: any) => model.loaded && !model.is_loading);
  expect(status.loaded_count).toBe(1);
  expect(loaded.map((model: any) => model.id)).toEqual([omlxModel]);
  expect(status.models.some((model: any) => model.is_loading)).toBe(false);
  const servingResponse = await fetch(new URL("../api/status", `${omlxEndpoint}/`).href, {
    headers: { authorization: `Bearer ${omlxApiKey}`, "x-api-key": omlxApiKey },
    signal: AbortSignal.timeout(5000),
  });
  const serving = await servingResponse.json();
  expect(serving.active_requests).toBe(0);
  expect(serving.waiting_requests).toBe(0);
  return { loaded_count: status.loaded_count, active_requests: serving.active_requests, waiting_requests: serving.waiting_requests, models: loaded.map((model: any) => ({ id: model.id, loaded: model.loaded, is_loading: model.is_loading, actual_size: model.actual_size })) };
}

test.beforeAll(async () => {
  nonce = `GEMINI_EXTENSION_NONCE_${randomBytes(10).toString("hex")}`;
  mcpServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = body ? JSON.parse(body) : {};
    rpcRequests.push({ method: rpc.method, params: rpc.params });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("mcp-session-id", "gemini-extension-fixture-session");
    if (!rpc.id) { response.writeHead(204).end(); return; }
    const result = rpc.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "gemini-fixture", version: "1.0" } }
      : rpc.method === "tools/list"
        ? { tools: [{ name: "get_extension_nonce", description: "Read the fresh extension verification nonce. Read only; no side effects.", inputSchema: { type: "object", properties: {}, required: [] } }] }
        : rpc.method === "tools/call" && rpc.params?.name === "get_extension_nonce"
          ? { content: [{ type: "text", text: nonce }] }
          : null;
    response.end(JSON.stringify(result === null
      ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown fixture method" } }
      : { jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const address = mcpServer.address();
  if (!address || typeof address === "string") throw new Error("MCP fixture did not bind TCP");
  mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => mcpServer.close((error) => error ? reject(error) : resolve()));
});

test.beforeEach(async ({ page }) => {
  rpcRequests.length = 0;
  providerRequests.length = 0;
  await page.exposeFunction("__GEMINI_TEST_HTTP", async (args: any) => {
    const url = String(args.url || "");
    const isMcp = url === mcpUrl;
    const isOmlx = runRealOmlx && url.startsWith(`${omlxEndpoint}/`);
    if (!isMcp && !isOmlx) throw new Error(`Fixture refused unknown network destination: ${url}`);
    if (isOmlx && args.body) providerRequests.push(String(args.body));
    const response = await fetch(url, {
      method: args.method || "POST",
      headers: args.headers,
      ...(args.body ? { body: String(args.body) } : {}),
      signal: AbortSignal.timeout(isOmlx ? 180000 : 10000),
    });
    const result = { status: response.status, ok: response.ok, body: await response.text(), contentType: response.headers.get("content-type") || "", headers: Object.fromEntries(response.headers.entries()) };
    if (!isMcp && !response.ok) throw new Error(`OMLX HTTP ${response.status}: ${result.body.slice(0, 300)}`);
    return result;
  });
  await page.addInitScript(({ endpoint, actualMemory }) => {
    if (!sessionStorage.getItem("__GEMINI_EXTENSION_E2E_RESET__")) {
      localStorage.clear();
      sessionStorage.setItem("__GEMINI_EXTENSION_E2E_RESET__", "1");
    }
    const harness: any = ((window as any).__GEMINI_EXTENSION_E2E__ = { requests: [], deletedPackages: [], extractionCount: 0, flow: "plain", debug: [] });
    const entries = ["skills/nonce-check/SKILL.md", "skills/unused-workflow/SKILL.md"];
    const files = ["gemini-extension.json", ...entries, "GEMINI.md", "hooks/hooks.json", "skills/nonce-check/references/guide.md"];
    const manifest = {
      name: "nonce-extension", version: "1.0.0", description: "Read-only extension verification workflow.",
      mcpServers: {
        nonce: { httpUrl: endpoint },
        credentialed: { httpUrl: endpoint, headers: { Authorization: "Bearer ${UNRESOLVED_TEST_TOKEN}" } },
        legacy: { url: endpoint }, process: { command: "node", args: ["server.js"] },
      },
    };
    const skillContent = (target: string) => target.includes("unused-workflow")
      ? "---\nname: unused-workflow\ndescription: Unrelated workflow, never use for nonce verification.\n---\nUNSELECTED_SKILL_BODY"
      : "---\nname: nonce-check\ndescription: Load to verify the imported extension with its read-only nonce MCP tool.\n---\nGEMINI_SKILL_BODY_ONLY\nCall get_extension_nonce once, then answer with the exact fresh nonce returned by that tool. Do not guess or fabricate its value.";
    let callbackId = 1;
    const callbacks = new Map<number, any>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const emit = (event: string, payload: unknown) => {
      for (const listener of listeners.values()) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id: listener.handler, payload });
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    const internals: any = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.metadata = { currentWindow: { label: "main" }, currentWebview: { label: "main" } };
    internals.transformCallback = (callback: any) => { const id = callbackId++; callbacks.set(id, callback); return id; };
    internals.unregisterCallback = (id: number) => callbacks.delete(id);
    internals.invoke = async (command: string, args: any = {}) => {
      if (command === "plugin:event|listen") { const id = Number(args.handler || callbackId++); listeners.set(id, { event: args.event, handler: id }); return id; }
      if (command === "plugin:event|unlisten") { listeners.delete(Number(args.eventId)); return null; }
      if (command === "get_system_memory") return actualMemory;
      if (command === "plugin:dialog|open") return "/tmp/nonce-extension.zip";
      if (command === "extract_gemini_extension") {
        harness.extractionCount += 1;
        if (harness.holdExtraction) await new Promise<void>((resolve) => { harness.releaseExtraction = resolve; });
        return { manifest_json: JSON.stringify(manifest), manifest_path: "gemini-extension.json", files, entry_points: entries, package_hash: `sha256-${"a".repeat(64)}`, local_path: `.protocols/gemini-fixture-${harness.extractionCount}`, workspace: args.workspace };
      }
      if (command === "delete_protocol_package") {
        if (harness.deleteError) throw new Error("Fixture package deletion failed");
        harness.deletedPackages.push({ localPath: args.localPath, workspace: args.workspace }); return null;
      }
      if (command === "discover_personal_agent_skills") return [];
      if (command === "set_workspace_root" || command === "canonicalize_workspace_path") return String(args.path || "/tmp/e2e-cloud-tool-fallback");
      if (command === "get_workspace_root") return "/tmp/e2e-cloud-tool-fallback";
      if (command === "read_file") {
        if (String(args.path).includes(".protocols/gemini-fixture-") && String(args.path).endsWith("SKILL.md")) return skillContent(args.path);
        if (String(args.path).endsWith("references/guide.md")) return "Relative extension support resource.";
        throw new Error("ENOENT");
      }
      if (command === "glob_search") return String(args.pattern).startsWith(".protocols/") ? [`${String(args.pattern).split("/**")[0]}/references/guide.md`] : [];
      if (command === "list_directory" || command === "list_project_sessions" || command === "rebuild_project_sessions_index") return [];
      if (command === "get_git_status") return { isRepo: false, repoRoot: null, branch: null, changes: [], staged: [], unstaged: [], untracked: [] };
      if (command === "save_project_session") return args.session || {};
      if (command === "load_project_session") return {};
      if (command === "load_project_session_meta") return { id: args.sessionId, runtimeSnapshot: harness.pausedMetadata ? { conversationTurns: [{ id: "cold-paused-turn", status: "paused", runtimeOutcome: { status: "paused" } }] } : {} };
      if (command === "append_debug_log") { harness.debug.push({ source: args.source, message: args.message }); return null; }
      if (command === "proxy_request_detailed") {
        if (harness.holdDiscovery && JSON.parse(args.body || "{}").method === "tools/list") await new Promise<void>((resolve) => { harness.releaseDiscovery = resolve; });
        return (window as any).__GEMINI_TEST_HTTP(args);
      }
      if (command === "start_chat_stream") {
        try {
          harness.requests.push(String(args.body || ""));
          const result = await (window as any).__GEMINI_TEST_HTTP({ ...args, method: "POST" });
          emit("chat-stream-chunk", { stream_id: args.streamId, chunk: result.body });
          emit("chat-stream-done", { stream_id: args.streamId, status: "ok", error: null });
        } catch (error) {
          emit("chat-stream-done", { stream_id: args.streamId, status: "error", error: String(error) });
        }
        return null;
      }
      if (command === "cancel_chat_stream" || command === "cancel_proxy_request") return null;
      if (command === "proxy_request") {
        if (String(args.url).includes("127.0.0.1:8000") || String(args.url).includes("localhost:8000")) return (await (window as any).__GEMINI_TEST_HTTP(args)).body;
        const body = String(args.body || "{}");
        harness.requests.push(body);
        if (harness.flow !== "skill-mcp") return JSON.stringify({ output_text: "ordinary-workspace-ok" });
        const parsed = JSON.parse(body);
        const receipts: any[] = [];
        const collect = (value: any) => {
          if (typeof value === "string" && value.trim().startsWith("{")) { try { collect(JSON.parse(value)); } catch { /* plain text */ } }
          else if (Array.isArray(value)) value.forEach(collect);
          else if (value && typeof value === "object") { if (value.type === "skill.catalog" || value.type === "skill.loaded") receipts.push(value); else Object.values(value).forEach(collect); }
        };
        collect(parsed);
        const nativeCall = (name: string, callArgs: any) => JSON.stringify({ output: [{ type: "function_call", call_id: `fixture-${harness.requests.length}`, name, arguments: JSON.stringify(callArgs) }] });
        const foundNonce = body.match(/GEMINI_EXTENSION_NONCE_[a-f0-9]+/);
        if (foundNonce) return JSON.stringify({ output_text: `Verified ${foundNonce[0]}` });
        if (!receipts.some((receipt) => receipt.type === "skill.loaded")) {
          const catalog = receipts.find((receipt) => receipt.type === "skill.catalog");
          return nativeCall("load_skill", catalog ? { skill_id: catalog.entries.find((entry: any) => entry.name === "nonce-check").id } : { operation: "list", query: "nonce-check" });
        }
        const mcpTool = parsed.tools.find((tool: any) => String(tool.name || tool.function?.name).includes("get_extension_nonce"));
        if (!mcpTool) throw new Error("Imported MCP tool is missing from the real Runtime request");
        return nativeCall(mcpTool.name || mcpTool.function.name, {});
      }
      return null;
    };
  }, { endpoint: mcpUrl, actualMemory: { total_gb: os.totalmem() / 1024 ** 3, available_gb: os.freemem() / 1024 ** 3, total_bytes: os.totalmem(), available_bytes: os.freemem() } });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const evidence = await page.evaluate(() => ({ snapshot: (window as any).__CODELY_E2E__?.getSnapshot?.(), fixture: (window as any).__GEMINI_EXTENSION_E2E__ })).catch(() => null);
  await attachJson(testInfo, "failure-runtime-evidence", evidence);
});

async function openPanel(page: Page) {
  await page.getByRole("button", { name: "技能与提示词", exact: true }).click();
  const panel = page.getByTestId("gemini-extensions-panel");
  await expect(panel).toBeVisible();
  return panel;
}

async function importFixture(page: Page) {
  const panel = await openPanel(page);
  await panel.getByRole("button", { name: "导入 Gemini ZIP", exact: true }).click();
  const preview = page.getByTestId("gemini-extension-preview");
  await expect(preview).toBeVisible();
  await preview.getByRole("checkbox", { name: /unused-workflow/ }).uncheck();
  return { panel, preview };
}

async function installAndDiscover(page: Page) {
  const { panel, preview } = await importFixture(page);
  await preview.getByRole("button", { name: "安装所选组件", exact: true }).click();
  await expect(page.getByTestId("gemini-extension-installation")).toBeVisible();
  await panel.getByRole("button", { name: "测试并发现工具", exact: true }).click();
  await expect(panel.getByText("nonce · 已连接", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
}

async function extensionState(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state?.geminiExtensions || []);
}

async function runtimeLifecycle(page: Page) {
  return page.evaluate(async () => {
    const storeModule = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /\/src\/store\/useAppStore\.ts(?:\?|$)/.test(name)).at(-1) || "/src/store/useAppStore.ts";
    const { useAppStore } = await import(storeModule);
    const checkpointModule = "/src/lib/runtime-v2/checkpoint.ts";
    const { normalizeRuntimeV2Checkpoint } = await import(checkpointModule);
    const state = useAppStore.getState();
    const checkpoint = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[state.currentTurnId]);
    return checkpoint?.events.filter((event: any) => ["turn.admitted", "run.started", "run.completed", "turn.completed"].includes(event.type)).map((event: any) => ({ type: event.type, resultKind: event.outcome?.resultKind, turnId: event.turn?.turnId || event.run?.turnId || checkpoint.owner.turnId }));
  });
}

test("ZIP preview selects supported components, discovers real HTTP MCP, and persists without connection cache", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const { panel, preview } = await importFixture(page);
  await expect(preview.getByText(/以下内容不会生效/)).toContainText("GEMINI.md");
  await expect(preview.getByText(/以下内容不会生效/)).toContainText("hooks");
  await expect(preview.getByRole("checkbox", { name: /credentialed/ })).toBeDisabled();
  await expect(preview.getByRole("checkbox", { name: /legacy/ })).toBeDisabled();
  await expect(preview.getByRole("checkbox", { name: /process/ })).toBeDisabled();
  for (const theme of ["light", "dark", "black"] as const) {
    await page.evaluate((mode) => (window as any).__CODELY_E2E__.setThemeMode(mode), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await panel.screenshot({ path: testInfo.outputPath(`gemini-extension-${theme}.png`) });
  }
  await preview.getByRole("button", { name: "安装所选组件", exact: true }).click();
  await expect.poll(() => extensionState(page)).toHaveLength(1);
  const [installed] = await extensionState(page);
  expect(installed.workspaceScope).toBe(WORKSPACE);
  expect(installed.skillEntryPoints).toEqual(["skills/nonce-check/SKILL.md"]);
  expect(installed.mcpServers.filter((server: any) => server.enabled).map((server: any) => server.key)).toEqual(["nonce"]);
  await panel.getByRole("button", { name: "测试并发现工具", exact: true }).click();
  await expect(panel.getByText("nonce · 已连接", { exact: true })).toBeVisible();
  expect(rpcRequests.map((request) => request.method)).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
  expect(rpcRequests.some((request) => request.method === "tools/call")).toBe(false);
  await page.reload();
  const reloaded = await openPanel(page);
  await expect(page.getByTestId("gemini-extension-installation")).toContainText("nonce-extension");
  await expect(reloaded.getByText("nonce · 尚未发现工具", { exact: true })).toBeVisible();
});

test("next Turn loads the imported Skill then calls real MCP; another workspace receives neither capability", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await installAndDiscover(page);
  await page.evaluate(() => { (window as any).__GEMINI_EXTENSION_E2E__.flow = "skill-mcp"; });
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__.sendCloudMessage("请查找并加载 nonce-check Skill，再按其说明调用只读工具并返回 nonce。"))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot().currentTurnResultKind), { timeout: 30000 }).toBe("success");
  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
  expect(snapshot.visibleFinalCount).toBe(1);
  expect(snapshot.toolNames).toContain("load_skill");
  expect(snapshot.agentTexts.join("\n")).toContain(nonce);
  const lifecycle = await runtimeLifecycle(page);
  expect(lifecycle?.map((event: any) => event.type)).toEqual(["turn.admitted", "run.started", "run.completed", "turn.completed"]);
  expect(lifecycle?.slice(-2).every((event: any) => event.resultKind === "success")).toBe(true);
  expect(rpcRequests.some((request) => request.method === "tools/call" && request.params?.name === "get_extension_nonce")).toBe(true);
  const bodies: string[] = await page.evaluate(() => (window as any).__GEMINI_EXTENSION_E2E__.requests.filter((body: string) => body.includes("[MAIN RUNTIME V2]")));
  expect(bodies[0]).not.toContain("GEMINI_SKILL_BODY_ONLY");
  expect(bodies.some((body) => body.includes("GEMINI_SKILL_BODY_ONLY"))).toBe(true);
  expect(bodies.join("\n")).not.toContain("UNSELECTED_SKILL_BODY");
  await attachJson(testInfo, "mcp-rpc-evidence", rpcRequests);
  await page.evaluate(async () => {
    const storeModule = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /\/src\/store\/useAppStore\.ts(?:\?|$)/.test(name)).at(-1) || "/src/store/useAppStore.ts";
    const { useAppStore } = await import(storeModule);
    useAppStore.setState((state: any) => ({ currentWorkspace: "/tmp/gemini-other-workspace", selectedWorkspace: "/tmp/gemini-other-workspace", currentSessionId: null, config: { ...state.config, workspace: "/tmp/gemini-other-workspace" } }));
    const harness = (window as any).__GEMINI_EXTENSION_E2E__;
    harness.flow = "plain"; harness.requests = [];
  });
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__.sendCloudMessage("请回答这个项目是否可用。"))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot().currentTurnResultKind)).toBe("success");
  const otherRequests: string[] = await page.evaluate(() => (window as any).__GEMINI_EXTENSION_E2E__.requests.filter((body: string) => body.includes("[MAIN RUNTIME V2]")));
  expect(otherRequests.length).toBeGreaterThan(0);
  for (const body of otherRequests) {
    const request = JSON.parse(body);
    expect(JSON.stringify(request.tools)).not.toContain("get_extension_nonce");
    // Conversation history can mention an earlier Skill; admission must not
    // advertise it as a capability in this different workspace.
    expect(String(request.instructions)).not.toContain("nonce-check");
    expect(String(request.instructions)).not.toContain("GEMINI_SKILL_BODY_ONLY");
  }
});

test("cancel and a late extraction after closing clean only the captured workspace package", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const { panel, preview } = await importFixture(page);
  await preview.getByRole("button", { name: "取消导入", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__GEMINI_EXTENSION_E2E__.deletedPackages)).toEqual([{ localPath: ".protocols/gemini-fixture-1", workspace: WORKSPACE }]);
  await page.evaluate(() => { (window as any).__GEMINI_EXTENSION_E2E__.holdExtraction = true; });
  await panel.getByRole("button", { name: "导入 Gemini ZIP", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__GEMINI_EXTENSION_E2E__.releaseExtraction)).toBe("function");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => (window as any).__GEMINI_EXTENSION_E2E__.releaseExtraction());
  await expect.poll(() => page.evaluate(() => (window as any).__GEMINI_EXTENSION_E2E__.deletedPackages.length)).toBe(2);
  expect(await extensionState(page)).toEqual([]);
});

test("failed deletion preserves the installation and cold paused metadata blocks uninstall", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await installAndDiscover(page);
  const original = await extensionState(page);
  const panel = await openPanel(page);
  await page.evaluate(() => { (window as any).__GEMINI_EXTENSION_E2E__.deleteError = true; });
  await panel.getByRole("button", { name: "卸载", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  expect(await extensionState(page)).toEqual(original);
  await page.evaluate(async () => {
    const storeModule = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /\/src\/store\/useAppStore\.ts(?:\?|$)/.test(name)).at(-1) || "/src/store/useAppStore.ts";
    const { useAppStore } = await import(storeModule);
    useAppStore.setState((state: any) => ({ sessionsByWorkspace: { ...state.sessionsByWorkspace, "/tmp/e2e-cloud-tool-fallback": [...state.sessionsByWorkspace["/tmp/e2e-cloud-tool-fallback"], { id: 999888, title: "Cold paused session", storageStatus: "stored", messages: [], active: false }] } }));
    const harness = (window as any).__GEMINI_EXTENSION_E2E__;
    harness.deleteError = false; harness.pausedMetadata = true;
  });
  await panel.getByRole("button", { name: "卸载", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("进行中或暂停的任务");
  expect(await extensionState(page)).toEqual(original);
  expect(await page.evaluate(() => (window as any).__GEMINI_EXTENSION_E2E__.deletedPackages)).toEqual([]);
  await page.evaluate(() => { (window as any).__GEMINI_EXTENSION_E2E__.pausedMetadata = false; });
  await panel.getByRole("button", { name: "卸载", exact: true }).click();
  await expect.poll(() => extensionState(page)).toEqual([]);
});

test("a discovery settling after workspace switch does not publish feedback into the replacement panel", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const { panel, preview } = await importFixture(page);
  await preview.getByRole("button", { name: "安装所选组件", exact: true }).click();
  await page.evaluate(() => { (window as any).__GEMINI_EXTENSION_E2E__.holdDiscovery = true; });
  await panel.getByRole("button", { name: "测试并发现工具", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__GEMINI_EXTENSION_E2E__.releaseDiscovery)).toBe("function");
  await page.evaluate(async () => {
    const storeModule = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /\/src\/store\/useAppStore\.ts(?:\?|$)/.test(name)).at(-1) || "/src/store/useAppStore.ts";
    const { useAppStore } = await import(storeModule);
    useAppStore.setState({ currentWorkspace: "/tmp/gemini-replacement-workspace", selectedWorkspace: "/tmp/gemini-replacement-workspace" });
  });
  await expect(panel.getByText("尚未在此项目安装 Gemini CLI 扩展。", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__GEMINI_EXTENSION_E2E__.releaseDiscovery());
  await expect(panel.getByRole("button", { name: "导入 Gemini ZIP", exact: true })).toBeEnabled();
  await expect(page.getByTestId("gemini-extension-installation")).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("real OMLX model uses the installed Skill and unauthenticated MCP through MAIN Runtime", async ({ page }, testInfo) => {
  test.skip(!runRealOmlx, "Set MAIN_REAL_OMLX_E2E=1 to run against an already loaded local model.");
  test.setTimeout(300000);
  const before = await loadedOmlxStatus();
  await attachJson(testInfo, "omlx-preflight", before);
  await attachJson(testInfo, "omlx-cache-before", await omlxCacheEvidence());
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await installAndDiscover(page);
  const configured = await page.evaluate(async ({ endpoint, model, apiKey }) => {
    const storeModule = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /\/src\/store\/useAppStore\.ts(?:\?|$)/.test(name)).at(-1) || "/src/store/useAppStore.ts";
    const { useAppStore } = await import(storeModule);
    useAppStore.setState((state: any) => ({ config: { ...state.config, activeProfile: "local", instructionsEnabled: true, local: { ...state.config.local, provider: "OMLX", endpoint, model, apiKey, contextLimit: 32768, toolProtocol: "auto", maxActiveRequests: 1 } } }));
    return { activeProfile: useAppStore.getState().config.activeProfile, model: useAppStore.getState().config.local.model };
  }, { endpoint: omlxEndpoint, model: omlxModel, apiKey: omlxApiKey });
  expect(configured).toEqual({ activeProfile: "local", model: omlxModel });
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__.sendCloudMessage("请先查找并加载名为 nonce-check 的已安装 Skill，然后严格按其说明调用外部只读工具，准确返回该工具提供的当前 nonce。不要读取本地文件，也不要猜测 nonce。"))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot().currentTurnResultKind), { timeout: 240000, intervals: [1000, 2000, 5000] }).toBe("success");
  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
  await attachJson(testInfo, "main-runtime-result", snapshot);
  const rawCheckpoint = await page.evaluate(async () => {
    const storeModule = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /\/src\/store\/useAppStore\.ts(?:\?|$)/.test(name)).at(-1) || "/src/store/useAppStore.ts";
    const { useAppStore } = await import(storeModule);
    const state = useAppStore.getState();
    return state.runtimeV2Checkpoints[state.currentTurnId];
  });
  await attachJson(testInfo, "main-raw-checkpoint", rawCheckpoint);
  await attachJson(testInfo, "real-mcp-rpc", rpcRequests);
  await attachJson(testInfo, "omlx-request-shape", providerRequests.map((body) => { const request = JSON.parse(body); return { model: request.model, stream: request.stream, tools: request.tools?.map((tool: any) => tool.function?.name || tool.name), skillBodyPresent: body.includes("GEMINI_SKILL_BODY_ONLY") }; }));
  expect(providerRequests.length).toBeGreaterThan(0);
  expect(snapshot.toolNames).toContain("load_skill");
  expect(snapshot.visibleFinalCount).toBe(1);
  expect(snapshot.agentTexts.join("\n")).toContain(nonce);
  expect(rpcRequests.some((request) => request.method === "tools/call" && request.params?.name === "get_extension_nonce")).toBe(true);
  const lifecycle = await runtimeLifecycle(page);
  await attachJson(testInfo, "single-turn-lifecycle", lifecycle);
  expect(lifecycle?.map((event: any) => event.type)).toEqual(["turn.admitted", "run.started", "run.completed", "turn.completed"]);
  expect(lifecycle?.every((event: any) => event.turnId === snapshot.currentTurnId)).toBe(true);
  expect(lifecycle?.slice(-2).every((event: any) => event.resultKind === "success")).toBe(true);
  await attachJson(testInfo, "omlx-postflight", await loadedOmlxStatus());
  await attachJson(testInfo, "omlx-cache-after", await omlxCacheEvidence());
});

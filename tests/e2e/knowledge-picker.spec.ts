import { expect, test, type Page } from "@playwright/test";

const WORKSPACE_A = "/tmp/main-knowledge-picker-a";
const WORKSPACE_B = "/tmp/main-knowledge-picker-b";

async function seedKnowledge(page: Page, theme = "dark") {
  await page.addInitScript(({ theme, workspaceA, workspaceB }) => {
    localStorage.clear();
    const now = Date.now();
    const session = (id: number) => ({ id, title: `资料聊天 ${id}`, active: true, messages: [], date: new Date(now).toISOString(), storageStatus: "temporary", recordingDisabled: true });
    const sessions: Record<string, any[]> = { [workspaceA]: [session(201)], [workspaceB]: [session(202)] };
    localStorage.setItem("local-agent-ide", JSON.stringify({ version: 2, state: {
      config: { language: "zh", themeMode: theme, sessionRecordingEnabled: false, activeProfile: "local", workflowMode: "chat", local: { provider: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", model: "fixture-no-inference", contextLimit: 16384, apiKey: "" } },
      currentWorkspace: workspaceA, selectedWorkspace: workspaceA, currentSessionId: 201,
      workspaces: [{ path: workspaceA, name: "资料项目 A", addedAt: now }, { path: workspaceB, name: "资料项目 B", addedAt: now }],
      sessionsByWorkspace: sessions, activeSessionByWorkspace: { [workspaceA]: 201, [workspaceB]: 202 }, selectedMainModeKey: "main_mode",
    } }));
    const base = { id: "kb-cn", name: "中文产品资料", description: "本地词面索引", enabled: true, sourceCount: 2, indexStatus: "ready", indexRevision: "index-v1", embeddingProfile: "fts5_cjk_bigram_v2", createdAtMs: now, updatedAtMs: now };
    const source = { id: "source-cn", kbId: base.id, title: "项目约定", originalPath: "fixture.md", storagePath: "fixture.md", ext: ".md", size: 3200, hash: "fixture-hash", status: "indexed", metadata: {}, lastIndexedAtMs: now, sourceRevision: "source-v1" };
    const state = (window as any).__KNOWLEDGE_E2E__ = { calls: [] as any[], holdCatalog: false, pending: [] as Array<() => void>, admissions: [] as any[], pendingAdmissions: [] as Array<() => void>, fixtureModel: false, modelRequests: [] as any[], callbacks: {} as Record<number, any>, listeners: {} as Record<string, number[]> };
    let callbackId = 1;
    let activeWorkspace = workspaceA;
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    internals.metadata = { currentWindow: { label: "main" }, currentWebview: { label: "main" } };
    internals.transformCallback = (callback: any) => { const id = callbackId++; state.callbacks[id] = callback; return id; };
    internals.unregisterCallback = () => {};
    internals.invoke = async (command: string, args?: any) => {
      if (command === "plugin:event|listen") { (state.listeners[args.event] ??= []).push(args.handler); return callbackId++; }
      if (command === "plugin:event|unlisten") return null;
      if (command === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (command === "get_workspace_root") return activeWorkspace;
      if (command === "canonicalize_workspace_path") return args.path;
      if (command === "set_workspace_root") { activeWorkspace = args.path; return activeWorkspace; }
      if (command === "list_all_session_snapshots" || command === "list_legacy_session_files") return [];
      if (command === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
      if (command === "list_project_sessions" || command === "rebuild_project_sessions_index") return sessions[args.workspace] || [];
      if (command === "load_project_session" || command === "load_project_session_meta") return sessions[args.workspace]?.find(item => String(item.id) === String(args.sessionId)) || null;
      if (command === "save_project_session") return args.session;
      if (command === "get_git_status") return { isRepo: false, gitAvailable: true, clean: true };
      if (command === "main_update_status") return { status: "idle" };
      if (command === "discover_personal_agent_skills" || command === "glob_search") return [];
      if (command === "read_file") throw new Error("ENOENT");
      if (command.startsWith("knowledge_")) state.calls.push({ command, args: JSON.parse(JSON.stringify(args || {})) });
      if (command === "knowledge_list_bases") {
        if (state.holdCatalog) await new Promise<void>(release => state.pending.push(release));
        return [base];
      }
      if (command === "knowledge_list_sources") return [source, { ...source, id: "source-scan", title: "扫描件待 OCR", status: "needs_ocr", sourceRevision: "scan-v1" }];
      if (command === "knowledge_search" || command === "knowledge_get_excerpt") {
        const selected = args.references || [];
        if (!selected.length) return command === "knowledge_search" ? { hits: [], note: "No selected sources" } : null;
        if (selected.some((ref: any) => ref.kbId !== base.id || (ref.kind === "source" && ref.sourceId !== source.id))) throw new Error("STALE_KNOWLEDGE_REFERENCE");
        const hit = { text: "中文知识库正文；这是有限开头概览。", excerpt: "中文知识库正文", citation: { kbId: base.id, kbName: base.name, sourceId: source.id, sourceTitle: source.title, chunkId: args.chunkId || "source-cn:0", sourceRevision: source.sourceRevision, indexRevision: base.indexRevision, score: 0 }, returnedCharRange: { start: 0, end: 22 }, totalChars: 2800, complete: false, retrievalKind: "source_overview", sourceOverview: { totalChunks: 4, totalChars: 9500, nextChunkId: "source-cn:1" } };
        return command === "knowledge_search" ? { query: args.query, hits: [hit], note: "NO_LEXICAL_MATCH: limited opening overview, not a full summary" } : { ...hit, retrievalKind: "source_excerpt" };
      }
      if (command === "start_chat_stream") {
        if (!state.fixtureModel) throw new Error("This test must not invoke a model");
        state.modelRequests.push(JSON.parse(args.body));
        const emit = (event: string, payload: any) => (state.listeners[event] || []).forEach((id: number) => state.callbacks[id]?.({ event, payload }));
        setTimeout(() => {
          emit("chat-stream-chunk", { stream_id: args.streamId, chunk: `data: ${JSON.stringify({ choices: [{ delta: { content: "已根据本轮可见内容回答。" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
          emit("chat-stream-done", { stream_id: args.streamId, status: "ok" });
        }, 15);
        return null;
      }
      if (command === "proxy_request" || command === "stream_chat") {
        if (!state.fixtureModel) throw new Error("This test must not invoke a model");
        const body = args.body ? JSON.parse(args.body) : {};
        if (body.messages?.some((message: any) => typeof message.content === "string" && message.content.includes("[MAIN RUNTIME V2]"))) state.modelRequests.push(body);
        if (!body.messages) return JSON.stringify({ data: [{ id: "fixture-no-inference", context_length: 16384, loaded: true }] });
        return JSON.stringify({ choices: [{ message: { role: "assistant", content: "已根据本轮可见内容回答。" }, finish_reason: "stop" }] });
      }
      return null;
    };
  }, { theme, workspaceA: WORKSPACE_A, workspaceB: WORKSPACE_B });
  await page.goto("/");
  await expect(page.getByTestId("composer-textarea")).toBeVisible();
}

async function chooseSource(page: Page) {
  const input = page.getByTestId("composer-textarea");
  await input.fill("#项目");
  const picker = page.getByTestId("knowledge-picker");
  await picker.getByRole("checkbox", { name: "项目约定", exact: true }).check();
  await picker.getByRole("button", { name: "添加所选 (1)", exact: true }).click();
  await expect(page.getByTestId("knowledge-selection-chips")).toContainText("项目约定");
}

test("hash searches and multi-selects exact versioned libraries or sources without interpreting Markdown", async ({ page }) => {
  await seedKnowledge(page);
  const input = page.getByTestId("composer-textarea");
  await input.fill("#");
  const picker = page.getByTestId("knowledge-picker");
  await expect(picker.getByRole("checkbox")).toHaveCount(3);
  await expect(picker.getByRole("checkbox", { name: "扫描件待 OCR", exact: true })).toBeDisabled();
  await picker.getByRole("checkbox", { name: "中文产品资料", exact: true }).check();
  await picker.getByRole("checkbox", { name: "项目约定", exact: true }).check();
  await picker.getByRole("button", { name: "添加所选 (2)", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("knowledge-selection-chips").getByRole("button")).toHaveCount(2);
  await page.getByRole("button", { name: "移除知识资料", exact: true }).first().click();
  await expect(page.getByTestId("knowledge-selection-chips")).toContainText("项目约定");
  for (const text of ["# 标题", "## 标题", "word#项目", "\\#项目"]) {
    await input.fill(text);
    await expect(picker).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.calls.filter((entry: any) => entry.command === "knowledge_search").length)).toBe(0);
});

test("loading, Escape, IME, and an owner switch cannot attach a stale catalog selection", async ({ page }) => {
  await seedKnowledge(page);
  const input = page.getByTestId("composer-textarea");
  const picker = page.getByTestId("knowledge-picker");
  await page.evaluate(() => { (window as any).__KNOWLEDGE_E2E__.holdCatalog = true; });
  await input.fill("#");
  await expect(picker.getByRole("status")).toContainText("加载中");
  await input.press("Enter");
  await expect(input).toHaveValue("#");
  await input.press("Escape");
  await page.evaluate(() => { const state = (window as any).__KNOWLEDGE_E2E__; state.holdCatalog = false; state.pending.splice(0).forEach((release: () => void) => release()); });
  await expect(picker).toHaveCount(0);
  await input.fill("#项目");
  await picker.getByRole("checkbox", { name: "项目约定", exact: true }).check();
  await input.dispatchEvent("compositionstart", { data: "中" });
  await picker.getByRole("button", { name: "添加所选 (1)", exact: true }).click();
  await expect(input).toHaveValue("#项目");
  await expect(page.getByTestId("knowledge-selection-chips")).toHaveCount(0);
  await input.dispatchEvent("compositionend", { data: "中" });
});

test("a late catalog cannot restore references after the Composer owner switches", async ({ page }) => {
  await seedKnowledge(page);
  const input = page.getByTestId("composer-textarea");
  const picker = page.getByTestId("knowledge-picker");
  await page.evaluate(() => { (window as any).__KNOWLEDGE_E2E__.holdCatalog = true; });
  await input.fill("#");
  await expect.poll(() => page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.pending.length)).toBeGreaterThan(0);
  await page.getByTestId("sidebar-workspace-row").filter({ hasText: "资料项目 B" }).click();
  await expect(picker).toHaveCount(0);
  await page.evaluate(() => { const state = (window as any).__KNOWLEDGE_E2E__; state.holdCatalog = false; state.pending.splice(0).forEach((release: () => void) => release()); });
  await expect(page.getByTestId("knowledge-selection-chips")).toHaveCount(0);
});

test("accepted-message cleanup preserves newly edited source choices while each submitted payload stays frozen", async ({ page }) => {
  await seedKnowledge(page);
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    useAppStore.setState({ acceptWorkspaceInstruction: async (input: any) => {
      const state = (window as any).__KNOWLEDGE_E2E__;
      state.admissions.push(JSON.parse(JSON.stringify(input)));
      await new Promise<void>(release => state.pendingAdmissions.push(release));
      return { accepted: true, receipt: { receiptId: "fixture-receipt", turnId: "fixture-turn" }, queuePosition: 1, durability: "durable" };
    } } as any);
  });
  await chooseSource(page);
  const input = page.getByTestId("composer-textarea");
  await input.fill("依据资料回答");
  await page.getByTestId("composer-send-button").click();
  await expect.poll(() => page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.admissions.length)).toBe(1);
  await page.getByRole("button", { name: "移除知识资料", exact: true }).click();
  await input.fill("#中文");
  const picker = page.getByTestId("knowledge-picker");
  await picker.getByRole("checkbox", { name: "中文产品资料", exact: true }).check();
  await picker.getByRole("button", { name: "添加所选 (1)", exact: true }).click();
  await page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.pendingAdmissions.splice(0).forEach((release: () => void) => release()));
  await expect(page.getByTestId("knowledge-selection-chips")).toContainText("中文产品资料");
  expect(await page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.admissions[0].knowledgeReferences)).toEqual([{ kind: "source", kbId: "kb-cn", sourceId: "source-cn", sourceRevision: "source-v1", label: "项目约定" }]);
  await page.getByRole("button", { name: "移除知识资料", exact: true }).click();
  await input.fill("下一条没有资料");
  await page.getByTestId("composer-send-button").click();
  await expect.poll(() => page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.admissions.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.admissions[1].knowledgeReferences)).toEqual([]);
  await page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.pendingAdmissions.splice(0).forEach((release: () => void) => release()));
});

test("same-ID Session epoch replacement preserves only the new owner's explicit source selection", async ({ page }) => {
  await seedKnowledge(page);
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const state = useAppStore.getState();
    useAppStore.setState({ sessionsByWorkspace: { ...state.sessionsByWorkspace, [state.currentWorkspace!]: state.sessionsByWorkspace[state.currentWorkspace!].map(session => ({ ...session, planLifecycleEpoch: "epoch-original" })) }, acceptWorkspaceInstruction: async (input: any) => {
      const fixture = (window as any).__KNOWLEDGE_E2E__;fixture.admissions.push(JSON.parse(JSON.stringify(input)));
      await new Promise<void>(release => fixture.pendingAdmissions.push(release));
      return { accepted: true, receipt: { receiptId: "old-epoch-receipt", turnId: "old-epoch-turn" }, queuePosition: 1, durability: "durable" };
    } } as any);
  });
  await chooseSource(page);
  await page.getByTestId("composer-textarea").fill("旧容器提交");
  await page.getByTestId("composer-send-button").click();
  await expect.poll(() => page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.admissions.length)).toBe(1);
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");const state = useAppStore.getState();
    useAppStore.setState({ sessionsByWorkspace: { ...state.sessionsByWorkspace, [state.currentWorkspace!]: state.sessionsByWorkspace[state.currentWorkspace!].map(session => ({ ...session, planLifecycleEpoch: "epoch-replacement" })) } });
  });
  await expect(page.getByTestId("knowledge-selection-chips")).toHaveCount(0);
  await chooseSource(page); // Exact same source/version, explicitly selected in the replacement.
  await page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.pendingAdmissions.splice(0).forEach((release: () => void) => release()));
  await expect(page.getByTestId("knowledge-selection-chips")).toContainText("项目约定");
});

test("the production preflight and excerpt executor use only the message's frozen scope", async ({ page }) => {
  await seedKnowledge(page);
  const result = await page.evaluate(async () => {
    const { prepareKnowledgeContext } = await import("/src/store/prepareKnowledgeContext.ts");
    const { executeTool } = await import("/src/lib/toolExecutor.ts");
    const signal = new AbortController().signal;
    const budget = { inputBudget: 16000, readWindowChars: 12000 } as any;
    const empty = await prepareKnowledgeContext({ references: [], query: "未选", budget, reservedInputTokens: 0, signal });
    const before = (window as any).__KNOWLEDGE_E2E__.calls.filter((entry: any) => entry.command === "knowledge_search").length;
    const references = [{ kind: "source", kbId: "kb-cn", sourceId: "source-cn", sourceRevision: "source-v1" }] as const;
    const packet = await prepareKnowledgeContext({ references, query: "总结这份资料", budget, reservedInputTokens: 0, signal });
    const next = await executeTool("knowledge_get_excerpt", { source_id: "source-cn", chunk_id: "source-cn:1", kb_ids: ["foreign"] }, "", "__MAIN_GLOBAL_CHAT__:fixture", { knowledgeReferences: references });
    return { empty: empty ?? null, before, packet, next, calls: (window as any).__KNOWLEDGE_E2E__.calls };
  });
  expect(result.empty).toBeNull();
  expect(result.before).toBe(0);
  expect(result.packet?.hits[0]?.retrievalKind).toBe("source_overview");
  expect(result.packet?.hits[0]?.sourceOverview?.nextChunkId).toBe("source-cn:1");
  for (const entry of result.calls.filter((item: any) => ["knowledge_search", "knowledge_get_excerpt"].includes(item.command))) expect(entry.args.references).toEqual([{ kind: "source", kbId: "kb-cn", sourceId: "source-cn", sourceRevision: "source-v1" }]);
});

test("global first-request wire includes selected evidence and the next Turn inherits no retrieval grant", async ({ page }) => {
  await seedKnowledge(page);
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const state = useAppStore.getState();
    (window as any).__KNOWLEDGE_E2E__.fixtureModel = true;
    useAppStore.setState({ currentWorkspace: null, selectedWorkspace: null, currentSessionId: null,
      sessionsByWorkspace: { __MAIN_GLOBAL_CHAT__: [] }, activeSessionByWorkspace: { __MAIN_GLOBAL_CHAT__: null },
      runtimeBySessionKey: {}, taskFlow: [], agentMessages: [], conversationTurns: [], runtimeV2Checkpoints: {},
      isGenerating: false, agentStatus: "idle", currentTurnId: null, harnessRunMarker: null,
      config: { ...state.config, workflowMode: "chat" } } as any);
    if (!useAppStore.getState().sendMessage("请依据所选资料回答。", undefined, { resolvedIntent: "respond", skipIntentResolution: true,
      knowledgeReferencesSnapshot: [{ kind: "source", kbId: "kb-cn", sourceId: "source-cn", sourceRevision: "source-v1" }] })) throw new Error("first Turn not admitted");
  });
  await expect.poll(() => page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
    const state = useAppStore.getState();
    return Object.values(state.runtimeV2Checkpoints).filter(checkpoint => normalizeRuntimeV2Checkpoint(checkpoint)?.aggregate.terminalOutcome).length;
  }), { timeout: 20000 }).toBe(1);
  const first = await page.evaluate(() => (window as any).__KNOWLEDGE_E2E__.modelRequests[0]);
  expect(first.messages.some((message: any) => String(message.content).includes("[SELECTED KNOWLEDGE REFERENCE DATA]"))).toBe(true);
  expect(JSON.stringify(first.messages)).toContain("中文知识库正文");
  const evidence = page.getByTestId("knowledge-evidence");
  await expect(evidence).toHaveCount(1);
  await expect(evidence.locator("summary")).toContainText("有限开头概览");
  await evidence.locator("summary").click();
  await expect(evidence.getByTestId("knowledge-next-chunk")).toContainText("source-cn:1");
  const canonical = await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
    return Object.values(useAppStore.getState().runtimeV2Checkpoints).map(checkpoint => normalizeRuntimeV2Checkpoint(checkpoint)?.aggregate.knowledgeContext)[0];
  });
  expect(canonical?.references).toEqual([{ kind: "source", kbId: "kb-cn", sourceId: "source-cn", sourceRevision: "source-v1" }]);
  expect(canonical?.hits[0]?.citation.sourceId).toBe("source-cn");
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    if (!useAppStore.getState().sendMessage("这一条进行普通聊天。", undefined, { resolvedIntent: "respond", skipIntentResolution: true, knowledgeReferencesSnapshot: [] })) throw new Error("second Turn not admitted");
  });
  await expect.poll(() => page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
    return Object.values(useAppStore.getState().runtimeV2Checkpoints).filter(checkpoint => normalizeRuntimeV2Checkpoint(checkpoint)?.aggregate.terminalOutcome).length;
  }), { timeout: 20000 }).toBe(2);
  const snapshot = await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const state = (window as any).__KNOWLEDGE_E2E__;
    return { requests: state.modelRequests, searches: state.calls.filter((entry: any) => entry.command === "knowledge_search"), sessionId: useAppStore.getState().currentSessionId };
  });
  expect(snapshot.sessionId).not.toBeNull();
  expect(snapshot.searches).toHaveLength(1);
  expect(snapshot.requests).toHaveLength(2);
  expect(JSON.stringify(snapshot.requests[1].messages)).not.toContain("[SELECTED KNOWLEDGE REFERENCE DATA]");
  expect(snapshot.requests[1].tools?.some((tool: any) => ["knowledge_search", "knowledge_get_excerpt"].includes(tool.function.name)) || false).toBe(false);
});

for (const theme of ["light", "dark", "black"] as const) {
  test(`source picker and honest overview/range disclosure remain readable in ${theme}`, async ({ page }, testInfo) => {
    await seedKnowledge(page, theme);
    await page.getByTestId("composer-textarea").fill("#");
    const picker = page.getByTestId("knowledge-picker");
    await expect(picker.getByRole("checkbox")).toHaveCount(3);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await picker.screenshot({ path: testInfo.outputPath(`knowledge-picker-${theme}.png`), animations: "disabled" });
    await page.evaluate(async () => {
      const { default: React } = await import("/node_modules/.vite/deps/react.js");
      const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
      const { default: Evidence } = await import("/src/components/KnowledgeEvidence.tsx");
      const host = document.createElement("div");host.id = "knowledge-evidence-preview";host.style.cssText = "position:fixed;left:24px;top:80px;width:640px;padding:20px;z-index:9999;background:var(--surface-2);color:var(--surface-text)";document.body.append(host);
      const refs = [{ kind: "source", kbId: "kb-cn", sourceId: "source-cn", sourceRevision: "source-v1", label: "项目约定" }];
      const packet = { state: "retrieved", query: "总结这份资料", references: refs, hits: [{ text: "这是所选中文资料的一部分。\n后续章节尚未读取。", citation: { kbId: "kb-cn", kbName: "中文产品资料", sourceId: "source-cn", sourceTitle: "项目约定", chunkId: "source-cn:0", sourceRevision: "source-v1", page: 2 }, returnedCharRange: { start: 800, end: 2400 }, totalChars: 2800, complete: false, retrievalKind: "source_overview", sourceOverview: { totalChunks: 4, totalChars: 9500, nextChunkId: "source-cn:1" } }], note: "NO_LEXICAL_MATCH" };
      createRoot(host).render(React.createElement(Evidence, { packet, language: "zh" } as any));
    });
    const evidence = page.getByTestId("knowledge-evidence");
    await evidence.locator("summary").click();
    await expect(evidence).toContainText("不是全文总结");
    await expect(evidence.getByTestId("knowledge-returned-range")).toContainText("801–2400 / 2800");
    await expect(evidence.getByTestId("knowledge-next-chunk")).toContainText("source-cn:1");
    await page.locator("#knowledge-evidence-preview").screenshot({ path: testInfo.outputPath(`knowledge-evidence-${theme}.png`), animations: "disabled" });
  });
}

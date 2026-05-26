import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1500, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();

    const workspace = "/tmp/e2e-session-pagination";
    const now = new Date("2026-05-06T08:00:00.000Z").toISOString();
    const sessions = [
      { id: 2001, title: "Short Session", date: now, active: true, storageStatus: "temporary", recordingDisabled: true },
      { id: 2002, title: "Paged Session", date: now, active: false, storageStatus: "ok", recordingDisabled: false },
    ];
    const turns = Array.from({ length: 320 }, (_, index) => {
      const turnNumber = index + 1;
      return {
        id: `turn-${turnNumber}`,
        userPrompt: `Paged turn ${turnNumber}`,
        title: `Paged turn ${turnNumber}`,
        mode: "chat",
        status: "done",
        summary: `Summary ${turnNumber}`,
        blockIds: [turnNumber * 10 + 1, turnNumber * 10 + 2],
        collapsed: false,
        createdAt: turnNumber,
      };
    });
    const messages = turns.flatMap((turn, index) => {
      const turnNumber = index + 1;
      return [
        { id: turnNumber * 10 + 1, turnId: turn.id, type: "user", content: `User ${turnNumber}` },
        { id: turnNumber * 10 + 2, turnId: turn.id, type: "agent", content: `Agent ${turnNumber}`, streaming: false },
      ];
    });

    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: false,
          themeMode: "dark",
          activeProfile: "local",
          local: { provider: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", model: "test", contextLimit: 16384, apiKey: "" },
        },
        currentWorkspace: workspace,
        selectedWorkspace: workspace,
        currentSessionId: 2001,
        workspaces: [{ path: workspace, name: "Pagination Workspace", addedAt: Date.now(), lastActiveAt: Date.now() }],
        activeSessionByWorkspace: { [workspace]: 2001 },
        sessionsByWorkspace: { [workspace]: sessions, __MAIN_GLOBAL_CHAT__: [] },
        taskFlow: [
          { id: 1, turnId: "short-turn", type: "user", content: "Short Session" },
          { id: 2, turnId: "short-turn", type: "agent", content: "Short content", streaming: false },
        ],
        agentMessages: [],
        conversationTurns: [{
          id: "short-turn",
          userPrompt: "Short Session",
          title: "Short Session",
          mode: "chat",
          status: "done",
          summary: "Short content",
          blockIds: [1, 2],
          collapsed: false,
          createdAt: 1,
        }],
        currentTurnId: "short-turn",
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: "studio_auto",
      },
      version: 0,
    }));

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    internals.transformCallback = (callback: unknown) => {
      const id = callbackId++;
      callbacks.set(id, callback);
      return id;
    };
    internals.unregisterCallback = (id: number) => callbacks.delete(Number(id));
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") return callbackId++;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? workspace);
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return sessions;
      if (cmd === "save_project_session") return new Promise((resolve) => setTimeout(() => resolve(args?.session ?? {}), 700));
      if (cmd === "load_project_session_meta") {
        return {
          id: Number(args?.sessionId ?? 2002),
          title: "Paged Session",
          date: now,
          active: false,
          storageStatus: "ok",
          runtimeSnapshot: {
            agentMessages: [],
            selectedMainModeKey: "main_mode",
            selectedNexusModeKey: "nexus_general",
            planArtifacts: [],
            planTasks: [],
            planExecutionEvidenceLedger: [],
            planExecutionEvidenceCount: 0,
            planStage: "idle",
            isPlanApproved: false,
          },
          turnCount: turns.length,
          messageCount: messages.length,
        };
      }
      if (cmd === "load_project_session_page") {
        const before = Number(args?.beforeTurnIndex ?? turns.length);
        const limit = Number(args?.limit ?? 30);
        const end = Math.min(before, turns.length);
        const start = Math.max(0, end - limit);
        const pageTurns = turns.slice(start, end);
        const ids = new Set(pageTurns.flatMap((turn) => turn.blockIds));
        return {
          sessionId: String(args?.sessionId ?? 2002),
          turns: pageTurns,
          messages: messages.filter((message) => ids.has(message.id)),
          startTurnIndex: start,
          endTurnIndex: end,
          totalTurns: turns.length,
          hasMore: start > 0,
          nextBeforeTurnIndex: start > 0 ? start : null,
        };
      }
      if (cmd === "load_project_session") return {};
      return null;
    };
  });
});

test("switching to a 300+ turn session shows the recent page quickly and loads older history", async ({ page }) => {
  await page.goto("/");

  const startedAt = Date.now();
  await page.getByText("Paged Session").click();
  await expect(page.getByText("Paged turn 320")).toBeVisible({ timeout: 300 });
  expect(Date.now() - startedAt).toBeLessThan(700);
  await expect(page.getByText("Paged turn 1")).toHaveCount(0);

  await page.getByRole("button", { name: "加载更早历史" }).click();
  await expect(page.getByText("Paged turn 290")).toBeVisible();
});

test("empty live runtime cache does not block restoring persisted transcript pages", async ({ page }) => {
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("local-agent-ide");
    const persisted = raw ? JSON.parse(raw) : { state: {} };
    const workspace = "/tmp/e2e-session-pagination";
    persisted.state.currentSessionId = 2002;
    persisted.state.activeSessionByWorkspace = { [workspace]: 2002 };
    persisted.state.sessionsByWorkspace[workspace] = persisted.state.sessionsByWorkspace[workspace].map((session: any) => ({
      ...session,
      active: session.id === 2002,
      ...(session.id === 2002 ? { turnCount: 320, messageCount: 640 } : {}),
    }));
    persisted.state.taskFlow = [];
    persisted.state.conversationTurns = [];
    persisted.state.currentTurnId = null;
    persisted.state.runtimeBySessionKey = {
      [`${workspace}:2002`]: {
        taskFlow: [],
        conversationTurns: [],
        agentMessages: [],
        currentTurnId: null,
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: "studio_auto",
        gameStudioInitialized: false,
        pendingSlashCommand: null,
        planArtifacts: [],
        planTasks: [],
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planStage: "idle",
        isPlanApproved: false,
        showPlanPanel: false,
        showDiff: false,
        showTerminal: false,
        showFilePanel: false,
        rightPanelTab: "plan",
        selectedDiffTaskId: null,
        input: "",
        contextMentions: [],
        attachedFiles: [],
        preferredResponseLanguage: "zh",
        lockedComposerIntent: null,
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
        currentTurnExecutionConsent: { turnId: null, granted: false },
        readOnlyAutoApproveForSession: false,
        normalizedStreamState: {},
        currentTurnState: {
          interceptorHandled: false,
          interceptorThought: "",
          lastReportedThought: "",
          lastReportedAssistantText: "",
          capsuleExplanation: null,
          turnId: "",
        },
        isGenerating: false,
        agentStatus: "idle",
        abortController: null,
        elapsedTime: 0,
        pendingReviewResolve: null,
        pendingReviewTaskId: null,
        pendingToolCall: null,
        fileViewerPath: "",
        fileViewerContent: "",
        fileViewerWindow: null,
        fileViewerError: "",
        fileViewerLoading: false,
      },
    };
    window.localStorage.setItem("local-agent-ide", JSON.stringify(persisted));
  });

  await page.goto("/");

  await expect(page.getByText("Paged turn 320")).toBeVisible();
  await expect(page.getByText("Agent 320")).toBeVisible();
});

test("deleting the current empty third session restores the previous session and does not save it empty", async ({ page }) => {
  await page.addInitScript(() => {
    const workspace = "/tmp/e2e-session-delete-restore";
    const now = new Date("2026-05-06T09:00:00.000Z").toISOString();
    const secondTurns = [{
      id: "second-turn",
      userPrompt: "Second Session",
      title: "Second Session",
      mode: "chat",
      status: "done",
      summary: "Second answer survives delete",
      blockIds: [21, 22],
      collapsed: false,
      createdAt: 2,
    }];
    const secondMessages = [
      { id: 21, turnId: "second-turn", type: "user", content: "Second Session" },
      { id: 22, turnId: "second-turn", type: "agent", content: "Second answer survives delete", streaming: false },
    ];
    const sessions = [
      { id: 3001, title: "First Delete Session", date: "2026-05-06T09:00:03.000Z", active: false, storageStatus: "temporary", recordingDisabled: true, messages: [{ id: 11, type: "agent", content: "First content" }] },
      { id: 3002, title: "Second Delete Session", date: "2026-05-06T09:00:02.000Z", active: false, storageStatus: "ok", recordingDisabled: false, turnCount: 1, messageCount: 2 },
      { id: 3003, title: "Third Empty Session", date: "2026-05-06T09:00:01.000Z", active: true, storageStatus: "ok", recordingDisabled: false, turnCount: 1, messageCount: 1 },
    ];

    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: true,
          themeMode: "dark",
          activeProfile: "local",
          local: { provider: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", model: "test", contextLimit: 16384, apiKey: "" },
        },
        currentWorkspace: workspace,
        selectedWorkspace: workspace,
        currentSessionId: 3003,
        workspaces: [{ path: workspace, name: "Delete Restore Workspace", addedAt: Date.now(), lastActiveAt: Date.now() }],
        activeSessionByWorkspace: { [workspace]: 3003 },
        sessionsByWorkspace: { [workspace]: sessions, __MAIN_GLOBAL_CHAT__: [] },
        taskFlow: [],
        agentMessages: [],
        conversationTurns: [],
        currentTurnId: null,
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: "studio_auto",
        runtimeBySessionKey: {
          [`${workspace}:3003`]: {
            taskFlow: [],
            conversationTurns: [],
            agentMessages: [],
            currentTurnId: null,
            selectedMainModeKey: "main_mode",
            selectedNexusModeKey: "nexus_general",
            activeStudioAgentKey: "studio_auto",
            gameStudioInitialized: false,
            pendingSlashCommand: null,
            planArtifacts: [],
            planTasks: [],
            planExecutionEvidenceLedger: [],
            planExecutionEvidenceCount: 0,
            planStage: "idle",
            isPlanApproved: false,
            showPlanPanel: false,
            showDiff: false,
            showTerminal: false,
            showFilePanel: false,
            rightPanelTab: "plan",
            selectedDiffTaskId: null,
            input: "",
            contextMentions: [],
            attachedFiles: [],
            preferredResponseLanguage: "zh",
            lockedComposerIntent: null,
            pendingRunDecision: null,
            pendingRunDecisionResolver: null,
            currentTurnExecutionConsent: { turnId: null, granted: false },
            readOnlyAutoApproveForSession: false,
            normalizedStreamState: {},
            currentTurnState: {
              interceptorHandled: false,
              interceptorThought: "",
              lastReportedThought: "",
              lastReportedAssistantText: "",
              capsuleExplanation: null,
              turnId: "",
            },
            isGenerating: false,
            agentStatus: "idle",
            abortController: null,
            elapsedTime: 0,
            pendingReviewResolve: null,
            pendingReviewTaskId: null,
            pendingToolCall: null,
            fileViewerPath: "",
            fileViewerContent: "",
            fileViewerWindow: null,
            fileViewerError: "",
            fileViewerLoading: false,
          },
        },
      },
      version: 0,
    }));

    const savedSessions: any[] = [];
    (window as any).__SESSION_DELETE_RESTORE_SAVES__ = savedSessions;

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    internals.transformCallback = (callback: unknown) => {
      const id = callbackId++;
      callbacks.set(id, callback);
      return id;
    };
    internals.unregisterCallback = (id: number) => callbacks.delete(Number(id));
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") return callbackId++;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? workspace);
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return sessions;
      if (cmd === "save_project_session") {
        savedSessions.push(args?.session);
        return args?.session ?? {};
      }
      if (cmd === "delete_project_session") {
        return new Promise((resolve) => {
          setTimeout(() => resolve(sessions.filter((session) => session.id !== Number(args?.sessionId))), 800);
        });
      }
      if (cmd === "load_project_session_meta") {
        return {
          id: Number(args?.sessionId ?? 3002),
          title: Number(args?.sessionId) === 3002 ? "Second Delete Session" : "Third Empty Session",
          date: now,
          active: false,
          storageStatus: "ok",
          runtimeSnapshot: {
            agentMessages: [],
            selectedMainModeKey: "main_mode",
            selectedNexusModeKey: "nexus_general",
            planArtifacts: [],
            planTasks: [],
            planExecutionEvidenceLedger: [],
            planExecutionEvidenceCount: 0,
            planStage: "idle",
            isPlanApproved: false,
          },
          turnCount: Number(args?.sessionId) === 3002 ? 1 : 0,
          messageCount: Number(args?.sessionId) === 3002 ? 2 : 0,
        };
      }
      if (cmd === "load_project_session_page") {
        return {
          sessionId: String(args?.sessionId ?? 3002),
          turns: Number(args?.sessionId) === 3002 ? secondTurns : [],
          messages: Number(args?.sessionId) === 3002 ? secondMessages : [],
          startTurnIndex: 0,
          endTurnIndex: Number(args?.sessionId) === 3002 ? 1 : 0,
          totalTurns: Number(args?.sessionId) === 3002 ? 1 : 0,
          hasMore: false,
          nextBeforeTurnIndex: null,
        };
      }
      if (cmd === "delete_chat_session_temp_files") return null;
      if (cmd === "load_project_session") return {};
      return null;
    };
  });

  await page.goto("/");

  await page.getByTestId("session-delete-3003").click({ force: true });
  await expect(page.getByTestId("delete-session-confirmation")).toBeVisible();
  await expect(page.getByTestId("delete-session-confirmation")).toContainText("不可恢复");
  await page.getByTestId("delete-session-cancel").click();
  await expect(page.getByTestId("session-item-3003")).toContainText("Third Empty Session");
  await page.getByTestId("session-delete-3003").click({ force: true });
  await page.getByTestId("delete-session-confirm").click();
  await expect(page.getByText("Second answer survives delete")).toBeVisible({ timeout: 1500 });
  await page.waitForTimeout(1000);
  await expect(page.getByText("Second answer survives delete")).toBeVisible();
  await expect(page.getByTestId("session-item-3002")).toContainText("Second Delete Session");

  const savedSecondEmpty = await page.evaluate(() => {
    const saves = (window as any).__SESSION_DELETE_RESTORE_SAVES__ || [];
    return saves.some((session: any) =>
      session?.id === 3002 &&
      Array.isArray(session.messages) &&
      session.messages.length === 0 &&
      Array.isArray(session.runtimeSnapshot?.conversationTurns) &&
      session.runtimeSnapshot.conversationTurns.length === 0
    );
  });
  expect(savedSecondEmpty).toBe(false);
});

test("deleting the first visible current session selects the next visible session", async ({ page }) => {
  await page.addInitScript(() => {
    const workspace = "/tmp/e2e-session-delete-first";
    const now = new Date("2026-05-06T09:30:00.000Z").toISOString();
    const secondRuntime = {
      taskFlow: [
        { id: 41, turnId: "next-visible-turn", type: "user", content: "Next visible session" },
        { id: 42, turnId: "next-visible-turn", type: "agent", content: "Next visible content", streaming: false },
      ],
      agentMessages: [],
      conversationTurns: [{
        id: "next-visible-turn",
        userPrompt: "Next visible session",
        title: "Next visible session",
        mode: "chat",
        status: "done",
        summary: "Next visible content",
        blockIds: [41, 42],
        collapsed: false,
        createdAt: 2,
      }],
      currentTurnId: "next-visible-turn",
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      isPlanApproved: false,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
      selectedDiffTaskId: null,
    };
    const firstRuntime = {
      ...secondRuntime,
      taskFlow: [],
      conversationTurns: [],
      currentTurnId: null,
    };
    const sessions = [
      { id: 3101, title: "First Visible Session", date: "2026-05-06T09:30:03.000Z", active: true, storageStatus: "temporary", recordingDisabled: true, messages: [], runtimeSnapshot: firstRuntime },
      { id: 3102, title: "Second Visible Session", date: "2026-05-06T09:30:02.000Z", active: false, storageStatus: "temporary", recordingDisabled: true, messages: secondRuntime.taskFlow, runtimeSnapshot: secondRuntime },
      { id: 3103, title: "Third Visible Session", date: "2026-05-06T09:30:01.000Z", active: false, storageStatus: "temporary", recordingDisabled: true, messages: [{ id: 51, type: "agent", content: "Third visible content" }] },
    ];
    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: false,
          themeMode: "dark",
          activeProfile: "local",
          local: { provider: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", model: "test", contextLimit: 16384, apiKey: "" },
        },
        currentWorkspace: workspace,
        selectedWorkspace: workspace,
        currentSessionId: 3101,
        workspaces: [{ path: workspace, name: "Delete First Workspace", addedAt: Date.now(), lastActiveAt: Date.now() }],
        activeSessionByWorkspace: { [workspace]: 3101 },
        sessionsByWorkspace: { [workspace]: sessions, __MAIN_GLOBAL_CHAT__: [] },
        taskFlow: [],
        agentMessages: [],
        conversationTurns: [],
        currentTurnId: null,
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: "studio_auto",
      },
      version: 0,
    }));
    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    internals.transformCallback = (callback: unknown) => {
      const id = callbackId++;
      callbacks.set(id, callback);
      return id;
    };
    internals.unregisterCallback = (id: number) => callbacks.delete(Number(id));
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") return callbackId++;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? workspace);
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return sessions;
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "delete_project_session") return sessions.filter((session) => session.id !== Number(args?.sessionId));
      if (cmd === "delete_chat_session_temp_files") return null;
      if (cmd === "load_project_session") return {};
      return null;
    };
  });

  await page.goto("/");

  await page.getByTestId("session-delete-3101").click({ force: true });
  await expect(page.getByTestId("delete-session-confirmation")).toBeVisible();
  await expect(page.getByTestId("delete-session-confirmation")).toContainText("不可恢复");
  await page.getByTestId("delete-session-cancel").click();
  await expect(page.getByTestId("session-item-3101")).toContainText("First Visible Session");
  await page.getByTestId("session-delete-3101").click({ force: true });
  await page.getByTestId("delete-session-confirm").click();
  await expect(page.getByText("Next visible content")).toBeVisible();
  await expect(page.getByTestId("session-item-3102")).toContainText("Second Visible Session");
});

test("switching between persisted sessions does not reuse or save the previous chat into the target", async ({ page }) => {
  await page.addInitScript(() => {
    const workspace = "/tmp/e2e-session-switch-isolation";
    const sessions = [
      { id: 3201, title: "First Persisted", date: "2026-05-06T10:00:03.000Z", active: true, storageStatus: "ok", recordingDisabled: false, turnCount: 1, messageCount: 2 },
      { id: 3202, title: "Second Persisted", date: "2026-05-06T10:00:02.000Z", active: false, storageStatus: "ok", recordingDisabled: false, turnCount: 1, messageCount: 2 },
      { id: 3203, title: "Third Empty", date: "2026-05-06T10:00:01.000Z", active: false, storageStatus: "temporary", recordingDisabled: true, messages: [], runtimeSnapshot: { taskFlow: [], conversationTurns: [], agentMessages: [] } },
    ];
    const makeRuntime = (label: string, base: number) => ({
      taskFlow: [
        { id: base + 1, turnId: `${label}-turn`, type: "user", content: `${label} user` },
        { id: base + 2, turnId: `${label}-turn`, type: "agent", content: `${label} visible answer`, streaming: false },
      ],
      conversationTurns: [{
        id: `${label}-turn`,
        userPrompt: `${label} user`,
        title: `${label} title`,
        mode: "chat",
        status: "done",
        summary: `${label} visible answer`,
        blockIds: [base + 1, base + 2],
        collapsed: false,
        createdAt: base,
      }],
      agentMessages: [],
      currentTurnId: `${label}-turn`,
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      isPlanApproved: false,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
      selectedDiffTaskId: null,
    });
    const firstRuntime = makeRuntime("First", 100);
    const secondRuntime = makeRuntime("Second", 200);

    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: true,
          themeMode: "dark",
          activeProfile: "local",
          local: { provider: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", model: "test", contextLimit: 16384, apiKey: "" },
        },
        currentWorkspace: workspace,
        selectedWorkspace: workspace,
        currentSessionId: 3201,
        workspaces: [{ path: workspace, name: "Switch Isolation Workspace", addedAt: Date.now(), lastActiveAt: Date.now() }],
        activeSessionByWorkspace: { [workspace]: 3201 },
        sessionsByWorkspace: { [workspace]: sessions, __MAIN_GLOBAL_CHAT__: [] },
        taskFlow: firstRuntime.taskFlow,
        agentMessages: [],
        conversationTurns: firstRuntime.conversationTurns,
        currentTurnId: firstRuntime.currentTurnId,
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: "studio_auto",
        runtimeBySessionKey: {
          [`${workspace}:3202`]: { ...firstRuntime, input: "", contextMentions: [], attachedFiles: [], preferredResponseLanguage: "zh", lockedComposerIntent: null, pendingRunDecision: null, pendingRunDecisionResolver: null, currentTurnExecutionConsent: { turnId: null, granted: false }, readOnlyAutoApproveForSession: false, normalizedStreamState: {}, currentTurnState: {}, isGenerating: false, agentStatus: "idle", abortController: null, elapsedTime: 0, pendingReviewResolve: null, pendingReviewTaskId: null, pendingToolCall: null, fileViewerPath: "", fileViewerContent: "", fileViewerWindow: null, fileViewerError: "", fileViewerLoading: false },
        },
      },
      version: 0,
    }));

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    internals.transformCallback = (callback: unknown) => {
      const id = callbackId++;
      callbacks.set(id, callback);
      return id;
    };
    internals.unregisterCallback = (id: number) => callbacks.delete(Number(id));
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") return callbackId++;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? workspace);
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return sessions;
      if (cmd === "save_project_session") return { ...(args?.session as object), storageStatus: "ok" };
      if (cmd === "load_project_session_meta") {
        const id = Number(args?.sessionId);
        const runtime = id === 3201 ? firstRuntime : secondRuntime;
        return {
          ...sessions.find((session) => session.id === id),
          runtimeSnapshot: runtime,
          turnCount: runtime.conversationTurns.length,
          messageCount: runtime.taskFlow.length,
        };
      }
      if (cmd === "load_project_session_page") {
        const id = Number(args?.sessionId);
        const runtime = id === 3201 ? firstRuntime : secondRuntime;
        return {
          sessionId: String(id),
          turns: runtime.conversationTurns,
          messages: runtime.taskFlow,
          startTurnIndex: 0,
          endTurnIndex: runtime.conversationTurns.length,
          totalTurns: runtime.conversationTurns.length,
          hasMore: false,
          nextBeforeTurnIndex: null,
        };
      }
      if (cmd === "load_project_session") return {};
      return null;
    };
  });

  await page.goto("/");
  await expect(page.getByText("First visible answer")).toBeVisible();

  await page.getByTestId("session-item-3202").click();
  await expect(page.getByText("Second visible answer")).toBeVisible();
  await expect(page.getByText("First visible answer")).toHaveCount(0);

  await page.getByTestId("session-item-3203").click();
  await expect(page.getByText("Second visible answer")).toHaveCount(0);

  await page.getByTestId("session-item-3202").click();
  await expect(page.getByText("Second visible answer")).toBeVisible();
  await expect(page.locator('[data-testid^="session-item-"]').nth(0)).toContainText("First Persisted");
  await expect(page.locator('[data-testid^="session-item-"]').nth(1)).toContainText("Second Persisted");
});

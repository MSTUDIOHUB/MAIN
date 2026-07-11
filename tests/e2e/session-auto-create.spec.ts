import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("manual project session starts as a top temporary row and never becomes Missing before first send", async ({ page }) => {
  const workspace = "/tmp/e2e-manual-session-create";
  const oldSessions = [
    {
      id: 6101,
      title: "Older Project Session",
      date: "2020-01-02T00:00:00.000Z",
      active: true,
      storageStatus: "ok",
      recordingDisabled: false,
      turnCount: 1,
      messageCount: 2,
    },
    {
      id: 6102,
      title: "Oldest Project Session",
      date: "2020-01-01T00:00:00.000Z",
      active: false,
      storageStatus: "ok",
      recordingDisabled: false,
      turnCount: 1,
      messageCount: 2,
    },
  ];
  await page.addInitScript(({ workspace, oldSessions }) => {
    window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    window.localStorage.clear();

    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: true,
          themeMode: "dark",
          activeProfile: "local",
          local: {
            provider: "LM Studio",
            endpoint: "http://127.0.0.1:1234/v1",
            model: "test",
            contextLimit: 16384,
            apiKey: "",
          },
        },
        currentWorkspace: workspace,
        selectedWorkspace: workspace,
        currentSessionId: 6101,
        workspaces: [{ path: workspace, name: "Manual Create Workspace", addedAt: Date.now(), lastActiveAt: Date.now() }],
        activeSessionByWorkspace: { [workspace]: 6101 },
        sessionsByWorkspace: { [workspace]: oldSessions, __MAIN_GLOBAL_CHAT__: [] },
        taskFlow: [
          { id: 1, turnId: "old-turn", type: "user", content: "Older Project Session" },
          { id: 2, turnId: "old-turn", type: "agent", content: "Older content", streaming: false },
        ],
        agentMessages: [],
        conversationTurns: [{
          id: "old-turn",
          userPrompt: "Older Project Session",
          title: "Older Project Session",
          mode: "chat",
          status: "done",
          summary: "Older content",
          blockIds: [1, 2],
          collapsed: false,
          createdAt: 1,
        }],
        currentTurnId: "old-turn",
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: "studio_auto",
      },
      version: 0,
    }));

    (window as any).__MANUAL_CREATE_SESSION_LOADS__ = [];
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
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") {
        const raw = window.localStorage.getItem("local-agent-ide");
        const state = raw ? JSON.parse(raw).state : {};
        const currentId = Number(state.currentSessionId || 0);
        const hasLocalNewSession = currentId && !oldSessions.some((session) => session.id === currentId);
        return hasLocalNewSession
          ? [
              ...oldSessions.map((session) => ({ ...session, active: false })),
              {
                id: currentId,
                title: "Missing Session",
                date: "",
                active: false,
                storageStatus: "missing",
                turnCount: 0,
                messageCount: 0,
              },
            ]
          : oldSessions;
      }
      if (cmd === "save_project_session") {
        return { ...(args?.session as object), storageStatus: "ok", recordingDisabled: false };
      }
      if (cmd === "load_project_session_meta") {
        const requestedId = Number(args?.sessionId);
        const existing = oldSessions.find((session) => session.id === requestedId);
        if (existing) {
          return {
            ...existing,
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
          };
        }
        (window as any).__MANUAL_CREATE_SESSION_LOADS__.push(requestedId);
        return {
          id: requestedId,
          title: "Missing Session",
          date: "",
          active: false,
          storageStatus: "missing",
          turnCount: 0,
          messageCount: 0,
        };
      }
      if (cmd === "load_project_session_page") {
        const requestedId = Number(args?.sessionId);
        const isKnownSession = oldSessions.some((session) => session.id === requestedId);
        const turnId = requestedId === 6101 ? "old-turn" : "oldest-turn";
        const title = requestedId === 6101 ? "Older Project Session" : "Oldest Project Session";
        const summary = requestedId === 6101 ? "Older content" : "Oldest content";
        return {
          sessionId: String(args?.sessionId),
          turns: isKnownSession ? [{
            id: turnId,
            userPrompt: title,
            title,
            mode: "chat",
            status: "done",
            summary,
            blockIds: [requestedId * 10 + 1, requestedId * 10 + 2],
            collapsed: false,
            createdAt: requestedId,
          }] : [],
          messages: isKnownSession ? [
            { id: requestedId * 10 + 1, turnId, type: "user", content: title },
            { id: requestedId * 10 + 2, turnId, type: "agent", content: summary, streaming: false },
          ] : [],
          startTurnIndex: 0,
          endTurnIndex: isKnownSession ? 1 : 0,
          totalTurns: isKnownSession ? 1 : 0,
          hasMore: false,
          nextBeforeTurnIndex: null,
        };
      }
      if (cmd === "load_project_session") return {};
      return null;
    };
  }, { workspace, oldSessions });

  await page.goto("/");
  await expect(
    page.locator('[data-testid^="session-item-"]').first().locator(".sidebar-session-title"),
  ).toHaveText("Older Project Session");

  await page.getByTestId("workspace-new-session").first().click();

  const firstSessionTitle = page.locator('[data-testid^="session-item-"]').first().locator(".sidebar-session-title");
  await expect(firstSessionTitle).toHaveText("新聊天");
  await expect(page.getByText("Missing Session")).toHaveCount(0);
  await expect(page.getByText("详情缺失")).toHaveCount(0);
  await expect(page.locator('[data-testid^="session-item-"]').nth(1).locator(".sidebar-session-title")).toHaveText("Older Project Session");

  await page.getByTitle(workspace).first().click();
  await expect(firstSessionTitle).toHaveText("新聊天");
  await expect(page.getByText("Missing Session")).toHaveCount(0);
  await expect(page.getByText("详情缺失")).toHaveCount(0);
  await expect
    .poll(async () => page.evaluate(() => (window as any).__MANUAL_CREATE_SESSION_LOADS__?.length ?? -1))
    .toBe(0);
});

test("first real send creates and activates a project session", async ({ page }) => {
  await page.goto("/?e2eScenario=session-auto-create");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().sessionCount ?? -1),
    )
    .toBe(0);

  const sent = await page.evaluate(() => (window as any).__CODELY_E2E__?.sendFirstMessage?.());
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          sessionCount: snapshot?.sessionCount,
          currentSessionActive: snapshot?.currentSessionActive,
          activeCount: snapshot?.activeSessionIds?.length,
          conversationTurns: snapshot?.conversationTurns,
          taskFlowUserCount: snapshot?.taskFlowUserCount,
          currentTurnStatus: snapshot?.currentTurnStatus,
        };
      }),
    )
    .toEqual({
      sessionCount: 1,
      currentSessionActive: true,
      activeCount: 1,
      conversationTurns: 1,
      taskFlowUserCount: 1,
      currentTurnStatus: "done",
    });

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          runtimeTurns: snapshot?.currentSessionRuntimeTurns,
          runtimeBlocks: snapshot?.currentSessionRuntimeBlocks,
          messages: snapshot?.currentSessionMessages,
        };
      }),
    )
    .toEqual({
      runtimeTurns: 1,
      runtimeBlocks: 2,
      messages: 2,
    });
});

test("missing currentSessionId creates a new session instead of reusing an old one", async ({ page }) => {
  await page.goto("/?e2eScenario=session-auto-create");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.prepareStaleCurrentSession?.());
  const staleSessionId = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.getSnapshot?.().staleSessionId,
  );

  const sent = await page.evaluate(() => (window as any).__CODELY_E2E__?.sendFirstMessage?.());
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate((oldId) => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          sessionCount: snapshot?.sessionCount,
          createdNewSession: Boolean(snapshot?.currentSessionId && snapshot.currentSessionId !== oldId),
          activeCount: snapshot?.activeSessionIds?.length,
          currentSessionActive: snapshot?.currentSessionActive,
          staleSessionMessages: snapshot?.staleSessionMessages,
          conversationTurns: snapshot?.conversationTurns,
        };
      }, staleSessionId),
    )
    .toEqual({
      sessionCount: 2,
      createdNewSession: true,
      activeCount: 1,
      currentSessionActive: true,
      staleSessionMessages: 0,
      conversationTurns: 1,
    });
});

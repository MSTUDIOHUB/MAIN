import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1500, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();

    const workspace = "/tmp/e2e-session-panel-reset";
    const now = new Date("2026-05-06T08:00:00.000Z").toISOString();
    const makeRuntime = (id: number, title: string) => {
      const turnId = `turn-${id}`;
      const userBlock = { id: id * 10 + 1, turnId, type: "user", content: title };
      const diffBlock = {
        id: id * 10 + 2,
        turnId,
        type: "tool",
        toolName: "replace_in_file",
        target: "src/main.ts",
        status: "executed",
        toolStatus: "executed",
        diff: { old: "old\n", new: "new\n", path: "src/main.ts", existed: true, fullFile: true, binary: false },
      };
      return {
        taskFlow: [userBlock, diffBlock],
        agentMessages: [],
        conversationTurns: [{
          id: turnId,
          userPrompt: title,
          title,
          mode: "chat",
          status: "done",
          summary: title,
          blockIds: [userBlock.id, diffBlock.id],
          collapsed: false,
          createdAt: Date.now(),
        }],
        currentTurnId: turnId,
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
        showDiff: true,
        showTerminal: true,
        showFilePanel: true,
        rightPanelTab: "diff",
        selectedDiffTaskId: diffBlock.id,
      };
    };
    const firstRuntime = makeRuntime(1001, "First Session");
    const secondRuntime = makeRuntime(1002, "Second Session");
    const sessions = [
      { id: 1001, title: "First Session", date: now, active: true, storageStatus: "ok", recordingDisabled: false, turnCount: 1, messageCount: 2 },
      { id: 1002, title: "Second Session", date: now, active: false, storageStatus: "ok", recordingDisabled: false, turnCount: 1, messageCount: 2 },
    ];

    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: false,
          themeMode: "dark",
          activeProfile: "cloud",
          cloud: {
            protocol: "openai",
            apiFormat: "chat_completions",
            provider: "OpenAI",
            endpoint: "https://api.openai.test/v1",
            model: "test-model",
            apiKey: "test-key",
            customHeaders: "",
            disableResponseStorage: true,
            toolProtocol: "auto",
          },
        },
        currentWorkspace: workspace,
        selectedWorkspace: workspace,
        currentSessionId: 1001,
        workspaces: [{ path: workspace, name: "Panel Reset Workspace", addedAt: Date.now(), lastActiveAt: Date.now() }],
        activeSessionByWorkspace: { [workspace]: 1001 },
        sessionsByWorkspace: {
          [workspace]: sessions,
          __MAIN_GLOBAL_CHAT__: [],
        },
        taskFlow: firstRuntime.taskFlow,
        agentMessages: [],
        conversationTurns: firstRuntime.conversationTurns,
        currentTurnId: firstRuntime.currentTurnId,
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: "studio_auto",
        gameStudioInitialized: false,
        showPlanPanel: false,
        showDiff: true,
        showTerminal: false,
        showFilePanel: true,
        rightPanelTab: "diff",
        selectedDiffTaskId: firstRuntime.selectedDiffTaskId,
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
      if (cmd === "load_project_session_meta") {
        const requestedId = Number(args?.sessionId ?? 1001);
        const session = sessions.find((candidate) => candidate.id === requestedId) || sessions[0];
        return {
          ...session,
          runtimeSnapshot: requestedId === 1002 ? secondRuntime : firstRuntime,
        };
      }
      if (cmd === "load_project_session_page") {
        const requestedId = Number(args?.sessionId ?? 1001);
        const runtime = requestedId === 1002 ? secondRuntime : firstRuntime;
        return {
          sessionId: String(requestedId),
          turns: runtime.conversationTurns,
          messages: runtime.taskFlow,
          startTurnIndex: 0,
          endTurnIndex: 1,
          totalTurns: 1,
          hasMore: false,
          nextBeforeTurnIndex: null,
        };
      }
      if (cmd === "list_directory") {
        return [{ name: "src", path: `${workspace}/src`, is_dir: true }];
      }
      if (cmd === "read_file") return "export const value = 1;\n";
      if (cmd === "read_file_window") {
        return {
          path: String(args?.path ?? ""),
          content: "export const value = 1;\n",
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          totalChars: 24,
          returnedChars: 24,
          truncated: false,
          nextStartLine: null,
        };
      }
      if (cmd === "get_pty_status") {
        return { active: true, running: true, pid: 4242, exitCode: null, bufferStartOffset: 0, bufferEndOffset: 0, bufferBytes: 0, tail: "" };
      }
      if (cmd === "spawn_pty" || cmd === "resize_pty" || cmd === "write_pty") return null;
      if (cmd === "read_pty_buffer") return "";
      return null;
    };
  });
});

test("switching sessions closes the currently open right and file panels", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("session-item-1001")).toContainText("First Session");
  await expect(page.getByTestId("diff-panel")).toHaveCount(0);
  await expect(page.getByTestId("file-panel")).toHaveCount(0);
  await page.locator('button[aria-label="变更比对"]').click();
  await page.locator('button[aria-label="文件"]').click();
  await expect(page.getByTestId("diff-panel")).toBeVisible();
  await expect(page.getByTestId("file-panel")).toBeVisible();

  await page.getByText("Second Session").click();

  await expect(page.getByTestId("diff-panel")).toHaveCount(0);
  await expect(page.getByTestId("file-panel")).toHaveCount(0);
  await expect(page.getByTestId("integrated-terminal")).toHaveCount(0);

  await page.locator('button[aria-label="变更比对"]').click();
  await expect(page.getByTestId("diff-panel")).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";

async function seedStaleSelectedWorkspace(page: Page, themeMode: "dark" | "light" | "black") {
  await page.addInitScript((seedThemeMode) => {
    window.localStorage.clear();

    const workspace = "/tmp/e2e-sidebar-stale-selected";
    const globalKey = "__MAIN_GLOBAL_CHAT__";
    const now = new Date("2026-05-31T08:00:00.000Z").toISOString();
    const projectSession = {
      id: 9101,
      title: "Project Session",
      date: now,
      updatedAt: now,
      updatedAtMs: Date.now() - 1_000,
      active: true,
      storageStatus: "temporary",
      recordingDisabled: true,
      messages: [],
    };
    const globalSession = {
      id: 9201,
      title: "Global Chat Session",
      date: now,
      updatedAt: now,
      updatedAtMs: Date.now(),
      active: true,
      storageStatus: "temporary",
      recordingDisabled: true,
      messages: [],
    };

    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: false,
          themeMode: seedThemeMode,
          activeProfile: "local",
          local: {
            provider: "LM Studio",
            endpoint: "http://127.0.0.1:1234/v1",
            model: "test-model",
            contextLimit: 16384,
            apiKey: "",
          },
        },
        currentWorkspace: "",
        selectedWorkspace: workspace,
        currentSessionId: globalSession.id,
        workspaces: [{ path: workspace, name: "DataFiles", addedAt: Date.now() - 2_000, lastActiveAt: Date.now() - 2_000 }],
        activeSessionByWorkspace: { [workspace]: projectSession.id, [globalKey]: globalSession.id },
        sessionsByWorkspace: {
          [workspace]: [projectSession],
          [globalKey]: [globalSession],
        },
        taskFlow: [
          { id: 1, turnId: "global-turn", type: "user", content: "Global Chat Session" },
          { id: 2, turnId: "global-turn", type: "agent", content: "Global reply", streaming: false },
        ],
        agentMessages: [],
        conversationTurns: [{
          id: "global-turn",
          userPrompt: "Global Chat Session",
          title: "Global Chat Session",
          mode: "chat",
          status: "done",
          summary: "Global reply",
          blockIds: [1, 2],
          collapsed: false,
          createdAt: 1,
        }],
        currentTurnId: "global-turn",
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
      if (cmd === "get_workspace_root") return "";
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? workspace);
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") {
        return String(args?.workspace ?? "") === workspace ? [projectSession] : [globalSession];
      }
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "load_project_session_meta") return globalSession;
      if (cmd === "load_project_session_detail") return {
        ...globalSession,
        runtimeSnapshot: {
          taskFlow: [],
          agentMessages: [],
          conversationTurns: [],
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
      if (cmd === "get_git_status") return { isRepo: false, gitAvailable: true, clean: true };
      if (cmd === "main_update_status") return { status: "idle" };
      return null;
    };
  }, themeMode);
}

for (const themeMode of ["dark", "light", "black"] as const) {
  test(`global chat remains the only highlighted target when selectedWorkspace is stale (${themeMode})`, async ({ page }) => {
    await seedStaleSelectedWorkspace(page, themeMode);
    await page.goto("/");

    const workspaceRow = page.getByTestId("sidebar-workspace-row").filter({ hasText: "DataFiles" }).first();
    const chatRow = page.getByTestId("sidebar-global-chat-row");
    const globalSessionRow = page.getByTestId("session-item-9201");
    const projectSessionRow = page.getByTestId("session-item-9101");

    await expect(workspaceRow).toBeVisible();
    await expect(chatRow).toBeVisible();
    await expect(globalSessionRow).toBeVisible();
    await expect(projectSessionRow).toBeVisible();
    await expect(chatRow).toHaveClass(/bg-\[#18181b\]/);
    await expect(chatRow.getByTestId("sidebar-global-chat-icon")).toHaveClass(/theme-text/);
    await expect(globalSessionRow).toHaveClass(/bg-\[#18181b\]/);
    await expect(globalSessionRow.locator("svg").first()).toHaveClass(/theme-text/);
    await expect(workspaceRow.getByTestId("sidebar-workspace-icon")).not.toHaveClass(/theme-text/);

    const workspaceRowClasses = (await workspaceRow.getAttribute("class"))?.split(/\s+/) ?? [];
    const projectSessionRowClasses = (await projectSessionRow.getAttribute("class"))?.split(/\s+/) ?? [];
    expect(workspaceRowClasses).not.toContain("bg-[#18181b]");
    expect(projectSessionRowClasses).not.toContain("bg-[#18181b]");
  });
}

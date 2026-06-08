import { expect, test, type Page } from "@playwright/test";

type SidebarActiveScenario =
  | "global-active"
  | "global-switch-gap"
  | "project-with-background-global-pending";

async function seedStaleSelectedWorkspace(
  page: Page,
  themeMode: "dark" | "light" | "black",
  scenario: SidebarActiveScenario = "global-active",
) {
  await page.addInitScript(({ seedThemeMode, seedScenario }) => {
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
    const currentWorkspace = seedScenario === "project-with-background-global-pending" ? workspace : "";
    const currentSessionId = seedScenario === "global-switch-gap" ? projectSession.id : (
      seedScenario === "project-with-background-global-pending" ? projectSession.id : globalSession.id
    );
    const backgroundGlobalRuntime = {
      taskFlow: [
        { id: 10, turnId: "global-pending-turn", type: "user", content: "Global background action" },
      ],
      agentMessages: [],
      contextMemoryState: null,
      conversationTurns: [{
        id: "global-pending-turn",
        userPrompt: "Global background action",
        title: "Global background action",
        mode: "plan",
        status: "awaiting_approval",
        summary: "",
        blockIds: [10],
        collapsed: false,
        createdAt: 1,
      }],
      currentTurnId: "global-pending-turn",
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      pendingRunDecision: {
        kind: "intent_confirmation",
        source: "preflight",
        originalInput: "Global background action",
        originalImages: [],
        suggestedIntent: "execute",
        reason: "Background global chat needs a decision.",
        title: "Background global decision",
        options: [
          { id: "execute", label: "批准执行", value: "execute" },
          { id: "respond", label: "只回复", value: "respond" },
        ],
      },
      pendingRunDecisionResolver: null,
      isGenerating: false,
      agentStatus: "pending_review",
      abortController: null,
      elapsedTime: 0,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
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
        currentWorkspace,
        selectedWorkspace: workspace,
        currentSessionId,
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
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
        agentStatus: "idle",
        isGenerating: false,
        runtimeBySessionKey: seedScenario === "project-with-background-global-pending"
          ? { [`${globalKey}:${globalSession.id}`]: backgroundGlobalRuntime }
          : {},
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
  }, { seedThemeMode: themeMode, seedScenario: scenario });
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

test("global chat child remains highlighted during the workspace switch gap", async ({ page }) => {
  await seedStaleSelectedWorkspace(page, "dark", "global-switch-gap");
  await page.goto("/");

  const workspaceRow = page.getByTestId("sidebar-workspace-row").filter({ hasText: "DataFiles" }).first();
  const chatRow = page.getByTestId("sidebar-global-chat-row");
  const globalSessionRow = page.getByTestId("session-item-9201");
  const projectSessionRow = page.getByTestId("session-item-9101");

  await expect(chatRow).toHaveClass(/bg-\[#18181b\]/);
  await expect(globalSessionRow).toHaveClass(/bg-\[#18181b\]/);
  await expect(globalSessionRow.locator("svg").first()).toHaveClass(/theme-text/);
  await expect(workspaceRow.getByTestId("sidebar-workspace-icon")).not.toHaveClass(/theme-text/);

  const projectSessionRowClasses = (await projectSessionRow.getAttribute("class"))?.split(/\s+/) ?? [];
  expect(projectSessionRowClasses).not.toContain("bg-[#18181b]");
});

test("background global chat pending decision does not surface in the active project", async ({ page }) => {
  await seedStaleSelectedWorkspace(page, "dark", "project-with-background-global-pending");
  await page.goto("/");

  const workspaceRow = page.getByTestId("sidebar-workspace-row").filter({ hasText: "DataFiles" }).first();
  const chatRow = page.getByTestId("sidebar-global-chat-row");
  const globalSessionRow = page.getByTestId("session-item-9201");
  const projectSessionRow = page.getByTestId("session-item-9101");

  await expect(workspaceRow).toHaveClass(/bg-\[#18181b\]/);
  await expect(workspaceRow.getByTestId("sidebar-workspace-icon")).toHaveClass(/theme-text/);
  await expect(projectSessionRow).toHaveClass(/bg-\[#18181b\]/);
  await expect(page.getByTestId("top-island-pending-run-decision")).toHaveCount(0);
  await expect(page.getByTestId("top-island-shell")).toHaveCount(0);

  const chatRowClasses = (await chatRow.getAttribute("class"))?.split(/\s+/) ?? [];
  const globalSessionRowClasses = (await globalSessionRow.getAttribute("class"))?.split(/\s+/) ?? [];
  expect(chatRowClasses).not.toContain("bg-[#18181b]");
  expect(globalSessionRowClasses).not.toContain("bg-[#18181b]");
});

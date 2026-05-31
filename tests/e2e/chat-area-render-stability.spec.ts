import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: false,
          themeMode: "dark",
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
        selectedWorkspace: "",
        currentSessionId: null,
        workspaces: [],
        activeSessionByWorkspace: {},
        sessionsByWorkspace: { __MAIN_GLOBAL_CHAT__: [] },
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
    internals.invoke = async (cmd: string) => {
      if (cmd === "plugin:event|listen") return callbackId++;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "get_workspace_root") return "";
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return [];
      if (cmd === "get_git_status") return { isRepo: false, gitAvailable: true, clean: true };
      if (cmd === "main_update_status") return { status: "idle" };
      return null;
    };
  });
});

test("idle global chat does not enter a maximum update depth render loop", async ({ page }) => {
  const maxDepthErrors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && text.includes("Maximum update depth exceeded")) {
      maxDepthErrors.push(text);
    }
  });

  await page.goto("/");
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
  await page.waitForTimeout(750);

  expect(maxDepthErrors).toEqual([]);
});

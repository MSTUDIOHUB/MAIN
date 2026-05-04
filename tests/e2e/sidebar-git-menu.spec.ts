import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 820 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();

    const gitWorkspace = "/tmp/e2e-sidebar-git";
    const plainWorkspace = "/tmp/e2e-sidebar-plain";
    const now = new Date("2026-05-04T08:00:00.000Z").toISOString();

    window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: {
          language: "zh",
          workflowMode: "chat",
          sessionRecordingEnabled: false,
        },
        currentWorkspace: gitWorkspace,
        selectedWorkspace: gitWorkspace,
        currentSessionId: 7001,
        workspaces: [
          { path: gitWorkspace, name: "E2E Git Workspace", addedAt: Date.now(), lastActiveAt: Date.now() },
          { path: plainWorkspace, name: "E2E Plain Workspace", addedAt: Date.now(), lastActiveAt: Date.now() },
        ],
        activeSessionByWorkspace: {
          [gitWorkspace]: 7001,
          [plainWorkspace]: 8001,
        },
        sessionsByWorkspace: {
          [gitWorkspace]: [
            { id: 7001, title: "Git Session One", date: now, active: true, storageStatus: "temporary", recordingDisabled: true, messages: [] },
            { id: 7002, title: "Git Session Two", date: now, active: false, storageStatus: "temporary", recordingDisabled: true, messages: [] },
          ],
          [plainWorkspace]: [
            { id: 8001, title: "Plain Session", date: now, active: true, storageStatus: "temporary", recordingDisabled: true, messages: [] },
          ],
          __MAIN_GLOBAL_CHAT__: [],
        },
        taskFlow: [],
        agentMessages: [],
        conversationTurns: [],
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        activeStudioAgentKey: "studio_auto",
        gameStudioInitialized: false,
        showPlanPanel: false,
        showDiff: false,
        showTerminal: false,
        showFilePanel: false,
        rightPanelTab: "plan",
      },
      version: 0,
    }));

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const eventListeners = new Map<number, { event: string; handlerId: number }>();
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    let status = {
      isRepo: true,
      gitAvailable: true,
      repoRoot: gitWorkspace,
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      changedFiles: 5,
      insertions: 12,
      deletions: 3,
      untrackedFiles: 2,
      stagedFiles: 1,
      unstagedFiles: 2,
      conflictedFiles: 0,
      clean: false,
      hasOrigin: true,
      error: null,
    };

    (window as any).__GIT_SIDEBAR_TEST__ = {
      calls,
      getStatus: () => status,
    };

    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {
      unregisterListener: () => {},
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
      calls.push({ cmd, args });
      if (cmd === "plugin:event|listen") {
        const handlerId = Number(args?.handler ?? callbackId++);
        eventListeners.set(handlerId, {
          event: String(args?.event ?? ""),
          handlerId,
        });
        return handlerId;
      }
      if (cmd === "plugin:event|unlisten") {
        eventListeners.delete(Number(args?.eventId ?? args?.handler));
        return null;
      }
      if (cmd === "get_workspace_root") return gitWorkspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? gitWorkspace);
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return [];
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "get_git_status") {
        return args?.workspace === gitWorkspace
          ? { ...status, insertions: args?.includeStats ? status.insertions : 0, deletions: args?.includeStats ? status.deletions : 0 }
          : {
              isRepo: false,
              gitAvailable: true,
              repoRoot: null,
              branch: null,
              upstream: null,
              ahead: 0,
              behind: 0,
              changedFiles: 0,
              insertions: 0,
              deletions: 0,
              untrackedFiles: 0,
              stagedFiles: 0,
              unstagedFiles: 0,
              conflictedFiles: 0,
              clean: true,
              hasOrigin: false,
              error: null,
            };
      }
      if (cmd === "git_commit_all") {
        status = { ...status, changedFiles: 0, insertions: 0, deletions: 0, untrackedFiles: 0, stagedFiles: 0, unstagedFiles: 0, clean: true };
        return status;
      }
      if (cmd === "git_push_current_branch") {
        status = { ...status, ahead: 0 };
        return status;
      }
      if (cmd === "git_create_branch") {
        status = { ...status, branch: String(args?.branch ?? "feature/sidebar-git"), upstream: null };
        return status;
      }
      return null;
    };
  });
});

test("sidebar Git menu replaces project counts and performs basic Git actions", async ({ page }) => {
  await page.goto("/");

  const gitRow = page.getByTestId("sidebar-workspace-row").filter({ hasText: "E2E Git Workspace" });
  await expect(gitRow).toBeVisible();
  await expect(page.getByTestId("sidebar-git-button")).toHaveCount(1);
  await expect(gitRow).not.toContainText(/\b2\b/);

  await page.getByTestId("sidebar-git-button").click();
  const menu = page.getByTestId("sidebar-git-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("main");
  await expect(menu).toContainText("+12");
  await expect(menu).toContainText("-3");
  await expect(menu).toContainText("未跟踪");

  await menu.getByRole("button", { name: "提交" }).click();
  await page.getByPlaceholder("提交信息").fill("test: sidebar git menu");
  await menu.getByRole("button", { name: "确认" }).click();
  await expect(menu).toContainText("已提交全部更改。");

  await menu.getByRole("button", { name: "推送" }).click();
  await expect(menu).toContainText("已推送当前分支。");

  await menu.getByRole("button", { name: "创建分支" }).click();
  await page.getByPlaceholder("new-branch-name").fill("feature/sidebar-git");
  await menu.getByRole("button", { name: "确认" }).click();
  await expect(menu).toContainText("feature/sidebar-git");

  const calls = await page.evaluate(() => (window as any).__GIT_SIDEBAR_TEST__.calls);
  expect(calls.some((call: any) => call.cmd === "git_commit_all" && call.args.message === "test: sidebar git menu")).toBe(true);
  expect(calls.some((call: any) => call.cmd === "git_push_current_branch")).toBe(true);
  expect(calls.some((call: any) => call.cmd === "git_create_branch" && call.args.branch === "feature/sidebar-git")).toBe(true);
});

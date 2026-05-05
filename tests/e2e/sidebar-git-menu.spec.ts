import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 820 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const shouldSeedStorage = !window.sessionStorage.getItem("__MAIN_GIT_SIDEBAR_E2E_SEEDED__");
    if (shouldSeedStorage) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__MAIN_GIT_SIDEBAR_E2E_SEEDED__", "1");
    }

    const gitWorkspace = "/tmp/e2e-sidebar-git";
    const plainWorkspace = "/tmp/e2e-sidebar-plain";
    const now = new Date("2026-05-04T08:00:00.000Z").toISOString();

    if (shouldSeedStorage) window.localStorage.setItem("local-agent-ide", JSON.stringify({
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
            model: "commit-model",
            apiKey: "test-key",
            customHeaders: "",
            disableResponseStorage: true,
          },
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
    let diffMode: "normal" | "empty" = "normal";
    let proxyMode: "success" | "fail" = "success";

    (window as any).__GIT_SIDEBAR_TEST__ = {
      calls,
      getStatus: () => status,
      setDiffMode: (mode: "normal" | "empty") => { diffMode = mode; },
      setProxyMode: (mode: "success" | "fail") => { proxyMode = mode; },
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
      if (cmd === "proxy_request") {
        if (proxyMode === "fail") throw new Error("model unavailable");
        return JSON.stringify({
          choices: [{ message: { content: "test: generated commit" } }],
        });
      }
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
      if (cmd === "get_git_file_list") {
        if (args?.filter === "added") return [{ path: "src/new.ts", status: "A" }, { path: "notes.md", status: "U" }];
        if (args?.filter === "deleted") return [{ path: "src/removed.ts", status: "D" }];
        return [{ path: "src/main.ts", status: "M" }, { path: "src/renamed.ts", status: "R" }];
      }
      if (cmd === "get_git_diff") {
        if (diffMode === "empty") return [];
        const path = String(args?.path || "");
        if (path === "src/main.ts") {
          return [{
            path: "src/main.ts",
            status: "M",
            old: "export const title = 'old';\n",
            new: "export const title = 'new';\n",
            existed: true,
            fullFile: true,
            binary: false,
          }];
        }
        if (args?.filter === "added") {
          return [{
            path: "src/new.ts",
            status: "A",
            old: "",
            new: "export const created = true;\n",
            existed: false,
            fullFile: true,
            binary: false,
          }];
        }
        return [
          {
            path: "src/components/Sidebar.tsx",
            status: "M",
            old: "export const title = 'old';\n",
            new: "export const title = 'new';\n",
            existed: true,
            fullFile: true,
            binary: false,
          },
          {
            path: "src/lib/gitCommitMessage.ts",
            status: "M",
            old: "export const oldMessage = true;\n",
            new: "export const newMessage = true;\n",
            existed: true,
            fullFile: true,
            binary: false,
          },
        ];
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
  await expect(menu).toHaveCSS("box-shadow", "none");
  await expect(menu.getByTestId("sidebar-git-summary-button")).toHaveCount(1);
  await expect(menu.getByText("已暂存")).toHaveCount(1);
  await expect(menu.getByText("未跟踪")).toHaveCount(1);

  const sidebarBox = await page.getByTestId("workspace-sidebar").boundingBox();
  const menuBox = await menu.boundingBox();
  expect(sidebarBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width - 1);
  expect(menuBox!.y).toBeGreaterThanOrEqual(0);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(820);

  await menu.getByTestId("sidebar-git-summary-button").click();
  await expect(page.getByTestId("diff-panel-title")).toContainText("Git 更改");
  await expect(page.getByTestId("diff-panel")).toContainText("src/components/Sidebar.tsx");

  await page.evaluate(() => (window as any).__GIT_SIDEBAR_TEST__.setDiffMode("empty"));
  await menu.getByTestId("sidebar-git-summary-button").click();
  await expect(menu).toContainText("当前选择没有可显示的 Diff。");
  await expect(menu).not.toContainText("当前选择没有可显示的 Diff。", { timeout: 6_000 });
  await page.evaluate(() => (window as any).__GIT_SIDEBAR_TEST__.setDiffMode("normal"));

  await menu.getByRole("button", { name: "提交" }).click();
  await menu.getByRole("button", { name: "确认" }).click();
  await expect(menu).toContainText("已提交全部更改。 test: generated commit");

  await menu.getByRole("button", { name: "推送" }).click();
  await expect(menu).toContainText("已推送当前分支。");

  await menu.getByRole("button", { name: "创建分支" }).click();
  await page.getByPlaceholder("new-branch-name").fill("feature/sidebar-git");
  await menu.getByRole("button", { name: "确认" }).click();
  await expect(menu).toContainText("feature/sidebar-git");

  const calls = await page.evaluate(() => (window as any).__GIT_SIDEBAR_TEST__.calls);
  expect(calls.some((call: any) => call.cmd === "proxy_request")).toBe(true);
  expect(calls.some((call: any) => call.cmd === "git_commit_all" && call.args.message === "test: generated commit")).toBe(true);
  expect(calls.some((call: any) => call.cmd === "git_push_current_branch")).toBe(true);
  expect(calls.some((call: any) => call.cmd === "git_create_branch" && call.args.branch === "feature/sidebar-git")).toBe(true);
});

test("sidebar Git icon stays transparent across themes and empty commit falls back locally", async ({ page }) => {
  await page.goto("/");

  for (const theme of ["dark", "light", "black"]) {
    await page.evaluate((themeMode) => {
      const raw = window.localStorage.getItem("local-agent-ide");
      const parsed = JSON.parse(raw || "{}");
      parsed.state.config.themeMode = themeMode;
      window.localStorage.setItem("local-agent-ide", JSON.stringify(parsed));
    }, theme);
    await page.reload();
    const button = page.getByTestId("sidebar-git-button");
    await expect(button).toBeVisible();
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }

  await page.evaluate(() => (window as any).__GIT_SIDEBAR_TEST__.setProxyMode("fail"));
  await page.getByTestId("sidebar-git-button").click();
  const menu = page.getByTestId("sidebar-git-menu");
  await menu.getByRole("button", { name: "提交" }).click();
  await menu.getByRole("button", { name: "确认" }).click();
  await expect(menu).toContainText("已提交全部更改。 更新 Git 菜单");

  const calls = await page.evaluate(() => (window as any).__GIT_SIDEBAR_TEST__.calls);
  expect(calls.some((call: any) => call.cmd === "git_commit_all" && call.args.message === "更新 Git 菜单")).toBe(true);
});

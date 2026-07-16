import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
    const deletion = ((window as any).__GOAL_DELETE_E2E__ ??= {
      calls: [] as Array<{ path: string; workspace: string | null }>,
      fenceWrites: [] as Array<{ path: string; workspace: string | null; content: string }>,
      savedSessions: [] as Array<{ workspace: string | null; session: any }>,
      fail: false,
      delayMs: 0,
      saveFailuresRemaining: 0,
      recoveryFence: null as null | {
        workspace: string;
        goalId: string;
        ownerSessionKey: string;
        session: any;
      },
    });
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "list_directory") {
        const fence = deletion.recoveryFence;
        return fence && args?.workspace === fence.workspace &&
          args?.path === ".MAIN/goals/.deleted"
          ? [{
              name: `${fence.goalId}.json`,
              path: `.MAIN/goals/.deleted/${fence.goalId}.json`,
              is_dir: false,
            }]
          : [];
      }
      if (cmd === "read_file") {
        const fence = deletion.recoveryFence;
        if (fence && args?.workspace === fence.workspace &&
          args?.path === `.MAIN/goals/.deleted/${fence.goalId}.json`) {
          return JSON.stringify({
            schemaVersion: 1,
            goalId: fence.goalId,
            ownerSessionKey: fence.ownerSessionKey,
            deletedAt: 500,
          });
        }
        return "";
      }
      if (cmd === "list_project_sessions") {
        const fence = deletion.recoveryFence;
        return fence && args?.workspace === fence.workspace ? [fence.session] : [];
      }
      if (cmd === "load_project_session") {
        const fence = deletion.recoveryFence;
        return fence && args?.workspace === fence.workspace ? fence.session : null;
      }
      if (cmd === "write_file_atomic") {
        deletion.fenceWrites.push({
          path: String(args?.path ?? ""),
          workspace: args?.workspace == null ? null : String(args.workspace),
          content: String(args?.content ?? ""),
        });
        return null;
      }
      if (cmd === "delete_workspace_path") {
        deletion.calls.push({
          path: String(args?.path ?? ""),
          workspace: args?.workspace == null ? null : String(args.workspace),
        });
        if (deletion.delayMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, deletion.delayMs));
        }
        if (deletion.fail) throw new Error("simulated Goal directory deletion failure");
        return null;
      }
      if (cmd === "save_project_session") {
        deletion.savedSessions.push({
          workspace: args?.workspace == null ? null : String(args.workspace),
          session: args?.session,
        });
        if (deletion.saveFailuresRemaining > 0) {
          deletion.saveFailuresRemaining -= 1;
          throw new Error("simulated owner session save failure");
        }
        return args?.session ?? null;
      }
      return null;
    };
  });
});

test("Goal capsule exposes one themed popover with persistent lifecycle controls", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");

  await expect(page.getByTestId("turn-elapsed-time")).toHaveText("1m23s");
  const trigger = page.getByTestId("goal-capsule-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("data-goal-status", "active");

  await trigger.click();
  const panel = page.getByTestId("goal-popover-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("持续目标");
  await expect(panel).toContainText("验证 Capsule Goal 菜单与三主题");
  await expect(panel).toContainText("npm run lint");
  await expect(panel).toContainText("模型轮次");
  await expect(panel).not.toContainText("3/40");
  await expect(panel).not.toContainText("执行切片");
  await expect(page.getByTestId("effective-progress-popover")).toHaveCount(0);
  await expect(page.getByTestId("tasks-progress-popover")).toHaveCount(0);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setTheme?.("green"));
  for (const mode of ["dark", "black", "light"] as const) {
    await page.evaluate((themeMode) => (window as any).__CODELY_E2E__?.setThemeMode?.(themeMode), mode);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await expect(panel).toBeVisible();
    await expect.poll(async () => page.evaluate((themeMode) => {
      const root = getComputedStyle(document.documentElement);
      const button = document.querySelector<HTMLElement>("[data-testid='goal-capsule-trigger']");
      const accent = root.getPropertyValue("--accent-light").trim();
      const probe = document.createElement("span");
      probe.style.color = accent;
      document.body.appendChild(probe);
      const normalizedAccent = getComputedStyle(probe).color;
      probe.remove();
      if (!button) return false;
      const triggerColor = getComputedStyle(button).color;
      if (themeMode !== "light") return triggerColor === normalizedAccent;
      const channels = triggerColor.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
      return channels.length >= 3 && channels[1] > channels[0] && channels[1] > channels[2];
    }, mode)).toBe(true);

    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const button = document.querySelector<HTMLElement>("[data-testid='goal-capsule-trigger']");
      const popover = document.querySelector<HTMLElement>("[data-testid='goal-popover-panel']");
      const accent = root.getPropertyValue("--accent-light").trim();
      const probe = document.createElement("span");
      probe.style.color = accent;
      document.body.appendChild(probe);
      const normalizedAccent = getComputedStyle(probe).color;
      probe.remove();
      return {
        accent: normalizedAccent,
        trigger: button ? getComputedStyle(button).color : "",
        background: popover ? getComputedStyle(popover).backgroundColor : "",
        foreground: popover ? getComputedStyle(popover).color : "",
      };
    });

    if (mode !== "light") expect(colors.trigger).toBe(colors.accent);
    else expect(colors.trigger).not.toBe("rgb(168, 85, 247)");
    expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.foreground).not.toBe(colors.background);
  }

  await page.getByTestId("goal-pause-button").click();
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().goalStatus)).toBe("paused");
  await expect(trigger).toHaveAttribute("data-goal-status", "paused");
  await expect(page.getByTestId("goal-resume-button")).toBeVisible();

  await page.getByTestId("goal-edit-button").click();
  const editor = page.getByTestId("goal-objective-editor");
  await expect(editor).toBeVisible();
  await editor.fill("完成 Goal Runtime、Loop Engineering 与三主题 Capsule 验证");
  await page.getByRole("button", { name: "保存目标" }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalRevision)).toBe(2);
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().goalStatus)).toBe("paused");
  await expect(panel).toContainText("完成 Goal Runtime、Loop Engineering 与三主题 Capsule 验证");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setGoalStatus?.("completed"));
  await expect(trigger).toHaveAttribute("data-goal-status", "completed");
  await expect(panel).toContainText("已完成");
  await expect(page.getByTestId("goal-resume-button")).toHaveCount(0);
  await expect(trigger).toBeVisible();

  await page.getByTestId("goal-clear-button").click();
  await expect(page.getByTestId("goal-clear-confirm")).toContainText("不会回滚文件修改");
  const goalId = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalId as string);
  await page.evaluate(() => { (window as any).__GOAL_DELETE_E2E__.fail = true; });
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByTestId("goal-clear-error")).toContainText("simulated Goal directory deletion failure");
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalId)).toBe(goalId);

  await page.evaluate(() => { (window as any).__GOAL_DELETE_E2E__.fail = false; });
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(trigger).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalId)).toBeNull();
  await expect.poll(async () => page.evaluate((targetPath) =>
    (window as any).__GOAL_DELETE_E2E__.calls.filter(
      (call: { path: string }) => call.path === targetPath,
    ), `.MAIN/goals/${goalId}`)).toEqual([
      { path: `.MAIN/goals/${goalId}`, workspace: "/tmp/e2e-goal-capsule" },
      { path: `.MAIN/goals/${goalId}`, workspace: "/tmp/e2e-goal-capsule" },
    ]);
  await expect.poll(async () => page.evaluate((markerPath) =>
    (window as any).__GOAL_DELETE_E2E__.fenceWrites.filter(
      (write: { path: string }) => write.path === markerPath,
    ).length, `.MAIN/goals/.deleted/${goalId}.json`)).toBe(2);
});

test("Goal deletion clears its owner session after the user switches sessions", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");

  const trigger = page.getByTestId("goal-capsule-trigger");
  await trigger.click();
  const goalId = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalId as string);
  await page.getByTestId("goal-clear-button").click();
  await page.evaluate(() => { (window as any).__GOAL_DELETE_E2E__.delayMs = 250; });
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__GOAL_DELETE_E2E__.calls.length)).toBe(1);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.switchAwayFromGoalSession?.());
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentSessionId)).toBe(999616);
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getGoalOwnerSnapshot?.())).toMatchObject({
    runtimeGoalId: null,
    sessionGoalId: null,
    currentSessionId: 999616,
    currentGoalId: null,
  });
  await expect.poll(async () => page.evaluate(() => (window as any).__GOAL_DELETE_E2E__.savedSessions.length)).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => page.evaluate(() => {
    const savedSessions = (window as any).__GOAL_DELETE_E2E__.savedSessions;
    const saved = savedSessions[savedSessions.length - 1];
    return {
      workspace: saved?.workspace ?? null,
      activeGoalId: saved?.session?.runtimeSnapshot?.activeGoal?.id ?? null,
      runtimeGoalId: saved?.session?.runtimeSnapshot?.goalRuntime?.goal?.id ?? null,
    };
  })).toEqual({
    workspace: "/tmp/e2e-goal-capsule",
    activeGoalId: null,
    runtimeGoalId: null,
  });
  await expect.poll(async () => page.evaluate(() => (window as any).__GOAL_DELETE_E2E__.calls[0])).toEqual({
    path: `.MAIN/goals/${goalId}`,
    workspace: "/tmp/e2e-goal-capsule",
  });
});

test("Goal deletion remains incomplete until the owner-session deletion record persists", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");

  const trigger = page.getByTestId("goal-capsule-trigger");
  await trigger.click();
  const goalId = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalId as string);
  await page.getByTestId("goal-clear-button").click();
  await page.evaluate(() => { (window as any).__GOAL_DELETE_E2E__.saveFailuresRemaining = 2; });
  await page.getByRole("button", { name: "确认删除" }).click();

  await expect(page.getByTestId("goal-clear-error")).toContainText("Retry deletion before restarting MAIN");
  await expect(trigger).toHaveCount(1);
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalId)).toBe(goalId);
  await expect.poll(async () => page.evaluate(() => (window as any).__GOAL_DELETE_E2E__.calls[0])).toEqual({
    path: `.MAIN/goals/${goalId}`,
    workspace: "/tmp/e2e-goal-capsule",
  });
  await expect.poll(async () => page.evaluate(() => (window as any).__GOAL_DELETE_E2E__.savedSessions.length)).toBe(2);

  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(trigger).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalId)).toBeNull();
  await expect.poll(async () => page.evaluate((targetPath) =>
    (window as any).__GOAL_DELETE_E2E__.calls.filter(
      (call: { path: string }) => call.path === targetPath,
    ).length, `.MAIN/goals/${goalId}`)).toBe(2);
  await expect.poll(async () => page.evaluate((markerPath) =>
    (window as any).__GOAL_DELETE_E2E__.calls.filter(
      (call: { path: string }) => call.path === markerPath,
    ).length, `.MAIN/goals/.deleted/${goalId}.json`)).toBe(0);
});

test("Goal deletion clears its exact pending user choice and reply options", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.setGoalUserChoicePending?.());

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalStatus: snapshot?.goalStatus,
      actionKind: snapshot?.activeActionRequestKind,
      replyOptionBlocks: snapshot?.pendingReplyOptionBlocks,
      turnStatus: snapshot?.currentTurnStatus,
    };
  })).toEqual({
    goalStatus: "awaiting_input",
    actionKind: "user_choice",
    replyOptionBlocks: 1,
    turnStatus: "awaiting_input",
  });

  await page.getByTestId("goal-capsule-trigger").click();
  await page.getByTestId("goal-clear-button").click();
  await page.getByRole("button", { name: "确认删除" }).click();

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalId: snapshot?.activeGoalId,
      actionKind: snapshot?.activeActionRequestKind,
      replyOptionBlocks: snapshot?.pendingReplyOptionBlocks,
      turnStatus: snapshot?.currentTurnStatus,
    };
  })).toEqual({
    goalId: null,
    actionKind: null,
    replyOptionBlocks: 0,
    turnStatus: "stopped_no_action",
  });
});

test("Goal deletion clears a user choice published after deletion started", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");
  await page.getByTestId("goal-capsule-trigger").click();
  await page.getByTestId("goal-clear-button").click();
  await page.evaluate(() => { (window as any).__GOAL_DELETE_E2E__.delayMs = 250; });
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect.poll(async () => page.evaluate(() =>
    (window as any).__GOAL_DELETE_E2E__.calls.length
  )).toBeGreaterThan(0);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setGoalUserChoicePending?.());
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalId: snapshot?.activeGoalId,
      actionKind: snapshot?.activeActionRequestKind,
      replyOptionBlocks: snapshot?.pendingReplyOptionBlocks,
    };
  })).toEqual({
    goalId: null,
    actionKind: null,
    replyOptionBlocks: 0,
  });
});

test("pausing a Goal cancels only its exact queued continuation", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.setExactGoalContinuationQueued?.(
    "继续修复按钮交互",
  ));
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      source: snapshot?.queuedGoalContinuationSource,
      guidance: snapshot?.queuedGoalContinuationGuidance,
    };
  })).toEqual({
    source: "goal_manual_resume",
    guidance: "继续修复按钮交互",
  });

  await page.getByTestId("goal-capsule-trigger").click();
  await page.getByTestId("goal-pause-button").click();
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalStatus: snapshot?.goalStatus,
      queuedSource: snapshot?.queuedGoalContinuationSource,
    };
  })).toEqual({
    goalStatus: "paused",
    queuedSource: null,
  });
});

test("a manual Goal resume queued behind a busy run is not misreported as rejected", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.resumeGoalIntoBusyQueue?.());

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalStatus: snapshot?.goalStatus,
      queuedSource: snapshot?.queuedGoalContinuationSource,
      guidance: snapshot?.queuedGoalContinuationGuidance,
    };
  })).toEqual({
    goalStatus: "active",
    queuedSource: "goal_manual_resume",
    guidance: "从最近检查点继续执行当前目标 e2e_goal_capsule。",
  });
});

test("deleting an unleased Goal continuation pauses its Goal and never injects foreign guidance", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.resumeGoalIntoBusyQueue?.());

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalStatus: snapshot?.goalStatus,
      queuedSource: snapshot?.queuedGoalContinuationSource,
    };
  })).toEqual({
    goalStatus: "active",
    queuedSource: "goal_manual_resume",
  });
  await expect(page.getByTestId("composer-guidance-button")).toBeDisabled();

  await page.getByTestId("composer-queued-delete-button").click();
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalStatus: snapshot?.goalStatus,
      queuedMessage: snapshot?.queuedUserMessage ?? null,
      activeGuidance: snapshot?.activeGuidance ?? null,
    };
  })).toEqual({
    goalStatus: "paused",
    queuedMessage: null,
    activeGuidance: null,
  });
});

test("replacing an unleased Goal continuation pauses only its owner", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.resumeGoalIntoBusyQueue?.());
  await expect.poll(async () => page.evaluate(() =>
    (window as any).__CODELY_E2E__?.getSnapshot?.().queuedGoalContinuationSource ?? null
  )).toBe("goal_manual_resume");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.replaceQueuedGoalContinuation?.(
    "保留这条普通排队消息",
  ));
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalStatus: snapshot?.goalStatus,
      queuedText: snapshot?.queuedUserMessage?.text ?? null,
      queuedSource: snapshot?.queuedGoalContinuationSource,
    };
  })).toEqual({
    goalStatus: "paused",
    queuedText: "保留这条普通排队消息",
    queuedSource: null,
  });
});

test("consuming an exact queued Goal replay does not roll its active Goal back", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");
  await page.evaluate(() => (window as any).__CODELY_E2E__?.resumeGoalIntoBusyQueue?.());
  await expect.poll(async () => page.evaluate(() =>
    (window as any).__CODELY_E2E__?.getSnapshot?.().queuedGoalContinuationSource ?? null
  )).toBe("goal_manual_resume");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.consumeQueuedGoalContinuation?.());
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      goalStatus: snapshot?.goalStatus,
      queuedMessage: snapshot?.queuedUserMessage ?? null,
    };
  })).toEqual({
    goalStatus: "active",
    queuedMessage: null,
  });
});

test("startup recovery finishes a fenced Goal deletion before restoring its old session", async ({ page }) => {
  await page.addInitScript(() => {
    const workspace = "/tmp/e2e-goal-capsule";
    const sessionId = 999615;
    const goalId = "e2e_goal_capsule";
    const turnId = "e2e-goal-capsule-turn";
    const goal = {
      schemaVersion: 3,
      id: goalId,
      objective: "stale deleted Goal",
      rawText: "stale deleted Goal",
      definitionOfDone: ["must stay deleted"],
      criteria: [{
        id: "criterion-1",
        text: "must stay deleted",
        kind: "verification",
        status: "pending",
        evidenceIds: [],
      }],
      constraints: [],
      verificationHints: [],
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
      status: "active",
      iterationBudget: 6,
      sessionKey: `${workspace}:${sessionId}`,
      ownerTurnId: turnId,
    };
    (window as any).__GOAL_DELETE_E2E__.recoveryFence = {
      workspace,
      goalId,
      ownerSessionKey: `${workspace}:${sessionId}`,
      session: {
        id: sessionId,
        title: "Stale Goal owner",
        date: new Date(100).toISOString(),
        active: true,
        storageStatus: "ok",
        recordingDisabled: false,
        messages: [{ id: 1, turnId, type: "user", content: "old Goal" }],
        runtimeSnapshot: {
          taskFlow: [{ id: 1, turnId, type: "user", content: "old Goal" }],
          conversationTurns: [{
            id: turnId,
            userPrompt: "old Goal",
            title: "Old Goal",
            mode: "edit",
            intent: "goal",
            displayIntent: "goal",
            status: "paused",
            summary: "stale",
            blockIds: [1],
            collapsed: false,
            createdAt: 100,
          }],
          currentTurnId: turnId,
          activeGoal: goal,
          goalStatus: "active",
          goalRuntime: null,
        },
      },
    };
  });

  await page.goto("/?e2eScenario=goal-capsule");
  await expect.poll(async () => page.evaluate(() => {
    const saved = (window as any).__GOAL_DELETE_E2E__.savedSessions;
    return saved.some((entry: any) =>
      entry.workspace === "/tmp/e2e-goal-capsule" &&
      entry.session?.runtimeSnapshot?.activeGoal == null &&
      entry.session?.runtimeSnapshot?.goalRuntime == null
    );
  })).toBe(true);
  await expect.poll(async () => page.evaluate(() => {
    const calls = (window as any).__GOAL_DELETE_E2E__.calls;
    return {
      deletedGoalDirectory: calls.some((call: any) =>
        call.path === ".MAIN/goals/e2e_goal_capsule"
      ),
      clearedFence: calls.some((call: any) =>
        call.path === ".MAIN/goals/.deleted/e2e_goal_capsule.json"
      ),
    };
  })).toEqual({ deletedGoalDirectory: true, clearedFence: true });
  await expect(page.getByTestId("goal-capsule-trigger")).toHaveCount(0);
});

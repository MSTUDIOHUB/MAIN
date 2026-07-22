import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
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
      if (cmd === "save_project_session") {
        const capture = ((window as any).__COMPOSER_PREFERENCE_E2E__ ??= { savedSessions: [] });
        capture.savedSessions.push(JSON.parse(JSON.stringify(args?.session ?? null)));
        return args?.session ?? null;
      }
      if (cmd === "list_project_sessions") return [];
      return null;
    };
  });
});

test("ordinary running workspace turn keeps its Turn header while streaming", async ({ page }) => {
  await page.goto("/?e2eScenario=streaming-timer");

  await expect(page.getByTestId("turn-state-anchor")).toHaveCount(1);
  await expect(page.getByTestId("turn-state-anchor")).toContainText("计时器回归流");
  await expect(page.getByText("请检查计时器是否正常增长。")).toBeVisible();
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
});

test("stopping a running Turn atomically projects one canceled conclusion and restores the send control", async ({ page }) => {
  await page.goto("/?e2eScenario=streaming-timer");

  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
  await page.getByTestId("composer-stop-button").click();

  await expect(page.getByTestId("composer-stop-button")).toHaveCount(0);
  await expect(page.getByTestId("composer-send-button")).toBeVisible();
  await expect(
    page.getByTestId("turn-state-anchor").getByText("已取消", { exact: true }),
  ).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      isGenerating: snapshot?.isGenerating,
      agentStatus: snapshot?.agentStatus,
      turnStatus: snapshot?.turnStatus,
      turnResultKind: snapshot?.turnResultKind,
      canceledRunConclusions: snapshot?.canceledRunConclusions,
      turnConclusions: snapshot?.turnConclusions,
      visibleFinals: snapshot?.visibleFinals,
    };
  })).toEqual({
    isGenerating: false,
    agentStatus: "idle",
    turnStatus: "done",
    turnResultKind: "canceled",
    canceledRunConclusions: 1,
    turnConclusions: 1,
    visibleFinals: 1,
  });
});

test("composer explicitly queues additional durable Turns while a run is active", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-running-guidance");

  const textarea = page.getByTestId("composer-textarea");
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
  await expect(page.getByTestId("composer-send-button")).toHaveCount(0);
  const autoReviewToggle = page.getByTestId("composer-auto-review-toggle");
  const subagentToggle = page.getByTestId("composer-subagent-preference-toggle");
  await expect(autoReviewToggle).toBeVisible();
  await expect(subagentToggle).toBeVisible();
  await expect(subagentToggle).toBeDisabled();
  await expect(subagentToggle).toHaveAttribute("aria-pressed", "false");

  page.once("dialog", (dialog) => dialog.accept());
  await autoReviewToggle.click();
  await expect
    .poll(async () => page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().autoApproveTools)))
    .toBe(true);
  await expect(autoReviewToggle).toBeDisabled();

  const firstInstruction = "追加检查导入后的空状态";
  const secondInstruction = "然后验证恢复后的焦点状态";
  await textarea.fill(firstInstruction);
  await expect(page.getByTestId("composer-guidance-button")).toBeVisible();
  await expect(page.getByTestId("composer-queue-button")).toBeVisible();
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
  await expect(page.getByTestId("composer-send-button")).toHaveCount(0);

  await page.getByTestId("composer-queue-button").click();
  await expect(textarea).toHaveValue("");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().input ?? "missing"))
    .toBe("");

  await textarea.fill(secondInstruction);
  await page.getByTestId("composer-queue-button").click();
  await expect(textarea).toHaveValue("");

  await expect.poll(async () => page.evaluate(() => {
    const entries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
    return entries
      .filter((entry: { source?: string }) => entry.source === "store.workspace_instruction_admitted")
      .map((entry: { message?: string }) => {
        const message = JSON.parse(String(entry.message || "{}"));
        return {
          queuePosition: message.queuePosition,
          turnId: message.turnId,
          durability: message.durability,
        };
      });
  })).toEqual([
    expect.objectContaining({ queuePosition: 1, durability: "session" }),
    expect.objectContaining({ queuePosition: 2, durability: "session" }),
  ]);
  const admittedTurns = await page.evaluate(() => {
    const entries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
    return entries
      .filter((entry: { source?: string }) => entry.source === "store.workspace_instruction_admitted")
      .map((entry: { message?: string }) => JSON.parse(String(entry.message || "{}"))?.turnId);
  });
  expect(new Set(admittedTurns).size).toBe(2);

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    return {
      conversationTurns: snapshot?.conversationTurns ?? null,
      taskFlowUserCount: snapshot?.taskFlowUserCount ?? null,
      agentStatus: snapshot?.agentStatus ?? null,
    };
  })).toEqual({
    conversationTurns: 3,
    taskFlowUserCount: 3,
    agentStatus: "running",
  });
  await expect(page.getByTestId("user-message-content")).toHaveText([
    "请检查运行中输入体验。",
    firstInstruction,
    secondInstruction,
  ]);
  await expect(page.getByTestId("composer-queued-message")).toContainText("已排队 · 2 个回合");
  await expect(page.getByTestId("composer-queued-message")).toContainText(firstInstruction);
  await expect(page.getByTestId("composer-active-guidance")).toHaveCount(0);
  await expect(page.getByTestId("composer-guidance-button")).toHaveCount(0);
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
});

test("composer guides the current run without admitting a new Turn", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-running-guidance");

  const guidance = "优先检查当前焦点恢复，不要开启新回合";
  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill(guidance);

  await expect(page.getByTestId("composer-guidance-button")).toBeEnabled();
  await expect(page.getByTestId("composer-queue-button")).toBeEnabled();
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();
  await page.getByTestId("composer-guidance-button").click();

  await expect(textarea).toHaveValue("");
  await expect(page.getByTestId("composer-active-guidance")).toContainText("正在引导当前执行");
  await expect(page.getByTestId("composer-active-guidance")).toContainText(guidance);
  await expect(page.getByTestId("composer-queued-message")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    const entries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
    return {
      activeGuidance: snapshot?.activeGuidance?.text ?? null,
      conversationTurns: snapshot?.conversationTurns ?? null,
      taskFlowUserCount: snapshot?.taskFlowUserCount ?? null,
      admittedTurns: entries.filter((entry: { source?: string }) =>
        entry.source === "store.workspace_instruction_admitted"
      ).length,
    };
  })).toEqual({
    activeGuidance: guidance,
    conversationTurns: 1,
    taskFlowUserCount: 1,
    admittedTurns: 0,
  });

  await page.getByTestId("composer-guidance-undo-button").click();
  await expect(page.getByTestId("composer-active-guidance")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() =>
    (window as any).__CODELY_E2E__?.getSnapshot?.().activeGuidance ?? null
  )).toBeNull();
});

test("composer subagent preference toggle activates after the current run stops", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=composer-running-guidance");

  const subagentToggle = page.getByTestId("composer-subagent-preference-toggle");
  await expect(subagentToggle).toBeDisabled();
  await page.evaluate(() => (window as any).__CODELY_E2E__?.clearModelRuntimeLock?.());
  await expect(subagentToggle).toBeEnabled();
  await subagentToggle.click();
  await expect(subagentToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("composer-subagent-preference-status")).toContainText("协作已开启");
  await expect
    .poll(async () => page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().preferSubagents)))
    .toBe(true);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setModelRuntimeLock?.({ status: "running" }));
  const preferenceInstruction = "检查启动和菜单模块";
  await page.getByTestId("composer-textarea").fill(preferenceInstruction);
  await page.getByTestId("composer-queue-button").click();
  await expect.poll(async () => page.evaluate((text) => {
    const savedSessions = (window as any).__COMPOSER_PREFERENCE_E2E__?.savedSessions || [];
    for (const session of savedSessions) {
      const entries = session?.runtimeSnapshot?.workspaceTurnQueue?.entries || [];
      const admitted = entries.find((entry: any) => entry?.instruction?.payload?.text === text);
      if (admitted) {
        return admitted.instruction.payload.dispatchHints?.subagentPreference ?? null;
      }
    }
    return null;
  }, preferenceInstruction)).toBe("preferred");

  const autoReviewToggle = page.getByTestId("composer-auto-review-toggle");
  const themeDraft = "检查运行中输入选择的主题显示";
  await page.getByTestId("composer-textarea").fill(themeDraft);
  const guidanceButton = page.getByTestId("composer-guidance-button");
  const queueButton = page.getByTestId("composer-queue-button");
  const runningActions = queueButton.locator("xpath=..");
  await expect(
    page.locator('[data-testid="composer-subagent-preference-toggle"] + [data-testid="composer-auto-review-toggle"]'),
  ).toHaveCount(1);
  for (const theme of ["light", "dark", "black"] as const) {
    await page.evaluate((nextTheme) => (window as any).__CODELY_E2E__?.setThemeMode?.(nextTheme), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(subagentToggle).toBeVisible();
    await expect(subagentToggle).toHaveClass(/is-active/);
    await expect(autoReviewToggle).toBeVisible();
    await expect(guidanceButton).toContainText("引导");
    await expect(queueButton).toContainText("排队");
    await expect(page.getByTestId("composer-stop-button")).toBeVisible();
    await expect(page.getByTestId("composer-queued-message")).toBeVisible();
    await subagentToggle.screenshot({ path: testInfo.outputPath(`subagent-toggle-${theme}.png`) });
    await runningActions.screenshot({ path: testInfo.outputPath(`running-input-actions-${theme}.png`) });
    await page.getByTestId("composer-queued-message").screenshot({ path: testInfo.outputPath(`running-input-queue-${theme}.png`) });
  }
});

test("chat history remains scrollable during rapid streaming updates", async ({ page }) => {
  await page.goto("/?e2eScenario=streaming-responsiveness");

  const scroller = page.getByTestId("chat-scroll-container");
  await expect(
    page.locator("section[data-turn-id='e2e-responsive-active-turn']").getByTestId("turn-state-anchor"),
  ).toContainText("流式滚动回归");
  await expect(page.getByText("请持续输出，同时保持历史滚动流畅。")).toBeAttached();
  await expect(page.getByTestId("composer-stop-button")).toBeVisible();

  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const bottom = await scroller.evaluate((el) => el.scrollTop);

  await scroller.hover();
  await page.mouse.wheel(0, -900);

  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop), { timeout: 2500 })
    .toBeLessThan(bottom - 100);

  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().tickCount ?? 0))
    .toBeGreaterThan(5);
});

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("settled updates stay ordered in ChatArea while live model flow replaces the Capsule status", async ({ page }) => {
  await page.goto("/?e2eScenario=capsule-model-explanation");

  const capsule = page.getByTestId("agent-explanation-capsule");
  const thoughtSummary = capsule.getByTestId("capsule-thought-summary-label");
  await expect(capsule.getByTestId("capsule-status-label")).toHaveCount(0);
  await expect(capsule.getByTestId("capsule-activity-label")).toHaveCount(0);
  await expect(thoughtSummary).toHaveText(
    "让我继续查看 ChatArea.tsx，确认 Capsule 的实时投影入口。",
  );
  await expect(thoughtSummary.locator("strong")).toHaveText("ChatArea.tsx");
  await expect(capsule).not.toContainText("保留这条模型说明");
  await expect(capsule).not.toContainText("read_file");
  await expect(capsule).not.toContainText("grep_search");
  await expect(capsule).not.toContainText("暂无工具调用");
  await expect(capsule).not.toContainText("tool:");
  await expect(capsule).not.toContainText("等待您的下一步指令");
  const firstUpdate = page.getByText("已确认阶段性结论应留在 ChatArea，实时动作应进入 Capsule。");
  const secondUpdate = page.getByText("已确认重复展示来自同一工具前言被同时投影；Capsule 只保留精简判断。");
  await expect(firstUpdate).toHaveCount(1);
  await expect(secondUpdate).toHaveCount(1);
  await expect(page.locator('[data-testid="chat-scroll-container"]')).not.toContainText(
    "让我继续查看 ChatArea.tsx，确认 Capsule 的实时投影入口。",
  );
  await expect.poll(async () => firstUpdate.evaluate((first, secondText) => {
    const second = Array.from(document.querySelectorAll("*")).find((node) => node.textContent === secondText);
    return second ? Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
  }, "已确认重复展示来自同一工具前言被同时投影；Capsule 只保留精简判断。")).toBe(true);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.getByTestId("effective-progress-ledger")).toHaveCount(0);

  const runStatusTrigger = page.getByTitle("查看运行状态");
  await runStatusTrigger.click();
  const progressPopover = page.getByTestId("effective-progress-popover");
  await expect(progressPopover).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭运行状态" })).toBeFocused();
  await expect(progressPopover).toContainText("运行状态");
  await expect(progressPopover).toContainText("当前活动");
  await expect(progressPopover).toContainText("最近里程碑");
  await expect(page.getByTestId("run-status-current-activity")).toContainText("ChatArea.tsx");
  await expect(page.getByTestId("run-status-milestone")).toHaveCount(2);
  await expect(progressPopover).toContainText("ChatArea.tsx");
  await expect(progressPopover).toContainText("npm run test:workflow-assets");

  for (const mode of ["light", "dark", "black"] as const) {
    await page.evaluate((themeMode) => (window as any).__CODELY_E2E__?.setThemeMode?.(themeMode), mode);
    await expect.poll(async () => (
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().themeMode ?? null)
    )).toBe(mode);
    await expect(progressPopover).toBeVisible();
    await expect(thoughtSummary).toHaveText("让我继续查看 ChatArea.tsx，确认 Capsule 的实时投影入口。");
    const capsuleSurface = await capsule.evaluate((element) => {
      const capsuleStyle = getComputedStyle(element);
      const thought = element.querySelector<HTMLElement>('[data-testid="capsule-thought-summary-label"]');
      const paragraph = thought?.querySelector<HTMLElement>("p") || null;
      const paragraphStyle = paragraph ? getComputedStyle(paragraph) : null;
      return {
        backgroundColor: capsuleStyle.backgroundColor,
        thoughtColor: paragraphStyle?.color || "",
        thoughtWhiteSpace: paragraphStyle?.whiteSpace || "",
        thoughtTextOverflow: paragraphStyle?.textOverflow || "",
      };
    });
    expect(capsuleSurface.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(capsuleSurface.thoughtColor).not.toBe("");
    expect(capsuleSurface.thoughtColor).not.toBe("rgb(161, 161, 170)");
    expect(capsuleSurface.thoughtColor).not.toBe("rgb(212, 212, 216)");
    expect(capsuleSurface.thoughtWhiteSpace).toBe("pre-wrap");
    expect(capsuleSurface.thoughtTextOverflow).not.toBe("ellipsis");
    const surface = await progressPopover.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderTopColor,
        fitsViewport: element.getBoundingClientRect().width <= window.innerWidth,
      };
    });
    expect(surface.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(surface.borderColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(surface.fitsViewport).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(progressPopover).toBeHidden();
  await expect(runStatusTrigger).toBeFocused();

  const timeline = page.getByTestId("live-turn-process-timeline");
  await expect(timeline).toBeVisible();
  const processDisclosure = page.getByTestId("turn-process-disclosure");
  await expect(processDisclosure).toHaveAttribute("aria-expanded", "true");
  await expect(processDisclosure).toContainText("3 个工具");
  await processDisclosure.click();
  await expect(processDisclosure).toHaveAttribute("aria-expanded", "false");
  await expect(timeline).toHaveCount(0);
  await expect(capsule.getByTestId("capsule-status-label")).toHaveCount(0);
  await expect(thoughtSummary).toContainText("让我继续查看 ChatArea.tsx");
  await expect(firstUpdate).toHaveCount(1);
  await expect(secondUpdate).toHaveCount(1);

  await processDisclosure.click();
  await expect(timeline).toBeVisible();
  await expect(page.getByTestId("live-turn-process-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-status-label")).toHaveCount(0);
  await expect(page.getByTestId("tool-collapsed-summary")).toHaveCount(0);
  await expect(page.getByTestId("chat-operation-summary")).toHaveCount(0);
  await expect(page.getByTestId("completed-tool-group-summary")).toHaveCount(0);

  await expect(page.getByTestId("live-turn-step")).toHaveCount(3);
  await expect(page.getByTestId("live-turn-process-details")).toContainText("运行回归测试确认折叠状态");

  await page.reload();
  await expect(page.getByText("已确认阶段性结论应留在 ChatArea，实时动作应进入 Capsule。")).toHaveCount(1);
  await expect(page.getByText("已确认重复展示来自同一工具前言被同时投影；Capsule 只保留精简判断。")).toHaveCount(1);
  await expect(page.getByTestId("agent-explanation-capsule")).not.toContainText("保留这条模型说明");
  await expect(page.getByTestId("capsule-thought-summary-label")).toContainText("让我继续查看 ChatArea.tsx");
  await expect(page.getByTestId("capsule-activity-label")).toHaveCount(0);
});

test("capsule falls back to the lifecycle status until real model flow is available", async ({ page }) => {
  await page.goto("/?e2eScenario=capsule-progress-only");

  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toBeVisible();
  await expect(capsule.getByTestId("capsule-status-label")).toHaveText("正在执行");
  await expect(capsule.getByTestId("capsule-thought-summary-label")).toHaveCount(0);
  await expect(capsule.getByTestId("capsule-activity-label")).toHaveCount(0);
  await expect(capsule).not.toContainText("grep_search");
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.getByTestId("effective-progress-ledger")).toHaveCount(0);
});

test("turn process timeline stays inside its frame in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 720 });
  await page.goto("/?e2eScenario=capsule-model-explanation");

  await expect(page.getByTestId("capsule-status-label")).toHaveCount(0);
  await expect(page.getByTestId("capsule-activity-label")).toHaveCount(0);
  const thoughtSummary = page.getByTestId("capsule-thought-summary-label");
  await expect(thoughtSummary).toContainText("让我继续查看 ChatArea.tsx");
  const thoughtMetrics = await thoughtSummary.evaluate((element) => {
    const paragraph = element.querySelector<HTMLElement>("p");
    const style = paragraph ? getComputedStyle(paragraph) : null;
    return {
      whiteSpace: style?.whiteSpace || "",
      textOverflow: style?.textOverflow || "",
      height: element.getBoundingClientRect().height,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      capsuleWidth: element.closest('[data-testid="agent-explanation-capsule"]')?.getBoundingClientRect().width || 0,
    };
  });
  expect(thoughtMetrics.whiteSpace).toBe("pre-wrap");
  expect(thoughtMetrics.textOverflow).not.toBe("ellipsis");
  expect(thoughtMetrics.height).toBeGreaterThan(0);
  expect(thoughtMetrics.clientWidth).toBeLessThanOrEqual(thoughtMetrics.capsuleWidth);
  expect(thoughtMetrics.scrollWidth).toBeLessThanOrEqual(thoughtMetrics.clientWidth + 1);

  const timeline = page.getByTestId("live-turn-process-timeline");
  await expect(timeline).toBeVisible();
  await expect(page.getByTestId("live-turn-step")).toHaveCount(3);

  const overflowing = await page.evaluate(() => {
    const selector = [
      '[data-testid="live-turn-process-timeline"]',
      '[data-testid="live-turn-process-toggle"]',
      '[data-testid="live-turn-process-details"]',
      '[data-testid="live-turn-step"]',
      '[data-testid="turn-archive-step-toggle"]',
      '[data-testid="turn-archive-step-details"]',
    ].join(",");
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((element) => ({
        testId: element.getAttribute("data-testid"),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      }))
      .filter((entry) => entry.scrollWidth - entry.clientWidth > 2);
  });

  expect(overflowing).toEqual([]);
});

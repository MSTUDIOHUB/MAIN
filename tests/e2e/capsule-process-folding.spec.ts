import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("capsule preserves model explanation while tools are folded", async ({ page }) => {
  await page.goto("/?e2eScenario=capsule-model-explanation");

  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toContainText("保留这条模型说明");
  await expect(capsule).not.toContainText("等待您的下一步指令");
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
  await expect(capsule).toContainText("保留这条模型说明");

  await processDisclosure.click();
  await expect(timeline).toBeVisible();
  await expect(page.getByTestId("live-turn-process-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-status-label")).toHaveCount(0);
  await expect(page.getByTestId("tool-collapsed-summary")).toHaveCount(0);
  await expect(page.getByTestId("chat-operation-summary")).toHaveCount(0);
  await expect(page.getByTestId("completed-tool-group-summary")).toHaveCount(0);

  await expect(page.getByTestId("live-turn-step")).toHaveCount(3);
  await expect(page.getByTestId("live-turn-process-details")).toContainText("运行回归测试确认折叠状态");
});

test("capsule progress fallback never shows idle waiting copy", async ({ page }) => {
  await page.goto("/?e2eScenario=capsule-progress-only");

  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toBeVisible();
  const capsuleText = (await capsule.textContent()) || "";
  expect(capsuleText).not.toContain("等待您的下一步指令");
  expect(capsuleText).not.toContain("随时准备开始新的探索或修改");
  expect(capsuleText.trim().length).toBeGreaterThan(0);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.getByTestId("effective-progress-ledger")).toHaveCount(0);
});

test("turn process timeline stays inside its frame in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/?e2eScenario=capsule-model-explanation");

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

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

  const timeline = page.getByTestId("live-turn-process-timeline");
  await expect(timeline).toBeVisible();
  await expect(page.getByTestId("live-turn-process-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("tool-status-label")).toHaveCount(0);
  await expect(page.getByTestId("tool-collapsed-summary")).toHaveCount(0);
  await expect(page.getByTestId("chat-operation-summary")).toHaveCount(0);
  await expect(page.getByTestId("completed-tool-group-summary")).toHaveCount(0);

  await page.getByTestId("live-turn-process-toggle").click();
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
});

test("turn process timeline stays inside its frame in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/?e2eScenario=capsule-model-explanation");

  const timeline = page.getByTestId("live-turn-process-timeline");
  await expect(timeline).toBeVisible();
  await page.getByTestId("live-turn-process-toggle").click();
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

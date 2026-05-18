import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("game studio completed tool calls collapse into one group while keeping the latest running card", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-tool-group-collapse");

  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  await expect(page.getByTestId("live-turn-process-timeline")).toBeVisible();
  const steps = page.getByTestId("live-turn-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText("定位 Main Camera 对象");
  await expect(steps.nth(1)).toContainText("核对 Main Camera 当前相机参数");
  await expect(steps.nth(2)).toContainText("读取控制脚本确认行为");
  await expect(steps.nth(3)).toContainText("继续调整 Main Camera 视角");
  await expect(steps.nth(3)).toContainText("进行中");
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-notice")).toContainText("已完成 3 次，当前调用工具：Main Camera");
  await expect(page.getByTestId("tool-status-label").filter({ hasText: "执行中" })).toHaveCount(0);

  await steps.nth(3).getByTestId("turn-archive-step-toggle").click();
  await expect(page.getByTestId("tool-status-label").filter({ hasText: "执行中" })).toHaveCount(1);
});

test("game studio awaiting_input state does not keep showing running tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-awaiting-choice");

  await expect(page.getByTestId("live-turn-process-timeline")).toBeVisible();
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.getByText("正在调用工具")).toHaveCount(0);
});

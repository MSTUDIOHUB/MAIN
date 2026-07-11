import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("game studio live steps show concise progress without nested action cards", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-tool-group-collapse");

  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  await expect(page.getByTestId("live-turn-process-timeline")).toBeVisible();
  await expect(page.getByTestId("turn-process-disclosure")).toContainText("4 个工具");
  const liveToggle = page.getByTestId("live-turn-process-toggle");
  await expect(liveToggle).toHaveAttribute("aria-expanded", "true");
  const capsule = page.getByTestId("agent-explanation-capsule");
  await expect(capsule).toContainText("manage_camera");
  await expect(capsule).toContainText("重复 2 次");
  const capsuleStyleBefore = await capsule.evaluate((element) => {
    const style = getComputedStyle(element);
    const fill = getComputedStyle(element, "::before");
    return {
      animationName: style.animationName,
      border: style.border,
      boxShadow: style.boxShadow,
      fillAnimationName: fill.animationName,
    };
  });
  expect(capsuleStyleBefore.animationName).toBe("none");
  expect(capsuleStyleBefore.fillAnimationName).toContain("capsule-fill-flow");
  await page.waitForTimeout(250);
  const capsuleStyleAfter = await capsule.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      border: style.border,
      boxShadow: style.boxShadow,
    };
  });
  expect(capsuleStyleAfter.border).toBe(capsuleStyleBefore.border);
  expect(capsuleStyleAfter.boxShadow).toBe(capsuleStyleBefore.boxShadow);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);

  const steps = page.getByTestId("live-turn-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText("定位 Main Camera 对象");
  await expect(steps.nth(1)).toContainText("核对 Main Camera 当前相机参数");
  await expect(steps.nth(2)).toContainText("读取控制脚本确认行为");
  await expect(steps.nth(3)).toContainText("继续调整 Main Camera 视角");
  await expect(steps.nth(3)).toContainText("视角偏移 需要用工具结果确认后再继续");
  await expect(steps.nth(3)).not.toContainText("因为：");
  await expect(steps.nth(3)).not.toContainText("**视角偏移**");
  await expect(steps.nth(3).getByTestId("turn-archive-step-intent")).toContainText("视角偏移");
  await expect(steps.nth(3)).toContainText("进行中");
  await expect(steps.nth(3).getByTestId("turn-archive-step-toggle")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("tool-status-label").filter({ hasText: "执行中" })).toHaveCount(0);
  await expect(page.getByTestId("turn-archive-step-details")).toHaveCount(0);
});

test("game studio awaiting_input state does not keep showing running tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-awaiting-choice");

  await expect(page.getByTestId("turn-state-anchor")).toContainText("待选择");
  await expect(page.getByTestId("live-turn-process-timeline")).toBeVisible();
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.locator('[data-testid="live-turn-step"][data-status="running"]')).toHaveCount(0);
  await expect(page.getByText("请选择下一步。")).toBeVisible();
  await expect(page.getByText("正在调用工具")).toHaveCount(0);
});

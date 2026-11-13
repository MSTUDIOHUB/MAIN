import { expect, test } from "@playwright/test";
import { installCapsuleFixtureStartup } from "./capsuleFixtureStartup";

test.beforeEach(({ page }) => installCapsuleFixtureStartup(page));

test("MAIN live steps show concise progress with tool details collapsed", async ({ page }) => {
  await page.goto("/?e2eScenario=tool-group-collapse");

  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  await expect(page.getByTestId("live-turn-process-timeline")).toBeVisible();
  const liveToggle = page.getByTestId("live-turn-process-toggle");
  await expect(liveToggle).toHaveAttribute("aria-expanded", "false");
  await expect(liveToggle).toContainText("本轮活动");
  await expect(liveToggle).toContainText("读取 config.ts");
  const capsule = page.getByTestId("agent-explanation-capsule");
  // The seeded tool block has no active Run owner, so only the durable
  // process disclosure can identify its current target.
  await expect(capsule).toContainText("正在执行");
  await expect(capsule).not.toContainText("read_file");
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
  expect(capsuleStyleBefore.fillAnimationName).toBe("capsule-beam-travel");
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

  await liveToggle.click();
  const steps = page.getByTestId("live-turn-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText("src/config.ts");
  await expect(steps.nth(1)).toContainText("node scripts/inspect-config.mjs");
  await expect(steps.nth(2)).toContainText("http://localhost/config");
  await expect(steps.nth(3).getByTestId("turn-archive-step-intent")).toContainText("config.ts");
  await expect(steps.nth(3).getByTestId("turn-archive-step-intent")).not.toContainText("**");
  await expect(steps.nth(3)).toContainText("进行中");
  await expect(steps.nth(3).getByTestId("turn-archive-step-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("tool-status-label").filter({ hasText: "执行中" })).toHaveCount(0);
  await expect(page.getByTestId("turn-archive-step-details")).toHaveCount(0);
  // Compact activity rows describe the concrete action. Model-authored
  // purpose remains available through the separately disclosed operation.
  await steps.nth(3).getByTestId("turn-archive-step-toggle").click();
  const activeDetails = steps.nth(3).getByTestId("turn-archive-step-details");
  await expect(activeDetails).toContainText("继续检查配置加载顺序");
  // ActionCard's disclosed purpose is verbatim model text; compact summary
  // labels above remain free of raw Markdown syntax.
  await expect(activeDetails).toContainText("**加载顺序** 需要用工具结果确认后再继续");
  await expect(activeDetails).not.toContainText("因为：");
});

test("MAIN awaiting_input state does not keep showing running tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=tool-group-awaiting-choice");

  await expect(page.getByTestId("turn-state-anchor")).toContainText("待选择");
  await expect(page.getByTestId("live-turn-process-timeline")).toBeVisible();
  await page.getByTestId("live-turn-process-toggle").click();
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.locator('[data-testid="live-turn-step"][data-status="running"]')).toHaveCount(0);
  await expect(page.getByText("请选择下一步。")).toBeVisible();
  await expect(page.getByText("正在调用工具")).toHaveCount(0);
});

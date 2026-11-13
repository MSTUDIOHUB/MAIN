import { expect, test } from "@playwright/test";
import { installCapsuleFixtureStartup } from "./capsuleFixtureStartup";

test.beforeEach(({ page }) => installCapsuleFixtureStartup(page));

test("stream error clears the lingering thinking notice", async ({ page }) => {
  await page.goto("/?e2eScenario=stream-error-recovery");

  const activityNotice = page.getByTestId("turn-activity-notice");
  await expect(activityNotice).toHaveCount(0);
  const activity = page.getByTestId("live-turn-process-toggle");
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await expect(activity.getByTestId("turn-activity-issues")).toContainText("失败 1");
  await activity.click();

  const failedStep = page.getByTestId("live-turn-step").filter({
    hasText: "模型服务在传输回复时中断或返回了无法解析的数据。",
  });
  await expect(failedStep).toHaveAttribute("data-status", "failed");
  await failedStep.getByTestId("turn-archive-step-toggle").click();
  const errorCard = page.getByRole("button", { name: /连接中断，回复可能不完整/ });
  await expect(errorCard).toBeVisible();
  await errorCard.click();
  await expect(page.getByText("模型服务在传输回复时中断或返回了无法解析的数据。").first()).toBeVisible();
  await expect(activityNotice).toHaveCount(0);
});

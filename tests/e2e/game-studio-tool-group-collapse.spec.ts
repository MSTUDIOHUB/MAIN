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

  const groups = page.getByTestId("completed-tool-group");
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toContainText("已完成 3 次工具调用");
  await expect(page.getByTestId("turn-activity-notice")).toContainText("已完成 3 次，当前调用工具：Main Camera");
  await expect(page.getByText("执行中...")).toHaveCount(1);

  await groups.first().click();
  await expect(page.getByTestId("completed-tool-group-details")).toBeVisible();
  await expect(page.getByTestId("completed-tool-group-item")).toHaveCount(3);
});

test("game studio awaiting_input state does not keep showing running tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-awaiting-choice");

  await expect(page.getByTestId("completed-tool-group")).toHaveCount(1);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.getByText("正在调用工具")).toHaveCount(0);
});

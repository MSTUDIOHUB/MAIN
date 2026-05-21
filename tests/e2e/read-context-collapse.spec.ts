import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("completed read tools collapse into one expandable context group", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-collapse");

  await expect(page.getByTestId("turn-process-archive-toggle")).toBeVisible();
  await expect(page.getByTestId("read-context-group")).toHaveCount(0);
  await page.getByTestId("turn-process-archive-toggle").click();

  const contextSteps = page.locator('[data-testid="turn-archive-step"][data-kind="discover"], [data-testid="turn-archive-step"][data-kind="inspect"]');
  await expect(contextSteps).toHaveCount(2);
  await expect(contextSteps.nth(0)).toContainText("10 个文件");
  await expect(contextSteps.nth(0)).toContainText("项目骨架");
  await expect(contextSteps.nth(0)).not.toContainText("下一步读取最小必要上下文");
  await expect(contextSteps.nth(0)).toContainText("文件不存在");
  await expect(contextSteps.nth(1)).toContainText("1 个文件");
  const groups = page.getByTestId("read-context-group");
  await expect(groups).toHaveCount(1);
  const firstGroup = groups.nth(0);

  await expect(firstGroup).toBeVisible();
  await expect(firstGroup).toContainText("已读取 10 项上下文");
  await expect(firstGroup).toContainText("+7");
  await expect(page.getByTestId("read-context-group-details")).toHaveCount(0);
  await expect(page.getByText("BattleActionQueue.cs")).not.toBeVisible();

  await firstGroup.click();

  const details = page.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(page.getByTestId("read-context-item")).toHaveCount(10);
  await expect(details).toContainText("BattleActionQueue.cs");
  await expect(details).not.toContainText("MissingConfig.cs");

  await firstGroup.click();
  await expect(page.getByTestId("read-context-group-details")).toHaveCount(0);

  await contextSteps.nth(1).getByTestId("turn-archive-step-toggle").click();
  await expect(page.getByTestId("read-context-group").filter({ hasText: "已读取 1 项上下文" })).toBeVisible();
  await expect(contextSteps.nth(0)).toContainText("MissingConfig.cs");
  await expect(page.locator('[data-testid="turn-archive-step"][data-kind="edit"]')).toContainText("GeneratedBattleUnit.cs");
});

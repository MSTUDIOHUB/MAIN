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

  const group = page.getByTestId("read-context-group");
  await expect(group).toBeVisible();
  await expect(group).toContainText("已读取 10 项上下文");
  await expect(group).toContainText("+7");
  await expect(page.getByTestId("read-context-group-details")).toHaveCount(0);
  await expect(page.getByText("BattleActionQueue.cs")).not.toBeVisible();

  await group.click();

  const details = page.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(page.getByTestId("read-context-item")).toHaveCount(10);
  await expect(details).toContainText("BattleActionQueue.cs");
  await expect(details).not.toContainText("MissingConfig.cs");

  await group.click();
  await expect(page.getByTestId("read-context-group-details")).toHaveCount(0);

  await expect(page.getByText("MissingConfig.cs")).toBeVisible();
  await expect(page.getByText("已编辑")).toBeVisible();
});

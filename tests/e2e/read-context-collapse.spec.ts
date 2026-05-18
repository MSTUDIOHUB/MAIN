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

  const groups = page.getByTestId("read-context-group");
  await expect(groups).toHaveCount(2);
  const firstGroup = groups.nth(0);
  const secondGroup = groups.nth(1);

  await expect(firstGroup).toBeVisible();
  await expect(firstGroup).toContainText("已读取 10 项上下文");
  await expect(firstGroup).toContainText("+7");
  await expect(secondGroup).toContainText("已读取 1 项上下文");
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

  await expect(page.getByText("MissingConfig.cs")).toBeVisible();
  await expect(page.getByText("已编辑")).toBeVisible();
});

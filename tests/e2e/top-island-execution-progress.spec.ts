import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("TopIsland does not invent execution step progress from plain tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-execution-progress");

  await expect(page.getByTestId("top-island-shell")).toHaveCount(0);
  await expect(page.getByTestId("top-island-execution-badge")).toHaveCount(0);
  await expect(page.getByTestId("top-island-execution-progress")).toHaveCount(0);
});

test("TopIsland shows the full approved plan task list during execution", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-plan-task-progress");

  await expect(page.getByTestId("top-island-plan-badge")).toContainText("任务 8/9");
  await page.getByTestId("top-island-shell").hover();
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("共 9 个任务，已完成 8 个");
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("T1: 更新");
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("T8: 更新");
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("T9: 更新");
  await expect(page.getByTestId("top-island-current-plan-task")).toContainText("T9: 更新");
  await expect(page.getByTestId("top-island-current-plan-task")).not.toContainText("当前");
});

test("TopIsland keeps approval buttons visible for a long command with plan tasks", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-pending-tool-review");

  await expect(page.getByTestId("top-island-tool-review")).toBeVisible();
  await expect(page.getByTestId("top-island-tool-review")).toContainText("拒绝");
  await expect(page.getByTestId("top-island-tool-review")).toContainText("当前会话全部允许");
  await expect(page.getByTestId("top-island-tool-review")).toContainText("单次批准");
  await expect(page.getByTestId("top-island-tool-review")).toContainText("printf");
  await expect(page.getByTestId("top-island-plan-progress")).toContainText("任务明细已收起");
  await expect(page.getByTestId("top-island-current-plan-task")).toHaveCount(0);
});

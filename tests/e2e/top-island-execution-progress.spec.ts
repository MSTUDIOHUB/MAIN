import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("TopIsland shows execution-mode step progress from tool activity", async ({ page }) => {
  await page.goto("/?e2eScenario=top-island-execution-progress");

  await expect(page.getByTestId("top-island-execution-badge")).toContainText("步骤 1/3");
  await page.getByTestId("top-island-shell").hover();
  await expect(page.getByTestId("top-island-execution-progress")).toContainText("共 3 个步骤，已完成 1 个");
  await expect(page.getByTestId("top-island-execution-progress")).toContainText("读取文件: TopIsland.tsx");
  await expect(page.getByTestId("top-island-execution-progress")).toContainText("修改文件: TopIsland.tsx");
  await expect(page.getByTestId("top-island-execution-progress")).toContainText("执行命令: npm test");
});

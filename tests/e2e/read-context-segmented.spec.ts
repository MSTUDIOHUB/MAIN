import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("read/search tools stay grouped when interleaved with command cards", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-interleaved");

  const groups = page.getByTestId("read-context-group");
  await expect(groups).toHaveCount(1);
  const group = groups.first();
  await expect(group).toContainText("已读取 3 项上下文");

  await expect(page.getByText("git status --short --branch")).toBeVisible();
  await expect(page.getByText("npm run build -- --mode test")).toBeVisible();

  await group.click();
  const details = page.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(page.getByTestId("read-context-item")).toHaveCount(3);
  await expect(details).toContainText("package.json");
  await expect(details).toContainText("useAppStore.ts");
  await expect(details).toContainText("*release*.md");
});

test("visible agent output splits read/search groups into separate segments", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-agent-segment");

  const groups = page.getByTestId("read-context-group");
  await expect(groups).toHaveCount(2);
  const firstGroup = groups.nth(0);
  const secondGroup = groups.nth(1);
  await expect(firstGroup).toContainText("已读取 2 项上下文");
  await expect(secondGroup).toContainText("已读取 1 项上下文");
  await expect(page.getByText("第一段读取完成，先输出阶段结论。")).toBeVisible();

  await firstGroup.click();
  let details = page.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("ChatArea.tsx");
  await expect(page.getByTestId("read-context-item")).toHaveCount(2);
  await firstGroup.click();
  await expect(page.getByTestId("read-context-group-details")).toHaveCount(0);

  await secondGroup.click();
  details = page.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("README.md");
  await expect(page.getByTestId("read-context-item")).toHaveCount(1);
});

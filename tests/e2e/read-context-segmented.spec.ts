import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("read/search progress stays visible when interleaved with command cards", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-interleaved");

  const ledger = page.getByTestId("effective-progress-ledger");
  await expect(ledger).toBeVisible();
  await expect(ledger).toContainText("5 条有效进展");

  const archiveToggle = page.getByTestId("turn-process-archive-toggle");
  await expect(archiveToggle).toContainText("上下文 3");
  await expect(archiveToggle).toContainText("验证 1");
  await expect(archiveToggle).toContainText("命令 1");
  await archiveToggle.click();

  await expect(page.locator('[data-testid="turn-archive-step"]').filter({ hasText: "package.json" })).toBeVisible();
  await expect(page.locator('[data-testid="turn-archive-step"]').filter({ hasText: "useAppStore.ts" })).toBeVisible();
  await expect(page.locator('[data-testid="turn-archive-step"]').filter({ hasText: "*release*.md" })).toBeVisible();
  await expect(page.locator('[data-testid="turn-archive-step"]').filter({ hasText: "git status --short --branch" })).toBeVisible();
  await expect(page.locator('[data-testid="turn-archive-step"]').filter({ hasText: "npm run build -- --mode test" })).toBeVisible();
});

test("visible agent output is preserved inside archived read/search evidence", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-agent-segment");

  await expect(page.getByTestId("effective-progress-ledger")).toContainText("3 条有效进展");
  await expect(page.getByText("第二段读取完成。")).toBeVisible();
  await page.getByTestId("turn-process-archive-toggle").click();

  const contextStep = page.locator('[data-testid="turn-archive-step"][data-kind="inspect"]').first();
  await expect(contextStep).toContainText("ChatArea.tsx");
  await expect(contextStep).toContainText("README.md");
  await contextStep.getByTestId("turn-archive-step-toggle").click();
  await expect(contextStep).toContainText("第一段读取完成，先输出阶段结论。");

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

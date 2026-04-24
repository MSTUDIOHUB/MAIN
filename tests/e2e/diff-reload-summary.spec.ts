import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("diff summary stays clickable after reload and restores the diff viewer", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");

  await expect(page.getByText("2 个变更文件")).toBeVisible();
  await expect(page.getByTestId("turn-change-entry").filter({ hasText: "main.ts" })).toBeVisible();
  await expect(page.getByTestId("turn-change-entry").filter({ hasText: "helper.ts" })).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().seedCount ?? 0),
    )
    .toBe(1);

  await page.getByTestId("turn-change-entry").filter({ hasText: "main.ts" }).click();
  await expect(page.getByTestId("diff-panel-title")).toContainText("src/main.ts");

  await expect
    .poll(async () =>
      page.evaluate(() => ({
        showDiff: Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().showDiff),
        selectedDiffTaskId: (window as any).__CODELY_E2E__?.getSnapshot?.().selectedDiffTaskId ?? null,
      })),
    )
    .toMatchObject({
      showDiff: true,
    });
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedDiffTaskId ?? null),
    )
    .not.toBeNull();

  await page.reload();

  await expect(page.getByText("2 个变更文件")).toBeVisible();
  await expect(page.getByTestId("diff-panel-title")).toContainText("src/main.ts");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().seedCount ?? 0),
    )
    .toBe(1);

  await page.getByTestId("turn-change-entry").filter({ hasText: "helper.ts" }).click();
  await expect(page.getByTestId("diff-panel-title")).toContainText("src/utils/helper.ts");
});

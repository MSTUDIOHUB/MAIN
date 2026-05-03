import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("Feishu remote analysis shows analysis badge without inferred choice buttons", async ({ page }) => {
  await page.goto("/?e2eScenario=feishu-remote-analysis");

  await expect(page.getByTestId("turn-intent-badge-analyze")).toHaveText("分析");
  await expect(page.getByText("检查html版本和pygame版本的界面差别")).toBeVisible();
  await expect(page.getByText(/High score loaded from .*highscore\.json.* file/)).toBeVisible();
  await expect(page.getByTestId("top-island-awaiting-choice")).toHaveCount(0);
  await expect(page.getByTestId("top-island-reply-option-0")).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnIntent ?? null),
    )
    .toBe("analyze");
});

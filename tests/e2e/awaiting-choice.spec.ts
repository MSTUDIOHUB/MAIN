import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("reply options pause the turn and continue within the same turn after selection", async ({ page }) => {
  await page.goto("/?e2eScenario=awaiting-choice");

  await expect(page.getByTestId("plan-stage-badge")).toContainText("待选择");
  await expect(page.getByTestId("reply-option-0")).toBeVisible();
  await expect(page.getByTestId("top-island-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("top-island-reply-option-0")).toBeVisible();

  await page.getByTestId("top-island-reply-option-0").click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().conversationTurns ?? -1),
    )
    .toBe(1);

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().taskFlowUserCount ?? -1),
    )
    .toBe(2);

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnStatus ?? null),
    )
    .toBe("done");

  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.completed)),
    )
    .toBe(true);

  await expect(page.getByTestId("turn-summary-card").filter({ hasText: "用户完成选择后，当前回合已继续并保留上下文。" })).toBeVisible();
});

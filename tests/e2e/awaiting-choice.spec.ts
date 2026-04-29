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

  await expect(page.getByTestId("archived-choice-feedback")).toContainText("已保留上一步反馈");
  await expect(page.getByTestId("archived-choice-feedback")).toContainText("先修暂停等待选择");

  await page.getByTestId("archived-choice-feedback").click();
  await expect(page.getByTestId("archived-choice-feedback-expanded")).toContainText("已选择：先修暂停等待选择");
  await expect(page.getByText("我发现这里有一个关键分叉，需要你先确认优先级")).toBeVisible();
  await expect(page.getByText(/已按你的选择继续/)).toBeVisible();
});

test("custom reply option continues within the same turn", async ({ page }) => {
  await page.goto("/?e2eScenario=awaiting-choice");

  await expect(page.getByTestId("top-island-awaiting-choice")).toBeVisible();
  await page.getByTestId("top-island-custom-reply-input").fill("我想先补一个轻量方案再继续");
  await page.getByTestId("top-island-custom-reply-submit").click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().conversationTurns ?? -1),
    )
    .toBe(1);

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedOptions ?? []),
    )
    .toEqual(["我想先补一个轻量方案再继续"]);

  await expect(page.getByText(/已按你的选择继续/)).toBeVisible();
});

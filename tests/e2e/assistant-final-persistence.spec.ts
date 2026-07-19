import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const resetKey = "__MAIN_E2E_ASSISTANT_FINAL_RESET__";
    if (window.sessionStorage.getItem(resetKey)) return;
    window.localStorage.clear();
    window.sessionStorage.removeItem("__MAIN_E2E_ASSISTANT_FINAL_SNAPSHOT__");
    window.sessionStorage.setItem(resetKey, "1");
  });
});

test("completed assistant final survives persistence reload without promoting non-completed turns", async ({ page }) => {
  await page.goto("/?e2eScenario=assistant-final-persistence");

  const completedFinal = page.locator(
    '[data-testid="assistant-final"][data-turn-id="assistant-final-completed"]',
  );
  await expect(completedFinal).toBeVisible();
  await expect(completedFinal).toContainText("持久化后的最终结论仍然可见。");
  await expect(page.getByTestId("assistant-final")).toHaveCount(1);

  for (const turnId of ["assistant-final-paused", "assistant-final-error", "assistant-final-pending"]) {
    await expect(page.locator(`[data-testid="assistant-final"][data-turn-id="${turnId}"]`)).toHaveCount(0);
  }
  await expect(page.getByText("暂停回合只显示检查点，不显示成功 final。")).toBeVisible();
  await expect(page.getByText("失败回合不会获得成功 final。")).toBeVisible();
  await expect(page.getByText("等待 handoff 的回合不会提前显示成功 final。")).toBeVisible();

  const persistedBeforeReload = await page.evaluate(() => JSON.parse(
    window.sessionStorage.getItem("__MAIN_E2E_ASSISTANT_FINAL_SNAPSHOT__") || "{}",
  ));
  expect(persistedBeforeReload.taskFlow).toEqual(expect.arrayContaining([
    expect.objectContaining({
      turnId: "assistant-final-completed",
      type: "agent",
      visibility: "assistant_final",
      content: "持久化后的最终结论仍然可见。",
    }),
  ]));

  await page.reload();

  await expect(completedFinal).toBeVisible();
  await expect(completedFinal).toContainText("持久化后的最终结论仍然可见。");
  await expect(page.getByTestId("assistant-final")).toHaveCount(1);
  for (const turnId of ["assistant-final-paused", "assistant-final-error", "assistant-final-pending"]) {
    await expect(page.locator(`[data-testid="assistant-final"][data-turn-id="${turnId}"]`)).toHaveCount(0);
  }
  await expect.poll(async () => page.evaluate(() =>
    (window as any).__CODELY_E2E__?.events?.[0]?.type || "",
  )).toBe("restored");
});

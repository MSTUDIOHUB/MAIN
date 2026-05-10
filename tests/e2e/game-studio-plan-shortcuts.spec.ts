import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("game studio slash menu exposes plan shortcut and hides non-plan MAIN shortcuts", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-plan-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/");

  await expect(page.getByText("计划入口").first()).toBeVisible();
  await expect(page.getByText("/计划").first()).toBeVisible();
  await expect(page.getByText("/报告")).toHaveCount(0);
});

test("Shift+Tab toggles plan intent mode in the GAME STUDIO composer", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-plan-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("需要先规划这个改动");
  await textarea.focus();
  await page.keyboard.press("Shift+Tab");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe("plan");

  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe(null);
});

test("game studio plan shortcut can be selected from leading slash and keeps existing content", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-plan-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("先处理这个需求");
  await textarea.evaluate((node: HTMLTextAreaElement) => {
    node.focus();
    node.selectionStart = 0;
    node.selectionEnd = 0;
  });
  await page.keyboard.type("/ ");

  await expect(page.getByText("计划入口").first()).toBeVisible();
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe("plan");
  await expect(textarea).toHaveValue("先处理这个需求");
});

test("locked game studio plan turn submits as plan intent", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-plan-shortcuts");

  const textarea = page.getByTestId("composer-textarea");

  await textarea.fill("先规划这个游戏系统重构");
  await textarea.focus();
  await page.keyboard.press("Shift+Tab");
  await page.getByTestId("composer-send-button").click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnIntent ?? null),
    )
    .toBe("plan");
});

test("game studio continuation keeps previous plan turn identity", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-plan-shortcuts");

  await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.seedPlanTurnForContinuation?.(),
  );

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("继续");
  await page.getByTestId("composer-send-button").click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          currentTurnIntent: snapshot?.currentTurnIntent ?? null,
          conversationTurns: snapshot?.conversationTurns ?? null,
        };
      }),
    )
    .toEqual({
      currentTurnIntent: "plan",
      conversationTurns: 1,
    });
});

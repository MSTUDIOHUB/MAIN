import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("game studio onboarding inserts drafts and does not auto-send", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-onboarding");
  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.setNexusMode?.("nexus_game_studio");
  });

  const onboarding = page.getByTestId("game-studio-onboarding");
  await expect(onboarding).toBeVisible();
  await expect(onboarding).toContainText("MAIN GAME STUDIO");

  await page.getByTestId("game-studio-onboarding-setup-engine").click();

  await expect(page.getByTestId("composer-textarea")).toHaveValue("/setup-engine ");
  await expect(onboarding).toBeHidden();
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().taskFlowUserCount ?? -1),
    )
    .toBe(0);
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().conversationTurns ?? -1),
    )
    .toBe(0);

  await page.getByTestId("composer-send-button").click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().conversationTurns ?? -1),
    )
    .toBe(1);
  await expect(onboarding).toBeHidden();
});

test("game studio onboarding initialization hides the panel without sending a message", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-onboarding");
  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.setNexusMode?.("nexus_game_studio");
  });

  await page.getByTestId("game-studio-onboarding-init").click();

  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().gameStudioInitialized)),
    )
    .toBe(true);
  await expect(page.getByTestId("game-studio-onboarding")).toBeHidden();
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().taskFlowUserCount ?? -1),
    )
    .toBe(0);
});

test("switching away and back to game studio reopens onboarding and allows removing studio assets", async ({ page }) => {
  page.on("dialog", async (dialog) => {
    await dialog.accept();
  });

  await page.goto("/?e2eScenario=game-studio-onboarding");
  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.setNexusMode?.("nexus_game_studio");
  });

  await page.getByTestId("game-studio-onboarding-init").click();
  await expect(page.getByTestId("game-studio-onboarding")).toBeHidden();

  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.setNexusMode?.("nexus_general");
  });
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedMainModeKey ?? null),
    )
    .toBe("main_mode");

  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.setNexusMode?.("nexus_game_studio");
  });

  await expect(page.getByTestId("game-studio-onboarding")).toBeVisible();
  await expect(page.getByTestId("game-studio-onboarding-remove")).toBeVisible();

  await page.getByTestId("game-studio-onboarding-remove").click();

  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().gameStudioInitialized)),
    )
    .toBe(false);
  await expect(page.getByTestId("game-studio-onboarding-init")).toBeVisible();
});

test("game studio onboarding stays readable in light mode and can be dismissed", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-onboarding");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setThemeMode?.("light"));
  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.setNexusMode?.("nexus_game_studio");
  });

  const onboarding = page.getByTestId("game-studio-onboarding");
  await expect(onboarding).toBeVisible();

  const titleColor = await onboarding.getByText("MAIN GAME STUDIO").evaluate((node) => getComputedStyle(node).color);
  const workspaceCardBackground = await page
    .getByTestId("game-studio-onboarding-workspace")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const initButtonBackground = await page
    .getByTestId("game-studio-onboarding-init")
    .evaluate((node) => getComputedStyle(node).backgroundColor);

  expect(titleColor).toBe("rgb(126, 34, 206)");
  expect(workspaceCardBackground).toBe("rgba(255, 255, 255, 0.82)");
  expect(initButtonBackground).toBe("rgb(147, 51, 234)");

  await page.getByTestId("game-studio-onboarding-dismiss").click();
  await expect(onboarding).toBeHidden();
});

test("main focus picker uses clean selected and neutral item colors in light mode", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-onboarding");

  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.setThemeMode?.("light");
    (window as any).__CODELY_E2E__?.setNexusMode?.("nexus_game_studio");
  });

  await page.getByTestId("main-focus-picker-button").click();

  const selectedItem = page.getByTestId("main-focus-option-game_studio");
  const neutralItem = page.getByTestId("main-focus-option-main_mode");

  const selectedBackground = await selectedItem.evaluate((node) => getComputedStyle(node).backgroundColor);
  const neutralTitleColor = await neutralItem.evaluate(
    (node) => getComputedStyle(node.querySelector("div") as Element).color,
  );
  const neutralBodyColor = await neutralItem.evaluate(
    (node) => getComputedStyle(node.querySelectorAll("div")[1] as Element).color,
  );

  expect(selectedBackground).toBe("rgba(147, 51, 234, 0.15)");
  expect(neutralTitleColor).toBe("rgb(24, 24, 27)");
  expect(neutralBodyColor).toBe("rgb(82, 82, 91)");
});

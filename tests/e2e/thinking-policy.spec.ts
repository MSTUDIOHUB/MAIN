import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.localStorage.setItem("local-agent-ide", JSON.stringify({
        state: {
          config: {
            language: "zh",
            chatFontSize: 13,
            activeProfile: "local",
            thinkingPolicy: "action_only",
            thoughtDisplayMode: "hidden",
          },
        },
        version: 0,
      }));
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("process display ignores legacy hidden policy and keeps process text hierarchy dynamic", async ({ page }) => {
  await page.goto("/?e2eScenario=process-display");

  await expect(page.getByTestId("thought-block")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-thought-summary")).toHaveCount(0);
  await expect(page.getByTestId("turn-process-archive-toggle")).toBeVisible();
  await page.getByTestId("turn-process-archive-toggle").click();

  const inspectStep = page.locator('[data-testid="turn-archive-step"][data-kind="inspect"]');
  await expect(inspectStep).toContainText("收集上下文");
  await expect(inspectStep).toContainText("核对必要上下文");
  await expect(inspectStep).toContainText("ChatArea.tsx");
  await expect(inspectStep).not.toContainText("避免原始长文本刷屏");

  const initialArchiveToggleFontSize = await page.getByTestId("turn-process-archive-toggle").evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const initialArchiveStepFontSize = await inspectStep.first().evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const initialArchiveStepLabelFontSize = await inspectStep.getByTestId("turn-archive-step-label").first().evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const initialArchiveStepIntentFontSize = await inspectStep.getByTestId("turn-archive-step-intent").first().evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const initialComposerFontSize = await page.getByTestId("composer-textarea").evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  expect(initialArchiveToggleFontSize).toBeLessThan(initialComposerFontSize);
  expect(initialArchiveStepIntentFontSize).toBeLessThan(initialComposerFontSize);
  expect(initialArchiveStepLabelFontSize).toBeLessThan(initialArchiveStepIntentFontSize);

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await expect(page.getByTestId("settings-tab-general")).toHaveClass(/theme-bg/);
  await expect(page.getByText("思考策略")).toHaveCount(0);
  await expect(page.getByTestId("thinking-policy-normal")).toHaveCount(0);
  await expect(page.getByTestId("thinking-policy-action_only")).toHaveCount(0);
  await expect(page.getByTestId("session-recording-switch")).toBeVisible();
  await expect(page.getByTestId("settings-tab-general")).not.toContainText("思考显示");

  await page.getByTestId("chat-font-size-slider").fill("18");
  await expect(page.getByText("18 px")).toBeVisible();
  await page.getByTestId("settings-close").click();
  await expect.poll(async () =>
    inspectStep.first().evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).fontSize),
    ),
  ).toBeGreaterThan(initialArchiveStepFontSize + 4);

  const archiveToggleFontSize = await page.getByTestId("turn-process-archive-toggle").evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const archiveStepFontSize = await inspectStep.first().evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const archiveStepLabelFontSize = await inspectStep.getByTestId("turn-archive-step-label").first().evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const archiveStepIntentFontSize = await inspectStep.getByTestId("turn-archive-step-intent").first().evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const composerFontSize = await page.getByTestId("composer-textarea").evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );

  expect(archiveToggleFontSize).toBeGreaterThan(initialArchiveToggleFontSize + 2);
  expect(archiveStepFontSize).toBeGreaterThan(initialArchiveStepFontSize + 2);
  expect(archiveStepLabelFontSize).toBeGreaterThan(initialArchiveStepLabelFontSize + 2);
  expect(archiveStepIntentFontSize).toBeGreaterThan(initialArchiveStepIntentFontSize + 2);
  expect(composerFontSize).toBeGreaterThan(initialComposerFontSize + 2);
  expect(archiveToggleFontSize).toBeLessThan(composerFontSize);
  expect(archiveStepFontSize).toBeLessThan(composerFontSize);
  expect(archiveStepIntentFontSize).toBeLessThan(composerFontSize);
  expect(archiveStepLabelFontSize).toBeLessThan(archiveStepIntentFontSize);
  expect(composerFontSize - archiveStepFontSize).toBeGreaterThan(0.5);
  expect(composerFontSize - archiveStepFontSize).toBeLessThan(3);

  await page.reload();
  await expect(page.getByTestId("turn-process-archive-toggle")).toBeVisible();
  await page.getByTestId("turn-process-archive-toggle").click();
  await expect(inspectStep).toContainText("核对必要上下文");
  await expect(inspectStep).toContainText("ChatArea.tsx");
  await expect(page.getByTestId("thinking-policy-action_only")).toHaveCount(0);
});

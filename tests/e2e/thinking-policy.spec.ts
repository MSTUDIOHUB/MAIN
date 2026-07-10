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
            reasoningDisplay: "debug_summary",
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
  await expect(page.getByTestId("turn-activity-notice")).toBeVisible();
  await expect(page.getByTestId("effective-progress-ledger")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-thought-summary")).toContainText("流式结束后继续保留");
  await expect(page.getByTestId("turn-process-archive-toggle")).toHaveCount(0);
  await expect(page.getByText("过程显示测试回复。")).toBeVisible();
  const readGroup = page.getByTestId("read-context-group").first();
  await expect(readGroup).toBeVisible();
  await expect(readGroup).toContainText("ChatArea.tsx");

  const initialReadGroupFontSize = await readGroup.evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const initialAgentFontSize = await page.locator(".chat-agent-content").first().evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const initialComposerFontSize = await page.getByTestId("composer-textarea").evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  expect(initialReadGroupFontSize).toBeGreaterThanOrEqual(initialComposerFontSize);
  expect(initialReadGroupFontSize - initialComposerFontSize).toBeLessThanOrEqual(1);
  expect(initialAgentFontSize).toBe(initialComposerFontSize);

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
    page.locator(".chat-agent-content").first().evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).fontSize),
    ),
  ).toBeGreaterThan(initialAgentFontSize + 4);

  const readGroupFontSize = await readGroup.evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const agentFontSize = await page.locator(".chat-agent-content").first().evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );
  const composerFontSize = await page.getByTestId("composer-textarea").evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).fontSize),
  );

  expect(Math.abs(readGroupFontSize - initialReadGroupFontSize)).toBeLessThanOrEqual(0.5);
  expect(agentFontSize).toBeGreaterThan(initialAgentFontSize + 4);
  expect(composerFontSize).toBeGreaterThan(initialComposerFontSize + 2);
  expect(agentFontSize).toBe(composerFontSize);
  expect(readGroupFontSize).toBeLessThan(composerFontSize);

  await page.reload();
  await expect(page.getByTestId("turn-process-archive-toggle")).toHaveCount(0);
  await expect(page.getByTestId("read-context-group")).toContainText("ChatArea.tsx");
  await expect(page.getByText("过程显示测试回复。")).toBeVisible();
  await expect(page.getByTestId("thinking-policy-action_only")).toHaveCount(0);
});

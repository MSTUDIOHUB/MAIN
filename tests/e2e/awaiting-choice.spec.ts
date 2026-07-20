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
  await expect(page.getByTestId("reply-option-0")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-collapse-options")).toContainText("收起选项");

  await page.getByTestId("execution-capsule-collapse-options").click();
  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-show-options")).toContainText("展开选项");

  await page.getByTestId("execution-capsule-shell").hover();
  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toHaveCount(0);

  await page.getByTestId("execution-capsule-show-options").click();
  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-badge-0")).toHaveText("1.");
  await expect(page.getByTestId("execution-capsule-reply-option-badge-1")).toHaveText("2.");
  await expect(page.getByTestId("execution-capsule-custom-reply-badge")).toHaveText("3.");

  const optionBeforeHover = await page.getByTestId("execution-capsule-reply-option-0").evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await page.getByTestId("execution-capsule-reply-option-0").hover();
  const optionAfterHover = await page.getByTestId("execution-capsule-reply-option-0").evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(optionAfterHover).not.toBe(optionBeforeHover);

  await page.getByTestId("execution-capsule-reply-option-0").click();

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

  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await page.getByTestId("execution-capsule-custom-reply-input").fill("我想先补一个轻量方案再继续");
  await page.getByTestId("execution-capsule-custom-reply-submit").click();

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

test("ordinary composer command creates a new turn instead of consuming stale reply options", async ({ page }) => {
  await page.goto("/?e2eScenario=awaiting-choice");

  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();

  const command = "首先执行P0的重构，如果有任何不确定的方向请向我提问。";
  await page.getByTestId("composer-textarea").fill(command);
  await page.getByTestId("composer-send-button").click();

  // Workspace instructions are admitted as Turns before intent routing. They
  // must never fall back to the legacy pre-Turn execution-confirmation chat.
  await expect(page.getByTestId("execution-capsule-intent-option-execute")).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedOptions ?? []),
    )
    .toEqual([]);

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().conversationTurns ?? -1),
    )
    .toBe(2);

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().visibleConversationTurns ?? []),
    )
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "e2e-awaiting-choice-turn", status: "awaiting_input" }),
      expect.objectContaining({ displayIntent: "execute" }),
    ]));

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedOptions ?? []),
    )
    .toEqual([]);

  const originalTurnCheckpoint = page.locator(
    '[data-testid="turn-choice-checkpoint"][data-turn-id="e2e-awaiting-choice-turn"]',
  );
  await expect(originalTurnCheckpoint).toBeVisible();
});

test("mixed choice options keep execution choices together and split read-only permissions", async ({ page }) => {
  await page.goto("/?e2eScenario=awaiting-choice-mixed-options");

  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-1")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-2")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-3")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-awaiting-choice")).not.toContainText("继续调整方案");
  await expect(page.getByTestId("execution-capsule-awaiting-choice")).not.toContainText("取消操作");
  await expect(page.getByTestId("execution-capsule-awaiting-choice").getByText("选择下一步", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("execution-capsule-reply-option-badge-0")).toHaveText("1.");
  await expect(page.getByTestId("execution-capsule-reply-option-badge-1")).toHaveText("2.");
  await expect(page.getByTestId("execution-capsule-reply-option-badge-2")).toHaveText("3.");
  await expect(page.getByTestId("execution-capsule-reply-option-1")).toContainText("我来确认类型，然后执行修复");
  await expect(page.getByTestId("execution-capsule-custom-reply-badge")).toHaveText("4.");
  await expect(page.getByTestId("execution-capsule-custom-reply-input")).toHaveAttribute("placeholder", "说明需要如何调整，或提出其他要求");
  await expect(page.getByTestId("execution-capsule-custom-reply-submit")).toContainText("提交意见");
  await expect(page.getByRole("button", { name: "结束本轮" })).toBeVisible();

  const approvalSection = page.getByTestId("execution-capsule-approval-actions");
  await expect(approvalSection).toBeVisible();
  await expect(approvalSection).toContainText("只读授权动作");
  await expect(page.getByTestId("execution-capsule-approval-option-0")).toContainText("继续当前只读读取");
  await expect(page.getByTestId("execution-capsule-approval-option-1")).toContainText("当前会话只读步骤全部批准");

  const approvalBeforeHover = await page.getByTestId("execution-capsule-approval-option-0").evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await page.getByTestId("execution-capsule-approval-option-0").hover();
  const approvalAfterHover = await page.getByTestId("execution-capsule-approval-option-0").evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(approvalAfterHover).not.toBe(approvalBeforeHover);
});

test("diagnostic statements are not rendered as awaiting-choice buttons", async ({ page }) => {
  await page.goto("/?e2eScenario=awaiting-choice-diagnostic-rejected");

  await expect(page.getByText("那问题可能出在 Vite 的构建过程中")).toBeVisible();
  await expect(page.getByText("App.css", { exact: true })).toBeVisible();
  await expect(page.getByText(/被自动引入了/)).toBeVisible();
  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toHaveCount(0);
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toHaveCount(0);

  expect(await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnStatus ?? null))
    .toBe("stopped_no_action");
});

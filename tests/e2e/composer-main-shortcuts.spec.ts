import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("composer keeps a two-line minimum height and grows until it scrolls", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await expect(textarea).toHaveAttribute("placeholder", /输入需求，或输入 \/ 选择计划、执行、分析、总结、报告/);

  const initialBox = await textarea.boundingBox();
  expect(initialBox?.height ?? 0).toBeGreaterThanOrEqual(56);

  await textarea.fill("第一行\n第二行\n第三行\n第四行");
  const grownBox = await textarea.boundingBox();
  expect(grownBox?.height ?? 0).toBeGreaterThan(initialBox?.height ?? 0);

  await textarea.fill(Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行内容`).join("\n"));
  const longMetrics = await textarea.evaluate((node: HTMLTextAreaElement) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
  }));
  expect(longMetrics.scrollHeight).toBeGreaterThan(longMetrics.clientHeight);
  expect(longMetrics.overflowY).toBe("auto");

  await textarea.fill("");
  const emptyAgainBox = await textarea.boundingBox();
  expect(emptyAgainBox?.height ?? 0).toBeGreaterThanOrEqual(initialBox?.height ?? 0);
});

test("MAIN shortcut menu works from a leading slash before existing content", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("先处理这个需求");
  await textarea.evaluate((node: HTMLTextAreaElement) => {
    node.focus();
    node.selectionStart = 0;
    node.selectionEnd = 0;
  });
  await page.keyboard.type("/ ");

  await expect(page.getByText("MAIN 快捷入口").first()).toBeVisible();
  await expect(page.getByTestId("main-shortcut-item-plan")).toBeVisible();
  await expect(page.getByTestId("main-shortcut-item-execute")).toBeVisible();
});

test("MAIN shortcut order, keyboard selection, and labels stay aligned", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/");

  const shortcutIds = await page
    .locator("[data-testid^='main-shortcut-item-']")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  expect(shortcutIds).toEqual([
    "main-shortcut-item-plan",
    "main-shortcut-item-execute",
    "main-shortcut-item-report",
    "main-shortcut-item-analyze",
    "main-shortcut-item-summarize",
  ]);

  await expect(page.getByTestId("main-shortcut-item-execute")).toContainText("/执行");
  await expect(page.getByTestId("main-shortcut-item-execute")).not.toContainText("/执行 · 执行");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe("execute");
  await expect(textarea).toHaveValue("");
});

test("MDEBUG stays hidden from shortcut menu but submits as a plan turn", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/M");

  await expect(page.getByText("MAIN 快捷入口").first()).toBeVisible();
  await expect(page.getByText("/MDEBUG")).toHaveCount(0);

  await textarea.fill("/MDEBUG\n# MAIN 用户反馈修复请求\n\n## 问题描述与复现步骤\n点击 Terminal 后没有显示输出。");
  await expect(page.getByText("MAIN 快捷入口")).toHaveCount(0);
  await page.getByTestId("composer-send-button").click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent),
    )
    .toBe(null);
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnIntent ?? null),
    )
    .toBe("plan");

  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  expect(snapshot?.currentTurnTitle).toBe("MDEBUG：用户反馈自修复");
  expect(snapshot?.currentTurnPrompt).toContain("[MDEBUG: USER FEEDBACK SELF-REPAIR]");
  expect(snapshot?.currentTurnPrompt).toContain(".MAIN/plans/bugfix.md");
});

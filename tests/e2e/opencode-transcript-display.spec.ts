import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("realistic plan prompt renders as narrative plus a folded process archive", async ({ page }) => {
  await page.goto("/?e2eScenario=opencode-transcript-display");

  const prompt = "请进入 Plan 模式，检查这个 React/Tauri 项目的聊天工具显示结构，先理解项目结构再提出重构计划。";
  await page.evaluate((text) => {
    return (window as any).__CODELY_E2E__?.sendOpencodeTranscriptTestContent?.(text);
  }, prompt);

  await expect(page.getByText(prompt)).toBeVisible();
  await expect(page.getByText("我会先整体理解项目结构，然后读取 ChatArea、工具分组和 Plan runtime 的关键链路。")).toHaveCount(0);
  await expect(page.getByText("让我继续读取关键文件来确认渲染结构。")).toHaveCount(0);
  await expect(page.getByText("从已读取的文件中，我发现显示层需要先生成 operation cluster")).toBeVisible();

  await expect(page.getByTestId("turn-state-anchor")).toContainText("计划");
  const archiveToggle = page.getByTestId("turn-process-archive-toggle");
  await expect(archiveToggle).toHaveAttribute("aria-expanded", "false");
  await expect(archiveToggle).toContainText("2 步");
  await expect(archiveToggle).toContainText("ChatArea.tsx");
  await archiveToggle.click();

  const steps = page.getByTestId("turn-archive-step");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText("项目骨架");
  await steps.nth(0).getByTestId("turn-archive-step-toggle").click();

  const readGroup = steps.nth(0).getByTestId("read-context-group");
  await expect(readGroup).toContainText("已读取 4 项上下文");
  await expect(readGroup).toContainText("toolUiGrouping.ts");
  await expect(readGroup).toContainText("+1");
  await readGroup.click();
  const details = steps.nth(0).getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(steps.nth(0).getByTestId("read-context-item")).toHaveCount(4);
  await expect(details).toContainText("src/components/ChatArea.tsx");
  await expect(details).toContainText("src/lib/planRuntime.ts");
});

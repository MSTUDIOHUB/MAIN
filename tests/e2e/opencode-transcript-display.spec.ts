import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("realistic plan prompt renders as opencode-style narrative plus operation clusters", async ({ page }) => {
  await page.goto("/?e2eScenario=opencode-transcript-display");

  const prompt = "请进入 Plan 模式，检查这个 React/Tauri 项目的聊天工具显示结构，先理解项目结构再提出重构计划。";
  await page.evaluate((text) => {
    return (window as any).__CODELY_E2E__?.sendOpencodeTranscriptTestContent?.(text);
  }, prompt);

  await expect(page.getByText(prompt)).toBeVisible();
  await expect(page.getByText("我会先整体理解项目结构，然后读取 ChatArea、工具分组和 Plan runtime 的关键链路。")).toBeVisible();
  await expect(page.getByText("让我继续读取关键文件来确认渲染结构。")).toHaveCount(0);
  await expect(page.getByText("从已读取的文件中，我发现显示层需要先生成 operation cluster")).toBeVisible();

  const clusters = page.getByTestId("chat-operation-cluster");
  await expect(clusters).toHaveCount(2);
  await expect(clusters.nth(0)).toContainText(/Explore.*探索项目结构/);
  await expect(clusters.nth(0)).toContainText("项目骨架");
  await expect(clusters.nth(1)).toContainText("已读取 3 项上下文");
  await expect(clusters.nth(1)).toContainText("ChatArea.tsx");
  await expect(clusters.nth(1)).toContainText("toolUiGrouping.ts");
  await expect(clusters.nth(1)).toContainText("planRuntime.ts");

  await clusters.nth(1).getByTestId("read-context-group").click();
  const details = clusters.nth(1).getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(clusters.nth(1).getByTestId("read-context-item")).toHaveCount(3);
  await expect(details).toContainText("src/components/ChatArea.tsx");
});

import { expect, test } from "@playwright/test";

test.describe("subagent activity and right panel", () => {
  test("opens the selected subagent from ChatArea and shows execution details", async ({ page }) => {
    await page.goto("/?e2eScenario=subagents-panel");

    const notice = page.getByTestId("subagent-activity-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("已创建 2 个智能体");
    await expect(notice).toContainText("已关闭 1 个智能体");
    await expect(notice).toContainText("Mendel");
    await expect(notice).toContainText("ChatArea.tsx");

    await page.getByTestId("subagent-activity-subagent-mendel").click();
    const panel = page.getByTestId("subagents-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("本地单通道");
    await expect(panel).toContainText("qwen3.6-35b-a3b");
    await expect(page.getByTestId("subagent-detail")).toContainText("Mendel");
    await expect(page.getByTestId("subagent-detail")).toContainText("src/components/ChatArea.tsx");
    await expect(page.getByTestId("stop-subagent-button")).toBeVisible();

    await page.getByTestId("subagent-list-item-subagent-euler").click();
    await expect(page.getByTestId("subagent-detail")).toContainText("Euler");
    await expect(page.getByTestId("subagent-detail")).toContainText("事件投影保持完成状态");
    await expect(page.getByTestId("stop-subagent-button")).toHaveCount(0);
  });

  for (const theme of ["light", "dark", "black"] as const) {
    test(`keeps the activity and panel readable in ${theme} theme`, async ({ page }, testInfo) => {
      await page.goto(`/?e2eScenario=subagents-panel&theme=${theme}`);
      await page.getByTestId("subagent-activity-subagent-mendel").click();

      const notice = page.getByTestId("subagent-activity-notice");
      const panel = page.getByTestId("subagents-panel");
      await expect(notice).toBeVisible();
      await expect(panel).toBeVisible();
      await expect(page.getByTestId("subagent-detail")).toContainText("Mendel");

      const panelBox = await panel.boundingBox();
      const noticeBox = await notice.boundingBox();
      expect(panelBox).not.toBeNull();
      expect(noticeBox).not.toBeNull();
      expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1440);
      expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(panelBox!.x);

      await page.screenshot({ path: testInfo.outputPath(`subagents-${theme}.png`), fullPage: true });
    });
  }
});

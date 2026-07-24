import { expect, test } from "@playwright/test";

test.describe("subagent activity and right panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.clear();
    });
  });

  test("opens selected subagents and keeps degraded evidence readable", async ({ page }) => {
    await page.goto("/?e2eScenario=subagents-panel");

    const notice = page.getByTestId("subagent-activity-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("已创建 3 个智能体");
    await expect(notice).toContainText("已关闭 2 个智能体");
    await expect(notice).toContainText("Mendel");
    await expect(notice).toContainText("ChatArea.tsx");

    await page.getByTestId("subagent-activity-subagent-mendel").click();
    const panel = page.getByTestId("subagents-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("本地主体 + 最多 2 个子流");
    await expect(panel).toContainText("qwen3.6-35b-a3b");
    await expect(page.getByTestId("subagent-section-active")).toContainText("活跃 1");
    await expect(page.getByTestId("subagent-section-done")).toContainText("已完成 2");
    await expect(page.getByTestId("subagent-list-item-subagent-mendel"))
      .toHaveAttribute("data-subagent-section", "active");
    await expect(page.getByTestId("subagent-list-item-subagent-euler"))
      .toHaveAttribute("data-subagent-section", "done");
    await expect(page.getByTestId("subagent-detail")).toContainText("Mendel");
    await expect(page.getByTestId("subagent-detail")).toContainText("src/components/ChatArea.tsx");
    await expect(page.getByTestId("stop-subagent-button")).toBeVisible();

    await page.getByTestId("subagent-list-item-subagent-euler").click();
    await expect(page.getByTestId("subagent-detail")).toContainText("Euler");
    await expect(page.getByTestId("subagent-detail")).toContainText("事件投影保持完成状态");
    await expect(page.getByTestId("stop-subagent-button")).toHaveCount(0);

    await page.getByTestId("subagent-list-item-subagent-herschel").click();
    await expect(page.getByTestId("subagent-detail")).toContainText("已降级由主体接管");
    await expect(page.getByTestId("subagent-detail")).toContainText("已定位共享模型通道与内存采样入口");
    await expect(page.getByTestId("subagent-detail")).toContainText("接管原因");
    await expect(page.getByTestId("subagent-detail")).toContainText("可用内存低于预留线");
  });

  for (const theme of ["light", "dark", "black"] as const) {
    test(`keeps the activity and panel readable in ${theme} theme`, async ({ page }, testInfo) => {
      await page.goto(`/?e2eScenario=subagents-panel&theme=${theme}`);
      await page.getByTestId("subagent-activity-subagent-mendel").click();

      const notice = page.getByTestId("subagent-activity-notice");
      const panel = page.getByTestId("subagents-panel");
      await expect(notice).toBeVisible();
      await expect(panel).toBeVisible();
      await expect(page.getByTestId("subagent-section-active")).toBeVisible();
      await expect(page.getByTestId("subagent-section-done")).toBeVisible();
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

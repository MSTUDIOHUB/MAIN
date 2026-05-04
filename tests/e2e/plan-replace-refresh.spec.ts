import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("plan panel refreshes when tasks.md is updated through replace_in_file", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-replace-refresh");

  await expect(page.getByTestId("plan-stage-badge")).toContainText("执行中");
  await expect(page.getByText("任务 1/3")).toBeVisible();
  await expect(page.getByText("保存方案供用户留档（已完成）")).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate(() =>
        ((window as any).__CODELY_E2E__?.getSnapshot?.().planTasks ?? []).map(
          (task: { status: string }) => task.status,
        ),
      ),
    )
    .toEqual(["completed", "in_progress", "pending"]);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.replacePlanTasks?.());

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const event = (window as any).__CODELY_E2E__?.events?.find(
          (item: { type: string }) => item.type === "tasks-replaced",
        );
        if (!event) return null;
        return {
          statuses: event.statuses,
          artifactIncludesCompletedLine: String(event.artifactContent || "").includes("[x] 保存方案供用户留档（已完成）"),
        };
      }),
    )
    .toEqual({
      statuses: ["completed", "completed", "in_progress"],
      artifactIncludesCompletedLine: true,
    });

  await expect(page.getByText("任务 2/3")).toBeVisible();
  await expect(page.getByText("保存方案供用户留档（已完成）").first()).toBeVisible();
});

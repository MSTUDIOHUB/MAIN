import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("plan flow supports save then approve and finish", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-flow");

  await expect(page.getByTestId("plan-stage-badge")).toContainText("待审批");
  await expect(page.getByTestId("plan-save-button")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().planTasks?.length ?? -1),
    )
    .toBe(0);

  await page.getByTestId("plan-save-button").click();
  await expect(page.getByTestId("plan-save-button")).toHaveAttribute("data-save-state", "saved");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.savedDocuments?.length ?? 0),
    )
    .toBe(1);

  await expect(page.getByTestId("top-island-plan-approve")).toBeVisible();
  await page.getByTestId("top-island-plan-approve").click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const event = (window as any).__CODELY_E2E__?.events?.find(
          (item: { type: string }) => item.type === "tasks-rewritten",
        );
        if (!event) return null;
        return {
          stage: event.stage,
          statuses: event.statuses,
        };
      }),
    )
    .toEqual({
      stage: "executing",
      statuses: ["completed", "in_progress", "pending"],
    });

  await expect(page.getByTestId("plan-stage-badge")).toContainText("已完成");
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Boolean(
          (window as any).__CODELY_E2E__?.getSnapshot?.().planTasks?.every(
            (task: { status: string }) => task.status === "completed",
          ),
        ),
      ),
    )
    .toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.completed)),
    )
    .toBe(true);
});

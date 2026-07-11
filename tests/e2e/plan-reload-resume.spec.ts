import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("plan runtime survives reload and can resume execution", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-reload-resume");

  await expect(page.getByTestId("plan-stage-badge")).toContainText("已暂停");
  await expect(page.getByTestId("plan-resume-button")).toBeVisible();
  await expect(page.getByText("这个方案已经批准了，请继续把剩余任务做完。")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().seedCount ?? 0),
    )
    .toBe(1);

  await expect
    .poll(async () =>
      page.evaluate(() =>
        ((window as any).__CODELY_E2E__?.getSnapshot?.().planTasks ?? []).map(
          (task: { status: string }) => task.status,
        ),
      ),
    )
    .toEqual(["completed", "in_progress", "pending"]);

  await page.reload();

  await expect(page.getByTestId("plan-stage-badge")).toContainText("已暂停");
  await expect(page.getByTestId("plan-resume-button")).toBeVisible();
  await expect(page.getByText("这个方案已经批准了，请继续把剩余任务做完。")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().seedCount ?? 0),
    )
    .toBe(1);

  await expect
    .poll(async () =>
      page.evaluate(() =>
        ((window as any).__CODELY_E2E__?.getSnapshot?.().planTasks ?? []).map(
          (task: { status: string }) => task.status,
        ),
      ),
    )
    .toEqual(["completed", "in_progress", "pending"]);

  await page.getByTestId("plan-resume-button").click();

  await expect
    .poll(async () =>
      page.evaluate(() => Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().completed)),
    )
    .toBe(true);

  await expect(page.getByTestId("plan-stage-badge")).toContainText("已完成");
});

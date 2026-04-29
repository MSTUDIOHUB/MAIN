import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("stream error clears the lingering thinking notice", async ({ page }) => {
  await page.goto("/?e2eScenario=stream-error-recovery");

  const activityNotice = page.getByTestId("turn-activity-notice");
  await expect(activityNotice).toBeVisible();

  const errorCard = page.getByRole("button", { name: "系统请求失败" });
  await expect(errorCard).toBeVisible();
  await errorCard.click();
  await expect(page.getByText("模型服务在传输回复时中断或返回了无法解析的数据。")).toBeVisible();
  await expect(activityNotice).toHaveCount(0);
});

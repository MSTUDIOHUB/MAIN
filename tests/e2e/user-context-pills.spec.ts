import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("@ files, attachments, and screenshots render as compact user context pills", async ({ page }) => {
  await page.goto("/?e2eScenario=user-context-pills");

  const pillRow = page.getByTestId("user-context-pill-row");
  await expect(pillRow).toBeVisible();
  await expect(page.getByTestId("user-context-inline-summary")).toHaveCount(0);

  const pills = page.getByTestId("user-context-pill");
  await expect(pills).toHaveCount(4);
  await expect(pills.nth(0)).toContainText("src/App.tsx");
  await expect(pills.nth(0)).not.toContainText("@ src/App.tsx");
  await expect(pills.nth(1)).toContainText("report.csv");
  await expect(pills.nth(1)).toContainText("失败");
  await expect(pills.nth(2)).toContainText("截图 1");
  await expect(pills.nth(3)).toContainText("截图 2");

  await expect(page.locator("img.max-h-48")).toHaveCount(0);
  await expect(page.locator('img[alt^="user-image"]')).toHaveCount(0);
  const thumbnail = page.getByTestId("user-context-image-thumbnail");
  await expect(thumbnail).toHaveCount(1);
  await expect(thumbnail).toHaveAttribute(
    "src",
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  );
  const thumbnailBox = await thumbnail.boundingBox();
  expect(thumbnailBox).not.toBeNull();
  expect(thumbnailBox!.width).toBeLessThanOrEqual(40);
  expect(thumbnailBox!.height).toBeLessThanOrEqual(32);
  const deliveryStatus = page.getByTestId("visual-context-delivery-status");
  await expect(deliveryStatus).toHaveCount(1);
  await expect(deliveryStatus).toHaveAttribute("data-status", "delivered");
  await expect(deliveryStatus).toHaveAttribute("data-recognition", "observed");
  await expect(deliveryStatus).toContainText("模型已报告截图观察");
  await expect(deliveryStatus).toContainText("截图中可见文件、附件和两张截图上下文胶囊");

  await pills.nth(2).click();
  await expect(page.getByTestId("user-image-preview-modal")).toBeVisible();
  const fullPreview = page.getByTestId("user-image-preview");
  await expect(fullPreview).toBeVisible();
  await expect(fullPreview).toHaveAttribute(
    "src",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  );

  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  expect(snapshot.userContextItems.map((item: { kind: string }) => item.kind)).toEqual([
    "mention",
    "attachment",
    "image",
    "image",
  ]);
  expect(snapshot.userBlockImagesCount).toBe(1);
  expect(snapshot.agentMessageSummaries[0].hasImage).toBe(true);
  expect(snapshot.agentMessageSummaries[0].text).toContain("[attached_file]");
});

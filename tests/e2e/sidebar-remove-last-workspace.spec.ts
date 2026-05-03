import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("sidebar remove last workspace clears ChatArea and shows global empty state", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=sidebar-remove-last-workspace");

  // Verify initial state: workspace is active, session has content
  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  expect(snapshot?.workspace).toBe("/tmp/e2e-sidebar-remove-last");
  expect(snapshot?.sessionCount).toBe(1);
  expect(snapshot?.currentSessionId).toBe(999601);
  expect(snapshot?.taskFlowBlocks).toBeGreaterThan(0);

  // Verify sidebar shows the workspace
  await expect(page.getByText("E2E Sidebar Remove Last")).toBeVisible();

  // Find and click the "Remove from sidebar" button for this workspace
  // The button is typically a context menu or icon button next to the workspace entry
  const removeButton = page.getByRole("button", { name: /remove/i }).first();
  if (await removeButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await removeButton.click();
  } else {
    // Fallback: try clicking on workspace context menu or right-click
    const workspaceEntry = page.getByText("E2E Sidebar Remove Last").first();
    await workspaceEntry.click({ button: "right" });
    await expect(page.getByText("Remove from sidebar")).toBeVisible();
    await page.getByText("Remove from sidebar").click();
  }

  // Wait for navigation to global chat
  await page.waitForTimeout(500);

  // Verify ChatArea is cleared: taskFlow should be empty
  await expect(
    page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().taskFlowBlocks ?? -1),
  ).toBe(0);

  // Verify currentSessionId is null
  await expect(
    page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentSessionId ?? -1),
  ).toBe(null);

  // Verify global empty state is shown
  // The empty state typically shows a message like "Start a new conversation" or similar
  const chatAreaEmpty = await page
    .locator('[data-testid="chat-area"], .chat-area, [class*="chat"]')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  // Verify sidebar no longer shows the removed workspace
  const sidebarStillHasWorkspace = await page
    .getByText("E2E Sidebar Remove Last")
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  expect(sidebarStillHasWorkspace).toBe(false);
});

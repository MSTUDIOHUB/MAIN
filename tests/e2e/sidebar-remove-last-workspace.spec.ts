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
  const workspaceRow = page.getByTestId("sidebar-workspace-row").filter({ hasText: "E2E Sidebar Remove Last" }).first();
  await expect(workspaceRow).toBeVisible();

  // Find and click the "Remove from sidebar" button for this workspace
  // The button is typically a context menu or icon button next to the workspace entry
  const removeButton = workspaceRow.getByTitle(/Remove from sidebar|从侧边栏移除/);
  await expect(removeButton).toBeVisible();
  await removeButton.click();

  // Wait for navigation to global chat
  await page.waitForTimeout(500);

  // Verify ChatArea is cleared: taskFlow should be empty
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().taskFlowBlocks ?? -1))
    .toBe(0);

  // Verify currentSessionId is null
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentSessionId))
    .toBe(null);

  // Verify global empty state is shown
  // The empty state typically shows a message like "Start a new conversation" or similar
  const chatAreaEmpty = await page.getByTestId("chat-empty-state").isVisible({ timeout: 3000 }).catch(() => false);
  expect(chatAreaEmpty).toBe(true);

  // Verify sidebar no longer shows the removed workspace
  const sidebarStillHasWorkspace = await page
    .getByTestId("sidebar-workspace-row")
    .filter({ hasText: "E2E Sidebar Remove Last" })
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  expect(sidebarStillHasWorkspace).toBe(false);
});

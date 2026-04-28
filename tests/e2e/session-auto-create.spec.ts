import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("first real send creates and activates a project session", async ({ page }) => {
  await page.goto("/?e2eScenario=session-auto-create");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().sessionCount ?? -1),
    )
    .toBe(0);

  const sent = await page.evaluate(() => (window as any).__CODELY_E2E__?.sendFirstMessage?.());
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          sessionCount: snapshot?.sessionCount,
          currentSessionActive: snapshot?.currentSessionActive,
          activeCount: snapshot?.activeSessionIds?.length,
          conversationTurns: snapshot?.conversationTurns,
          taskFlowUserCount: snapshot?.taskFlowUserCount,
          currentTurnStatus: snapshot?.currentTurnStatus,
        };
      }),
    )
    .toEqual({
      sessionCount: 1,
      currentSessionActive: true,
      activeCount: 1,
      conversationTurns: 1,
      taskFlowUserCount: 1,
      currentTurnStatus: "done",
    });

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          runtimeTurns: snapshot?.currentSessionRuntimeTurns,
          runtimeBlocks: snapshot?.currentSessionRuntimeBlocks,
          messages: snapshot?.currentSessionMessages,
        };
      }),
    )
    .toEqual({
      runtimeTurns: 1,
      runtimeBlocks: 2,
      messages: 2,
    });
});

test("missing currentSessionId creates a new session instead of reusing an old one", async ({ page }) => {
  await page.goto("/?e2eScenario=session-auto-create");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.prepareStaleCurrentSession?.());
  const staleSessionId = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.getSnapshot?.().staleSessionId,
  );

  const sent = await page.evaluate(() => (window as any).__CODELY_E2E__?.sendFirstMessage?.());
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate((oldId) => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          sessionCount: snapshot?.sessionCount,
          createdNewSession: Boolean(snapshot?.currentSessionId && snapshot.currentSessionId !== oldId),
          activeCount: snapshot?.activeSessionIds?.length,
          currentSessionActive: snapshot?.currentSessionActive,
          staleSessionMessages: snapshot?.staleSessionMessages,
          conversationTurns: snapshot?.conversationTurns,
        };
      }, staleSessionId),
    )
    .toEqual({
      sessionCount: 2,
      createdNewSession: true,
      activeCount: 1,
      currentSessionActive: true,
      staleSessionMessages: 0,
      conversationTurns: 1,
    });
});

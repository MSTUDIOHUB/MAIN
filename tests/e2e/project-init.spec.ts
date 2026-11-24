import { expect, test, type Page } from "@playwright/test";

/** Admission uses the production Composer/Store path. The existing scenario
 * holds the dispatcher in FIFO, so no provider or tool execution is mocked as
 * successful. Editable review/save/owner/theme behavior lives in
 * structured-plan-workflows.spec.ts; CAS safety lives in project-init Node/IPC
 * and Rust tests rather than the retired deterministic directory refresh UI. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const fixture = ((window as any).__WORKSPACE_ADMISSION_E2E__ = {
      savedSessions: [] as unknown[],
      nativeCalls: [] as string[],
      holdNextSave: false,
      releaseSave: null as (() => void) | null,
    });
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.metadata = { currentWindow: { label: "main" }, currentWebview: { label: "main" } };
    internals.invoke = async (command: string, args?: Record<string, unknown>) => {
      fixture.nativeCalls.push(command);
      if (["start_chat_stream", "stream_chat", "proxy_request"].includes(command)) throw new Error("No model transport is allowed in this admission fixture");
      if (command === "plugin:event|listen") return 1;
      if (command === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (command === "save_project_session") {
        fixture.savedSessions.push(args?.session ?? null);
        if (fixture.holdNextSave) {
          fixture.holdNextSave = false;
          await new Promise<void>(resolve => { fixture.releaseSave = resolve; });
        }
        return args?.session ?? null;
      }
      if (["list_project_sessions", "list_all_session_snapshots", "list_legacy_session_files"].includes(command)) return [];
      if (command === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
      if (command === "finalize_legacy_session_import") return 0;
      return null;
    };
  });
});

async function snapshot(page: Page) {
  return page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
}

async function queuedRulesInstruction(page: Page, prompt: string) {
  return page.evaluate(text => {
    const saved = (window as any).__WORKSPACE_ADMISSION_E2E__.savedSessions;
    const entry = [...saved].reverse().flatMap(session => session?.runtimeSnapshot?.workspaceTurnQueue?.entries || [])
      .find(candidate => candidate.instruction?.payload?.text === text);
    return entry ? {
      text: entry.instruction.payload.text,
      explicitIntent: entry.instruction.payload.dispatchHints.explicitIntent,
      purpose: entry.instruction.payload.dispatchHints.planPurpose,
      receiptId: entry.receipt.receiptId,
      turnId: entry.receipt.turnId,
    } : null;
  }, prompt);
}

async function expectNoImmediateInitWrite(page: Page) {
  await expect(page.getByTestId("project-init-review-dialog")).toHaveCount(0);
  expect(await snapshot(page)).toMatchObject({ workspaceContentVersion: 0, instructionSourcePaths: [] });
  const calls = await page.evaluate(() => (window as any).__WORKSPACE_ADMISSION_E2E__.nativeCalls);
  expect(calls.filter((command: string) => ["inspect_project_init_target", "commit_project_init", "save_plan_document", "start_chat_stream", "stream_chat", "proxy_request"].includes(command))).toEqual([]);
}

test("idle Enter admits one workspace Turn without showing it as backlog", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");
  const textarea = page.getByTestId("composer-textarea");
  const prompt = "为当前项目拟定一个实现方案";
  await textarea.fill(prompt);
  await page.evaluate(() => { (window as any).__WORKSPACE_ADMISSION_E2E__.holdNextSave = true; });
  await textarea.press("Enter");
  await expect.poll(() => page.evaluate(() =>
    typeof (window as any).__WORKSPACE_ADMISSION_E2E__.releaseSave,
  )).toBe("function");

  try {
    await expect(page.getByTestId("user-message-content")).toHaveText([prompt]);
    expect(await snapshot(page)).toMatchObject({ agentStatus: "idle", conversationTurnCount: 1, workspaceInstructionLedgerCount: 1, workspaceTurnQueueCount: 1 });
    await expect(page.getByTestId("composer-queued-message")).toHaveCount(0);
  } finally {
    await page.evaluate(() => (window as any).__WORKSPACE_ADMISSION_E2E__.releaseSave());
  }

  await expect(textarea).toHaveValue("");
  await expect.poll(async () => (await snapshot(page)).providerDispatchAttemptCount).toBeGreaterThan(0);
  expect(await snapshot(page)).toMatchObject({ conversationTurnCount: 1, workspaceInstructionLedgerCount: 1, workspaceTurnQueueCount: 1 });
  await expect(page.getByTestId("composer-queued-message")).toHaveCount(0);
});

test("only Plan and Rules are public shortcuts; Rules is disabled outside a project", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");
  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/");
  expect(await page.locator("[data-testid^='main-shortcut-item-']").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-testid")))).toEqual(["main-shortcut-item-plan", "main-shortcut-item-rules"]);
  const rules = page.getByTestId("main-shortcut-item-rules");
  await expect(rules).toBeEnabled();
  await expect(rules).toContainText("/规则");
  await expect(rules).toContainText("调查项目、确认约束，审阅并保存 AGENTS.md。");
  await expect(page.getByTestId("main-shortcut-item-init")).toHaveCount(0);
  await page.evaluate(() => (window as any).__CODELY_E2E__.switchComposerSubmissionWorkspace(""));
  await expect.poll(async () => (await snapshot(page)).currentWorkspace).toBe("");
  await expect(rules).toBeDisabled();
  await expect(rules).toHaveAttribute("aria-disabled", "true");
  await expect(rules).toContainText("请先打开项目");
  await expect(page.getByTestId("main-shortcut-item-plan")).toBeEnabled();
  await textarea.fill("/init");
  await textarea.press("Enter");
  await expect(page.getByText("请先打开项目，再编写 AGENTS.md 规则。", { exact: true })).toBeVisible();
  await expect(textarea).toHaveValue("/init");
  expect(await snapshot(page)).toMatchObject({ conversationTurnCount: 0, workspaceInstructionLedgerCount: 0, workspaceTurnQueueCount: 0, providerDispatchAttemptCount: 0 });
  const direct = await page.evaluate(async () => ({ admission: await (window as any).__CODELY_E2E__.admitProjectInitDirect(), started: (window as any).__CODELY_E2E__.sendProjectInitDirect() }));
  expect(direct).toEqual({ admission: { accepted: false, reason: "workspace_required", retryable: false }, started: false });
  await expectNoImmediateInitWrite(page);
});

for (const prompt of ["/init 保留人工约束，调查后再提出项目规则", "/init --refresh 保留人工规则并先确认修改范围"]) {
  test(`hidden alias queues the Rules PlanPurpose without immediate refresh: ${prompt.split(" ").slice(0, 2).join(" ")}`, async ({ page }) => {
    await page.goto("/?e2eScenario=composer-main-shortcuts");
    const textarea = page.getByTestId("composer-textarea");
    await textarea.fill("/init");
    await expect(page.getByTestId("main-shortcut-item-init")).toHaveCount(0);
    await textarea.fill(prompt);
    await textarea.press("Enter");
    await expect.poll(async () => (await snapshot(page)).workspaceTurnQueueCount).toBe(1);
    const admitted = await queuedRulesInstruction(page, prompt);
    expect(admitted).toMatchObject({ text: prompt, explicitIntent: "plan", purpose: "rules", receiptId: expect.any(String), turnId: expect.any(String) });
    expect(await snapshot(page)).toMatchObject({ currentTurnIntent: "plan", currentTurnPrompt: prompt, conversationTurnCount: 1, workspaceInstructionLedgerCount: 1, workspaceTurnQueueCount: 1 });
    await expect.poll(async () => (await snapshot(page)).providerDispatchAttemptCount).toBeGreaterThan(0);
    await expect(textarea).toHaveValue("");
    await expectNoImmediateInitWrite(page);
  });
}

test("direct Store admission treats init as queued Rules intent rather than a privileged local write", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");
  const admission = await page.evaluate(() => (window as any).__CODELY_E2E__.admitProjectInitDirect());
  expect(admission).toMatchObject({ accepted: true });
  const admitted = await queuedRulesInstruction(page, "/init");
  expect(admitted).toMatchObject({ text: "/init", explicitIntent: "plan", purpose: "rules", receiptId: expect.any(String), turnId: expect.any(String) });
  expect(await snapshot(page)).toMatchObject({ currentTurnIntent: "plan", conversationTurnCount: 1, workspaceInstructionLedgerCount: 1, workspaceTurnQueueCount: 1 });
  await expectNoImmediateInitWrite(page);
});

import { expect, test, type Page } from "@playwright/test";

const WORKSPACE = "/tmp/e2e-composer-main-shortcuts";
const TARGET_PATH = `${WORKSPACE}/AGENTS.md`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }

    const workspace = "/tmp/e2e-composer-main-shortcuts";
    const targetPath = `${workspace}/AGENTS.md`;
    const harness = ((window as any).__PROJECT_INIT_E2E__ = {
      content: null as string | null,
      contentVersion: null as string | null,
      inspectCalls: [] as Array<Record<string, unknown>>,
      commitCalls: [] as Array<Record<string, unknown>>,
      savedSessions: [] as unknown[],
      staleCommit: false,
    });

    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") {
        return {
          total_gb: 32,
          available_gb: 24,
          total_bytes: 32 * 1024 ** 3,
          available_bytes: 24 * 1024 ** 3,
        };
      }
      if (cmd === "save_project_session") {
        harness.savedSessions.push(args?.session ?? null);
        return args?.session ?? null;
      }
      if (cmd === "list_project_sessions") return [];
      if (cmd === "canonicalize_workspace_path") return String(args?.path ?? workspace);
      if (cmd === "get_git_status") {
        return {
          isRepo: false,
          repoRoot: null,
          branch: null,
          changes: [],
          staged: [],
          unstaged: [],
          untracked: [],
        };
      }
      if (cmd === "list_directory" || cmd === "glob_search") return [];
      if (cmd === "read_file") {
        const path = String(args?.path ?? "");
        if ((path === "AGENTS.md" || path === targetPath) && harness.content !== null) {
          return harness.content;
        }
        throw new Error(`ENOENT: ${path}`);
      }
      if (cmd === "inspect_project_init_target") {
        harness.inspectCalls.push({ ...(args || {}) });
        return {
          canonicalWorkspace: workspace,
          targetPath,
          exists: harness.content !== null,
          content: harness.content ?? "",
          contentVersion: harness.contentVersion,
        };
      }
      if (cmd === "commit_project_init") {
        harness.commitCalls.push({ ...(args || {}) });
        if (harness.staleCommit) {
          harness.staleCommit = false;
          throw new Error("PROJECT_INIT_CONTENT_STALE: AGENTS.md changed after review");
        }
        const created = harness.content === null;
        const nextContent = String(args?.content ?? "");
        const unchanged = harness.content === nextContent;
        harness.content = nextContent;
        harness.contentVersion = `sha256-e2e-${harness.commitCalls.length}`;
        return {
          canonicalWorkspace: workspace,
          targetPath,
          created,
          unchanged,
          contentVersion: harness.contentVersion,
        };
      }
      return null;
    };
  });
});

async function openReadyPreview(page: Page, command = "/init") {
  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill(command);
  await textarea.press("Enter");
  await expect(page.getByTestId("project-init-review-dialog")).toBeVisible();
  await expect(page.getByTestId("project-init-review-confirm")).toBeVisible();
  await expect(page.getByTestId("project-init-review-confirm")).toBeEnabled();
}

async function readInitCalls(page: Page) {
  return page.evaluate(() => {
    const harness = (window as any).__PROJECT_INIT_E2E__;
    return {
      inspectCalls: harness?.inspectCalls || [],
      commitCalls: harness?.commitCalls || [],
    };
  });
}

async function readRuntimeSnapshot(page: Page) {
  return page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.() ?? null);
}

test("/init is the last workspace shortcut and remains visibly disabled without a workspace", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/");
  const shortcutIds = await page
    .locator("[data-testid^='main-shortcut-item-']")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  expect(shortcutIds.at(-1)).toBe("main-shortcut-item-init");
  await expect(page.getByText("工作区命令", { exact: true })).toBeVisible();
  await expect(page.getByTestId("main-shortcut-item-init")).toBeEnabled();

  await page.evaluate(() => (window as any).__CODELY_E2E__?.switchComposerSubmissionWorkspace?.(""));
  await expect.poll(async () => (await readRuntimeSnapshot(page))?.currentWorkspace).toBe("");
  await expect(page.getByTestId("main-shortcut-item-init")).toBeVisible();
  await expect(page.getByTestId("main-shortcut-item-init")).toBeDisabled();
  await expect(page.getByTestId("main-shortcut-item-init")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("main-shortcut-item-init")).toContainText("请先打开工作区");
});

test("direct Store admission cannot turn the reserved local command into a provider Turn", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const result = await page.evaluate(async () => ({
    admission: await (window as any).__CODELY_E2E__?.admitProjectInitDirect?.(),
    sendStarted: (window as any).__CODELY_E2E__?.sendProjectInitDirect?.(),
  }));
  expect(result).toEqual({
    admission: {
      accepted: false,
      reason: "local_command_requires_composer",
      retryable: false,
    },
    sendStarted: false,
  });
  expect(await readRuntimeSnapshot(page)).toMatchObject({
    conversationTurnCount: 0,
    workspaceInstructionLedgerCount: 0,
    workspaceTurnQueueCount: 0,
    providerDispatchAttemptCount: 0,
  });
});

test("preview, Cancel, and Escape never create a Turn or commit a file", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  await openReadyPreview(page);
  await expect(page.getByTestId("project-init-review-cancel")).toBeFocused();
  await expect(page.getByTestId("project-init-review-workspace")).toHaveText(WORKSPACE);
  await expect(page.getByTestId("project-init-review-target")).toHaveText(TARGET_PATH);
  await expect(page.getByTestId("project-init-review-diff")).toContainText("+++ ");

  expect(await readInitCalls(page)).toMatchObject({ inspectCalls: [{}], commitCalls: [] });
  expect(await readRuntimeSnapshot(page)).toMatchObject({
    currentTurnPrompt: null,
    conversationTurnCount: 0,
    workspaceInstructionLedgerCount: 0,
    workspaceTurnQueueCount: 0,
    providerDispatchAttemptCount: 0,
    workspaceContentVersion: 0,
  });

  await page.getByTestId("project-init-review-cancel").click();
  await expect(page.getByTestId("project-init-review-dialog")).toHaveCount(0);
  expect((await readInitCalls(page)).commitCalls).toHaveLength(0);

  await openReadyPreview(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-init-review-dialog")).toHaveCount(0);
  const callsAfterEscape = await readInitCalls(page);
  expect(callsAfterEscape.inspectCalls).toHaveLength(2);
  expect(callsAfterEscape.commitCalls).toHaveLength(0);
  expect(await readRuntimeSnapshot(page)).toMatchObject({
    conversationTurnCount: 0,
    workspaceInstructionLedgerCount: 0,
    providerDispatchAttemptCount: 0,
    workspaceContentVersion: 0,
  });
});

test("confirm is single-flight, performs one bound CAS write, and refreshes workspace instructions", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");
  await openReadyPreview(page);

  await page.getByTestId("project-init-review-confirm").evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByTestId("project-init-review-success")).toBeVisible();
  await expect.poll(async () => (await readInitCalls(page)).commitCalls.length).toBe(1);

  const calls = await readInitCalls(page);
  expect(calls.inspectCalls).toHaveLength(1);
  expect(calls.commitCalls).toHaveLength(1);
  expect(calls.commitCalls[0]).toMatchObject({
    workspace: WORKSPACE,
    expectedTargetPath: TARGET_PATH,
    expectedBaseVersion: null,
  });
  const proposedContent = String(calls.commitCalls[0].content ?? "");
  expect(proposedContent).toContain("<!-- MAIN:PROJECT_INIT:START v1 -->");
  expect(proposedContent).toContain("<!-- MAIN:PROJECT_INIT:END -->");
  expect(proposedContent).toContain("baseline-fingerprint: project-baseline-sha256-");
  expect(proposedContent).not.toContain("…");

  await expect.poll(async () => await readRuntimeSnapshot(page)).toMatchObject({
    currentTurnPrompt: null,
    conversationTurnCount: 0,
    workspaceInstructionLedgerCount: 0,
    workspaceTurnQueueCount: 0,
    providerDispatchAttemptCount: 0,
    workspaceContentVersion: 1,
    instructionSourcePaths: expect.arrayContaining(["AGENTS.md"]),
  });
});

test("a stale commit keeps the modal open and can regenerate a fresh preview", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");
  await page.evaluate(() => {
    (window as any).__PROJECT_INIT_E2E__.staleCommit = true;
  });
  await openReadyPreview(page);

  await page.getByTestId("project-init-review-confirm").click();
  await expect(page.getByTestId("project-init-review-dialog")).toBeVisible();
  await expect(page.getByTestId("project-init-review-error")).toContainText("审阅后已被修改");
  await expect(page.getByTestId("project-init-review-regenerate")).toBeVisible();
  expect((await readInitCalls(page)).commitCalls).toHaveLength(1);
  expect(await readRuntimeSnapshot(page)).toMatchObject({
    workspaceContentVersion: 0,
    instructionSourcePaths: [],
  });

  await page.getByTestId("project-init-review-regenerate").click();
  await expect(page.getByTestId("project-init-review-confirm")).toBeEnabled();
  const calls = await readInitCalls(page);
  expect(calls.inspectCalls).toHaveLength(2);
  expect(calls.commitCalls).toHaveLength(1);
});

test("switching workspaces invalidates an open preview without committing", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");
  await openReadyPreview(page);

  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.switchComposerSubmissionWorkspace?.("/tmp/e2e-project-init-other");
  });
  await expect(page.getByTestId("project-init-review-dialog")).toHaveCount(0);
  expect((await readInitCalls(page)).commitCalls).toHaveLength(0);
  expect(await readRuntimeSnapshot(page)).toMatchObject({
    currentWorkspace: "/tmp/e2e-project-init-other",
    conversationTurnCount: 0,
    workspaceInstructionLedgerCount: 0,
    providerDispatchAttemptCount: 0,
    workspaceContentVersion: 0,
  });
});

test("the review dialog stays visible in light, dark, and black themes", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");
  await openReadyPreview(page);

  const dialog = page.getByTestId("project-init-review-dialog");
  const modal = page.getByTestId("project-init-review-modal");
  for (const themeMode of ["light", "dark", "black"] as const) {
    await page.evaluate((mode) => (window as any).__CODELY_E2E__?.setThemeMode?.(mode), themeMode);
    await expect(page.locator("html")).toHaveAttribute("data-theme", themeMode);
    await expect(modal).toHaveAttribute("data-theme-mode", themeMode);
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("project-init-review-status")).toBeVisible();
    await expect(page.getByTestId("project-init-review-diff")).toBeVisible();
  }
});

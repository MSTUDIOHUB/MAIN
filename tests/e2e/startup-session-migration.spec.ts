import { expect, test, type Page } from "@playwright/test";

async function installMigrationFixture(page: Page, localImport?: "retry_after_finalize" | "already_committed" | "native_diverged") {
  await page.addInitScript(({ localImport }) => {
    const workspace = "/tmp/main-startup-session-migration";
    const turn = {
      id: "previous-turn", mode: "chat", status: "done", title: "Previous turn",
      userPrompt: "Previous prompt", summary: "Previous answer", blockIds: [1, 2],
    };
    const messages = [
      { id: 1, turnId: turn.id, type: "user", content: "Previous prompt" },
      { id: 2, turnId: turn.id, type: "agent", content: "Previous answer", streaming: false },
    ];
    const reference = {
      id: 1001, title: "Previous chat", active: true, storageStatus: "ok",
      storageRevision: 8, turnCount: 1, messageCount: 2,
    };
    let nativeSession: any = {
      ...reference,
      messages,
      runtimeSnapshot: { taskFlow: messages, conversationTurns: [turn], showAgentPicker: true },
    };
    const legacyLocalSession = {
      id: 1002, title: "Browser legacy chat", active: false, messages,
      runtimeSnapshot: { taskFlow: messages, conversationTurns: [turn] },
    };
    const importedSessionKey = "__migrationFixtureNativeImport";
    let importedSession = JSON.parse(window.sessionStorage.getItem(importedSessionKey) || "null");
    let finalizeAttempts = 0;
    let releaseFinalization = () => {};
    const canFinalize = new Promise<void>((resolve) => { releaseFinalization = resolve; });
    const commands: Array<{ command: string; sessionId?: string; revision?: number }> = [];
    (window as any).__migrationFixture = { commands, releaseFinalization };
    if (!importedSession) window.localStorage.setItem("local-agent-ide", JSON.stringify({
      state: {
        config: { language: "en", sessionRecordingEnabled: true },
        currentWorkspace: workspace, selectedWorkspace: workspace, currentSessionId: reference.id,
        workspaces: [{ path: workspace, name: "Migration fixture" }],
        activeSessionByWorkspace: { [workspace]: reference.id },
        sessionsByWorkspace: { [workspace]: localImport ? [reference, legacyLocalSession] : [reference] },
      },
      version: 0,
    }));
    let callbacks = 0;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++callbacks,
      unregisterCallback() {},
      invoke: async (command: string, args?: any) => {
        if (command === "plugin:event|listen") return ++callbacks;
        commands.push({
          command,
          sessionId: args?.sessionId ?? args?.input?.sessionId ?? (args?.session ? String(args.session.id) : undefined),
          revision: args?.input?.expectedRevision ?? args?.session?.storageRevision,
        });
        if (command === "list_all_session_snapshots") return [nativeSession, importedSession].filter(Boolean).map(snapshot => ({
          workspace, sessionId: String(snapshot.id), revision: snapshot.storageRevision,
          snapshot, updatedAtMs: 1,
        }));
        if (command === "compare_and_swap_session_snapshot") {
          const snapshot = { ...args.input.snapshot, storageRevision: args.input.expectedRevision + 1 };
          if (snapshot.id === reference.id) nativeSession = snapshot;
          else importedSession = snapshot;
          return { workspace, sessionId: String(snapshot.id), revision: snapshot.storageRevision, snapshot };
        }
        if (command === "list_legacy_session_files" || command === "discover_personal_agent_skills") return [];
        if (command === "finalize_legacy_session_import") {
          await canFinalize;
          if (localImport === "retry_after_finalize" && ++finalizeAttempts === 1) throw new Error("fixture finalization failed");
          return 0;
        }
        if (command === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
        if (command === "list_project_sessions") return [{ ...reference, storageRevision: nativeSession.storageRevision }];
        if (command === "load_project_session_meta") {
          const { messages: _messages, ...meta } = nativeSession;
          return meta;
        }
        if (command === "load_project_session_page") return {
          sessionId: String(reference.id), turns: [turn], messages,
          startTurnIndex: 0, endTurnIndex: 1, totalTurns: 1, hasMore: false, nextBeforeTurnIndex: null,
        };
        if (command === "load_project_session") return Number(args.sessionId) === reference.id ? nativeSession : importedSession;
        if (command === "save_project_session") {
          const owner = args.session.id === reference.id ? nativeSession : importedSession;
          const currentRevision = owner?.storageRevision ?? 0;
          if (args.session.storageRevision !== currentRevision) {
            throw JSON.stringify({ code: "revision_conflict", details: {
              expectedRevision: args.session.storageRevision, actualRevision: currentRevision,
            } });
          }
          const saved = { ...args.session, storageStatus: "ok", storageRevision: currentRevision + 1 };
          if (args.session.id === reference.id) nativeSession = saved;
          else {
            importedSession = saved;
            if (localImport === "already_committed" || localImport === "native_diverged") {
              const shadow = localImport === "native_diverged" ? { ...saved, title: "Different native title" } : saved;
              window.sessionStorage.setItem(importedSessionKey, JSON.stringify(shadow));
              // Native commit recorded, but the browser never receives its receipt.
              return new Promise(() => {});
            }
          }
          return saved;
        }
        return null;
      },
    };
  }, { localImport });
}

async function sessionCommands(page: Page) {
  return page.evaluate(() => ((window as any).__migrationFixture.commands as Array<{
    command: string;
    sessionId?: string;
    revision?: number;
  }>).filter(({ command }) => /^(list_all|list_project|load_project|save_project|finalize_legacy|cleanup_legacy)/.test(command)));
}

test("startup waits for migration before restoring and saving an active chat", async ({ page }) => {
  await installMigrationFixture(page);
  await page.goto("/");
  await expect(page.getByText("Updating chat history…")).toBeVisible();
  await expect.poll(async () => (await sessionCommands(page)).map(({ command }) => command)).toContain("finalize_legacy_session_import");
  await page.waitForTimeout(450);
  expect((await sessionCommands(page)).map(({ command }) => command)).toEqual([
    "list_all_session_snapshots", "finalize_legacy_session_import",
  ]);

  await page.evaluate(() => (window as any).__migrationFixture.releaseFinalization());
  await expect(page.getByText("Previous answer", { exact: true })).toBeVisible();
  await expect.poll(async () => (await sessionCommands(page)).find(({ command }) => command === "save_project_session")).toMatchObject({
    sessionId: "1001", revision: 9,
  });
  const commands = await sessionCommands(page);
  expect(commands.filter(({ command }) => command === "load_project_session_page")).toHaveLength(1);
  expect(commands.findIndex(({ command }) => command === "load_project_session_page"))
    .toBeGreaterThan(commands.findIndex(({ command }) => command === "cleanup_legacy_image_studio_outputs"));
});

test("startup retry keeps an already committed local import and restores after cleanup", async ({ page }) => {
  await installMigrationFixture(page, "retry_after_finalize");
  await page.goto("/");
  await expect.poll(async () => (await sessionCommands(page)).map(({ command }) => command)).toContain("finalize_legacy_session_import");
  await page.evaluate(() => (window as any).__migrationFixture.releaseFinalization());
  await expect(page.getByRole("alert")).toContainText("Chat history migration could not finish");
  expect((await sessionCommands(page)).map(({ command }) => command)).not.toContain("cleanup_legacy_image_studio_outputs");

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Previous answer", { exact: true })).toBeVisible();
  expect((await sessionCommands(page)).filter(({ command, sessionId }) => command === "save_project_session" && sessionId === "1002"))
    .toEqual([{ command: "save_project_session", sessionId: "1002", revision: 0 }]);
});

test("startup adopts an exact previous import after restart", async ({ page }) => {
  await installMigrationFixture(page, "already_committed");
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("__migrationFixtureNativeImport"))).not.toBeNull();
  await page.reload();
  await page.evaluate(() => (window as any).__migrationFixture.releaseFinalization());
  await expect(page.getByText("Previous answer", { exact: true })).toBeVisible();
  const commands = await sessionCommands(page);
  expect(commands.filter(({ command, sessionId }) => command === "save_project_session" && sessionId === "1002"))
    .toEqual([{ command: "save_project_session", sessionId: "1002", revision: 0 }]);
  expect(commands).toContainEqual({ command: "finalize_legacy_session_import", sessionId: "1002", revision: 1 });
});

test("startup preserves differing native and browser copies for retry", async ({ page }) => {
  await installMigrationFixture(page, "native_diverged");
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("__migrationFixtureNativeImport"))).not.toBeNull();
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Chat history migration could not finish");
  const commands = await sessionCommands(page);
  expect(commands.filter(({ command }) => command === "save_project_session"))
    .toEqual([{ command: "save_project_session", sessionId: "1002", revision: 0 }]);
  expect(commands.map(({ command }) => command)).not.toContain("cleanup_legacy_image_studio_outputs");
  const persisted = await page.evaluate(() => JSON.parse(window.localStorage.getItem("local-agent-ide") || "{}"));
  expect(persisted.state.sessionsByWorkspace["/tmp/main-startup-session-migration"].find(({ id }: { id: number }) => id === 1002))
    .toMatchObject({ title: "Browser legacy chat", messages: expect.any(Array) });
});

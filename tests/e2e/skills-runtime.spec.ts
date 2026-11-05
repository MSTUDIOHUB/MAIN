import { expect, test } from "@playwright/test";

const SKILL_NAME = "release-guard";
const SKILL_DESCRIPTION = "Only use when checking release readiness.";
const SKILL_SENTINEL = "SKILL_RUNTIME_SENTINEL: verify the release checklist before answering.";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.removeItem("__SKILLS_RUNTIME_SESSIONS__");
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const requests: Array<{ body: string }> = [];
    const deletedPackages: Array<{ localPath: string; workspace: string }> = [];
    const extractedPackages: string[] = [];
    const globalPackageId = "a".repeat(64);
    const entryPoints = [
      "skills-main/skills/unity-cli/SKILL.md",
      "skills-main/skills/zzz-folder/SKILL.md",
    ];
    const packageRoot = ".protocols/unity-skills-fixture";
    const packageFiles = Object.fromEntries(entryPoints.map((entry, index) => [
      `${packageRoot}/${entry}`,
      ["---", `name: ${index ? "zzz-sprite-tool" : "unity-cli"}`, "description: Unity fixture workflow.", "---", index ? "UNITY_LAST_SKILL_SENTINEL" : "UNITY_CLI_SKILL_SENTINEL"].join("\n"),
    ]));
    const globalMeta = {
      packageId: globalPackageId, name: "Unity Skills", entryPoint: entryPoints[0],
      entryPoints, files: entryPoints, reused: false,
    };
    (window as any).__SKILLS_RUNTIME_E2E__ = { requests, deletedPackages, extractedPackages };

    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {
      unregisterListener: () => {},
    };
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.transformCallback = (callback: unknown) => {
      const id = callbackId++;
      callbacks.set(id, callback);
      return id;
    };
    internals.unregisterCallback = (id: number) => {
      callbacks.delete(Number(id));
    };
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };

    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") {
        return Number(args?.handler ?? callbackId++);
      }
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") {
        return { total_gb: 32, available_gb: 24 };
      }
      if (cmd === "read_debug_log") {
        return { path: "/tmp/main-skills-ui-debug.log", content: "", truncated: false };
      }
      if (cmd === "discover_personal_agent_skills") {
        const state = (window as any).__SKILLS_RUNTIME_E2E__;
        state.discoveryCalls = (state.discoveryCalls || 0) + 1;
        state.discoveryArgs = args;
        if (state.discoveryError) throw new Error(state.discoveryError);
        if (state.holdDiscovery) await new Promise<void>((resolve) => { state.releaseDiscovery = resolve; });
        const entries = state.personalSkills || JSON.parse(sessionStorage.getItem("__EXTERNAL_SKILLS_FIXTURE__") || "[]");
        return Array.isArray(args?.enabledSources) ? entries.filter((entry: any) =>
          (args.enabledSources as string[]).includes(["codex", "claude", "gemini"].includes(entry.platformSource) ? entry.platformSource : "custom")) : entries;
      }
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? "");
      if (cmd === "get_workspace_root") return "/tmp/e2e-cloud-tool-fallback";
      if (cmd === "plugin:dialog|open") return "/tmp/unity-skills.zip";
      if (cmd === "extract_global_skill_package" || cmd === "fetch_and_install_github_skill_package") {
        if (cmd === "fetch_and_install_github_skill_package") (window as any).__SKILLS_RUNTIME_E2E__.githubArgs = args;
        const state = (window as any).__SKILLS_RUNTIME_E2E__;
        // Global imports have no workspace argument, including in project chat.
        if (args?.workspace !== undefined) throw new Error("Global import must not bind a workspace");
        extractedPackages.push("global");
        if (state.extractError) throw new Error(state.extractError);
        if (state.holdExtraction) await new Promise<void>((resolve) => { state.releaseExtraction = resolve; });
        state.extractionSettled = true;
        return { ...globalMeta, reused: extractedPackages.length > 1 };
      }
      if (cmd === "inspect_global_skill_package") {
        if (args?.packageId !== globalPackageId) throw new Error("Unknown package");
        return globalMeta;
      }
      if (cmd === "load_global_skill_package_catalog") {
        if (args?.packageId !== globalPackageId) throw new Error("Unknown package");
        return { meta: globalMeta, documents: entryPoints.map((relativePath) => ({
          relativePath, content: (window as any).__SKILLS_RUNTIME_E2E__.invalidMetadata
            ? "---\nname: [broken\n---\nInvalid metadata fixture" : packageFiles[`${packageRoot}/${relativePath}`],
        })) };
      }
      if (cmd === "read_global_skill_package_file") {
        if (args?.packageId !== globalPackageId) throw new Error("Unknown package");
        const source = packageFiles[`${packageRoot}/${String(args?.relativePath ?? "")}`];
        if (source === undefined) throw new Error("ENOENT");
        return (window as any).__SKILLS_RUNTIME_E2E__.invalidMetadata
          ? "---\nname: [broken\n---\nInvalid metadata fixture" : source;
      }
      if (cmd === "extract_protocol_package") {
        extractedPackages.push(String(args?.workspace ?? ""));
        const state = (window as any).__SKILLS_RUNTIME_E2E__;
        if (state.extractError) throw new Error(state.extractError);
        if (state.holdExtraction) await new Promise<void>((resolve) => { state.releaseExtraction = resolve; });
        return { name: "Unity Skills", entry_point: entryPoints[0], entry_points: entryPoints, local_path: packageRoot };
      }
      if (cmd === "delete_protocol_package") {
        deletedPackages.push({ localPath: String(args?.localPath ?? ""), workspace: String(args?.workspace ?? "") });
        return null;
      }
      if (cmd === "glob_search") {
        const pattern = String(args?.pattern ?? "");
        return pattern.startsWith(packageRoot)
          ? Object.keys(packageFiles)
          : [];
      }
      if (cmd === "read_file") {
        const target = String(args?.path ?? "");
        if (target in packageFiles) {
          return (window as any).__SKILLS_RUNTIME_E2E__.invalidMetadata
            ? "---\nname: [broken\n---\nInvalid metadata fixture"
            : packageFiles[target];
        }
        throw new Error("ENOENT");
      }
      if (["list_project_sessions", "rebuild_project_sessions_index", "save_project_session", "load_project_session", "load_project_session_meta", "load_project_session_page"].includes(cmd)) {
        const records = JSON.parse(window.sessionStorage.getItem("__SKILLS_RUNTIME_SESSIONS__") || "{}");
        const workspace = String(args?.workspace ?? "");
        const sessions = records[workspace] || {};
        if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") {
          return Object.values(sessions).map((record: any) => {
            const { messages: _messages, runtimeSnapshot: _runtime, ...meta } = record;
            return meta;
          });
        }
        const candidate = (args?.session || {}) as Record<string, any>;
        const id = String(cmd === "save_project_session" ? candidate.id : args?.sessionId);
        if (cmd === "save_project_session") {
          const previousRevision = sessions[id]?.storageRevision || 0;
          if ((candidate.storageRevision || 0) !== previousRevision) throw new Error("Session storage revision conflict");
          const saved = {
            ...candidate, workspaceRoot: workspace, storageVersion: 3,
            storageRevision: previousRevision + 1, storageStatus: "ok",
            updatedAtMs: candidate.updatedAtMs || Date.now(),
          };
          records[workspace] = { ...sessions, [id]: saved };
          window.sessionStorage.setItem("__SKILLS_RUNTIME_SESSIONS__", JSON.stringify(records));
          return saved;
        }
        const record = sessions[id] || {
          id, title: "Missing Session", date: "", active: false, messages: [],
          messageCount: 0, turnCount: 0, workspaceRoot: workspace,
          storageVersion: 3, storageRevision: 0, storageStatus: "missing",
        };
        if (cmd === "load_project_session_meta") {
          const { messages: _messages, ...meta } = record;
          return meta;
        }
        if (cmd === "load_project_session_page") {
          const turns = record.runtimeSnapshot?.conversationTurns || [];
          const endTurnIndex = Math.min(turns.length, Number(args?.beforeTurnIndex ?? turns.length));
          const startTurnIndex = Math.max(0, endTurnIndex - Number(args?.limit || 40));
          const pageTurns = turns.slice(startTurnIndex, endTurnIndex);
          const turnIds = new Set(pageTurns.map((turn: any) => turn.id));
          return {
            sessionId: id, turns: pageTurns,
            messages: (record.messages || []).filter((message: any) => turnIds.has(message.turnId)),
            startTurnIndex, endTurnIndex, totalTurns: turns.length,
            hasMore: startTurnIndex > 0, nextBeforeTurnIndex: startTurnIndex || null,
          };
        }
        return record;
      }
      if (cmd === "proxy_request") {
        // Yield once so the test exercises the same async React/runtime
        // scheduling boundary as the other cloud provider E2E fixtures.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        const body = String(args?.body ?? "{}");
        requests.push({ body });
        if (body.includes("Interpret MAIN's current user request.")) {
          return JSON.stringify({ output_text: JSON.stringify({
            semantic: {
              objective: "提供技能工作流建议",
              workType: (window as any).__SKILLS_RUNTIME_E2E__.providerFlow === "list-load" ? "investigate" : "answer",
              answerFormat: "answer", requiredCapabilities: [], forbiddenCapabilities: [], approvalRequiredCapabilities: [],
            }, confidence: 0.99, needsUserChoice: false,
          }) });
        }
        if ((window as any).__SKILLS_RUNTIME_E2E__.providerFlow === "list-load") {
          const receipts: any[] = [];
          const collectReceipts = (value: any) => {
            if (typeof value === "string" && value.trim().startsWith("{")) {
              try { collectReceipts(JSON.parse(value)); } catch { /* ordinary text */ }
            } else if (Array.isArray(value)) {
              value.forEach(collectReceipts);
            } else if (value && typeof value === "object") {
              if (value.type === "skill.catalog" || value.type === "skill.loaded") receipts.push(value);
              else Object.values(value).forEach(collectReceipts);
            }
          };
          collectReceipts(JSON.parse(body));
          const nativeCall = (callId: string, args: Record<string, unknown>) => JSON.stringify({
            output: [{ type: "function_call", call_id: callId, name: "load_skill", arguments: JSON.stringify(args) }],
          });
          if (receipts.some((receipt) => receipt.type === "skill.loaded")) {
            return JSON.stringify({ output_text: "已通过分页目录找到并加载最后一个 Unity 技能。" });
          }
          const lastPage = receipts.filter((receipt) => receipt.type === "skill.catalog").at(-1);
          if (!lastPage) return nativeCall("skill-list-first", { operation: "list", limit: 1 });
          if (lastPage.nextCursor) return nativeCall("skill-list-next", { operation: "list", limit: 1, cursor: lastPage.nextCursor });
          return nativeCall("skill-load-last", { skill_id: lastPage.entries.at(-1).id });
        }
        return JSON.stringify({ output_text: "skills-runtime-e2e-ok" });
      }
      return null;
    };
  });
});

function runtimeRequestSummary(body: string) {
  const parsed = JSON.parse(body || "{}");
  const toolNames = (parsed.tools || [])
    .map((tool: any) => tool?.name || tool?.function?.name)
    .filter(Boolean);
  return {
    body,
    toolNames,
  };
}

async function createRuntimeSession(page: import("@playwright/test").Page, workspace: boolean) {
  // The shared legacy cloud fixture seeds a Session without its admission
  // epoch. Create one through the real UI, which owns Session identity; the
  // storage adapter above preserves it instead of inventing an epoch per Turn.
  await (workspace
    ? page.getByTestId("workspace-new-session")
    : page.getByTitle("新建聊天", { exact: true })).click();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("local-agent-ide") || "{}").state;
    const scope = state.currentWorkspace || "__MAIN_GLOBAL_CHAT__";
    return state.sessionsByWorkspace?.[scope]?.find((session: any) => session.id === state.currentSessionId)?.planLifecycleEpoch;
  })).toMatch(/^plan-session-/);
}

async function submitSkillRequest(page: import("@playwright/test").Page, text: string) {
  // Exercise Composer -> semantic preflight -> Turn admission -> provider loop.
  // The legacy scenario bridge deliberately bypasses intent routing.
  await page.getByTestId("composer-textarea").fill(text);
  await page.getByTestId("composer-send-button").click();
}

test("panel Agent Skill persists manual-only admission into the next Turns", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");

  await page.getByRole("button", { name: "技能与提示词" }).click();
  const heading = page.getByRole("heading", { name: "技能与提示词" });
  await expect(heading).toBeVisible();
  const modal = heading.locator(
    "xpath=ancestor::div[contains(@class, 'rounded-xl')][1]",
  );

  await modal.getByRole("button", { name: "添加技能" }).click();
  await expect(modal.getByRole("heading", { name: "创建新技能" })).toBeVisible();

  const textInputs = modal.locator('input[type="text"]');
  await textInputs.nth(0).fill(SKILL_NAME);
  await textInputs.nth(1).fill(SKILL_DESCRIPTION);
  await modal.locator("textarea").first().fill(SKILL_SENTINEL);

  const modelMatching = modal.getByRole("switch", { name: "允许模型自动匹配", exact: true });
  await expect(modelMatching).toHaveAttribute("aria-checked", "true");
  await modelMatching.click();
  await modal.getByRole("button", { name: "保存技能" }).click();

  await expect(modal.getByText(SKILL_NAME, { exact: true })).toBeVisible();
  await expect(modal.getByText("仅手动", { exact: true })).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate((name) => {
        const persisted = JSON.parse(
          window.localStorage.getItem("local-agent-ide") || "{}",
        );
        const skill = (persisted?.state?.skills || []).find(
          (candidate: any) => candidate?.name === name,
        );
        return skill
          ? {
              active: skill.active,
              type: skill.type,
              allowImplicitInvocation: skill.allowImplicitInvocation,
              content: skill.content,
            }
          : null;
      }, SKILL_NAME),
    )
    .toEqual({
      active: true,
      type: "instruction",
      allowImplicitInvocation: false,
      content: SKILL_SENTINEL,
    });

  // A real reload proves this is store hydration, not only local checkbox
  // state retained by the open modal component.
  await page.reload();
  await page.getByRole("button", { name: "技能与提示词" }).click();
  const rehydratedHeading = page.getByRole("heading", {
    name: "技能与提示词",
  });
  await expect(rehydratedHeading).toBeVisible();
  const rehydratedModal = rehydratedHeading.locator(
    "xpath=ancestor::div[contains(@class, 'rounded-xl')][1]",
  );
  await expect(
    rehydratedModal.getByText(SKILL_NAME, { exact: true }),
  ).toBeVisible();
  await expect(
    rehydratedModal.getByText("仅手动", { exact: true }),
  ).toBeVisible();
  await rehydratedHeading.locator("xpath=following-sibling::button").click();
  await createRuntimeSession(page, false);

  await page.evaluate(() => {
    (window as any).__SKILLS_RUNTIME_E2E__.requests.length = 0;
  });
  await submitSkillRequest(page, "请直接回答一个普通问题。");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as any).__CODELY_E2E__?.getSnapshot?.()
            .currentTurnResultKind ?? null,
      ),
    )
    .toBe("success");

  const ordinaryRequests = await page.evaluate(() =>
    ((window as any).__SKILLS_RUNTIME_E2E__?.requests || []).map(
      (request: any) => request.body,
    ),
  );
  const ordinaryRuntimeRequests = ordinaryRequests
    .filter((body: string) => body.includes("[MAIN RUNTIME V2]"))
    .map(runtimeRequestSummary);
  expect(ordinaryRuntimeRequests).toHaveLength(1);
  expect(ordinaryRuntimeRequests[0].body).not.toContain(SKILL_NAME);
  expect(ordinaryRuntimeRequests[0].body).not.toContain(SKILL_SENTINEL);
  expect(ordinaryRuntimeRequests[0].toolNames).not.toContain("load_skill");

  const ordinaryTurnId = await page.evaluate(
    () =>
      (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnId ?? null,
  );
  expect(ordinaryTurnId).not.toBeNull();

  await page.evaluate(() => {
    (window as any).__SKILLS_RUNTIME_E2E__.requests.length = 0;
  });
  await submitSkillRequest(page, `请使用 @${SKILL_NAME} 给出一句建议。`);
  await expect
    .poll(async () =>
      page.evaluate((previousTurnId) => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          isNewTurn:
            !!snapshot?.currentTurnId &&
            snapshot.currentTurnId !== previousTurnId,
          resultKind: snapshot?.currentTurnResultKind ?? null,
        };
      }, ordinaryTurnId),
    )
    .toEqual({ isNewTurn: true, resultKind: "success" });

  const explicitRequests = await page.evaluate(() =>
    ((window as any).__SKILLS_RUNTIME_E2E__?.requests || []).map(
      (request: any) => request.body,
    ),
  );
  const explicitRuntimeRequests = explicitRequests
    .filter((body: string) => body.includes("[MAIN RUNTIME V2]"))
    .map(runtimeRequestSummary);
  expect(explicitRuntimeRequests).toHaveLength(1);
  expect(explicitRuntimeRequests[0].body).toContain(
    "[EXPLICITLY ACTIVATED SKILL",
  );
  expect(explicitRuntimeRequests[0].body).toContain(SKILL_NAME);
  expect(explicitRuntimeRequests[0].body).toContain(SKILL_SENTINEL);
  expect(explicitRuntimeRequests[0].toolNames).toContain("load_skill");
});


async function openPackageForm(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "技能与提示词" }).click();
  const heading = page.getByRole("heading", { name: "技能与提示词" });
  const modal = heading.locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
  await modal.getByRole("button", { name: "添加技能" }).click();
  await modal.getByRole("button", { name: "技能包", exact: true }).click();
  return modal;
}

test("Skills management offers generic package imports without the Gemini extension panel", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await expect(page.getByRole("button", { name: "技能与提示词", exact: true })).toBeVisible();
  // Retired metadata can exist at the current persist version, so exercise the
  // real merge path as well as the migration helper's Node contract.
  await page.evaluate(() => {
    const persisted = JSON.parse(localStorage.getItem("local-agent-ide") || "{}");
    persisted.state.geminiExtensions = [{ id: "retired-extension", enabled: true }];
    persisted.state.extensionMcpDiscovery = { retired: { tools: [{ name: "stale_tool" }] } };
    localStorage.setItem("local-agent-ide", JSON.stringify(persisted));
  });
  await page.reload();
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite browser module URL.
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const state = useAppStore.getState();
    return [Object.hasOwn(state, "geminiExtensions"), Object.hasOwn(state, "extensionMcpDiscovery")];
  })).toEqual([false, false]);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  const modal = page.getByRole("heading", { name: "技能与提示词", exact: true }).locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
  await expect(modal.getByText("Gemini CLI 扩展", { exact: true })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "导入 Gemini ZIP", exact: true })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "本机发现的技能", exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "添加技能", exact: true }).click();
  await modal.getByRole("button", { name: "技能包", exact: true }).click();
  await expect(modal.getByRole("button", { name: "上传 ZIP", exact: true })).toBeVisible();
  await expect(modal.getByRole("button", { name: "从 GitHub 安装", exact: true })).toBeVisible();
});

test("settings switches preserve keyboard updates across their panels", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  const recording = page.getByTestId("session-recording-switch");
  await expect(recording).toHaveRole("switch");
  await expect(recording).toHaveClass(/main-toggle-switch/);
  const recordingInitial = await recording.isChecked();
  await recording.press("Space");
  await expect(recording).toBeChecked({ checked: !recordingInitial });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state.config.sessionRecordingEnabled)).toBe(!recordingInitial);
  await recording.press("Enter");
  await expect(recording).toBeChecked({ checked: recordingInitial });
  await page.getByTestId("settings-tab-debug").click();
  const fullProcess = page.getByTestId("debug-full-turn-process-switch");
  await expect(fullProcess).toHaveRole("switch");
  await expect(fullProcess).toHaveClass(/main-toggle-switch/);
  const initial = await fullProcess.isChecked();
  await fullProcess.press("Space");
  await expect(fullProcess).toBeChecked({ checked: !initial });
  await fullProcess.press("Enter");
  await expect(fullProcess).toBeChecked({ checked: initial });
  await page.getByTestId("settings-tab-general").click();
  await expect(recording).toBeChecked({ checked: recordingInitial });
});

test("a Unity skill collection imports all entries and activates the final skill after reload", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await expect(modal.getByText("zzz-sprite-tool", { exact: true })).toBeVisible();
  for (const themeMode of ["light", "dark", "black"] as const) {
    await page.evaluate((mode) => (window as any).__CODELY_E2E__?.setThemeMode?.(mode), themeMode);
    await expect(page.locator("html")).toHaveAttribute("data-theme", themeMode);
    await modal.screenshot({ path: testInfo.outputPath(`unity-skills-import-${themeMode}.png`), animations: "disabled" });
  }
  await modal.getByRole("button", { name: "保存技能", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(window.localStorage.getItem("local-agent-ide") || "{}");
    return data?.state?.skills?.find((skill: any) => skill.name === "Unity Skills")?.entryPoints;
  })).toEqual(["skills-main/skills/unity-cli/SKILL.md", "skills-main/skills/zzz-folder/SKILL.md"]);
  await page.reload();
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await expect(page.getByText("Unity Skills", { exact: true })).toBeVisible();
  await expect(page.getByText("包含 2 个技能", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑技能: Unity Skills", exact: true }).click();
  await expect(page.getByText("zzz-sprite-tool", { exact: true })).toBeVisible();
  await expect(page.getByText("zzz-folder", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await createRuntimeSession(page, true);
  await submitSkillRequest(page, "请使用 $zzz-sprite-tool 给出一句建议。");
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnResultKind ?? null)).toBe("success");
  const requests = await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.requests.map((request: any) => request.body));
  expect(requests.some((body: string) => body.includes("[EXPLICITLY ACTIVATED SKILL") && body.includes("UNITY_LAST_SKILL_SENTINEL"))).toBe(true);
});

test("canceling a global import leaves shared cache unregistered", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.deletedPackages)).toEqual([]);
  expect(await page.evaluate(() => {
    const data = JSON.parse(window.localStorage.getItem("local-agent-ide") || "{}");
    return (data?.state?.skills || []).some((skill: any) => skill.name === "Unity Skills");
  })).toBe(false);
});

test("a global collection installs without a workspace and survives reload", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  const modal = await openPackageForm(page);
  await expect(modal.getByText("全局安装，一次导入后可在所有项目中使用。", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "保存技能", exact: true }).click();
  await expect(modal.getByText("全局 · 所有项目", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem("local-agent-ide") || "{}").state;
    const skill = state.skills.find((candidate: any) => candidate.name === "Unity Skills");
    return { storage: skill?.packageStorage, scope: skill?.workspaceScope ?? null, workspace: state.currentWorkspace || null };
  })).toEqual({ storage: { kind: "global", packageId: "a".repeat(64) }, scope: null, workspace: null });
  await page.reload();
  await createRuntimeSession(page, false);
  await submitSkillRequest(page, "请使用 $zzz-sprite-tool 给出一句建议。");
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnResultKind ?? null)).toBe("success");
  const bodies: string[] = await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.requests.map((request: any) => request.body));
  expect(bodies.some((body) => body.includes("[EXPLICITLY ACTIVATED SKILL") && body.includes("UNITY_LAST_SKILL_SENTINEL"))).toBe(true);
  // Reopen a project through the scenario's normal startup and create a real
  // Session. The same registration works without another ZIP extraction.
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await createRuntimeSession(page, true);
  await submitSkillRequest(page, "请使用 $zzz-sprite-tool 给出一句建议。");
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnResultKind ?? null)).toBe("success");
  const projectBodies: string[] = await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.requests.map((request: any) => request.body));
  expect(projectBodies.some((body) => body.includes("[EXPLICITLY ACTIVATED SKILL") && body.includes("UNITY_LAST_SKILL_SENTINEL"))).toBe(true);
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.extractedPackages)).toEqual([]);
});

test("reimporting identical content preserves the existing registration and manual policy", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  const modal = await openPackageForm(page);
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await modal.locator('input[type="text"]').first().fill("My Unity Skills");
  await modal.getByRole("switch", { name: "允许模型自动匹配", exact: true }).click();
  await modal.getByRole("button", { name: "保存技能", exact: true }).click();
  const before = await page.evaluate(() => JSON.parse(window.localStorage.getItem("local-agent-ide") || "{}").state.skills.find((skill: any) => skill.name === "My Unity Skills"));
  await modal.getByRole("button", { name: "添加技能", exact: true }).click();
  await modal.getByRole("button", { name: "技能包", exact: true }).click();
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "保存技能", exact: true }).click();
  const registrations = await page.evaluate(() => JSON.parse(window.localStorage.getItem("local-agent-ide") || "{}").state.skills.filter((skill: any) => skill.packageStorage?.kind === "global"));
  expect(registrations).toEqual([before]);
  expect(registrations[0].allowImplicitInvocation).toBe(false);
  await expect(modal.getByText("仅手动", { exact: true })).toBeVisible();
});


test("closing during extraction cannot register a late global package", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.holdExtraction = true; });
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__SKILLS_RUNTIME_E2E__.releaseExtraction)).toBe("function");
  await modal.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.releaseExtraction());
  await expect.poll(() => page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.extractionSettled)).toBe(true);
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.deletedPackages)).toEqual([]);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await expect(page.getByText("Unity Skills", { exact: true })).toHaveCount(0);
});

test("invalid skill ZIP errors remain visible with a retry action", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.extractError = "ZIP must contain SKILL.md"; });
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("ZIP must contain SKILL.md");
  await expect(modal.getByRole("button", { name: "上传 ZIP", exact: true })).toBeEnabled();
  await expect(modal.getByRole("button", { name: "保存技能", exact: true })).toBeDisabled();
});

test("load_skill lists every collection page then loads a discovered Skill through the provider loop", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "保存技能", exact: true }).click();
  await modal.getByRole("button", { name: "完成", exact: true }).click();
  await createRuntimeSession(page, true);
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.providerFlow = "list-load"; });
  await submitSkillRequest(page, "请从已安装技能中找到精灵工作流并给出建议。");
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnResultKind ?? null)).toBe("success");
  const runtimeBodies: string[] = await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.requests
    .map((request: any) => request.body).filter((body: string) => body.includes("[MAIN RUNTIME V2]")));
  expect(runtimeBodies).toHaveLength(4);
  for (const body of runtimeBodies.slice(0, 3)) expect(body).not.toContain("UNITY_LAST_SKILL_SENTINEL");
  expect(runtimeBodies[3]).toContain("UNITY_LAST_SKILL_SENTINEL");
  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  const receiptsFromBody = (body: string) => {
    const result: any[] = [];
    const collect = (value: any) => {
      if (typeof value === "string" && value.trim().startsWith("{")) {
        try { collect(JSON.parse(value)); } catch { /* ordinary text */ }
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") {
        if (value.type === "skill.catalog" || value.type === "skill.loaded") result.push(value);
        else Object.values(value).forEach(collect);
      }
    };
    collect(JSON.parse(body));
    return result;
  };
  const firstPage = receiptsFromBody(runtimeBodies[1]).at(-1);
  const lastPage = receiptsFromBody(runtimeBodies[2]).at(-1);
  const loaded = receiptsFromBody(runtimeBodies[3]).at(-1);
  expect(firstPage.entries.map((entry: any) => entry.name)).toEqual(["unity-cli"]);
  expect(firstPage.nextCursor).toBeTruthy();
  expect(lastPage.entries.map((entry: any) => entry.name)).toEqual(["zzz-sprite-tool"]);
  expect(lastPage.nextCursor).toBeNull();
  expect(loaded.type).toBe("skill.loaded");
  expect(loaded.name).toBe("zzz-sprite-tool");
  expect(snapshot.toolNames).toContain("load_skill");
  expect(snapshot.visibleFinalCount).toBe(1);
});


test("invalid SKILL frontmatter is reported in the import preview", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.invalidMetadata = true; });
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("部分技能说明无法完整解析或读取");
  await modal.getByRole("button", { name: "取消", exact: true }).click();
});


test("legacy tool descriptions hydrate as custom rules without a pretend executable schema", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await page.evaluate(() => {
    const persisted = JSON.parse(localStorage.getItem("local-agent-ide") || "{}");
    persisted.state.skills = [{ id: "legacy-rule", name: "Old workflow", desc: "Release checklist", content: "Keep these instructions.", type: "tool", toolParameters: '{"type":"object"}', active: true, allowImplicitInvocation: false }];
    localStorage.setItem("local-agent-ide", JSON.stringify(persisted));
  });
  await page.reload();
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await expect(page.getByText("旧版工具描述", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "编辑技能: Old workflow", exact: true }).click();
  await expect(page.getByRole("button", { name: "自定义规则", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "技能包", exact: true })).toBeVisible();
  await expect(page.getByText("OpenAI JSON Schema", { exact: false })).toHaveCount(0);
  await expect(page.getByPlaceholder("输入给模型的规则和说明（支持 Markdown）...")).toHaveValue("Keep these instructions.");
  await page.getByRole("button", { name: "更新技能", exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state.skills[0]);
  expect(saved.type).toBe("instruction");
  expect(saved.toolParameters).toBeUndefined();
  expect(saved.content).toBe("Keep these instructions.");
  expect(saved.allowImplicitInvocation).toBe(false);
});

test("GitHub install previews and registers a global collection with source inputs", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  const modal = await openPackageForm(page);
  await modal.getByRole("textbox", { name: "GitHub 仓库或 URL", exact: true }).fill("Unity-Technologies/skills");
  await modal.getByRole("textbox", { name: "分支（默认 main）", exact: true }).fill("stable");
  await modal.getByRole("button", { name: "从 GitHub 安装", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.githubArgs)).toEqual({ repoOrUrl: "Unity-Technologies/skills", branch: "stable" });
  await modal.getByRole("button", { name: "保存技能", exact: true }).click();
  await expect(modal.getByText("全局 · 所有项目", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.deletedPackages)).toEqual([]);
});

test("discovered external Skills show their platform provenance", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await page.evaluate(() => {
    (window as any).__SKILLS_RUNTIME_E2E__.personalSkills = ["codex", "claude", "gemini"].map((platformSource) => ({
      entryPath: `/home/skills/${platformSource}/SKILL.md`, basePath: `/home/skills/${platformSource}`, platformSource,
      content: `---\nname: ${platformSource}-workflow\ndescription: Workflow from ${platformSource}.\n---\nInstructions.`, openaiYaml: null, supportingFiles: [],
    }));
  });
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "本机发现的技能", exact: true })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "本机发现的技能", exact: true });
  for (const source of ["codex", "claude", "gemini"]) await expect(dialog.locator(`#discovered-source-${source}`)).toBeVisible();
});


test("GitHub download failures retain the repository and allow retry", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  const modal = await openPackageForm(page);
  await modal.getByRole("textbox", { name: "GitHub 仓库或 URL", exact: true }).fill("owner/skills");
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.extractError = "GitHub download failed"; });
  await modal.getByRole("button", { name: "从 GitHub 安装", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("GitHub download failed");
  await expect(modal.getByRole("textbox", { name: "GitHub 仓库或 URL", exact: true })).toHaveValue("owner/skills");
  await expect(modal.getByRole("button", { name: "从 GitHub 安装", exact: true })).toBeEnabled();
  await expect(modal.getByRole("button", { name: "保存技能", exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.extractError = undefined; (window as any).__SKILLS_RUNTIME_E2E__.holdExtraction = true; });
  await modal.getByRole("button", { name: "从 GitHub 安装", exact: true }).click();
  await expect(modal.getByRole("button", { name: "从 GitHub 安装", exact: true })).toBeDisabled();
  await expect(modal.getByRole("button", { name: "解压中...", exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.releaseExtraction());
  await expect.poll(() => page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.extractionSettled)).toBe(true);
  await expect(modal.getByText("Unity Skills", { exact: true })).toHaveCount(0);
});


const EXTERNAL_SKILL_PATH = "/home/skills/external-review/SKILL.md";
const EXTERNAL_SKILL_SENTINEL = "EXTERNAL_SELECTED_BODY_SENTINEL";

async function seedExternalSkills(page: import("@playwright/test").Page, options: { manual?: boolean; workspaceOnly?: boolean } = {}) {
  return page.evaluate(({ manual, workspaceOnly, entryPath, sentinel }) => {
    const persisted = JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state;
    const workspace = persisted.currentWorkspace || "";
    const docs = [{ entryPath, basePath: entryPath.slice(0, -"/SKILL.md".length), platformSource: "codex", scope: workspaceOnly ? "workspace" : "personal",
      content: `---\nname: external-review\ndescription: Only use for an external review.\n---\n${sentinel}`,
      openaiYaml: manual ? "policy:\n  allow_implicit_invocation: false\n" : null, supportingFiles: [],
    }];
    (window as any).__SKILLS_RUNTIME_E2E__.personalSkills = docs;
    sessionStorage.setItem("__EXTERNAL_SKILLS_FIXTURE__", JSON.stringify(docs));
    return workspace;
  }, { ...options, entryPath: EXTERNAL_SKILL_PATH, sentinel: EXTERNAL_SKILL_SENTINEL });
}

function externalSkillCard(page: import("@playwright/test").Page) {
  return page.locator(`[data-external-skill-path="${EXTERNAL_SKILL_PATH}"]`);
}

async function externalSkillSelections(page: import("@playwright/test").Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state.externalSkillSelections || []);
}

test("external Skills require an explicit Add to MAIN and persist only the selected project reference", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const workspace = await seedExternalSkills(page);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  const discoverButton = page.getByRole("button", { name: "本机发现的技能", exact: true });
  const addButton = page.getByRole("button", { name: "添加技能", exact: true });
  await expect(discoverButton).toBeVisible();
  await expect(addButton).toBeVisible();
  expect(Math.abs((await discoverButton.boundingBox())!.y - (await addButton.boundingBox())!.y)).toBeLessThan(2);
  await expect(page.locator("[data-external-skill-path]")).toHaveCount(0);
  const mainPanel = page.getByRole("heading", { name: "技能与提示词", exact: true }).locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
  for (const mode of ["light", "dark", "black"] as const) {
    await page.evaluate((theme) => (window as any).__CODELY_E2E__?.setThemeMode?.(theme), mode);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await mainPanel.screenshot({ path: testInfo.outputPath(`local-skills-entry-${mode}.png`), animations: "disabled" });
  }
  await discoverButton.click();
  const card = externalSkillCard(page);
  await expect(card.getByRole("button", { name: "添加到 MAIN", exact: true })).toBeVisible();
  const closeDiscovery = page.getByRole("button", { name: "关闭本机技能选择", exact: true });
  await expect(closeDiscovery).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(card.getByRole("button", { name: "添加到 MAIN", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeDiscovery).toBeFocused();
  await expect(card.getByRole("status")).toContainText("未添加");
  await expect(card.getByRole("combobox", { name: "external-review: 作用范围", exact: true })).toHaveValue("project");
  expect(await externalSkillSelections(page)).toEqual([]);
  await card.getByRole("button", { name: "添加到 MAIN", exact: true }).click();
  await expect(card.getByRole("combobox", { name: "external-review: 使用方式", exact: true })).toHaveValue("auto");
  expect(await externalSkillSelections(page)).toEqual([{ entryPath: EXTERNAL_SKILL_PATH, workspaceScope: workspace, mode: "auto" }]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state.skills.some((skill: any) => skill.content?.includes("EXTERNAL_SELECTED_BODY_SENTINEL")))).toBe(false);
  const modal = page.getByRole("dialog", { name: "本机发现的技能", exact: true });
  await expect(modal.getByText("选择供 MAIN 使用的技能，不启动来源 Agent。下次启动执行生效，不影响正在运行的任务。", { exact: true })).toBeVisible();
  for (const mode of ["light", "dark", "black"] as const) {
    await page.evaluate((theme) => (window as any).__CODELY_E2E__?.setThemeMode?.(theme), mode);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await modal.screenshot({ path: testInfo.outputPath(`external-skill-admission-${mode}.png`), animations: "disabled" });
  }
  await page.reload();
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  await expect(externalSkillCard(page).getByRole("combobox", { name: "external-review: 使用方式", exact: true })).toHaveValue("auto");
  await expect(externalSkillCard(page).getByRole("status")).toContainText("自动匹配");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "本机发现的技能", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "本机发现的技能", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "技能与提示词", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await expect(page.getByRole("dialog", { name: "本机发现的技能", exact: true })).toHaveCount(0);
});

test("local discovery dialog loads only on demand and presents loading, empty, and retryable error states", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const callsBefore = await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.discoveryCalls || 0);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  const button = page.getByRole("button", { name: "本机发现的技能", exact: true });
  await expect(button).toBeVisible();
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.discoveryCalls || 0)).toBe(callsBefore);
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.holdDiscovery = true; });
  await button.click();
  const dialog = page.getByRole("dialog", { name: "本机发现的技能", exact: true });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("status")).toContainText("正在扫描本机技能");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.evaluate(() => {
    const state = (window as any).__SKILLS_RUNTIME_E2E__;
    state.holdDiscovery = false;
    state.releaseDiscovery();
  });
  await button.click();
  await expect(dialog.getByRole("status")).toContainText("没有发现本机技能");
  await dialog.getByRole("button", { name: "关闭本机技能选择", exact: true }).click();
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.discoveryError = "discovery unavailable"; });
  await button.click();
  await expect(dialog.getByRole("status")).toContainText("无法读取本机技能");
  await dialog.getByRole("button", { name: "关闭本机技能选择", exact: true }).click();
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.discoveryError = undefined; });
  await seedExternalSkills(page);
  await button.click();
  await expect(externalSkillCard(page).getByRole("button", { name: "添加到 MAIN", exact: true })).toBeVisible();
});

test("an external manual selection activates only on mention and Disabled blocks even explicit mention", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  await seedExternalSkills(page);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  const card = externalSkillCard(page);
  await expect(card.getByRole("combobox", { name: "external-review: 作用范围", exact: true })).toHaveValue("global");
  await card.getByRole("button", { name: "添加到 MAIN", exact: true }).click();
  await card.getByRole("combobox", { name: "external-review: 使用方式", exact: true }).selectOption("manual");
  expect(await externalSkillSelections(page)).toEqual([{ entryPath: EXTERNAL_SKILL_PATH, workspaceScope: null, mode: "manual" }]);
  await page.getByRole("button", { name: "关闭本机技能选择", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await createRuntimeSession(page, false);
  const request = async (prompt: string) => {
    const previousTurn = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnId);
    await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.requests.length = 0; });
    await submitSkillRequest(page, prompt);
    await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnId)).not.toBe(previousTurn);
    await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnResultKind)).toBe("success");
    return page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.requests.map((entry: any) => entry.body).filter((body: string) => body.includes("[MAIN RUNTIME V2]")));
  };
  let bodies = await request("请给出一句普通建议。");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toContain("external-review");
  expect(bodies[0]).not.toContain(EXTERNAL_SKILL_SENTINEL);
  bodies = await request("请使用 $external-review 给出一句建议。");
  expect(bodies[0]).toContain("[EXPLICITLY ACTIVATED SKILL");
  expect(bodies[0]).toContain(EXTERNAL_SKILL_SENTINEL);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  await externalSkillCard(page).getByRole("combobox", { name: "external-review: 使用方式", exact: true }).selectOption("disabled");
  await page.getByRole("button", { name: "关闭本机技能选择", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await createRuntimeSession(page, false);
  bodies = await request("请使用 $external-review 给出一句建议。");
  expect(bodies[0]).not.toContain("[EXPLICITLY ACTIVATED SKILL");
  expect(bodies[0]).not.toContain(EXTERNAL_SKILL_SENTINEL);
  expect(runtimeRequestSummary(bodies[0]).toolNames).not.toContain("load_skill");
});

test("external source manual-only policy is preserved and workspace Skills cannot be enabled globally", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const workspace = await seedExternalSkills(page, { manual: true, workspaceOnly: true });
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  const card = externalSkillCard(page);
  await expect(card.getByRole("combobox", { name: "external-review: 作用范围", exact: true })).toHaveCount(0);
  await expect(card.getByText("当前项目", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "添加到 MAIN", exact: true }).click();
  await expect(card.getByRole("combobox", { name: "external-review: 使用方式", exact: true })).toHaveValue("manual");
  await expect(card.locator('option[value="auto"]')).toBeDisabled();
  await expect(card.getByText("来源规则要求仅手动调用。", { exact: true })).toBeVisible();
  expect(await externalSkillSelections(page)).toEqual([{ entryPath: EXTERNAL_SKILL_PATH, workspaceScope: workspace, mode: "manual" }]);
});

test("external Skill project settings override a separate global selection", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const workspace = await seedExternalSkills(page);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  const card = externalSkillCard(page);
  const scope = card.getByRole("combobox", { name: "external-review: 作用范围", exact: true });
  await scope.selectOption("global");
  await card.getByRole("button", { name: "添加到 MAIN", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("自动匹配");
  await scope.selectOption("project");
  await card.getByRole("button", { name: "添加到 MAIN", exact: true }).click();
  await card.getByRole("combobox", { name: "external-review: 使用方式", exact: true }).selectOption("disabled");
  await expect(card.getByRole("status")).toContainText("已停用");
  await scope.selectOption("global");
  await expect(card.getByRole("combobox", { name: "external-review: 使用方式", exact: true })).toHaveValue("auto");
  await expect(card.getByRole("status")).toContainText("已停用");
  expect(await externalSkillSelections(page)).toEqual([
    { entryPath: EXTERNAL_SKILL_PATH, workspaceScope: null, mode: "auto" },
    { entryPath: EXTERNAL_SKILL_PATH, workspaceScope: workspace, mode: "disabled" },
  ]);
});


test("Windows native Skill paths retain editable modes after portable selection persistence", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  await page.evaluate(() => {
    const entryPath = String.raw`C:\Users\Michael\.claude\skills\windows-review\SKILL.md`;
    const docs = [{ entryPath, basePath: String.raw`C:\Users\Michael\.claude\skills\windows-review`, platformSource: "claude", scope: "personal", content: "---\nname: windows-review\ndescription: Review Windows workflows.\n---\nInstructions.", openaiYaml: null, supportingFiles: [] }];
    (window as any).__SKILLS_RUNTIME_E2E__.personalSkills = docs;
    sessionStorage.setItem("__EXTERNAL_SKILLS_FIXTURE__", JSON.stringify(docs));
  });
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  const card = page.locator("[data-external-skill-path]").filter({ has: page.getByText("windows-review", { exact: true }) });
  await card.getByRole("button", { name: "添加到 MAIN", exact: true }).click();
  const mode = card.getByRole("combobox", { name: "windows-review: 使用方式", exact: true });
  await expect(mode).toHaveValue("auto");
  await mode.selectOption("manual");
  await expect(mode).toHaveValue("manual");
  expect(await externalSkillSelections(page)).toEqual([{ entryPath: "C:/Users/Michael/.claude/skills/windows-review/SKILL.md", workspaceScope: null, mode: "manual" }]);
  await page.reload();
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  await expect(card.getByRole("combobox", { name: "windows-review: 作用范围", exact: true })).toHaveValue("global");
  await expect(mode).toHaveValue("manual");
  await mode.selectOption("disabled");
  await expect(card.getByRole("status")).toContainText("已停用");
});

async function seedSourceSkills(page: import("@playwright/test").Page, includeCustom = false) {
  await page.evaluate((includeCustom) => {
    const docs = ["codex", "claude", "gemini", ...(includeCustom ? ["custom"] : [])].map((platformSource) => ({
      entryPath: `/home/skills/${platformSource}-flow/SKILL.md`, basePath: `/home/skills/${platformSource}-flow`, platformSource,
      content: `---\nname: ${platformSource}-flow\ndescription: ${platformSource} workflow instructions.\n---\nExact ${platformSource} body.`,
      openaiYaml: null, supportingFiles: [], scope: "personal",
    }));
    (window as any).__SKILLS_RUNTIME_E2E__.personalSkills = docs;
    sessionStorage.setItem("__EXTERNAL_SKILLS_FIXTURE__", JSON.stringify(docs));
  }, includeCustom);
}

test("Agent source switches show only Codex and restore existing manual choices after reload", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await seedSourceSkills(page);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "本机发现的技能", exact: true });
  await expect(dialog).toContainText("这些全局开关仅控制本机 Agent 来源。");
  await expect(dialog).toContainText("独立导入的技能包由主面板的包启用开关控制。");
  const claudeCard = dialog.locator('[data-external-skill-path="/home/skills/claude-flow/SKILL.md"]');
  await claudeCard.getByRole("button", { name: "添加到 MAIN", exact: true }).click();
  await claudeCard.getByRole("combobox", { name: "claude-flow: 使用方式", exact: true }).selectOption("manual");
  const selected = await externalSkillSelections(page);
  await dialog.getByRole("switch", { name: "Claude Code", exact: true }).click();
  await dialog.getByRole("switch", { name: "Gemini / Antigravity", exact: true }).click();
  await expect(dialog.locator("[data-external-skill-path]")).toHaveCount(1);
  await expect(dialog.getByText("codex-flow", { exact: true })).toBeVisible();
  await expect(dialog.locator("#discovered-source-claude")).toHaveCount(0);
  await expect(dialog.locator("#discovered-source-gemini")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "添加到 MAIN", exact: true })).toBeVisible();
  expect(await externalSkillSelections(page)).toEqual(selected);
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.discoveryArgs.enabledSources)).toEqual(["codex", "custom"]);
  for (const theme of ["light", "dark", "black"] as const) {
    await page.evaluate((mode) => (window as any).__CODELY_E2E__?.setThemeMode?.(mode), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await dialog.screenshot({ path: testInfo.outputPath(`skill-sources-${theme}.png`), animations: "disabled" });
  }
  await page.reload();
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "Claude Code", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByRole("switch", { name: "Gemini / Antigravity", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(dialog.locator("[data-external-skill-path]")).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state.externalSkillSources)).toEqual({ codex: true, claude: false, gemini: false, custom: true });
  await dialog.getByRole("switch", { name: "Claude Code", exact: true }).click();
  await expect(claudeCard.getByRole("combobox", { name: "claude-flow: 使用方式", exact: true })).toHaveValue("manual");
  expect(await externalSkillSelections(page)).toEqual(selected);
  await expect(dialog.locator('[data-external-skill-path="/home/skills/codex-flow/SKILL.md"]').getByRole("button", { name: "添加到 MAIN", exact: true })).toBeVisible();
});

test("turning every Agent source off has a persistent empty state without scanning or adding Skills", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  await seedSourceSkills(page, true);
  await page.getByRole("button", { name: "技能与提示词" }).click();
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "本机发现的技能", exact: true });
  await expect(dialog.locator("[data-external-skill-path]")).toHaveCount(4);
  for (const source of ["Codex", "Claude Code", "Gemini / Antigravity"]) await dialog.getByRole("switch", { name: source, exact: true }).click();
  await expect(dialog.locator("[data-external-skill-path]")).toHaveCount(1);
  const scans = await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.discoveryCalls);
  await dialog.getByRole("switch", { name: "其他", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("所有来源均已关闭");
  await expect(dialog.locator("[data-external-skill-path]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.discoveryCalls)).toBe(scans);
  expect(await externalSkillSelections(page)).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "技能与提示词" }).click();
  const scansBeforeOpen = await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.discoveryCalls || 0);
  await page.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("所有来源均已关闭");
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.discoveryCalls || 0)).toBe(scansBeforeOpen);
  await dialog.getByRole("switch", { name: "Codex", exact: true }).click();
  await expect(dialog.locator("[data-external-skill-path]")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "添加到 MAIN", exact: true })).toBeVisible();
  expect(await externalSkillSelections(page)).toEqual([]);
});

test("source and package switches independently control real dollar-menu candidates", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "保存技能", exact: true }).click();
  await seedSourceSkills(page);
  await modal.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "本机发现的技能", exact: true });
  for (const source of ["codex", "claude", "gemini"]) {
    await dialog.locator(`[data-external-skill-path="/home/skills/${source}-flow/SKILL.md"]`).getByRole("button", { name: "添加到 MAIN", exact: true }).click();
  }
  await dialog.getByRole("combobox", { name: "claude-flow: 使用方式", exact: true }).selectOption("manual");
  const selections = await externalSkillSelections(page);
  expect(selections).toHaveLength(3);
  expect(selections).toEqual(expect.arrayContaining([
    expect.objectContaining({ entryPath: "/home/skills/codex-flow/SKILL.md", mode: "auto" }),
    expect.objectContaining({ entryPath: "/home/skills/claude-flow/SKILL.md", mode: "manual" }),
    expect.objectContaining({ entryPath: "/home/skills/gemini-flow/SKILL.md", mode: "auto" }),
  ]));
  await dialog.getByRole("switch", { name: "Claude Code", exact: true }).click();
  await dialog.getByRole("switch", { name: "Gemini / Antigravity", exact: true }).click();
  await expect(dialog.getByText("codex-flow", { exact: true })).toBeVisible();
  await expect(dialog.locator("[data-external-skill-path]")).toHaveCount(1);
  await dialog.getByRole("button", { name: "关闭本机技能选择", exact: true }).click();
  await modal.getByRole("button", { name: "完成", exact: true }).click();

  const input = page.getByTestId("composer-textarea");
  const menu = page.getByRole("listbox", { name: "MAIN 技能", exact: true });
  const openPicker = async () => {
    await input.fill("");
    await input.fill("$");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option").filter({ hasText: "codex-flow" })).toBeVisible();
  };
  await openPicker();
  for (const name of ["claude-flow", "gemini-flow"]) await expect(menu.getByText(name, { exact: true })).toHaveCount(0);
  for (const name of ["unity-cli", "zzz-sprite-tool"]) {
    const option = menu.getByRole("option").filter({ hasText: name });
    await expect(option).toBeVisible();
    await expect(option).toContainText(/技能包\s*·\s*Unity Skills/);
  }
  for (const theme of ["light", "dark", "black"] as const) {
    await page.evaluate((mode) => (window as any).__CODELY_E2E__?.setThemeMode?.(mode), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await menu.screenshot({ path: testInfo.outputPath(`skill-origins-${theme}.png`), animations: "disabled" });
  }
  await input.press("Escape");

  await page.getByRole("button", { name: "技能与提示词" }).click();
  const packageSwitch = modal.getByRole("switch", { name: "Unity Skills: 启用", exact: true });
  await expect(packageSwitch).toHaveAttribute("aria-checked", "true");
  await packageSwitch.click();
  await expect(packageSwitch).toHaveAttribute("aria-checked", "false");
  await modal.getByRole("button", { name: "完成", exact: true }).click();
  await openPicker();
  for (const name of ["unity-cli", "zzz-sprite-tool", "claude-flow", "gemini-flow"]) await expect(menu.getByText(name, { exact: true })).toHaveCount(0);
  await input.press("Escape");

  await page.getByRole("button", { name: "技能与提示词" }).click();
  await modal.getByRole("button", { name: "本机发现的技能", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "Claude Code", exact: true })).toHaveAttribute("aria-checked", "false");
  await dialog.getByRole("switch", { name: "Claude Code", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "claude-flow: 使用方式", exact: true })).toHaveValue("manual");
  expect(await externalSkillSelections(page)).toEqual(selections);
  await dialog.getByRole("button", { name: "关闭本机技能选择", exact: true }).click();
  await modal.getByRole("button", { name: "完成", exact: true }).click();
  await openPicker();
  await expect(menu.getByRole("option").filter({ hasText: "claude-flow" })).toContainText("仅手动");
  for (const name of ["gemini-flow", "unity-cli", "zzz-sprite-tool"]) await expect(menu.getByText(name, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.requests.filter((request: any) =>
    request.body.includes("Interpret MAIN's current user request.") || request.body.includes("[MAIN RUNTIME V2]")).length)).toBe(0);
  await expect(page.getByTestId("user-message-content")).toHaveCount(0);
});

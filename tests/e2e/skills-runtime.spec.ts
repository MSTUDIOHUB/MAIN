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
    const entryPoints = [
      "skills-main/skills/unity-cli/SKILL.md",
      "skills-main/skills/zzz-folder/SKILL.md",
    ];
    const packageRoot = ".protocols/unity-skills-fixture";
    const packageFiles = Object.fromEntries(entryPoints.map((entry, index) => [
      `${packageRoot}/${entry}`,
      ["---", `name: ${index ? "zzz-sprite-tool" : "unity-cli"}`, "description: Unity fixture workflow.", "---", index ? "UNITY_LAST_SKILL_SENTINEL" : "UNITY_CLI_SKILL_SENTINEL"].join("\n"),
    ]));
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
      if (cmd === "discover_personal_agent_skills") return [];
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? "");
      if (cmd === "get_workspace_root") return "/tmp/e2e-cloud-tool-fallback";
      if (cmd === "plugin:dialog|open") return "/tmp/unity-skills.zip";
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

  const modelMatching = modal.locator('input[type="checkbox"]');
  await expect(modelMatching).toBeChecked();
  await modelMatching.uncheck();
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
  const ordinarySent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.(
      "请直接回答一个普通问题。",
    ),
  );
  expect(ordinarySent).toBe(true);
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
  const explicitSent = await page.evaluate((name) =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.(
      `请使用 @${name} 给出一句建议。`,
    ), SKILL_NAME,
  );
  expect(explicitSent).toBe(true);
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
  await modal.getByRole("button", { name: "协议包", exact: true }).click();
  return modal;
}

test("a Unity skill collection imports all entries and activates the final skill after reload", async ({ page }, testInfo) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await expect(modal.getByText("zzz-sprite-tool", { exact: true })).toBeVisible();
  for (const themeMode of ["light", "dark", "black"] as const) {
    await page.evaluate((mode) => (window as any).__CODELY_E2E__?.setThemeMode?.(mode), themeMode);
    await expect(page.locator("html")).toHaveAttribute("data-theme", themeMode);
    await modal.screenshot({ path: testInfo.outputPath(`unity-skills-import-${themeMode}.png`) });
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
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__?.sendCloudMessage?.("请使用 $zzz-sprite-tool 给出一句建议。"))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnResultKind ?? null)).toBe("success");
  const requests = await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.requests.map((request: any) => request.body));
  expect(requests.some((body: string) => body.includes("[EXPLICITLY ACTIVATED SKILL") && body.includes("UNITY_LAST_SKILL_SENTINEL"))).toBe(true);
});

test("canceling a skill collection import removes the extracted package", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect(modal.getByText("发现 2 个技能", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.deletedPackages)).toEqual([
    { localPath: ".protocols/unity-skills-fixture", workspace: "/tmp/e2e-cloud-tool-fallback" },
  ]);
  expect(await page.evaluate(() => {
    const data = JSON.parse(window.localStorage.getItem("local-agent-ide") || "{}");
    return (data?.state?.skills || []).some((skill: any) => skill.name === "Unity Skills");
  })).toBe(false);
});

test("package import explains that a workspace must be opened first", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  const modal = await openPackageForm(page);
  await expect(modal.getByText("请先打开项目文件夹，再导入技能包。", { exact: true })).toBeVisible();
  await expect(modal.getByRole("button", { name: "上传 ZIP", exact: true })).toBeDisabled();
});


test("closing during extraction cleans up the late package without saving it", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");
  const modal = await openPackageForm(page);
  await page.evaluate(() => { (window as any).__SKILLS_RUNTIME_E2E__.holdExtraction = true; });
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__SKILLS_RUNTIME_E2E__.releaseExtraction)).toBe("function");
  await modal.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.releaseExtraction());
  await expect.poll(() => page.evaluate(() => (window as any).__SKILLS_RUNTIME_E2E__.deletedPackages.length)).toBe(1);
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
  expect(await page.evaluate(() => (window as any).__CODELY_E2E__?.sendCloudMessage?.("请从已安装技能中找到精灵工作流并给出建议。"))).toBe(true);
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

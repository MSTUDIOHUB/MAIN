import { expect, test } from "@playwright/test";

const SKILL_NAME = "release-guard";
const SKILL_DESCRIPTION = "Only use when checking release readiness.";
const SKILL_SENTINEL = "SKILL_RUNTIME_SENTINEL: verify the release checklist before answering.";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const requests: Array<{ body: string }> = [];
    (window as any).__SKILLS_RUNTIME_E2E__ = { requests };

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
      if (cmd === "glob_search") return [];
      if (cmd === "read_file") throw new Error("ENOENT");
      if (
        cmd === "list_project_sessions" ||
        cmd === "rebuild_project_sessions_index"
      ) {
        return [];
      }
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "load_project_session") return {};
      if (cmd === "proxy_request") {
        // Yield once so the test exercises the same async React/runtime
        // scheduling boundary as the other cloud provider E2E fixtures.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        const body = String(args?.body ?? "{}");
        requests.push({ body });
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

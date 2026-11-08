import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    const admission = ((window as any).__WORKSPACE_ADMISSION_E2E__ ??= {
      savedSessions: [] as unknown[],
      failNextSave: false,
    });
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "save_project_session") {
        if (admission.failNextSave) {
          admission.failNextSave = false;
          throw new Error("forced workspace admission save failure");
        }
        admission.savedSessions.push(args?.session ?? null);
        return args?.session ?? null;
      }
      if (["list_project_sessions", "list_all_session_snapshots", "list_legacy_session_files"].includes(cmd)) return [];
      if (cmd === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
      if (cmd === "finalize_legacy_session_import") return 0;
      return null;
    };
  });
});

test("the Web Search panel uses a switch while its compact toolbar entrance remains a button", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");
  const toolbar = page.getByTestId("composer-web-search-toggle");
  if (await toolbar.getAttribute("aria-pressed") === "true") await toolbar.click();
  await toolbar.click();
  const enabled = page.getByRole("switch", { name: "网络搜索", exact: true });
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await enabled.press("Space");
  await expect(enabled).toHaveCount(0);
  await expect(toolbar).toHaveAttribute("aria-pressed", "false");
  await toolbar.click();
  await expect(page.getByRole("switch", { name: "网络搜索", exact: true })).toHaveAttribute("aria-checked", "true");
});

for (const theme of ["light", "dark", "black"] as const) {
  test(`free web providers default to Yahoo and allow Quark selection (${theme})`, async ({ page }) => {
    await page.goto("/?e2eScenario=composer-main-shortcuts");
    await page.evaluate(mode => (window as any).__CODELY_E2E__.setThemeMode(mode), theme);
    const toolbar = page.getByTestId("composer-web-search-toggle");
    await toolbar.click();
    await expect(toolbar).toHaveAttribute("title", "网络搜索已开启: Yahoo");
    await expect(page.getByRole("button", { name: /^夸克/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Yahoo/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^DuckDuckGo/ })).toBeVisible();
    await page.screenshot({ path: `test-results/web-providers-${theme}.png` });
    await page.getByRole("button", { name: /^夸克/ }).click();
    await expect(toolbar).toHaveAttribute("title", "网络搜索已开启: 夸克");
    await expect(toolbar).toHaveAttribute("aria-pressed", "true");
  });
}

test("composer keeps a two-line minimum height and grows until it scrolls", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await expect(textarea).toHaveAttribute("placeholder", "输入需求，/ 选择计划或规则，# 选择资料...");

  const initialBox = await textarea.boundingBox();
  expect(initialBox?.height ?? 0).toBeGreaterThanOrEqual(56);

  await textarea.fill("第一行\n第二行\n第三行\n第四行");
  const grownBox = await textarea.boundingBox();
  expect(grownBox?.height ?? 0).toBeGreaterThan(initialBox?.height ?? 0);

  await textarea.fill(Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行内容`).join("\n"));
  const longMetrics = await textarea.evaluate((node: HTMLTextAreaElement) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
  }));
  expect(longMetrics.scrollHeight).toBeGreaterThan(longMetrics.clientHeight);
  expect(longMetrics.overflowY).toBe("auto");

  await textarea.fill("");
  const emptyAgainBox = await textarea.boundingBox();
  expect(emptyAgainBox?.height ?? 0).toBeGreaterThanOrEqual(initialBox?.height ?? 0);
});

test("first workspace Composer admission renders one titled Turn that owns its user block", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const prompt = "检查首回合标题、消息归属与持久化收据";
  await page.getByTestId("composer-textarea").fill(prompt);
  await page.getByTestId("composer-send-button").click();

  await expect.poll(async () => page.evaluate((expectedPrompt) => {
    const savedSessions = (window as any).__WORKSPACE_ADMISSION_E2E__?.savedSessions || [];
    for (const session of [...savedSessions].reverse()) {
      const snapshot = session?.runtimeSnapshot;
      const turn = (snapshot?.conversationTurns || []).find(
        (candidate: any) => candidate?.userPrompt === expectedPrompt,
      );
      if (!turn) continue;
      const ledgerEntry = (snapshot?.workspaceInstructionLedger || []).find(
        (entry: any) => entry?.receipt?.turnId === turn.id,
      );
      const userBlockId = ledgerEntry?.receipt?.userBlockId ?? null;
      const userBlock = (snapshot?.taskFlow || []).find(
        (block: any) => block?.id === userBlockId && block?.type === "user",
      );
      return {
        turnId: turn.id,
        title: turn.title,
        userBlockId,
        turnOwnsUserBlock: turn.blockIds?.includes(userBlockId) === true,
        userBlockTurnId: userBlock?.turnId ?? null,
      };
    }
    return null;
  }, prompt)).toMatchObject({
    turnId: expect.any(String),
    title: expect.stringMatching(/\S/),
    userBlockId: expect.any(Number),
    turnOwnsUserBlock: true,
    userBlockTurnId: expect.any(String),
  });

  const ownership = await page.evaluate((expectedPrompt) => {
    const savedSessions = (window as any).__WORKSPACE_ADMISSION_E2E__?.savedSessions || [];
    for (const session of [...savedSessions].reverse()) {
      const turn = (session?.runtimeSnapshot?.conversationTurns || []).find(
        (candidate: any) => candidate?.userPrompt === expectedPrompt,
      );
      if (turn) return { turnId: turn.id, title: turn.title };
    }
    return null;
  }, prompt);
  expect(ownership).not.toBeNull();

  const turnSection = page.locator(`section[data-turn-id='${ownership!.turnId}']`);
  await expect(page.locator("section[data-turn-id]")).toHaveCount(1);
  await expect(turnSection).toHaveCount(1);
  await expect(turnSection.getByTestId("turn-state-anchor")).toContainText(ownership!.title);
  await expect(turnSection.getByTestId("user-message-content")).toHaveText(prompt);
});

test("MAIN shortcut menu works from a leading slash before existing content", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("先处理这个需求");
  await textarea.evaluate((node: HTMLTextAreaElement) => {
    node.focus();
    node.selectionStart = 0;
    node.selectionEnd = 0;
  });
  await page.keyboard.type("/");

  await expect(page.getByText("MAIN 快捷入口").first()).toBeVisible();
  await expect(page.getByTestId("main-shortcut-item-plan")).toBeVisible();
  await expect(page.getByTestId("main-shortcut-item-execute")).toHaveCount(0);
});

test("MAIN shortcut order, keyboard selection, and labels stay aligned", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/");

  const shortcutIds = await page
    .locator("[data-testid^='main-shortcut-item-']")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  expect(shortcutIds).toEqual(["main-shortcut-item-plan", "main-shortcut-item-rules"]);

  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe("plan");
  await expect(textarea).toHaveValue("");
});

test("Shift+Tab toggles plan intent mode in the MAIN composer", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("需要先规划这个改动");
  await textarea.focus();
  await page.keyboard.press("Shift+Tab");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe("plan");
  await expect(textarea).toHaveValue("需要先规划这个改动");

  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe(null);
  await expect(textarea).toHaveValue("需要先规划这个改动");
});











test("locked Plan intent remains exact while its durable Turn waits in FIFO", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/");
  await page.getByTestId("main-shortcut-item-plan").click();
  await textarea.fill("先检查运行时边界，再输出修复计划");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setComposerRuntimeState?.({
    isGenerating: true,
    agentStatus: "running",
  }));
  await page.getByTestId("composer-queue-button").click();

  await expect.poll(async () => page.evaluate(() => {
    const savedSessions = (window as any).__WORKSPACE_ADMISSION_E2E__?.savedSessions || [];
    for (const session of savedSessions as any[]) {
      const entries = session?.runtimeSnapshot?.workspaceTurnQueue?.entries || [];
      const admitted = entries.find((entry: any) =>
        entry?.instruction?.payload?.text === "先检查运行时边界，再输出修复计划"
      );
      if (!admitted) continue;
      const turn = (session?.runtimeSnapshot?.conversationTurns || []).find(
        (candidate: any) => candidate?.id === admitted?.receipt?.turnId,
      );
      return {
        hints: admitted.instruction.payload.dispatchHints || null,
        bypassesSemanticAdmission: admitted.instruction.payload.dispatchHints?.skipIntentResolution === true ||
          admitted.instruction.payload.dispatchHints?.resolvedIntent !== undefined ||
          admitted.instruction.payload.dispatchHints?.runtimeIntentOverride !== undefined,
        turnIntent: turn?.intent ?? null,
        turnDisplayIntent: turn?.displayIntent ?? null,
      };
    }
    return null;
  })).toMatchObject({
    hints: {
      // The capsule captures a capability ceiling. Its natural-language body
      // still goes through semantic admission when this FIFO entry dispatches.
      explicitIntent: "plan",
    },
    bypassesSemanticAdmission: false,
    turnIntent: "plan",
    turnDisplayIntent: "plan",
  });
  await expect.poll(async () =>
    page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
  ).toBe(null);
});

test("persistence failure closes one memory-accepted Plan Turn and consumes its draft once", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/");
  await page.getByTestId("main-shortcut-item-plan").click();
  const prompt = "这条 Plan 即使持久化失败也必须作为回合收口";
  await textarea.fill(prompt);
  await page.evaluate(() => {
    (window as any).__WORKSPACE_ADMISSION_E2E__.failNextSave = true;
  });

  await page.getByTestId("composer-send-button").click();

  await expect(textarea).toHaveValue("");
  await expect.poll(async () =>
    page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
  ).toBe(null);
  await expect(page.getByTestId("user-message-content")).toHaveCount(1);
  await expect(page.getByTestId("user-message-content")).toHaveText(prompt);
  await expect(page.getByTestId("assistant-final")).toHaveCount(1);
  await expect(page.getByTestId("assistant-final")).toContainText("Session 持久化失败");

  await expect.poll(async () => page.evaluate(() => {
    const entries = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
    return entries
      .filter((entry: { source?: string }) =>
        entry.source === "store.workspace_instruction_admission_memory_terminalized"
      )
      .map((entry: { message?: string }) => JSON.parse(String(entry.message || "{}")));
  })).toEqual([
    expect.objectContaining({
      turnId: expect.any(String),
      durability: "memory",
      resultKind: "error",
    }),
  ]);
  await expect(page.getByTestId("composer-send-button")).toBeDisabled();
});

test("user message bubble preserves multiline composer input", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const multilinePrompt = "第一行需求\n第二行补充\n\n第四行结尾";
  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill(multilinePrompt);
  await page.getByTestId("composer-send-button").click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnPrompt ?? null),
    )
    .toBe(multilinePrompt);

  const userMessage = page.getByTestId("user-message-content").last();
  await expect(userMessage).toBeVisible();

  const rendered = await userMessage.evaluate((node) => ({
    text: node.textContent,
    whiteSpace: window.getComputedStyle(node).whiteSpace,
  }));
  expect(rendered.text).toBe(multilinePrompt);
  expect(rendered.whiteSpace).toBe("pre-wrap");
});

test("MAIN shortcut intent survives transient empty Chinese IME composition", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe("plan");
  await expect(textarea).toHaveValue("");

  await textarea.evaluate((node: HTMLTextAreaElement) => {
    const setNativeValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(node, value);
    };
    node.focus();
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "j" }));
    setNativeValue("j");
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: "j",
      inputType: "insertCompositionText",
    }));
    setNativeValue("");
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: "",
      inputType: "insertCompositionText",
    }));
  });

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe("plan");

  await textarea.evaluate((node: HTMLTextAreaElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(node, "计划一下中文输入");
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: "计划一下中文输入",
      inputType: "insertCompositionText",
    }));
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "计划一下中文输入" }));
  });

  await expect(textarea).toHaveValue("计划一下中文输入");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent ?? null),
    )
    .toBe("plan");

  await page.getByTestId("composer-send-button").click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnIntent ?? null),
    )
    .toBe("plan");

  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  expect(snapshot?.currentTurnPrompt).toBe("计划一下中文输入");
  expect(snapshot?.currentTurnPrompt).not.toContain("/计划");
});

test("MDEBUG stays hidden, preserves the admitted prompt, and submits as a plan turn", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const textarea = page.getByTestId("composer-textarea");
  await textarea.fill("/M");

  await expect(page.getByText("MAIN 快捷入口").first()).toBeVisible();
  await expect(page.getByText("/MDEBUG")).toHaveCount(0);

  await textarea.fill("/MDEBUG\n# MAIN 用户反馈修复请求\n\n## 问题描述与复现步骤\n点击 Terminal 后没有显示输出。");
  await expect(page.getByText("MAIN 快捷入口")).toHaveCount(0);
  await page.getByTestId("composer-send-button").click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().lockedComposerIntent),
    )
    .toBe(null);
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnIntent ?? null),
    )
    .toBe("plan");

  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
  expect(snapshot?.currentTurnTitle).toBe("MDEBUG：用户反馈自修复");
  expect(snapshot?.currentTurnIntent).toBe("plan");
  expect(snapshot?.currentTurnPrompt).toBe(
    "/MDEBUG\n# MAIN 用户反馈修复请求\n\n## 问题描述与复现步骤\n点击 Terminal 后没有显示输出。",
  );
  expect(snapshot?.currentTurnPrompt).not.toContain("[MDEBUG: USER FEEDBACK SELF-REPAIR]");
});


for (const [command, purpose] of [["/计划", null], ["/规则", "rules"]] as const) {
  test(`${command} with a body dispatches on the first Enter`, async ({ page }) => {
    await page.goto("/?e2eScenario=composer-main-shortcuts");
    const prompt = `${command} 保留人工约束并检查当前项目`;
    const textarea = page.getByTestId("composer-textarea");
    await textarea.fill(prompt);
    await expect(page.locator("[data-testid^='main-shortcut-item-']")).toHaveCount(0);
    await textarea.press("Enter");
    await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().workspaceTurnQueueCount ?? 0)).toBe(1);
    const admitted = await page.evaluate((text) => {
      const saved = (window as any).__WORKSPACE_ADMISSION_E2E__.savedSessions || [];
      const entry = [...saved].reverse().flatMap(session => session?.runtimeSnapshot?.workspaceTurnQueue?.entries || [])
        .find(candidate => candidate.instruction?.payload?.text === text);
      return {
        text: entry?.instruction.payload.text,
        explicitIntent: entry?.instruction.payload.dispatchHints.explicitIntent,
        purpose: entry?.instruction.payload.dispatchHints.planPurpose ?? null,
        receiptId: entry?.receipt.receiptId,
        dispatchAttempts: (window as any).__CODELY_E2E__.getSnapshot().providerDispatchAttemptCount,
      };
    }, prompt);
    expect(admitted.text).toBe(prompt);
    expect(admitted.explicitIntent).toBe("plan");
    expect(admitted.purpose).toBe(purpose);
    expect(admitted.receiptId).toBeTruthy();
    expect(admitted.dispatchAttempts).toBeGreaterThan(0);
    await expect(textarea).toHaveValue("");
  });
}

import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";

async function initializePlanFixture(page: Page, theme = "dark", path = "/") {
  await page.addInitScript(({ theme }) => {
    localStorage.clear();
    localStorage.setItem("local-agent-ide", JSON.stringify({ version: 2, state: { config: { language: "zh", themeMode: theme, sessionRecordingEnabled: false }, sessionsByWorkspace: {}, workspaces: [] } }));
    let callback = 1;
    const commands = (window as any).__PLAN_FIXTURE_COMMANDS__ = [] as Array<{ command: string; args: unknown }>;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => callback++, unregisterCallback() {}, invoke: async (command: string, args: any) => {
      commands.push({ command, args });
      if (["list_all_session_snapshots", "list_legacy_session_files", "list_project_sessions", "discover_personal_agent_skills"].includes(command)) return [];
      if (command === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
      if (command === "plugin:event|listen") return callback++;
      if (command === "read_plan_document") return { ...args.reference, markdown: "# Collector 测试游戏\n\n保留已确认的新 Input System。\n\n## 验收\n验证金币收集、计分和重置。" };
      if (["start_chat_stream", "stream_chat", "proxy_request"].includes(command)) throw new Error("Model requests are not allowed in this component fixture");
      return null;
    } };
  }, { theme });
  await page.goto(path);
}

async function mountDraft(page: Page, { theme = "dark", language = "zh", draft = true } = {}) {
  await initializePlanFixture(page, theme);
  await page.evaluate(async ({ theme, language, draft }) => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { default: PlanDocumentCard } = await import("/src/components/PlanDocumentCard.tsx");
    const { formatPlanSubmissionDiagnostic } = await import("/src/lib/planDrafts.ts");
    document.getElementById("root")!.style.display = "none";
    document.documentElement.setAttribute("data-theme", theme);
    const host = document.createElement("div"); host.id = "draft-card-fixture";
    host.style.cssText = "width:700px;max-width:calc(100vw - 48px);margin:40px auto;padding:24px;background:var(--surface-1);color:var(--surface-text);border:1px solid var(--surface-border);border-radius:16px";
    document.body.append(host);
    const reference = { owner: { workspace: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", turnId: "source-turn" }, documentId: "draft-collector", revision: 1, contentHash: "a".repeat(64), path: "/app-data/plans/draft-collector/rev-1.md", title: "Collector 游戏实施方案", kind: "plan" };
    const record = { schemaVersion: 1, documentRef: reference, source: { turnId: "source-turn", runId: "source-run", providerSequence: 4, toolCallId: "submit-1", candidateHash: "b".repeat(64) }, diagnostics: [
      { code: "plan_validation_not_required", fieldPath: "validations[0]", criterionIds: ["criterion-user-objective"], rawKind: "advisory", compiledKind: "advisory", message: "backend message must not be rendered" },
      { code: "plan_validation_not_required", fieldPath: "validations[1]", criterionIds: ["criterion-user-objective"], rawKind: "finite_command", compiledKind: "advisory", normalizationReason: "non_finite_command_downgraded_to_advisory", message: "backend normalization detail" },
    ] };
    record.diagnostics.push({ ...record.diagnostics[0], fieldPath: "validations[2]" });
    record.diagnostics.push({ ...record.diagnostics[0], fieldPath: "validations[3]" });
    const ipc = (window as any).__TAURI_INTERNALS__;
    const invoke = ipc.invoke;
    ipc.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      if (command !== "read_plan_document" || !draft) return result;
      const bullets = record.diagnostics.map(item => `- ${formatPlanSubmissionDiagnostic(item as any, "zh")}`).join("\n");
      return { ...result, markdown: `${result.markdown}\n\n## 待补全的执行验证\n\n此文档为可审核草稿，尚未形成可批准执行的计划。\n\n${bullets}\n` };
    };
    const fixture = (window as any).__PLAN_DRAFT_CARD__ = { calls: [] as Array<string | null>, mode: "hold", pending: [] as Array<(result: boolean) => void>, replace: () => {} };
    function Harness() {
      const [ref, setRef] = React.useState(reference);
      fixture.replace = () => setRef({ ...reference, revision: 2, contentHash: "c".repeat(64) });
      return React.createElement(PlanDocumentCard, { reference: ref, draft: draft ? { ...record, documentRef: ref } : undefined, language,
        onCompleteValidation: async (supplement?: string) => {
          fixture.calls.push(supplement ?? null);
          return fixture.mode === "hold" ? new Promise<boolean>(resolve => fixture.pending.push(resolve)) : fixture.mode === "success";
        },
      });
    }
    createRoot(host).render(React.createElement(Harness));
  }, { theme, language, draft });
  await expect(page.getByTestId("plan-document-card")).toBeVisible();
}

for (const theme of ["light", "dark", "black"]) test(`${theme}: saved draft exposes validation gaps and no execution approval`, async ({ page }) => {
  await mountDraft(page, { theme });
  const card = page.getByTestId("plan-document-card");
  await expect(card).toHaveAttribute("data-plan-readiness", "draft");
  await expect(card).toContainText("草稿 · 待补全验证");
  await expect(card.getByText(/需要可执行的验收方式/)).toHaveCount(1);
  await expect(card).toContainText("该命令无法作为有限结束的验收命令");
  await expect(card).not.toContainText("criterion-user-objective");
  await expect(card).not.toContainText("backend message");
  await expect(card.getByRole("button", { name: /批准|执行/ })).toHaveCount(0);
  await card.getByRole("button", { name: "查看文档" }).click();
  const document = page.getByRole("dialog");
  await expect(document).toContainText("保留已确认的新 Input System。");
  await expect(document.getByText(/需要可执行的验收方式/)).toHaveCount(1);
  await document.getByRole("button", { name: "关闭" }).click();
  const complete = card.getByRole("button", { name: "补全验证", exact: true });
  await complete.focus();
  const colors = await card.evaluate(element => ({ text: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
  expect(colors.text).not.toBe(colors.background);
  await fs.mkdir("test-results/plan-draft-ui", { recursive: true });
  await page.locator("#draft-card-fixture").screenshot({ path: `test-results/plan-draft-ui/${theme}.png` });
  await complete.click();
  await expect(card.getByRole("textbox")).toBeFocused();
  await page.locator("#draft-card-fixture").screenshot({ path: `test-results/plan-draft-ui/${theme}-supplement.png` });
  await expect(card.getByRole("button", { name: "提交并继续" })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).__PLAN_DRAFT_CARD__.calls)).toEqual([]);
  await card.getByRole("textbox", { name: "你希望如何确认结果达标？" }).fill("  Inspector 里检查金币计数归零。  ");
  await card.getByRole("button", { name: "提交并继续" }).click();
  await expect(card.getByRole("button", { name: "正在核对…" })).toBeDisabled();
  await card.getByRole("button", { name: "查看文档" }).click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).__PLAN_DRAFT_CARD__.pending.shift()(false));
  await expect(card.getByRole("alert")).toContainText("无法继续此版本草稿");
  await expect(complete).toBeEnabled();
  await page.evaluate(() => { (window as any).__PLAN_DRAFT_CARD__.mode = "success"; });
  await card.getByRole("button", { name: "请 MAIN 继续核实" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__PLAN_DRAFT_CARD__.calls)).toEqual(["Inspector 里检查金币计数归零。", null]);
});

test("English draft copy is localized and ordinary documents have no completion action", async ({ page }) => {
  await mountDraft(page, { language: "en" });
  const card = page.getByTestId("plan-document-card");
  await expect(card).toContainText("Draft · validation needed");
  await expect(card.getByRole("button", { name: "Complete validation" })).toBeVisible();
  await mountDraft(page, { language: "en", draft: false });
  await expect(page.getByTestId("plan-document-card")).toHaveAttribute("data-plan-readiness", "document");
  await expect(page.getByRole("button", { name: "Complete validation" })).toHaveCount(0);
});

test("a late completion result does not change the replacement draft", async ({ page }) => {
  await mountDraft(page);
  const card = page.getByTestId("plan-document-card");
  await card.getByRole("button", { name: "补全验证", exact: true }).click();
  await card.getByRole("button", { name: "请 MAIN 继续核实" }).click();
  await page.evaluate(() => (window as any).__PLAN_DRAFT_CARD__.replace());
  await expect(card).toContainText("v2");
  await page.evaluate(() => (window as any).__PLAN_DRAFT_CARD__.pending.shift()(false));
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "补全验证", exact: true })).toBeEnabled();
});

test("plan workspace opens the latest owned revision instead of a legacy workspace plan", async ({ page }) => {
  await initializePlanFixture(page, "dark", "/?e2eScenario=awaiting-choice");
  await expect.poll(() => page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    return useAppStore.getState().harnessRunMarker?.runId;
  })).toBe("run-e2e-awaiting-choice");
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const { createPlanLifecycleState } = await import("/src/lib/planLifecycle.ts");
    window.history.replaceState(null, "", "/?e2eScenario=versioned-plan-workspace");
    const state = useAppStore.getState();
    const workspace = state.currentWorkspace;
    const sessionKey = state.harnessRunMarker!.sessionKey;
    const sessionEpoch = "plan-session-e2e-awaiting-choice";
    const reference = { owner: { workspace, sessionKey, sessionEpoch, turnId: "owned-turn" },
      documentId: "draft-collector", revision: 2, contentHash: "a".repeat(64), path: "/app-data/plans/draft-collector/rev-2.md", title: "当前会话的实施方案", kind: "plan" as const };
    const turn = { id: "owned-turn", userPrompt: "规划游戏", title: "规划游戏", mode: "plan", status: "partial", summary: "",
      blockIds: [], collapsed: false, createdAt: 1, planDocument: reference };
    const stale = { ...turn, id: "stale-turn", planDocument: { ...reference,
      owner: { ...reference.owner, turnId: "stale-turn", sessionEpoch: "old-epoch" }, title: "旧会话的实施方案" } };
    useAppStore.setState({ conversationTurns: [turn, stale], taskFlow: [], showPlanPanel: false, planArtifacts: [], planTasks: [],
      activeActionRequest: null, harnessRunMarker: null, planStage: "idle", planLifecycle: createPlanLifecycleState({ sessionKey, sessionEpoch }),
    } as any);
    (window as any).__PLAN_FIXTURE_COMMANDS__.length = 0;
  });
  await page.getByTestId("top-plan-panel-button").click();
  const plan = page.getByTestId("versioned-plan-panel");
  await expect(plan).toContainText("当前会话的实施方案 · v2");
  await expect(plan).not.toContainText("旧会话");
  await plan.getByRole("button", { name: "查看文档" }).click();
  const preview = page.getByRole("dialog");
  await expect(preview).toContainText("保留已确认的新 Input System。");
  await expect(preview).toContainText("/app-data/plans/draft-collector/rev-2.md");
  const commandLog = await page.evaluate(() => (window as any).__PLAN_FIXTURE_COMMANDS__);
  expect(commandLog.filter((entry: any) => entry.command === "read_plan_document")).toEqual([
    expect.objectContaining({ args: { reference: expect.objectContaining({ revision: 2, contentHash: "a".repeat(64) }) } }),
  ]);
  expect(commandLog.some((entry: any) => JSON.stringify(entry).includes("/.MAIN/plans/plan.md"))).toBe(false);
});

for (const theme of ["light", "dark", "black"]) test(`${theme}: approval dialog reviews the sealed body and passes the exact displayed request`, async ({ page }, testInfo) => {
  await initializePlanFixture(page, theme);
  await page.evaluate(async () => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { default: PlanApprovalDialog } = await import("/src/components/PlanApprovalDialog.tsx");
    document.getElementById("root")!.style.display = "none";
    const host = document.createElement("div");
    document.body.append(host);
    const fixture = (window as any).__APPROVAL_DIALOG__ = { approved: [] as unknown[] };
    const request = { schemaVersion: 1 as const, kind: "plan_review" as const, status: "pending" as const, createdAt: 1,
      title: "正式方案", requestId: "plan-review-fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", turnId: "plan-turn", runId: "plan-run",
      planRevision: 2, artifactHash: "d".repeat(64), artifactPaths: ["/app-data/plans/sealed/rev-2.md"] };
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return React.createElement(React.Fragment, null,
        React.createElement("button", { type: "button", onClick: () => setOpen(true) }, "审阅并批准"),
        open && React.createElement(PlanApprovalDialog, {
          request, markdown: "# 正式方案\n\n- 运行自动检查。", language: "zh",
          onClose: () => setOpen(false),
          onApprove: submitted => { fixture.approved.push({ same: submitted === request, ...submitted }); setOpen(false); },
        }));
    }
    createRoot(host).render(React.createElement(Harness));
  });
  const open = page.getByRole("button", { name: "审阅并批准" });
  const dialog = page.getByRole("dialog", { name: "审阅计划" });
  await open.click();
  await expect(dialog).toContainText("批准修订 2 后");
  await expect(dialog).toContainText("运行自动检查。");
  await expect(dialog.getByRole("button", { name: "稍后审阅" })).toBeFocused();
  await dialog.screenshot({ path: testInfo.outputPath(`${theme}-approval.png`) });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(await page.evaluate(() => (window as any).__APPROVAL_DIALOG__.approved)).toEqual([]);
  await open.click();
  await dialog.getByRole("button", { name: "批准执行" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__APPROVAL_DIALOG__.approved)).toEqual([
    expect.objectContaining({ same: true, requestId: "plan-review-fixture", sessionEpoch: "epoch-1", planRevision: 2, artifactHash: "d".repeat(64) }),
  ]);
});

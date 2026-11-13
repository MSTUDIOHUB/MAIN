import { expect, test, type Page } from "@playwright/test";

type Surface = "form" | "capsule" | "rules";

/** Real production components, isolated native transport and no model requests. */
async function mountWorkflow(page: Page, surface: Surface, theme = "dark") {
  await page.addInitScript(theme => {
    localStorage.clear();
    localStorage.setItem("local-agent-ide", JSON.stringify({ version: 2, state: { config: { language: "zh", themeMode: theme, sessionRecordingEnabled: false }, sessionsByWorkspace: {}, workspaces: [] } }));
    let callback = 1;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => callback++, unregisterCallback() {}, invoke: async (command: string) => {
      if (["list_all_session_snapshots", "list_legacy_session_files", "list_project_sessions", "discover_personal_agent_skills"].includes(command)) return [];
      if (command === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
      if (command === "plugin:event|listen") return callback++;
      if (["start_chat_stream", "stream_chat", "proxy_request"].includes(command)) throw new Error("No model transport is allowed in this component fixture");
      return null;
    } };
  }, theme);
  await page.goto("/");
  await page.evaluate(async ({ surface, theme }) => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { UserQuestionnaireForm } = await import("/src/components/UserQuestionnaireForm.tsx");
    const { default: ExecutionCapsule } = await import("/src/components/ExecutionCapsule.tsx");
    const { default: ProjectInitReviewModal } = await import("/src/components/ProjectInitReviewModal.tsx");
    const { buildUserChoiceActionRequest } = await import("/src/lib/actionRequest.ts");
    const { buildProjectRulesPreview, updateProjectRulesPreview } = await import("/src/lib/projectInit.ts");
    document.getElementById("root")!.style.display = "none";
    document.documentElement.setAttribute("data-theme", theme);
    const host = document.createElement("div");
    host.id = "structured-workflow-fixture";
    host.style.cssText = "width:720px;max-width:calc(100vw - 48px);margin:24px auto;padding:24px;border:1px solid var(--surface-border);border-radius:16px;background:var(--surface-1);color:var(--surface-text);text-align:center";
    document.body.append(host);
    const questionnaire = { revision: 1, purpose: "plan_confirmation", title: "确认方案范围", summary: "只有这里勾选或填写的要求会进入本轮计划。回答不授予文件或终端权限。", questions: [
      { id: "platform", prompt: "交付平台", selectionMode: "single", required: true, options: [{ id: "desktop", label: "桌面应用", description: "在本地运行" }, { id: "web", label: "网页应用", description: "在浏览器中使用" }] },
      { id: "checks", prompt: "选择两项验收", selectionMode: "multiple", required: true, minSelections: 2, maxSelections: 2, options: [{ id: "unit", label: "单元验证" }, { id: "ui", label: "界面验证" }, { id: "docs", label: "文档检查" }] },
      { id: "constraints", prompt: "补充限制", selectionMode: "text", required: true, options: [] },
    ] };
    const initialRequest = { ...buildUserChoiceActionRequest({ sessionKey: "__MAIN_GLOBAL_CHAT__:fixture", turnId: "turn-1", runId: "run-1", parentRunId: null, title: "方案需要确认", optionValues: [], questionnaire, now: 100 }), requestId: "question-1", executionBlocker: { sessionEpoch: "epoch-1" } };
    const inspection = { canonicalWorkspace: "/tmp/structured-plan-ui", workspaceIdentity: "workspace-fixture", targetPath: "/tmp/structured-plan-ui/AGENTS.md", exists: true, content: "# Existing rules\nKeep the project tests.\n", baseVersion: "sha256:baseline" };
    const initialPreview = buildProjectRulesPreview(inspection, "# Project rules\nUse npm test for validation.\n", "zh");
    const fixture = (window as any).__STRUCTURED_PLAN_UI__ = { answers: [] as any[], cancelled: 0, saves: [] as string[], edits: [] as string[], submitMode: "true", pending: [] as Array<(result: boolean) => void>, pendingSaves: [] as Array<() => void>, legacyReplies: [] as any[] };
    function Harness() {
      const [request, setRequest] = React.useState(initialRequest);
      const [preview, setPreview] = React.useState(initialPreview);
      const [phase, setPhase] = React.useState("review");
      const [closed, setClosed] = React.useState(false);
      fixture.replaceRequest = (patch: any) => setRequest((current: any) => ({ ...current, ...patch }));
      fixture.reviseQuestions = (patch: any) => setRequest((current: any) => ({ ...current, questionnaire: { ...current.questionnaire, ...patch } }));
      fixture.reopenRules = () => { setPhase("review"); setClosed(false); };
      const onSubmit = async (answer: any, identity: any) => {
        fixture.answers.push(JSON.parse(JSON.stringify({ answer, identity })));
        if (fixture.submitMode === "hold") return new Promise<boolean>(resolve => fixture.pending.push(resolve));
        if (fixture.submitMode === "throw") throw new Error("fixture submit failed");
        return fixture.submitMode !== "false";
      };
      const onCancel = () => { fixture.cancelled++; if (surface === "rules") setClosed(true); };
      if (surface === "rules") return closed ? null : React.createElement(ProjectInitReviewModal, { language: "zh", themeMode: theme, phase, preview, onCancel,
        onEditDraft: (content: string) => { fixture.edits.push(content); setPreview((current: any) => updateProjectRulesPreview(current, content)); },
        onRegenerate: () => setPreview(initialPreview),
        onConfirm: async () => { fixture.saves.push(preview.proposed); setPhase("committing"); await new Promise<void>(resolve => fixture.pendingSaves.push(resolve)); setPhase("success"); },
      } as any);
      if (surface === "capsule") return React.createElement(ExecutionCapsule, { title: "制定实现方案", status: "等待确认", statusToneClass: "theme-plan-pill", language: "zh", themeMode: theme, turnId: request.turnId, runId: request.runId, requestId: request.requestId,
        isRunActive: false, isAwaitingChoice: true, choiceRequest: request, onSubmitChoiceAnswer: onSubmit, onCancelTurn: onCancel,
        planTasks: [], planStage: "awaiting_confirmation", canApprovePlan: false, replyOptions: [],
        onApprovePlan: () => { throw new Error("Question answers cannot approve execution"); }, onRejectPlan: onCancel, onOpenDiff() {},
        onSelectReplyOption: (value: any) => fixture.legacyReplies.push(value),
      } as any);
      return React.createElement(UserQuestionnaireForm, { request, language: "zh", onSubmit, onCancel });
    }
    createRoot(host).render(React.createElement(Harness));
  }, { surface, theme });
  if (surface === "rules") await expect(page.getByTestId("project-init-review-dialog")).toBeVisible();
  else await expect(page.getByTestId("structured-user-questionnaire")).toBeVisible();
}

async function fillValidAnswers(page: Page) {
  const form = page.getByTestId("structured-user-questionnaire");
  await form.getByRole("radio", { name: /桌面应用/ }).check();
  await form.getByRole("checkbox", { name: "界面验证", exact: true }).check();
  await form.getByRole("checkbox", { name: "单元验证", exact: true }).check();
  await form.getByRole("textbox", { name: "补充限制", exact: true }).fill("  保留现有资料，离线运行。  ");
}

for (const surface of ["form", "capsule"] as const) {
  test(`${surface}: required and selection-count validation emits only typed answer IDs`, async ({ page }) => {
    await mountWorkflow(page, surface);
    const form = page.getByTestId("structured-user-questionnaire");
    const submit = form.getByRole("button", { name: "确认并继续", exact: true });
    await submit.click();
    await expect(form.getByRole("alert")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers.length)).toBe(0);
    await fillValidAnswers(page);
    await form.getByRole("textbox").fill("   ");
    await submit.click();
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers.length)).toBe(0);
    await form.getByRole("textbox").fill("  保留现有资料，离线运行。  ");
    await form.getByRole("checkbox", { name: "文档检查", exact: true }).check();
    await submit.click();
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers.length)).toBe(0);
    await form.getByRole("checkbox", { name: "文档检查", exact: true }).uncheck();
    await form.getByRole("checkbox", { name: "界面验证", exact: true }).uncheck();
    await submit.click();
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers.length)).toBe(0);
    await form.getByRole("checkbox", { name: "界面验证", exact: true }).check();
    await submit.click();
    await expect(form.getByRole("alert")).toHaveCount(0);
    const result = await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers[0]);
    expect(result.answer).toEqual({ requestId: "question-1", revision: 1, answers: [
      { questionId: "platform", selectedValues: ["desktop"] }, { questionId: "checks", selectedValues: ["unit", "ui"] }, { questionId: "constraints", selectedValues: [], text: "保留现有资料，离线运行。" },
    ] });
    expect(result.identity).toMatchObject({ sessionKey: "__MAIN_GLOBAL_CHAT__:fixture", turnId: "turn-1", runId: "run-1", requestId: "question-1", executionBlocker: { sessionEpoch: "epoch-1" } });
    expect(JSON.stringify(result.answer)).not.toContain("桌面应用");
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.legacyReplies)).toEqual([]);
  });

  test(`${surface}: pending, false, and thrown submissions retain editable typed answers`, async ({ page }) => {
    await mountWorkflow(page, surface);
    await fillValidAnswers(page);
    const form = page.getByTestId("structured-user-questionnaire");
    await page.evaluate(() => { (window as any).__STRUCTURED_PLAN_UI__.submitMode = "hold"; });
    await form.getByRole("button", { name: "确认并继续", exact: true }).click();
    await expect(form.getByRole("button", { name: "正在提交…", exact: true })).toBeDisabled();
    await expect(form.getByRole("radio").first()).toBeDisabled();
    await expect(form.getByRole("textbox")).toBeDisabled();
    await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.pending.shift()(false));
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(form.getByRole("textbox")).toHaveValue("  保留现有资料，离线运行。  ");
    await page.evaluate(() => { (window as any).__STRUCTURED_PLAN_UI__.submitMode = "throw"; });
    await form.getByRole("button", { name: "确认并继续", exact: true }).click();
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(form.getByRole("button", { name: "确认并继续", exact: true })).toBeEnabled();
  });

  test(`${surface}: optional questions require one explicit decision and Stop submits no answer`, async ({ page }) => {
    await mountWorkflow(page, surface);
    await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.reviseQuestions({ revision: 2, questions: [
      { id: "platform", prompt: "可选交付平台", selectionMode: "single", required: false, options: [{ id: "desktop", label: "桌面应用" }, { id: "web", label: "网页应用" }] },
      { id: "notes", prompt: "可选补充要求", selectionMode: "text", required: false, options: [] },
    ] }));
    const form = page.getByTestId("structured-user-questionnaire");
    const submit = form.getByRole("button", { name: "确认并继续", exact: true });
    const notes = form.getByRole("textbox", { name: "可选补充要求", exact: true });
    await expect(form.getByRole("radio").first()).not.toBeChecked();
    await expect(notes).toHaveValue("");
    await submit.click();
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers)).toEqual([]);
    await expect(form.getByRole("alert")).toHaveText("请至少选择一项或填写一项有效回答。");
    await notes.fill("   ");
    await submit.click();
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers)).toEqual([]);
    await form.getByRole("radio", { name: "桌面应用", exact: true }).check();
    await submit.click();
    await expect(form.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers.map((entry: any) => entry.answer))).toEqual([
      { requestId: "question-1", revision: 2, answers: [{ questionId: "platform", selectedValues: ["desktop"] }, { questionId: "notes", selectedValues: [] }] },
    ]);
    await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.replaceRequest({ requestId: "question-optional-text" }));
    await expect(form.getByRole("radio").first()).not.toBeChecked();
    await expect(notes).toHaveValue("");
    await notes.fill("  只保留本地运行要求。  ");
    await submit.click();
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers[1].answer)).toEqual({
      requestId: "question-optional-text", revision: 2, answers: [{ questionId: "platform", selectedValues: [] }, { questionId: "notes", selectedValues: [], text: "只保留本地运行要求。" }],
    });
    await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.replaceRequest({ requestId: "question-optional-stop" }));
    await expect(notes).toHaveValue("");
    await form.getByRole("button", { name: "停止", exact: true }).click();
    expect(await page.evaluate(() => ({ answers: (window as any).__STRUCTURED_PLAN_UI__.answers.length, cancelled: (window as any).__STRUCTURED_PLAN_UI__.cancelled, legacyReplies: (window as any).__STRUCTURED_PLAN_UI__.legacyReplies }))).toEqual({ answers: 2, cancelled: 1, legacyReplies: [] });
  });
}

test("same request/revision with a replacement owner resets old answers in the real Capsule form", async ({ page }) => {
  await mountWorkflow(page, "capsule");
  await fillValidAnswers(page);
  await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.replaceRequest({ sessionKey: "__MAIN_GLOBAL_CHAT__:replacement", turnId: "turn-2", runId: "run-2", executionBlocker: { sessionEpoch: "epoch-2" } }));
  const form = page.getByTestId("structured-user-questionnaire");
  await expect(form.getByRole("radio").first()).not.toBeChecked();
  await expect(form.getByRole("checkbox").first()).not.toBeChecked();
  await expect(form.getByRole("textbox")).toHaveValue("");
  await fillValidAnswers(page);
  await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.reviseQuestions({ revision: 2 }));
  await expect(form.getByRole("radio").first()).not.toBeChecked();
  await expect(form.getByRole("textbox")).toHaveValue("");
});

test("a changed request clears answers and a late old false result cannot mark the new request invalid", async ({ page }) => {
  await mountWorkflow(page, "form");
  await fillValidAnswers(page);
  const form = page.getByTestId("structured-user-questionnaire");
  await page.evaluate(() => { (window as any).__STRUCTURED_PLAN_UI__.submitMode = "hold"; });
  await form.getByRole("button", { name: "确认并继续", exact: true }).click();
  await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.replaceRequest({ requestId: "question-2" }));
  await expect(form.getByRole("textbox")).toHaveValue("");
  await expect(form.getByRole("button", { name: "确认并继续", exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.pending.shift()(false));
  await expect(form.getByRole("alert")).toHaveCount(0);
});

test("an old submission cannot unlock or invalidate the replacement request's pending submission", async ({ page }) => {
  await mountWorkflow(page, "capsule");
  const form = page.getByTestId("structured-user-questionnaire");
  await page.evaluate(() => { (window as any).__STRUCTURED_PLAN_UI__.submitMode = "hold"; });
  await fillValidAnswers(page);
  await form.getByRole("button", { name: "确认并继续", exact: true }).click();
  await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.replaceRequest({ requestId: "question-2" }));
  await expect(form.getByRole("radio").first()).toHaveAttribute("name", "question-2:platform");
  await expect(form.getByRole("textbox")).toHaveValue("");
  await fillValidAnswers(page);
  await form.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect(form.getByRole("button", { name: "正在提交…", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.pending.length)).toBe(2);
  await page.evaluate(async () => { (window as any).__STRUCTURED_PLAN_UI__.pending.shift()(false); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  await expect(form.getByRole("button", { name: "正在提交…", exact: true })).toBeDisabled();
  await expect(form.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.pending.shift()(true));
  await expect(form.getByRole("button", { name: "确认并继续", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.answers.map((entry: any) => entry.answer.requestId))).toEqual(["question-1", "question-2"]);
});

for (const theme of ["light", "dark", "black"] as const) {
  test(`structured Capsule choices remain readable in ${theme}`, async ({ page }, testInfo) => {
    await mountWorkflow(page, "capsule", theme);
    await fillValidAnswers(page);
    const form = page.getByTestId("structured-user-questionnaire");
    const desktop = form.getByRole("radio", { name: /桌面应用/ });
    const web = form.getByRole("radio", { name: /网页应用/ });
    const metrics = await form.evaluate(element => {
      const prompt = element.querySelector(".user-questionnaire-prompt")!;
      const label = element.querySelector(".user-questionnaire-option-label")!;
      const selected = element.querySelector(".user-questionnaire-option[data-selected='true']")!;
      const unselected = element.querySelector(".user-questionnaire-option[data-selected='false']")!;
      const marker = selected.querySelector("input")!.getBoundingClientRect();
      const copy = selected.querySelector(".user-questionnaire-option-copy")!.getBoundingClientRect();
      return { textAlign: getComputedStyle(element).textAlign,
        summaryAlign: getComputedStyle(element.querySelector(".user-questionnaire-summary")!).textAlign,
        promptSize: parseFloat(getComputedStyle(prompt).fontSize), optionSize: parseFloat(getComputedStyle(label).fontSize),
        promptWeight: parseFloat(getComputedStyle(prompt).fontWeight), optionWeight: parseFloat(getComputedStyle(label).fontWeight),
        groupRing: getComputedStyle(element.querySelector(".user-questionnaire-options")!).boxShadow,
        selectedBackground: getComputedStyle(selected).backgroundColor, unselectedBackground: getComputedStyle(unselected).backgroundColor,
        selectedRing: getComputedStyle(selected).boxShadow,
        centerOffset: Math.abs(marker.y + marker.height / 2 - copy.y - copy.height / 2) };
    });
    expect(metrics.textAlign).toBe("left");
    expect(metrics.summaryAlign).toBe("left");
    expect(metrics.promptSize).toBeGreaterThan(metrics.optionSize);
    expect(metrics.promptWeight).toBeGreaterThan(metrics.optionWeight);
    expect(metrics.groupRing).not.toBe("none");
    expect(metrics.selectedRing).not.toBe("none");
    expect(metrics.selectedBackground).not.toBe(metrics.unselectedBackground);
    expect(metrics.centerOffset).toBeLessThan(1);

    await desktop.focus();
    await page.keyboard.press("ArrowRight");
    await expect(web).toBeFocused();
    await expect(web).toBeChecked();
    await expect(desktop).not.toBeChecked();
    const selectedWeb = form.locator(".user-questionnaire-option").filter({ has: page.getByRole("radio", { name: /网页应用/ }) });
    await expect(selectedWeb).toHaveAttribute("data-selected", "true");
    await expect(selectedWeb).toHaveCSS("outline-style", "solid");
    await expect(selectedWeb).toHaveCSS("outline-width", "2px");
    await page.getByTestId("execution-capsule-shell").screenshot({ path: testInfo.outputPath(`structured-questionnaire-${theme}.png`), animations: "disabled" });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.reviseQuestions({ revision: 2, questions: [
      { id: "long-path", prompt: "游戏场景应该放到哪个文件？请确认名称与当前项目的场景路径。", selectionMode: "single", required: true,
        options: [{ id: "reuse", label: "复用Assets/Scenes/CollectorTestWithAVeryLongUnbrokenSceneName.unity", description: "保留现有场景结构，并在当前场景中配置玩家、金币和显示分数的界面。" },
          { id: "new", label: "新建一个场景" }] },
    ] }));
    await form.getByRole("radio").first().check();
    const narrow = await form.evaluate(element => {
      const row = element.querySelector(".user-questionnaire-option")!;
      const marker = row.querySelector("input")!.getBoundingClientRect();
      const copy = row.querySelector(".user-questionnaire-option-copy")!.getBoundingClientRect();
      return { formWidth: element.clientWidth, contentWidth: element.scrollWidth,
        rowWidth: row.clientWidth, rowContentWidth: row.scrollWidth,
        textHeight: copy.height, centerOffset: Math.abs(marker.y + marker.height / 2 - copy.y - copy.height / 2) };
    });
    expect(narrow.contentWidth).toBeLessThanOrEqual(narrow.formWidth + 1);
    expect(narrow.rowContentWidth).toBeLessThanOrEqual(narrow.rowWidth + 1);
    expect(narrow.textHeight).toBeGreaterThan(40);
    expect(narrow.centerOffset).toBeLessThan(1);
    await page.getByTestId("execution-capsule-shell").screenshot({ path: testInfo.outputPath(`structured-questionnaire-narrow-${theme}.png`), animations: "disabled" });
  });

  test(`rules draft supports lossless editing, live diff, empty input, save and cancel in ${theme}`, async ({ page }, testInfo) => {
    await mountWorkflow(page, "rules", theme);
    const editor = page.getByTestId("rules-draft-editor");
    const diff = page.getByTestId("project-init-review-diff");
    const revised = "# 项目规则\n保留用户资料。\n提交前运行 npm test。\n";
    await editor.fill(revised);
    await expect(diff).toContainText("+保留用户资料。");
    await expect(diff).toContainText("-Keep the project tests.");
    await editor.fill("");
    await expect(editor).toHaveValue("");
    await expect(page.getByTestId("project-init-review-confirm")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.saves)).toEqual([]);
    await editor.fill(revised);
    await expect(page.getByTestId("project-init-review-confirm")).toBeEnabled();
    await expect(diff).toContainText("+提交前运行 npm test。");
    await page.getByTestId("project-init-review-dialog").screenshot({ path: testInfo.outputPath(`rules-draft-${theme}.png`), animations: "disabled" });
    await page.getByTestId("project-init-review-confirm").click();
    await expect(page.getByTestId("project-init-review-confirm")).toBeDisabled();
    await expect(page.getByTestId("project-init-review-cancel")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-init-review-dialog")).toBeVisible();
    await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.pendingSaves.shift()());
    await expect(page.getByTestId("project-init-review-success")).toBeVisible();
    await page.getByTestId("project-init-review-close").click();
    await expect(page.getByTestId("project-init-review-dialog")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.saves)).toEqual([revised]);
    await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.reopenRules());
    await page.getByTestId("rules-draft-editor").fill("未保存的修改");
    await page.getByTestId("project-init-review-cancel").click();
    await expect(page.getByTestId("project-init-review-dialog")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__STRUCTURED_PLAN_UI__.saves)).toEqual([revised]);
  });
}

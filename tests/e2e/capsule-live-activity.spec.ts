import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

const scenePath = "Assets/Scenes/SampleScene.unity";
const privateOutput = "PRIVATE_STREAM_CONTENT_MUST_STAY_OUT_OF_ACTIVITY";
const sceneContent = `sceneName: SampleScene\ncomment: ${privateOutput}\n`;
const contentVersion = `sha256-${createHash("sha256").update(sceneContent).digest("hex")}`;

/** Seed a temporary workspace through the existing bridge and replace only
 * native I/O. The real Plan runner owns request, tool and pause transitions. */
async function mountPlanTransport(page: Page, fromComposer = false) {
  await page.addInitScript(({ scenePath, sceneContent, contentVersion }) => {
    localStorage.clear();
    const callbacks = new Map<number, (event: any) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let sequence = 0;
    let releaseRead: (() => void) | undefined;
    let finishOneShot: ((answer: string) => void) | undefined;
    const streams: Array<{ streamId: string; body: any }> = [];
    const oneShotRequests: unknown[] = [];
    const reads: string[] = [];
    const canceledStreams: string[] = [];
    const planDocuments = new Map<string, any>();
    const emit = (event: string, payload: unknown) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    const chunk = (stream: number, text: string) => emit("chat-stream-chunk", {
      stream_id: streams[stream].streamId,
      chunk: text,
    });
    (window as any).__CAPSULE_PLAN_IO__ = {
      streams,
      reads,
      canceledStreams,
      oneShotRequests,
      chunk,
      releaseRead: () => releaseRead?.(),
      finishOneShot: (answer: string) => finishOneShot?.(answer),
      finishText: (stream: number, content: string) => {
        chunk(stream, `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        emit("chat-stream-done", { stream_id: streams[stream].streamId, status: "ok" });
      },
      fail: (stream: number) => emit("chat-stream-done", {
        stream_id: streams[stream].streamId,
        status: "error",
        error: "error reading response body",
      }),
      tool: (stream: number, name: string, args: object, index = 0) => {
        chunk(stream, `data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index, id: `fixture-call-${stream}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
            finish_reason: null,
          }],
        })}\n\n`);
      },
      finish: (stream: number) => {
        chunk(stream, 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
        emit("chat-stream-done", { stream_id: streams[stream].streamId, status: "ok" });
      },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback(callback: (event: any) => void) {
        const id = ++sequence;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === "plugin:event|listen") {
          const id = ++sequence;
          listeners.set(id, { event: args.event, handler: args.handler });
          return id;
        }
        if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
        if (command === "start_chat_stream") {
          streams.push({ streamId: args.streamId, body: JSON.parse(args.body) });
          return null;
        }
        if (command === "cancel_chat_stream") { canceledStreams.push(args.streamId); return null; }
        if (command === "get_system_memory") return { total_gb: 32, available_gb: 24 };
        if (command === "canonicalize_workspace_path" || command === "set_workspace_root") return args.path;
        if (command === "get_workspace_root") return "/tmp/e2e-capsule-live-plan";
        if (command === "get_git_status") return { isRepo: false, gitAvailable: true, clean: true };
        if (command === "main_update_status") return { status: "idle" };
        if (command === "save_project_session") return args.session;
        if (command === "save_plan_document") {
          const { owner, documentId, title, kind, markdown } = args.input;
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
          const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
          const reference = { owner, documentId, title, kind, contentHash, revision: 1, path: `fixture-plans/${documentId}/rev-1.md` };
          planDocuments.set(documentId, { ...reference, markdown });
          return reference;
        }
        if (command === "read_plan_document") return planDocuments.get(args.reference.documentId);
        if (["list_all_session_snapshots", "list_legacy_session_files", "list_project_sessions", "rebuild_project_sessions_index", "discover_personal_agent_skills", "list_directory", "glob_search"].includes(command)) return [];
        if (command === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
        if (command === "get_project_skeleton") return `.\n- ${scenePath}`;
        if (command === "read_file_window" && args.path.endsWith(scenePath)) {
          reads.push(args.path);
          await new Promise<void>((resolve) => { releaseRead = resolve; });
          return { path: args.path, content: sceneContent, contentVersion, startLine: 1, endLine: 2, totalLines: 2, totalChars: sceneContent.length, returnedChars: sceneContent.length, truncated: false, nextStartLine: null };
        }
        if (command === "read_file" || command === "read_file_window") throw new Error("ENOENT");
        if (command === "proxy_request" || command === "proxy_request_detailed") {
          let body: string;
          if (args.body) {
            oneShotRequests.push(JSON.parse(args.body));
            const answer = await new Promise<string>((resolve) => { finishOneShot = resolve; });
            body = JSON.stringify({ choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }] });
          } else {
            body = JSON.stringify({ data: [{ id: "capsule-fixture", context_length: 32768, loaded: true }] });
          }
          return command === "proxy_request_detailed" ? { status: 200, body } : body;
        }
        return null;
      },
    };
    (window as any).__REAL_OMLX_WORKSPACE__ = "/tmp/e2e-capsule-live-plan";
  }, { scenePath, sceneContent, contentVersion });
  await page.goto("/?e2eScenario=real-omlx-plan-flow&model=capsule-fixture");
  await expect(page.getByTestId("composer-textarea")).toBeVisible();
  if (fromComposer) {
    const composer = page.getByTestId("composer-textarea");
    await composer.fill("/计划 为现有场景拟定测试计划。确认输入方式，安排可执行的 Play Mode 检查。");
    await composer.press("Enter");
    await expectStreams(page, 1);
    await page.evaluate(() => {
      const io = (window as any).__CAPSULE_PLAN_IO__;
      io.finishText(0, JSON.stringify({ title: "场景验证计划", semantic: {
        objective: "确认输入方式并为现有场景安排可执行的 Play Mode 检查。", workType: "plan", answerFormat: "plan",
        requiredCapabilities: ["workspace_read"], forbiddenCapabilities: [], approvalRequiredCapabilities: [],
      } }));
      io.streams.shift(); // Subsequent indexes refer to the admitted Plan requests.
    });
    return;
  }
  const admitted = await page.evaluate(() => (window as any).__CODELY_E2E__.sendRealMessage(
    "为现有场景拟定测试计划。读取 SampleScene 后请确认输入方式。",
    { resolvedIntent: "plan", skipIntentResolution: true, subagentPreferenceOverride: "forbidden" },
  ));
  expect(admitted).toBe(true);
}

async function expectStreams(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.streams.length)).toBe(count);
}

test("Plan Capsule follows model and tool boundaries and M shows only recorded activity", async ({ page }, testInfo) => {
  await mountPlanTransport(page);
  const capsule = page.getByTestId("agent-explanation-capsule");
  const guidance = capsule.getByTestId("capsule-guidance-label");
  const activity = page.getByTestId("effective-progress-popover");
  const trigger = page.getByRole("button", { name: "查看本轮活动", exact: true });
  const rows = activity.getByTestId("turn-activity-row");

  await expectStreams(page, 1);
  await expect(capsule).toHaveAttribute("data-activity-kind", "waiting");
  await expect(guidance).toContainText("等待模型响应");
  await expect(capsule).not.toContainText("整理成可审核的修复计划");
  await trigger.click();
  await expect(activity).toBeVisible();
  await expect(activity.getByTestId("run-status-current-activity")).toContainText("等待模型响应");
  await expect(activity.getByTestId("turn-activity-empty")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(activity).toBeHidden();
  await expect(trigger).toBeFocused();

  // The transport receives bytes twice without any model output. Deliver the
  // semantic tool delta separately so the test can inspect each boundary.
  await page.evaluate(async () => {
    const fixture = (window as any).__CAPSULE_PLAN_IO__;
    fixture.chunk(0, ': heartbeat\n\n');
    fixture.chunk(0, 'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(capsule).toHaveAttribute("data-activity-kind", "waiting");
  await page.evaluate((path) => {
    (window as any).__CAPSULE_PLAN_IO__.tool(0, "read_file", { path });
  }, scenePath);
  await expect(capsule).toHaveAttribute("data-activity-kind", "receiving");
  await expect(guidance).toContainText("正在接收模型输出");
  await page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.finish(0));
  await expect.poll(() => page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.reads.length)).toBe(1);
  await expect(capsule).toHaveAttribute("data-activity-kind", "tool");
  await expect(guidance).toContainText("SampleScene.unity");
  await expect(guidance).toContainText("正在读取");

  await page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.releaseRead());
  await expectStreams(page, 2);
  await expect(capsule).toHaveAttribute("data-activity-kind", "waiting");
  await trigger.click();
  await expect(activity.getByRole("heading", { name: "本轮活动", exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: "SampleScene.unity" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "SampleScene.unity" })).toHaveAttribute("data-outcome", "succeeded");
  await expect(activity).not.toContainText(privateOutput);
  await expect(activity).not.toContainText("正在形成计划");
  await expect(activity).not.toContainText("最近里程碑");

  for (const theme of ["light", "dark", "black"] as const) {
    await page.evaluate((mode) => (window as any).__CODELY_E2E__.setThemeMode(mode), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(activity).toBeVisible();
    await activity.screenshot({ path: testInfo.outputPath(`turn-activity-${theme}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 420, height: 720 });
  expect(await activity.evaluate(element => {
    const { left, right } = element.getBoundingClientRect();
    return left >= 0 && right <= window.innerWidth && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.evaluate(() => {
    const fixture = (window as any).__CAPSULE_PLAN_IO__;
    fixture.tool(1, "ask_plan_questions", {
      title: "确认场景测试方式",
      questions: [{
        id: "input",
        prompt: "测试时使用键盘还是手柄？",
        selectionMode: "single",
        options: [{ id: "keyboard", label: "键盘" }, { id: "gamepad", label: "手柄" }],
        required: true,
      }],
    });
    fixture.finish(1);
  });
  await expect(capsule.getByTestId("structured-user-questionnaire")).toBeVisible();
  await expect(capsule).toHaveAttribute("data-activity-kind", "action");
  await expect(capsule).not.toContainText(privateOutput);
  await trigger.click();
  await expect(rows.first()).toContainText(/等待|暂停/);
  await expect(rows.filter({ hasText: "SampleScene.unity" })).toHaveCount(1);
  await expect(activity).not.toContainText("ask_plan_questions");
  const runId = await capsule.getAttribute("data-run-id");
  await page.keyboard.press("Escape");
  const form = capsule.getByTestId("structured-user-questionnaire");
  await form.getByRole("radio", { name: "键盘", exact: true }).check();
  await form.getByRole("radio", { name: "形成并保存计划文档", exact: true }).check();
  await form.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expectStreams(page, 3);
  await expect(capsule).toHaveAttribute("data-run-id", runId!);
  await expect(capsule).toHaveAttribute("data-activity-kind", "waiting");
  const confirmed = page.getByTestId("user-question-answer-history");
  await expect(confirmed).toContainText("测试时使用键盘还是手柄？");
  await expect(confirmed).toContainText("键盘");
  await trigger.click();
  await expect(rows.first()).toHaveAttribute("data-outcome", "resumed");
  await expect(rows.filter({ hasText: "SampleScene.unity" })).toHaveCount(1);
  await expect(activity).not.toContainText("测试时使用键盘还是手柄？");
});

test("Plan from the composer reuses a confirmed answer and reaches a single review", async ({ page }) => {
  await mountPlanTransport(page, true);
  const capsule = page.getByTestId("agent-explanation-capsule");
  const form = page.getByTestId("structured-user-questionnaire");
  const history = page.getByTestId("user-question-answer-card");
  const question = { id: "input", prompt: "测试时使用键盘还是手柄？", selectionMode: "single", required: true,
    options: [{ id: "keyboard", label: "键盘" }, { id: "gamepad", label: "手柄" }] };
  await expectStreams(page, 1);
  await page.evaluate(spec => {
    const io = (window as any).__CAPSULE_PLAN_IO__;
    io.tool(0, "ask_plan_questions", { title: "确认场景测试方式", questions: [spec] });
    io.finish(0);
  }, question);
  await expect(form).toBeVisible();
  const runId = await capsule.getAttribute("data-run-id");
  await form.getByRole("radio", { name: "键盘", exact: true }).check();
  await form.getByRole("radio", { name: /形成可审核的实施计划/ }).check();
  await form.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expectStreams(page, 2);

  await page.evaluate(spec => {
    const io = (window as any).__CAPSULE_PLAN_IO__;
    io.tool(1, "ask_plan_questions", { title: "再次确认测试方式", questions: [{ ...spec, id: "input-again" }] });
    io.finish(1);
  }, question);
  await expectStreams(page, 3);
  await expect(form).toHaveCount(0);
  await expect(capsule).toHaveAttribute("data-run-id", runId!);
  await expect(history).toHaveCount(1);
  await expect(history).toContainText("键盘");

  await page.evaluate(() => {
    const io = (window as any).__CAPSULE_PLAN_IO__;
    ["Assets/Tests/**/*.cs", "Assets/**/*.asmdef", "Packages/manifest.json"].forEach((pattern, index) =>
      io.tool(2, "glob_search", { pattern }, index));
    io.finish(2);
  });
  await expectStreams(page, 4);
  await page.evaluate(path => {
    const io = (window as any).__CAPSULE_PLAN_IO__;
    io.tool(3, "read_file", { path });
    io.finish(3);
  }, scenePath);
  await expect.poll(() => page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.reads.length)).toBe(1);
  await page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.releaseRead());
  await expectStreams(page, 5);

  await page.evaluate(path => {
    const io = (window as any).__CAPSULE_PLAN_IO__;
    const receipt = io.streams[4].body.messages.find((message: any) => message.tool_call_id === "fixture-call-3-0");
    const evidenceId = /^\[(E\d+)\]/.exec(receipt?.content || "")?.[1];
    if (!evidenceId) throw new Error("Expected the scene read receipt on the next model request");
    io.tool(4, "submit_runtime_v2_work_plan", {
      planMarkdown: "# 场景验证计划\n\n保留现有场景，补充键盘输入的 Play Mode 测试。",
      changes: [{ operation: "create", targets: ["Assets/Tests/KeyboardSceneTest.cs"],
        change: `补充测试，确认 ${path} 正确响应键盘输入。`, basis: [evidenceId] }],
      validations: [{ kind: "finite_command", command: "Unity -batchmode -projectPath . -runTests -testPlatform PlayMode -testResults playmode.xml",
        expectedOutcome: "场景响应键盘输入的 Play Mode 测试通过。" }],
    });
    io.finish(4);
  }, scenePath);
  await expect(page.getByRole("button", { name: "审阅并批准", exact: true }).first()).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(history).toHaveCount(1);
  const events = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot().aggregate.events);
  const searches = new Set(events.filter((event: any) => event.type === "command.scheduled" && event.command.payload.toolName === "glob_search")
    .map((event: any) => event.command.idempotencyKey));
  expect(events.filter((event: any) => event.type === "tool.completed" && searches.has(event.idempotencyKey) && event.status === "succeeded")).toHaveLength(3);
  expect(events.filter((event: any) => event.type === "run.paused" && event.blocker.questionnaire)).toHaveLength(1);
  expect(events.filter((event: any) => event.type === "work_plan.sealed")).toHaveLength(1);
  expect(events.filter((event: any) => event.type === "work_plan.approved")).toHaveLength(0);
});

test("Canceled Plan callbacks cannot update a new chat and a one-shot retry returns to waiting", async ({ page }) => {
  await mountPlanTransport(page);
  const capsule = page.getByTestId("agent-explanation-capsule");
  await expectStreams(page, 1);
  await expect(capsule).toHaveAttribute("data-activity-kind", "waiting");
  const planSession = await capsule.getAttribute("data-session-key");
  await page.getByTestId("composer-stop-button").click();
  await expect.poll(() => page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.canceledStreams.length)).toBeGreaterThan(0);
  await expect(page.getByTestId("composer-stop-button")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot().runtimeV2?.terminal))
    .toMatchObject({ exactlyOnce: true, turnResultKind: "canceled" });

  await page.evaluate(() => {
    const bridge = (window as any).__CODELY_E2E__;
    bridge.prepareReadOnlyChat(false);
    if (!bridge.sendReadOnlyMessage("回复一条简短的测试消息。")) throw new Error("Chat was not admitted");
  });
  await expectStreams(page, 2);
  await expect(capsule).not.toHaveAttribute("data-session-key", planSession!);
  await expect(capsule).toHaveAttribute("data-activity-kind", "waiting");
  await page.evaluate(async (marker) => {
    const fixture = (window as any).__CAPSULE_PLAN_IO__;
    const delta = (data: object) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: data, finish_reason: null }] })}\n\n`;
    fixture.chunk(0, delta({ content: marker }));
    fixture.tool(0, "ask_plan_questions", { title: "已取消的提问", questions: [
      { id: "late", prompt: "是否继续？", selectionMode: "text", required: true, options: [] },
    ] });
    fixture.finish(0);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, privateOutput);
  await expect(capsule).toHaveAttribute("data-activity-kind", "waiting");
  await expect(capsule).not.toContainText(privateOutput);
  await expect(page.getByTestId("structured-user-questionnaire")).toHaveCount(0);

  await page.evaluate((marker) => {
    (window as any).__CAPSULE_PLAN_IO__.chunk(1, `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { reasoning_content: marker }, finish_reason: null }],
    })}\n\n`);
  }, privateOutput);
  await expect(capsule).toHaveAttribute("data-activity-kind", "receiving");
  await expect(capsule).not.toContainText(privateOutput);
  await page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.fail(1));
  await expect.poll(() => page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.oneShotRequests.length)).toBe(1);
  await expect(capsule).toHaveAttribute("data-activity-kind", "waiting");
  await expect(capsule.getByTestId("capsule-guidance-label")).toContainText("等待模型响应");
  await page.evaluate(() => (window as any).__CAPSULE_PLAN_IO__.finishOneShot("测试消息已收到。"));
  await expect(page.getByTestId("chat-scroll-container")).toContainText("测试消息已收到。");
  await expect(capsule).toBeHidden();
});

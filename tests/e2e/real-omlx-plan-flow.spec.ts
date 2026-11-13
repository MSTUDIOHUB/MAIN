import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isFinitePlanValidationCommand,
} from "../../src/lib/workflowModels";
import { isWorkspaceMutationToolName } from "../../src/lib/workspaceMutationTools";
import {
  normalizeRuntimeV2Checkpoint,
  validateWorkPlanDraftV1,
} from "../../src/lib/runtime-v2";
import {
  validateSealedWorkPlanV1Integrity,
} from "../../src/store/runtimeV2/workPlanAdapter";
import {
  hashPlanCandidate,
  PLAN_CANDIDATE_SCHEMA_VERSION,
  validateSealedPlanCandidate,
} from "../../src/lib/planContract";
import { PLAN_AUTHORING_CONTRACT_VERSION } from "../../src/lib/planAuthoringContract";
import { analyzeValidationCommand, isAcceptanceCapableValidationSpec } from "../../src/lib/validationContract";
import {
  collectBoundedRealOmlxWorkspaceFiles,
  checkRealOmlxSourceSyntax,
  createRealOmlxAcceptanceState,
  readBoundedRealOmlxWorkspaceTextFile,
  readBoundedRealOmlxWorkspaceTextFiles,
  readRealOmlxWorkspaceFileWindow,
  recordRealOmlxAcceptanceDebugEvent,
  REAL_OMLX_WORKSPACE_PROXY_LIMITS,
  runRealOmlxWorkspaceCommand,
  selectBoundedRealOmlxSearchFiles,
  shouldPruneRealOmlxWorkspaceDirectory,
  type RealOmlxWorkspaceInventory,
} from "./realOmlxWorkspaceProxy";
import {
  getMdViewerExecutionGaps,
  getMdViewerFinalSummaryGaps,
  getNewUndeclaredCallGaps,
  getMdViewerWorkPlanGaps,
} from "./realOmlxMdViewerPlanOracle";
import { expectRuntimeV2ReadOnlyCollaboration } from "./runtimeV2StructuralAssertions";
import { invokeRuntimeToolBridge } from "./runtimeToolBridge";
import { createCsvCreatorMappingOracle, prepareCsvDirectEditRepairFixture, useDefaultCsvBehaviorOracle, verifyCsvDirectEditRepairFixture } from "./realOmlxDirectEditFixture";
import { createRealOmlxStreamCapture, createRealOmlxStreamInactivity } from "./realOmlxStreamHarness";
import { validateRealOmlxPlannedPermission, type RealOmlxApprovedPlanBinding, type RealOmlxPlanPermissionObservation } from "./realOmlxPlanPermission";
import { createRealOmlxChatTelemetry } from "./realOmlxChatTelemetry";
import { canonicalChatNetworkRead, expectActualWebReadProviders, expectGlobalReadOnlyChatReply, type RealOmlxWebInvocation } from "./realOmlxChatReadOnlyAssertions";
import { verifyUnityCollector } from "./realUnityCollectorOracle";
import { observeRuntimeTask } from "./runtimeTaskObservation";

const runRealOmlx = process.env.MAIN_REAL_OMLX_E2E === "1";
const omlxEndpoint = String(
  process.env.OMLX_ENDPOINT || process.env.OMLX_BASE_URL || "http://127.0.0.1:8000/v1",
).replace(/\/+$/, "");
const omlxApiKey = String(process.env.OMLX_API_KEY || "mmnn");
const models = (process.env.OMLX_MODELS || (runRealOmlx ? "" : "e2e-placeholder-model"))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
if (runRealOmlx && models.length !== 1) {
  throw new Error(
    `Real OMLX validation requires exactly one explicit OMLX_MODELS id; received ${models.length}.`,
  );
}
const realOmlxFixture = String(
  process.env.REAL_OMLX_FIXTURE || "csv",
).trim().toLowerCase();
const realOmlxRequest =
  process.env.REAL_OMLX_REQUEST ||
  (
    realOmlxFixture === "md-viewer"
      ? "问题：1、在编辑界面显示了文件名和未保存的文档名字，这是不合理的。2、打开本地 md 文件后随后会弹出窗口，看起来是文件保存执行路径有关的问题。找到这些问题的根本原因并修复。"
      : realOmlxFixture === "snake"
        ? "请先生成可审批计划，再严格按依赖阶段实现一个 Python 贪吃蛇游戏：S1 使用 Python 标准库 tkinter 完成 snake.py 的 GUI 与可测试核心逻辑，禁止 pygame 等第三方运行时依赖；S2 在 S1 之后创建 test_snake.py；S3 在 S1、S2 之后更新 README.md。游戏须支持方向键和 WASD、计分、食物增长、撞墙/自身结束、R 键与按钮重启。结构化计划必须显式填写 S1 dependsOn=[]、S2 dependsOn=[0]、S3 dependsOn=[0,1]；分别列出精确且独立的 python3 -m compileall -q . 与 python3 -m unittest -v 两项 required validation，两项的 stepIndexes 都填写 [0,1,2]（测试也检查 README 启动说明）。每个 change 和 required validation 都须用 criterionIds 映射 Runtime 给出的 criterion-user-objective。请把一个边界明确的约束/逻辑/测试设计调查交给只读子 Agent，父线程并行取证，汇合并在可执行 change 的结构化 basis 中采用其证据后再提交计划；批准后按阶段修改，最后依次运行两项验证直到通过。"
      : "请修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。先生成可审批计划，批准后真实修改，并运行 npm test 验证直到通过。"
  );
const realOmlxPlanOnly = process.env.REAL_OMLX_PLAN_ONLY === "1";
const realOmlxPreferSubagents = process.env.REAL_OMLX_PREFER_SUBAGENTS === "1";
const breakoutTask = "实现基本的打砖块游戏，使用2D Sprite做原型创作。UI使用legacy的unity ui，每次打掉砖块得到分数。如果有什么不清楚的向我提问";
const breakoutReplayConfirmation = process.env.REAL_OMLX_BREAKOUT_REPLAY_CONFIRMATION === "1";
const breakoutResumeSessionId = Number(process.env.REAL_OMLX_BREAKOUT_RESUME_SESSION_ID || 0);
const breakoutLegacyClarifier = "项目缺少 TextMeshPro 包（com.unity.textmeshpro），无法使用 TextMeshProUGUI 组件。你希望如何处理分数文本？A) 使用 legacy Text 组件（com.unity.ugui 内置，无需额外包）；B) 我帮你安装 TextMeshPro 包（需要联网，可能耗时）。";
const breakoutLegacyRestatement = "沿用原指令：UI使用legacy的unity ui。";
// Public tool call and decisions from the Nov 8 incident. Sequence 71 is
// replayed once at the provider boundary; sequence 79 is entered in the UI.
const breakoutConfirmation = {
  sessionId: "1794125357377",
  providerSequence: 71,
  decisionSequence: 79,
  callId: "call_31bd8fec",
  publicText: "我需要确认几个关键设计决策，以便制定准确的计划。",
  arguments: {
    title: "打砖块游戏设计确认",
    questions: [
      {
        id: "verify_method", minSelections: 1, selectionMode: "single",
        prompt: "游戏完成后，你希望用哪种方式验证？这决定了我们如何搭建测试流程。",
        options: [
          { id: "unity_pipeline", label: "Unity Editor 自动化验证（安装 unity-pipeline，编译+进入Play Mode跑逻辑+截图）" },
          { id: "manual_play", label: "仅生成工程，由你在Unity里手动进入Play Mode测试" },
          { id: "unit_test", label: "编写C#单元测试验证核心逻辑（如砖块击碎加分）" },
        ],
      },
      {
        id: "scene_approach", minSelections: 1, selectionMode: "single",
        prompt: "打砖块游戏需要搭建场景（砖块、球、挡板、UI、相机、灯光）。你希望怎么组织？",
        options: [
          { id: "generate_scene", label: "用脚本自动生成完整场景（含所有GameObject、组件、UI、物理体）" },
          { id: "reuse_existing", label: "在现有CollectorTest.unity场景上搭建" },
          { id: "new_scene", label: "新建一个专门的Breakout场景" },
        ],
      },
      {
        id: "ball_paddle", minSelections: 1, selectionMode: "single",
        prompt: "球和挡板的交互细节，你希望实现到什么程度？",
        options: [
          { id: "basic", label: "基础版：球按物理反弹，挡板固定或左右移动接球，掉出屏幕下方扣分/结束" },
          { id: "angle_control", label: "加角度控制：球接触挡板不同位置改变反弹角度" },
          { id: "lives", label: "加生命值：多次失误才结束，含Game Over和重新开始" },
        ],
      },
    ],
  },
  answers: {
    verify_method: "unity_pipeline",
    scene_approach: "reuse_existing",
    ball_paddle: "angle_control",
    result_kind: "executable",
  } as Readonly<Record<string, string>>,
};

function breakoutConfirmationStream(model: string): Response {
  const chunks = [
    { delta: { role: "assistant", content: breakoutConfirmation.publicText }, finish_reason: null },
    { delta: { tool_calls: [{
      index: 0, id: breakoutConfirmation.callId, type: "function",
      function: { name: "ask_plan_questions", arguments: JSON.stringify(breakoutConfirmation.arguments) },
    }] }, finish_reason: null },
    { delta: {}, finish_reason: "tool_calls" },
  ];
  const body = chunks.map(choice => `data: ${JSON.stringify({
    id: "breakout-recorded-confirmation", object: "chat.completion.chunk", model, choices: [{ index: 0, ...choice }],
  })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const realOmlxImagePath = String(process.env.REAL_OMLX_IMAGE_PATH || "").trim();
const runDirectEditRecovery = process.env.REAL_OMLX_DIRECT_EDIT_RECOVERY === "1";
const runExecuteIncidentReplay = process.env.REAL_OMLX_EXECUTE_INCIDENT === "1";
const runSnakeExecuteReplay = process.env.REAL_OMLX_SNAKE_EXECUTE === "1";
const realOmlxMutationFile = String(
  process.env.REAL_OMLX_MUTATION_FILE ||
  (realOmlxFixture === "md-viewer"
    ? "src/main.js"
    : realOmlxFixture === "snake"
      ? "snake.py"
      : "src/hooks/useCsvParser.ts"),
).replace(/^[/\\]+/, "");
const realOmlxMutationExpectation = new RegExp(
  process.env.REAL_OMLX_MUTATION_EXPECT ||
  (realOmlxFixture === "md-viewer"
    ? "btn-new"
    : realOmlxFixture === "snake"
      ? "class\\s+Snake|tkinter"
      : "creatorName\\s*:"),
  "i",
);
const useSemanticCsvMutationOracle = useDefaultCsvBehaviorOracle({
  fixture: realOmlxFixture,
  workspaceOverride: process.env.REAL_OMLX_WORKSPACE,
  mutationExpectationOverride: process.env.REAL_OMLX_MUTATION_EXPECT,
  mutationFile: realOmlxMutationFile,
});
const inspectCsvCreatorMapping = createCsvCreatorMappingOracle();
const realOmlxDevServerUrl = String(
  process.env.REAL_OMLX_DEV_SERVER_URL ||
  (realOmlxFixture === "md-viewer" ? "http://localhost:1420/" : "http://localhost:5173/"),
);
const realOmlxPlanExpectation = new RegExp(
  process.env.REAL_OMLX_PLAN_EXPECT || (
    realOmlxFixture === "md-viewer"
      ? "src/main\\.js|未保存|保存|打开"
      : realOmlxFixture === "snake"
        ? "snake\\.py|test_snake\\.py|tkinter|贪吃蛇"
      : "useCsvParser\\.ts|CSV|creator"
  ),
  "i",
);
const realOmlxPlanExpectAll = String(process.env.REAL_OMLX_PLAN_EXPECT_ALL || "")
  .split(";;")
  .map((pattern) => pattern.trim())
  .filter(Boolean)
  .map((pattern) => new RegExp(pattern, "i"));
const realOmlxPlanEvidenceTargets = String(
  process.env.REAL_OMLX_PLAN_EVIDENCE_TARGETS || (
    realOmlxFixture === "csv"
      ? "src/hooks/useCsvParser.ts"
      : realOmlxFixture === "md-viewer"
        ? "src/main.js"
        : realOmlxFixture === "snake"
          ? "snake.py;;README.md"
        : ""
  ),
).split(";;").map((target) => target.trim()).filter(Boolean);
const requireSemanticTaskQuality =
  process.env.REAL_OMLX_REQUIRE_TASK_QUALITY === "1" ||
  (runExecuteIncidentReplay && realOmlxFixture === "md-viewer") ||
  realOmlxFixture === "snake";
if (
  runRealOmlx &&
  realOmlxFixture === "md-viewer" &&
  !String(process.env.REAL_OMLX_WORKSPACE || "").trim()
) {
  throw new Error(
    "The md-viewer real-model fixture requires a caller-prepared REAL_OMLX_WORKSPACE copy.",
  );
}
if (
  runRealOmlx &&
  requireSemanticTaskQuality &&
  realOmlxPlanEvidenceTargets.length === 0
) {
  throw new Error(
    "Task-quality validation requires explicit REAL_OMLX_PLAN_EVIDENCE_TARGETS for non-default fixtures.",
  );
}
const realOmlxPlanTimeoutMs = Math.max(
  30_000,
  Number(process.env.REAL_OMLX_PLAN_TIMEOUT_MS || 600_000),
);
const realOmlxExecutionTimeoutMs = Math.max(
  30_000,
  // This is a test-harness wait budget, not a product Run deadline. Ordinary
  // Execute stays open while work progresses; the replay still needs a finite
  // outer bound so CI can report a missing terminal instead of hanging.
  Number(process.env.REAL_OMLX_EXECUTION_TIMEOUT_MS || 780_000),
);
const expectAgentExplanation = process.env.REAL_OMLX_EXPECT_AGENT_TEXT === "1";
const forbiddenChatNoise = /<tool_use>|<user_options>|\[PROPOSAL START\]|append_debug_log|ContextMemoryState|MAIN TOOL FEEDBACK|^\s*कल\s*$/m;
const reviewablePlanStages = new Set(["plan", "design", "bugfix", "ready_to_execute"]);
const isMdViewerSavePathIncident =
  realOmlxFixture === "md-viewer" &&
  /(?:未保存|保存路径|打开本地|save\s*path|unsaved)/i.test(realOmlxRequest);
if (
  runRealOmlx &&
  runExecuteIncidentReplay &&
  realOmlxFixture === "md-viewer" &&
  !isMdViewerSavePathIncident
) {
  throw new Error(
    "The MD Viewer Execute incident lane requires an MD Viewer save/open request; fixture and objective are inconsistent.",
  );
}

const useSemanticMdViewerMutationOracle =
  realOmlxFixture === "md-viewer" &&
  process.env.REAL_OMLX_MUTATION_ORACLE !== "exact";
const realOmlxMutationOracleFiles = useSemanticMdViewerMutationOracle
  ? [
      "src/main.js",
      "src/components/editor.js",
      "src/components/statusbar.js",
      "src/components/toolbar.js",
      "src-tauri/src/main.rs",
    ]
  : [realOmlxMutationFile];

type FixtureMutationState = {
  satisfied: boolean;
  changedFiles: string[];
  contents: Record<string, string>;
  detail: string;
};

type SnakeAcceptanceReport = {
  gaps: string[];
  files: string[];
  compile: Awaited<ReturnType<typeof runRealOmlxWorkspaceCommand>>;
  tests: Awaited<ReturnType<typeof runRealOmlxWorkspaceCommand>>;
  importCheck: Awaited<ReturnType<typeof runRealOmlxWorkspaceCommand>>;
  testCount: number;
};

async function inspectSnakeAcceptance(
  workspace: string,
): Promise<SnakeAcceptanceReport> {
  const files = (await collectBoundedRealOmlxWorkspaceFiles(workspace, {
    maxFiles: 400,
  })).files;
  const snakePath = path.join(workspace, "snake.py");
  const testsPath = path.join(workspace, "test_snake.py");
  const readmePath = path.join(workspace, "README.md");
  const readOptional = async (absolutePath: string) => {
    try {
      return await fs.readFile(absolutePath, "utf8");
    } catch {
      return "";
    }
  };
  const [snakeSource, testsSource, readmeSource] = await Promise.all([
    readOptional(snakePath),
    readOptional(testsPath),
    readOptional(readmePath),
  ]);
  const [compile, tests, importCheck] = await Promise.all([
    runRealOmlxWorkspaceCommand(workspace, "python3 -m compileall -q ."),
    runRealOmlxWorkspaceCommand(workspace, "python3 -m unittest -v"),
    runRealOmlxWorkspaceCommand(
      workspace,
      "python3 -c \"import snake; print('SNAKE_IMPORT_OK')\"",
    ),
  ]);
  const testOutput = `${tests.stdout}\n${tests.stderr}`;
  const testCount = Number(testOutput.match(/Ran\s+(\d+)\s+tests?/i)?.[1] || 0);
  const gaps: string[] = [];
  if (!snakeSource.trim()) gaps.push("snake.py is missing or empty");
  if (!testsSource.trim()) gaps.push("test_snake.py is missing or empty");
  if (!readmeSource.trim()) gaps.push("README.md is missing or empty");
  if (compile.exitCode !== 0) gaps.push("python compileall failed");
  if (tests.exitCode !== 0) gaps.push("python unittest failed");
  if (importCheck.exitCode !== 0 || !importCheck.stdout.includes("SNAKE_IMPORT_OK")) {
    gaps.push("snake.py cannot be imported without starting or crashing the GUI");
  }
  if (testCount < 4) gaps.push(`expected at least 4 logic tests, observed ${testCount}`);
  if (!/\b(?:tkinter|turtle)\b/i.test(snakeSource)) {
    gaps.push("no standard-library GUI implementation was found");
  }
  for (const control of ["Up", "Down", "Left", "Right"]) {
    if (!new RegExp(`<${control}>|[\"']${control.toLowerCase()}[\"']`, "i").test(snakeSource)) {
      gaps.push(`missing ${control} control binding`);
    }
  }
  for (const control of ["w", "a", "s", "d"]) {
    if (!new RegExp(`[\"']${control}[\"']`, "i").test(snakeSource)) {
      gaps.push(`missing ${control.toUpperCase()} control binding`);
    }
  }
  if (!/\bscore\b/i.test(snakeSource)) gaps.push("score handling is not visible in snake.py");
  if (!/\b(?:restart|reset|new_game)\b/i.test(snakeSource)) {
    gaps.push("restart/reset behavior is not visible in snake.py");
  }
  if (!/\b(?:game_over|collision|hit_wall|hit_self)\b/i.test(snakeSource)) {
    gaps.push("wall/self collision behavior is not visible in snake.py");
  }
  if (!/\b(?:food|apple)\b/i.test(snakeSource)) {
    gaps.push("food placement/growth behavior is not visible in snake.py");
  }
  if (!/python3\s+snake\.py/i.test(readmeSource)) {
    gaps.push("README.md does not document how to start the game");
  }
  return { gaps, files, compile, tests, importCheck, testCount };
}

function getSnakeWorkPlanGaps(sealedWorkPlan: any): string[] {
  const draft = sealedWorkPlan?.draft || {};
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  const validations = Array.isArray(draft.validations)
    ? draft.validations
    : [];
  const targetsFor = (step: any) =>
    (Array.isArray(step?.targets) ? step.targets : [])
      .map((target: unknown) => String(target || "").replace(/^\.\//, ""));
  const indexesForTarget = (target: string) => steps
    .map((step: any, index: number) =>
      targetsFor(step).includes(target) ? index : -1
    )
    .filter((index: number) => index >= 0);
  const snakeSteps = indexesForTarget("snake.py");
  const testSteps = indexesForTarget("test_snake.py");
  const readmeSteps = indexesForTarget("README.md");
  const rendered = JSON.stringify(draft);
  const finiteCommands = validations
    .filter((validation: any) =>
      validation?.required === true &&
      validation?.kind === "finite_command"
    )
    .map((validation: any) => String(validation.command || ""));
  const normalizeCommand = (command: unknown) =>
    String(command || "").replace(/\s+/g, " ").trim();
  const compileValidations = validations.filter((validation: any) =>
    validation?.required === true &&
    validation?.kind === "finite_command" &&
    normalizeCommand(validation.command) === "python3 -m compileall -q ."
  );
  const unittestValidations = validations.filter((validation: any) =>
    validation?.required === true &&
    validation?.kind === "finite_command" &&
    normalizeCommand(validation.command) === "python3 -m unittest -v"
  );
  const gaps: string[] = [];
  if (steps.length < 3) {
    gaps.push(`expected at least three implementation stages, observed ${steps.length}`);
  }
  if (snakeSteps.length === 0) gaps.push("no snake.py implementation stage");
  if (testSteps.length === 0) gaps.push("no test_snake.py test stage");
  if (readmeSteps.length === 0) gaps.push("no README.md documentation stage");
  if (
    snakeSteps.length !== 1 ||
    testSteps.length !== 1 ||
    readmeSteps.length !== 1 ||
    !(snakeSteps[0] < testSteps[0] && testSteps[0] < readmeSteps[0])
  ) {
    gaps.push("Snake stages must be unique and ordered S1 snake, S2 tests, S3 README");
  }
  if (
    snakeSteps.length === 1 &&
    JSON.stringify(steps[snakeSteps[0]]?.dependsOn || []) !== "[]"
  ) {
    gaps.push("the snake implementation stage must have dependsOn=[]");
  }
  if (
    snakeSteps.length > 0 &&
    testSteps.length > 0 &&
    !testSteps.some((testIndex: number) =>
      (Array.isArray(steps[testIndex]?.dependsOn)
        ? steps[testIndex].dependsOn
        : []).some((dependency: number) => snakeSteps.includes(dependency))
    )
  ) {
    gaps.push("the test stage does not depend on a snake.py implementation stage");
  }
  if (
    readmeSteps.length > 0 &&
    !readmeSteps.some((readmeIndex: number) => {
      const dependencies = Array.isArray(steps[readmeIndex]?.dependsOn)
        ? steps[readmeIndex].dependsOn
        : [];
      return snakeSteps.some((index: number) => dependencies.includes(index)) &&
        testSteps.some((index: number) => dependencies.includes(index));
    })
  ) {
    gaps.push("the README stage does not depend on both implementation and tests");
  }
  if (
    testSteps.length === 1 && snakeSteps.length === 1 &&
    JSON.stringify(steps[testSteps[0]]?.dependsOn || []) !==
      JSON.stringify([snakeSteps[0]])
  ) {
    gaps.push("the test stage must depend exactly on the snake stage");
  }
  if (
    readmeSteps.length === 1 &&
    snakeSteps.length === 1 &&
    testSteps.length === 1 &&
    JSON.stringify(steps[readmeSteps[0]]?.dependsOn || []) !==
      JSON.stringify([snakeSteps[0], testSteps[0]])
  ) {
    gaps.push("the README stage must depend exactly on snake and tests");
  }
  for (const pattern of [
    /tkinter/i,
    /(?:方向键|arrow)/i,
    /WASD/i,
    /(?:食物|food)/i,
    /(?:分数|score)/i,
    /(?:撞墙|wall)/i,
    /(?:自身|self)/i,
    /(?:重启|重新开始|restart|reset)/i,
    /(?:核心逻辑|logic).*(?:GUI|界面)|(?:GUI|界面).*(?:核心逻辑|logic)/i,
  ]) {
    if (!pattern.test(rendered)) {
      gaps.push(`plan does not cover ${pattern.source}`);
    }
  }
  if (!finiteCommands.some((command: string) =>
    /python3\s+-m\s+(?:compileall|py_compile)/i.test(command)
  )) {
    gaps.push("no required Python compile validation");
  }
  if (!finiteCommands.some((command: string) =>
    /python3\s+-m\s+unittest/i.test(command)
  )) {
    gaps.push("no required unittest validation");
  }
  if (compileValidations.length !== 1) {
    gaps.push("compile validation must be one independent exact command");
  }
  if (unittestValidations.length !== 1) {
    gaps.push("unittest validation must be one independent exact command");
  }
  const validationCovers = (pattern: RegExp, indexes: number[]) =>
    validations.some((validation: any) =>
      validation?.required === true &&
      validation?.kind === "finite_command" &&
      pattern.test(String(validation.command || "")) &&
      indexes.every((index) =>
        Array.isArray(validation.stepIndexes) &&
        validation.stepIndexes.includes(index)
      )
    );
  if (!validationCovers(
    /python3\s+-m\s+(?:compileall|py_compile)/i,
    [...snakeSteps, ...testSteps, ...readmeSteps],
  )) {
    gaps.push("compile validation does not cover every Snake stage");
  }
  if (!validationCovers(
    /python3\s+-m\s+unittest/i,
    [...snakeSteps, ...testSteps],
  )) {
    gaps.push("unittest validation does not cover implementation and tests");
  }
  const expectedStepIndexes = [...snakeSteps, ...testSteps, ...readmeSteps];
  for (const validation of [...compileValidations, ...unittestValidations]) {
    if (
      JSON.stringify(validation.stepIndexes || []) !==
      JSON.stringify(expectedStepIndexes)
    ) {
      gaps.push(`${normalizeCommand(validation.command)} does not cover all three stages exactly`);
    }
    if (!Array.isArray(validation.criterionIds) ||
      !validation.criterionIds.includes("criterion-user-objective")) {
      gaps.push(`${normalizeCommand(validation.command)} does not map the admitted criterion`);
    }
  }
  for (const index of expectedStepIndexes) {
    if (!Array.isArray(steps[index]?.criterionIds) ||
      !steps[index].criterionIds.includes("criterion-user-objective")) {
      gaps.push(`stage ${index + 1} does not map the admitted criterion`);
    }
  }
  return gaps;
}

function runtimeV2FailureDiagnostic(runtimeV2: any) {
  const diagnosticDebug = (runtimeV2?.debug || []).filter((entry: any) =>
    /(?:tool_execution_(?:failed|blocked|rejected)|recovery|phase_transition|plan_source_freshness|execute_terminal|provider_transport_failed)/i
      .test(String(entry?.source || ""))
  ).slice(-80);
  return {
    debug: diagnosticDebug,
    strategy: runtimeV2?.strategy || null,
    phase: runtimeV2?.phase || null,
    terminalOutcome: runtimeV2?.terminalOutcome || null,
    terminal: runtimeV2?.terminal || null,
    workPlan: runtimeV2?.workPlan || null,
    events: runtimeV2?.events || [],
    evidence: runtimeV2?.evidence || [],
    receipts: runtimeV2?.receipts || [],
    commands: runtimeV2?.commands || [],
    subagents: runtimeV2?.subagents || [],
    subagentConcurrency: runtimeV2?.subagentConcurrency || null,
  };
}

async function readFixtureMutationContents(workspace: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(realOmlxMutationOracleFiles.map(async (relativePath) => [
    relativePath,
    await fs.readFile(path.join(workspace, relativePath), "utf8"),
  ])));
}

const PLAN_ONLY_FINGERPRINT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".MAIN",
  ".MAIN-chat-attachments", // Host-owned attachment copies, not model source edits.
  "node_modules",
  "target",
  "dist",
  "build",
]);

async function fingerprintPlanOnlyWorkspace(workspace: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && PLAN_ONLY_FINGERPRINT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(workspace, absolutePath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(await fs.readFile(absolutePath));
        hash.update("\0");
      }
    }
  };
  await visit(workspace);
  return hash.digest("hex");
}

async function loadRealOmlxReplayImages(): Promise<string[]> {
  if (!realOmlxImagePath) return [];
  const extension = path.extname(realOmlxImagePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".gif"
      ? "image/gif"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
  const body = await fs.readFile(realOmlxImagePath);
  return [`data:${mime};base64,${body.toString("base64")}`];
}

async function inspectFixtureMutation(
  workspace: string,
  baseline?: Record<string, string>,
): Promise<FixtureMutationState> {
  const contents = await readFixtureMutationContents(workspace);
  const changedFiles = baseline
    ? realOmlxMutationOracleFiles.filter((relativePath) => contents[relativePath] !== baseline[relativePath])
    : [];
  const executionGaps = useSemanticMdViewerMutationOracle
    ? getMdViewerExecutionGaps({
        caller: contents["src/main.js"] || "",
        editor: contents["src/components/editor.js"] || "",
        handler: contents["src-tauri/src/main.rs"] || "",
        toolbar: contents["src/components/toolbar.js"] || "",
      })
    : [];
  if (useSemanticMdViewerMutationOracle && baseline) {
    const allowedMutationFiles = new Set([
      "src/main.js",
      "src/components/editor.js",
      "src/components/toolbar.js",
    ]);
    for (const relativePath of allowedMutationFiles) {
      executionGaps.push(...getNewUndeclaredCallGaps({
        path: relativePath,
        before: baseline[relativePath] || "",
        after: contents[relativePath] || "",
      }));
    }
    for (const relativePath of changedFiles) {
      if (allowedMutationFiles.has(relativePath)) continue;
      executionGaps.push(
        `${relativePath}:1:1 - this file is not a root-cause owner for the verified incident; restore its pre-run content and leave it unchanged`,
      );
    }
  }
  const csvCheck = useSemanticCsvMutationOracle ? await inspectCsvCreatorMapping(workspace) : null;
  const csvSourceStillCurrent = csvCheck && csvCheck.sourceHash === createHash("sha256").update(contents[realOmlxMutationFile] || "").digest("hex") &&
    csvCheck.sourceHash === createHash("sha256").update(await fs.readFile(path.join(workspace, realOmlxMutationFile), "utf8")).digest("hex");
  const satisfied = useSemanticMdViewerMutationOracle
    ? executionGaps.length === 0
    : csvCheck ? csvCheck.passed && !!csvSourceStillCurrent
    : realOmlxMutationExpectation.test(contents[realOmlxMutationFile] || "");
  return {
    satisfied,
    changedFiles,
    contents,
    detail: useSemanticMdViewerMutationOracle
      ? executionGaps.length === 0
        ? "the pristine initial tab is replaced on open, programmatic loading stays clean, and save_file_content uses the active filePath"
        : executionGaps.join("\n")
      : csvCheck ? csvCheck.passed && csvSourceStillCurrent
        ? "all five CSV creator mappings and the public CsvOrder.creatorName TypeScript contract pass"
        : csvCheck.sourceChangedDuringCheck || !csvSourceStillCurrent ? "CSV source changed while its independent behavior/type contract was checked; check the current version again"
        : `CSV behavior/type contract failed:\n${csvCheck.behavior.stdout}${csvCheck.behavior.stderr}${csvCheck.typecheck.stdout}${csvCheck.typecheck.stderr}`
      : `${realOmlxMutationFile} matches ${realOmlxMutationExpectation.source}`,
  };
}

type RealOmlxActionRequest = {
  kind?: string;
  requestId?: string;
  toolName?: string;
  target?: string;
  risk?: string;
};

function isPathInsideWorkspace(candidate: string, workspace: string): boolean {
  const relative = path.relative(path.resolve(workspace), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isInScopeBrowserPermission(
  request: RealOmlxActionRequest | null | undefined,
  workspace: string,
): boolean {
  if (
    request?.kind !== "tool_permission" ||
    request.toolName !== "browser_evaluate" ||
    !request.requestId ||
    !request.target
  ) {
    return false;
  }
  try {
    const targetUrl = new URL(request.target);
    if (targetUrl.origin === new URL(realOmlxDevServerUrl).origin) return true;
    return targetUrl.protocol === "file:" && isPathInsideWorkspace(fileURLToPath(targetUrl), workspace);
  } catch {
    return false;
  }
}

async function approveInScopeBrowserPermission(
  page: Page,
  request: RealOmlxActionRequest | null | undefined,
  workspace: string,
): Promise<boolean> {
  if (!isInScopeBrowserPermission(request, workspace)) return false;
  return await page.evaluate((expectedRequestId) => {
    const bridge = (window as any).__CODELY_E2E__;
    const current = bridge?.getSnapshot?.().activeActionRequest;
    if (
      current?.kind !== "tool_permission" ||
      current.requestId !== expectedRequestId ||
      current.toolName !== "browser_evaluate"
    ) {
      return false;
    }
    bridge?.approvePendingTool?.();
    return true;
  }, request?.requestId);
}

async function inspectPlannedPermissionStore(
  page: Page,
  approval: { signature: string; identity: { sessionKey: string; turnId: string; runId: string; requestId: string; taskId: number } } | null = null,
): Promise<{ observed: RealOmlxPlanPermissionObservation; signature: string; approved: boolean }> {
  return await page.evaluate(async (approval) => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
    const state = useAppStore.getState();
    const aggregate = state.currentTurnId
      ? normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[state.currentTurnId])?.aggregate || null
      : null;
    const marker = state.harnessRunMarker;
    const observed = {
      currentWorkspace: state.currentWorkspace,
      currentSessionKey: state.getCurrentSessionKey(),
      currentTurnId: state.currentTurnId,
      sessionEpoch: state.planLifecycle.sessionEpoch,
      marker: marker ? { sessionKey: marker.sessionKey, turnId: marker.turnId, runId: marker.runId,
        parentRunId: marker.parentRunId ?? null, status: marker.status } : null,
      request: state.activeActionRequest,
      pendingReviewTaskId: state.pendingReviewTaskId,
      hasPendingResolver: typeof state.pendingReviewResolve === "function",
      pendingToolCall: state.pendingToolCall,
      aggregate,
    };
    const signature = JSON.stringify(observed);
    if (!approval || signature !== approval.signature) return { observed, signature, approved: false };
    // Same synchronous Store action used by Capsule's approve-once control.
    // No persisted auto-review flag or capability requirement is changed.
    state.approvePendingReviewOnce(approval.identity);
    const after = useAppStore.getState();
    return { observed, signature, approved: after.activeActionRequest?.requestId !== approval.identity.requestId };
  }, approval) as any;
}

async function approveReviewedExecutionPermission(
  page: Page,
  testInfo: TestInfo,
  workspace: string,
  approved: RealOmlxApprovedPlanBinding,
  seen: Set<string>,
): Promise<boolean> {
  const captured = await inspectPlannedPermissionStore(page);
  const request = captured.observed.request;
  if (request?.kind !== "tool_permission") return false;
  if (await approveInScopeBrowserPermission(page, request, workspace)) {
    seen.add(request.requestId);
    return true;
  }
  const label = `planned-permission-${createHash("sha256").update(request.requestId).digest("hex").slice(0, 12)}.json`;
  try {
    const decision = await validateRealOmlxPlannedPermission(captured.observed, approved, workspace);
    const dispatched = await inspectPlannedPermissionStore(page, { signature: captured.signature, identity: decision.identity });
    if (!dispatched.approved) return false; // Exact request changed while the host checked its paths.
    if (!seen.has(request.requestId)) {
      seen.add(request.requestId);
      console.log(`[real-omlx-planned-permission-approval] ${JSON.stringify({ requestId: request.requestId, toolName: request.toolName, ...decision })}`);
      await fs.writeFile(testInfo.outputPath(label), JSON.stringify({ action: "approve_once", decision, observed: captured.observed }, null, 2));
    }
    return true;
  } catch (error) {
    await fs.writeFile(testInfo.outputPath(label), JSON.stringify({ action: "left_pending", error: String(error), observed: captured.observed }, null, 2));
    throw error;
  }
}

function summarizePlanDebugTail(entries: unknown[]): string[] {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return String(entry || "");
      const record = entry as Record<string, unknown>;
      const source = String(record.source || record.target || "");
      if (!/(?:^agent\.(?:plan_|loop_stop$|agent_loop_)|^store\.(?:runtime_v2_|non_actionable_stop|agent_loop_stop_summary|agent_loop_crashed|parent_subagents_finalized|terminal_|workflow_|harness_close_|stale_run_error_)|^app\.instance\.closed$|stream_(?:error|timeout|watchdog))/i.test(source)) {
        return "";
      }
      return [record.level, source, record.message]
        .filter((value) => value != null && String(value).trim())
        .map(String)
        .join(" ");
    })
    .filter(Boolean)
    .slice(-12)
    .map((line) => line.slice(0, 1_200));
}

function summarizeSubagentPlanFailureDebug(entries: unknown[]): unknown[] {
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const source = String(record.source || record.target || "");
    if (!/(?:plan_|subagent_evidence|parent_(?:wait|resume|join)|tool_surface|loop_stop|non_actionable)/i.test(source)) {
      return [];
    }
    let message: unknown = record.message;
    if (typeof message === "string") {
      try {
        message = JSON.parse(message);
      } catch {
        message = message.slice(0, 2_400);
      }
    }
    return [{ source, level: record.level, message }];
  }).slice(-80);
}

function summarizeTaskFlowForFailure(entries: unknown[]): unknown[] {
  return (Array.isArray(entries) ? entries : []).slice(-50).map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return {
      type: record.type,
      toolName: record.toolName,
      target: record.target,
      status: record.status,
      content: String(record.content || "").slice(0, 800),
    };
  });
}

type StructuredDebugEntry = Record<string, unknown> & { source: string };

function parseStructuredDebugEntries(entries: unknown[]): StructuredDebugEntry[] {
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    let payload: Record<string, unknown> = {};
    if (record.message && typeof record.message === "object") {
      payload = record.message as Record<string, unknown>;
    } else if (typeof record.message === "string") {
      try {
        const parsed = JSON.parse(record.message);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // Human-readable debug text is intentionally excluded from assertions.
      }
    }
    return [{ ...payload, source: String(record.source || "") }];
  });
}

function expectCanonicalRuntimeV2Terminal(
  snapshot: any,
  expected: {
    turnId: string;
    resultKind: "success" | "partial" | "blocked" | "error" | "canceled";
    strategy?: "execute" | "plan";
  },
): any {
  const runtime = snapshot?.runtimeV2;
  expect(runtime, "The turn must expose its durable Runtime v2 checkpoint.").not.toBeNull();
  expect(runtime?.schemaVersion).toBe("turn-aggregate.v1");
  expect(runtime?.strategy).toBe(expected.strategy || "execute");
  expect(runtime?.turnId).toBe(expected.turnId);
  expect(runtime?.turnIdentity?.turnId).toBe(expected.turnId);
  expect(runtime?.runIdentity?.turnId).toBe(expected.turnId);
  expect(String(runtime?.runId || "")).not.toBe("");
  expect(runtime?.phase).toBe("completed");
  expect(runtime?.terminalOutcome?.resultKind).toBe(expected.resultKind);
  expect(runtime?.terminal).toMatchObject({
    runCompletedCount: 1,
    turnCompletedCount: 1,
    finalProjectionCount: 1,
    runResultKind: expected.resultKind,
    turnResultKind: expected.resultKind,
    exactlyOnce: true,
  });

  const events = Array.isArray(runtime?.events) ? runtime.events : [];
  const sequences = events.map((event: { sequence?: number }) => Number(event.sequence));
  expect(sequences.length).toBeGreaterThan(0);
  expect(sequences.every(Number.isFinite)).toBe(true);
  for (let index = 1; index < sequences.length; index += 1) {
    expect(sequences[index]).toBe(sequences[index - 1] + 1);
  }
  expect(new Set(events.map((event: { eventId?: string }) => event.eventId)).size)
    .toBe(events.length);
  expect(events[0]?.type).toBe("turn.admitted");
  expect(events.filter((event: { type?: string }) => event.type === "run.started"))
    .toHaveLength(1);
  expect(events.filter((event: { type?: string }) => event.type === "run.completed"))
    .toHaveLength(1);
  expect(events.filter((event: { type?: string }) => event.type === "turn.completed"))
    .toHaveLength(1);

  const commands = Array.isArray(runtime?.commands) ? runtime.commands : [];
  const receipts = Array.isArray(runtime?.receipts) ? runtime.receipts : [];
  expect(commands.length).toBeGreaterThan(0);
  expect(new Set(commands.map((command: { idempotencyKey?: string }) =>
    command.idempotencyKey
  )).size).toBe(commands.length);
  expect(new Set(receipts.map((receipt: { idempotencyKey?: string }) =>
    receipt.idempotencyKey
  )).size).toBe(receipts.length);
  expect(commands.map((command: { idempotencyKey?: string }) => command.idempotencyKey).sort())
    .toEqual(receipts.map((receipt: { idempotencyKey?: string }) => receipt.idempotencyKey).sort());
  expect(commands.every((command: { status?: string; completedAt?: number }) =>
    ["succeeded", "failed", "canceled"].includes(String(command.status || "")) &&
    Number.isFinite(command.completedAt)
  )).toBe(true);
  expect(commands.every((command: { turnId?: string; runId?: string }) =>
    command.turnId === expected.turnId && command.runId === runtime.runId
  )).toBe(true);
  if (
    expected.resultKind === "success" &&
    (expected.strategy || "execute") === "execute"
  ) {
    const mutationEvents = events.filter((event: {
      type?: string;
      status?: string;
      evidence?: Array<{ kind?: string }>;
    }) =>
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      (event.evidence || []).some((entry) => entry.kind === "mutation")
    );
    expect(mutationEvents.length).toBeGreaterThan(0);
    const finalMutationSequence = Math.max(
      ...mutationEvents.map((event: { sequence?: number }) =>
        Number(event.sequence || 0)
      ),
    );
    const passedParentValidations = events.filter((event: {
      type?: string;
      passed?: boolean;
      sequence?: number;
    }) =>
      event.type === "validation.completed" &&
      event.passed === true &&
      Number(event.sequence || 0) > finalMutationSequence
    );
    const passedChildValidations = events.flatMap((event: {
      type?: string;
      status?: string;
      report?: unknown;
      validationReceipts?: Array<{
        passed?: boolean;
        authority?: unknown;
        mutationBoundarySequence?: number;
        validatedMutationVersions?: unknown[];
      }>;
    }) => {
      if (
        event.type === "subagent.completed" &&
        event.status === "completed" &&
        !!event.report
      ) {
        return (event.validationReceipts || []).filter(
          (receipt) =>
            receipt.passed === true &&
            Number(receipt.mutationBoundarySequence || 0) >=
              finalMutationSequence,
        );
      }
      return [];
    });
    expect(
      passedParentValidations.length + passedChildValidations.length,
    ).toBeGreaterThan(0);
    const passedValidationKeys = new Set(
      passedParentValidations.map((event: { idempotencyKey?: string }) =>
        String(event.idempotencyKey || "")
      ),
    );
    expect(commands.some((command: {
      kind?: string;
      status?: string;
      idempotencyKey?: string;
    }) =>
      command.kind === "execute_validation" &&
      command.status === "succeeded" &&
      passedValidationKeys.has(String(command.idempotencyKey || ""))
    )).toBe(true);

    if (runtime?.workPlan?.status === "approved") {
      const authoritativeReceipts = [
        ...passedParentValidations,
        ...passedChildValidations,
      ].filter((receipt: {
        authority?: unknown;
        mutationBoundarySequence?: number;
        validatedMutationVersions?: unknown[];
      }) =>
        !!receipt.authority &&
        Number.isInteger(receipt.mutationBoundarySequence) &&
        Number(receipt.mutationBoundarySequence) > 0 &&
        Array.isArray(receipt.validatedMutationVersions) &&
        receipt.validatedMutationVersions.length > 0
      );
      expect(authoritativeReceipts.length).toBeGreaterThan(0);
    } else {
      // The minimal direct-Execute kernel preserves the admitted objective
      // and proves it with a post-mutation behavioral validation. It does not
      // revive the removed model-authored execution-contract protocol.
      expect(runtime?.executionContract ?? null).toBeNull();
    }
  }

  const projections = Array.isArray(runtime?.projections) ? runtime.projections : [];
  const finalProjection = projections.filter(
    (projection: { audience?: string; kind?: string }) =>
      projection.audience === "final" && projection.kind === "final",
  );
  expect(finalProjection).toHaveLength(1);
  expect(finalProjection[0]?.projectionId).toBe(runtime?.terminalOutcome?.finalProjectionId);
  expect(runtime?.presentation?.finals || []).toHaveLength(1);
  const threadTerminalEvents = runtime?.presentation?.threadEvents || [];
  const projectedRunCompleted = threadTerminalEvents.filter(
    (event: { type?: string }) => event.type === "run.completed",
  );
  const projectedTurnCompleted = threadTerminalEvents.filter(
    (event: { type?: string }) => event.type === "turn.completed",
  );
  expect(projectedRunCompleted).toHaveLength(1);
  expect(projectedTurnCompleted).toHaveLength(1);
  expect(projectedRunCompleted[0]?.resultKind).toBe(expected.resultKind);
  expect(projectedTurnCompleted[0]?.resultKind).toBe(expected.resultKind);
  expect(Number(projectedRunCompleted[0]?.timestampMs))
    .toBeLessThanOrEqual(Number(projectedTurnCompleted[0]?.timestampMs));
  return runtime;
}

function expectRuntimeV2TurnPresentationStatus(snapshot: any): void {
  const resultKind = String(
    snapshot?.runtimeV2?.terminalOutcome?.resultKind || "",
  );
  expect([
    "success",
    "partial",
    "blocked",
    "error",
    "canceled",
  ]).toContain(resultKind);
  expect(snapshot?.currentTurnStatus).toBe(
    resultKind === "error" ? "error" : "done",
  );
}

function expectSuccessfulPlanExecutionOrder(runtime: any): void {
  const events = Array.isArray(runtime?.events) ? runtime.events : [];
  const approvalIndex = events.findIndex(
    (event: { type?: string }) => event.type === "work_plan.approved",
  );
  const mutationIndexes = events.flatMap(
    (event: {
      type?: string;
      status?: string;
      evidence?: Array<{ kind?: string }>;
    }, index: number) => (
      index > approvalIndex &&
        (
          (event.type === "tool.completed" && event.status === "succeeded") ||
          (event.type === "subagent.completed" && event.status === "completed")
        ) &&
        (event.evidence || []).some((entry) => entry.kind === "mutation")
        ? [index]
        : []
    ),
  );
  const mutationIndex = mutationIndexes[0] ?? -1;
  const lastMutationIndex = mutationIndexes.at(-1) ?? -1;
  const validationIndex = events.findIndex(
    (event: {
      type?: string;
      status?: string;
      report?: unknown;
      passed?: boolean;
      validationReceipts?: Array<{ passed?: boolean }>;
    }, index: number) =>
      index > lastMutationIndex &&
      (
        (
          event.type === "validation.completed" &&
          event.passed === true
        ) ||
        (
          event.type === "subagent.completed" &&
          event.status === "completed" &&
          !!event.report &&
          (event.validationReceipts || []).some(
            (receipt) => receipt.passed === true,
          )
        )
      ),
  );
  const runCompletedIndex = events.findIndex(
    (event: { type?: string }, index: number) =>
      index > validationIndex && event.type === "run.completed",
  );
  const turnCompletedIndex = events.findIndex(
    (event: { type?: string }, index: number) =>
      index > runCompletedIndex && event.type === "turn.completed",
  );

  expect(approvalIndex, "Plan execution must begin after the sealed plan is approved.")
    .toBeGreaterThanOrEqual(0);
  expect(mutationIndex, "A successful plan run must commit mutation evidence after approval.")
    .toBeGreaterThan(approvalIndex);
  expect(validationIndex, "A successful plan run must validate after its last accepted mutation.")
    .toBeGreaterThan(mutationIndex);
  expect(runCompletedIndex).toBeGreaterThan(validationIndex);
  expect(turnCompletedIndex).toBeGreaterThan(runCompletedIndex);

  const planSteps = Array.isArray(runtime?.sealedWorkPlan?.draft?.steps)
    ? runtime.sealedWorkPlan.draft.steps
    : [];
  const normalizeTarget = (value: unknown) =>
    String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();
  const approvalSequence = Number(events[approvalIndex]?.sequence ?? -1);
  const receipts = events.flatMap((event: any) => {
    const successfulMutation =
      (event.type === "tool.completed" && event.status === "succeeded") ||
      (event.type === "subagent.completed" && event.status === "completed");
    if (!successfulMutation) return [];
    const targets = (event.evidence || [])
      .filter((entry: any) => entry.kind === "mutation")
      .map((entry: any) => normalizeTarget(entry.target))
      .filter(Boolean);
    return targets.length > 0
      ? [{ sequence: Number(event.sequence), targets }]
      : [];
  });
  const consumed = new Set<string>();
  const completionSequences: number[] = [];
  for (const [stepIndex, step] of planSteps.entries()) {
    const dependencySequences = (Array.isArray(step?.dependsOn)
      ? step.dependsOn
      : []).map((dependency: number) => completionSequences[dependency]);
    expect(
      dependencySequences.every(Number.isFinite),
      `WorkPlan S${stepIndex + 1} must not execute before all declared dependencies complete.`,
    ).toBe(true);
    const boundary = Math.max(approvalSequence, ...dependencySequences);
    if (step?.operation === "preserve") {
      completionSequences[stepIndex] = boundary;
      continue;
    }
    const targetSequences = (Array.isArray(step?.targets)
      ? step.targets
      : []).map((rawTarget: unknown) => {
        const target = normalizeTarget(rawTarget);
        for (const receipt of receipts) {
          if (receipt.sequence <= boundary) continue;
          const receiptTargetIndex = receipt.targets.findIndex(
            (candidate: string, index: number) =>
              candidate === target &&
              !consumed.has(`${receipt.sequence}:${index}`),
          );
          if (receiptTargetIndex < 0) continue;
          consumed.add(`${receipt.sequence}:${receiptTargetIndex}`);
          return receipt.sequence;
        }
        return Number.NaN;
      });
    expect(
      targetSequences.every(Number.isFinite),
      `Successful WorkPlan execution must commit S${stepIndex + 1} only after its dependency boundary.`,
    ).toBe(true);
    completionSequences[stepIndex] = Math.max(...targetSequences);
    for (const dependency of Array.isArray(step?.dependsOn)
      ? step.dependsOn
      : []) {
      expect(completionSequences[dependency])
        .toBeLessThan(completionSequences[stepIndex]);
    }
  }
  expect(Number(events[validationIndex]?.sequence))
    .toBeGreaterThan(Math.max(...completionSequences));
}

function expectRuntimeV2PlanReviewContract(
  snapshot: any,
  expected: { turnId: string },
): any {
  const runtime = snapshot?.runtimeV2;
  expect(runtime, "Plan must expose its durable Runtime v2 checkpoint.").not.toBeNull();
  expect(runtime?.schemaVersion).toBe("turn-aggregate.v1");
  expect(runtime?.strategy).toBe("plan");
  expect(runtime?.turnId).toBe(expected.turnId);
  expect(runtime?.turnIdentity?.turnId).toBe(expected.turnId);
  expect(runtime?.runIdentity?.turnId).toBe(expected.turnId);
  expect(String(runtime?.runId || "")).not.toBe("");
  expect(runtime?.phase).toBe("reviewing");
  expect(runtime?.terminalOutcome).toBeNull();

  const events = Array.isArray(runtime?.events) ? runtime.events : [];
  const sequences = events.map((event: { sequence?: number }) => Number(event.sequence));
  expect(sequences.length).toBeGreaterThan(0);
  expect(sequences.every(Number.isFinite)).toBe(true);
  for (let index = 1; index < sequences.length; index += 1) {
    expect(sequences[index]).toBe(sequences[index - 1] + 1);
  }
  expect(new Set(events.map((event: { eventId?: string }) => event.eventId)).size)
    .toBe(events.length);
  expect(events[0]?.type).toBe("turn.admitted");
  expect(events.filter((event: { type?: string }) => event.type === "run.started"))
    .toHaveLength(1);
  expect(events.filter((event: { type?: string }) => event.type === "work_plan.sealed"))
    .toHaveLength(1);
  expect(events.filter((event: { type?: string }) =>
    event.type === "run.completed" || event.type === "turn.completed"
  )).toHaveLength(0);

  const sealed = runtime?.sealedWorkPlan;
  const reference = runtime?.workPlan;
  const commit = runtime?.planReviewCommit;
  expect(sealed?.schemaVersion).toBe("work-plan.v1");
  expect(sealed?.status).toBe("pending_review");
  expect(reference?.status).toBe("pending_review");
  expect(validateWorkPlanDraftV1(
    sealed?.draft,
    (sealed?.evidence || []).map((item: { id?: string }) => String(item.id || "")),
    sealed?.evidence || [],
  )).toEqual([]);
  const integrity = validateSealedWorkPlanV1Integrity(sealed);
  expect(integrity.ok).toBe(true);
  const authority = {
    id: sealed.id,
    revision: sealed.revision,
    digest: sealed.digest,
    projectionHash: sealed.projectionHash,
  };
  expect(reference).toMatchObject(authority);
  expect(commit?.schemaVersion).toBe("runtime-v2-plan-review-commit.v1");
  expect(commit?.authority).toEqual(authority);
  expect(commit?.review?.authority).toEqual(authority);
  expect(commit?.review).toMatchObject({
    sessionKey: runtime.turnIdentity.sessionKey,
    sessionEpoch: runtime.turnIdentity.sessionEpoch,
    turnId: expected.turnId,
    runId: runtime.runId,
    parentRunId: runtime.runIdentity.parentRunId ?? null,
  });
  expect(String(commit?.review?.requestId || "")).not.toBe("");
  const documentRef = commit?.artifact?.documentRef;
  if (documentRef) {
    expect(documentRef.kind).toBe("plan");
    expect(documentRef.owner).toEqual({
      workspace: snapshot.currentWorkspace || null,
      sessionKey: runtime.turnIdentity.sessionKey,
      sessionEpoch: runtime.turnIdentity.sessionEpoch,
      turnId: expected.turnId,
    });
    expect(Number.isSafeInteger(documentRef.revision)).toBe(true);
    expect(documentRef.revision).toBeGreaterThanOrEqual(1);
    expect(String(documentRef.documentId || "").trim()).not.toBe("");
    expect(path.isAbsolute(documentRef.path)).toBe(true);
    expect(path.basename(documentRef.path)).toBe(`rev-${documentRef.revision}.md`);
    expect(path.basename(path.dirname(documentRef.path))).toBe(documentRef.documentId);
    if (documentRef.owner.workspace) {
      expect(documentRef.path).toBe(path.join(documentRef.owner.workspace, ".MAIN", "plans", documentRef.documentId, `rev-${documentRef.revision}.md`));
    }
    expect(documentRef.contentHash).toBe(createHash("sha256").update(sealed.markdown).digest("hex"));
    expect(commit.artifact).toEqual({ path: documentRef.path, documentRef,
      content: sealed.markdown, projectionHash: sealed.projectionHash });
    // The production review binding owns the exact owner + WorkPlan authority;
    // the document ref lives in the artifact member of the same immutable commit.
    if (commit.review.documentRef !== undefined) expect(commit.review.documentRef).toEqual(documentRef);
    expect(snapshot?.activeActionRequest?.documentRef).toEqual(documentRef);
  } else {
    // Persisted pre-document WorkPlans retain their original precise contract.
    expect(commit?.artifact).toEqual({ path: ".MAIN/plans/plan.md",
      content: sealed.markdown, projectionHash: sealed.projectionHash });
    expect(commit?.review?.documentRef).toBeUndefined();
    expect(snapshot?.activeActionRequest?.documentRef).toBeUndefined();
  }
  const sealedEvent = events.find((event: any) => event.type === "work_plan.sealed");
  expect(sealedEvent?.sealedPlan).toEqual(sealed);
  expect(sealedEvent?.reviewCommit).toEqual(commit);
  expect(events.filter((event: any) => event.type === "work_plan.approved")).toHaveLength(0);
  expect((runtime.evidence || []).filter((item: any) => item.kind === "mutation")).toHaveLength(0);
  expect(commit?.panel).toMatchObject({
    audience: "plan_panel",
    status: "pending_review",
    authority,
    title: sealed.draft.objective,
    markdown: sealed.markdown,
    validationCount: sealed.draft.validations.length,
  });
  expect(commit?.chat).toMatchObject({
    audience: "chat_milestone",
    authority,
  });
  expect(String(commit?.chat?.markdown || "")).not.toBe("");
  expect(String(commit?.chat?.dedupeKey || "")).not.toBe("");

  expect(snapshot?.activeActionRequest).toMatchObject({
    kind: "plan_review",
    requestId: commit.review.requestId,
    sessionKey: commit.review.sessionKey,
    sessionEpoch: commit.review.sessionEpoch,
    turnId: expected.turnId,
    runId: runtime.runId,
    parentRunId: commit.review.parentRunId,
    planRevision: sealed.revision,
    artifactHash: sealed.projectionHash,
    artifactPaths: [commit.artifact.path],
  });

  const commands = Array.isArray(runtime?.commands) ? runtime.commands : [];
  const receipts = Array.isArray(runtime?.receipts) ? runtime.receipts : [];
  expect(commands.length).toBeGreaterThan(0);
  expect(new Set(commands.map((command: { idempotencyKey?: string }) =>
    command.idempotencyKey
  )).size).toBe(commands.length);
  expect(new Set(receipts.map((receipt: { idempotencyKey?: string }) =>
    receipt.idempotencyKey
  )).size).toBe(receipts.length);
  expect(commands.map((command: { idempotencyKey?: string }) => command.idempotencyKey).sort())
    .toEqual(receipts.map((receipt: { idempotencyKey?: string }) => receipt.idempotencyKey).sort());
  expect(commands.every((command: { status?: string; completedAt?: number }) =>
    ["succeeded", "failed", "canceled"].includes(String(command.status || "")) &&
    Number.isFinite(command.completedAt)
  )).toBe(true);
  expect(commands.every((command: { turnId?: string; runId?: string }) =>
    command.turnId === expected.turnId && command.runId === runtime.runId
  )).toBe(true);
  const artifactWrites = commands.filter((command: any) =>
    command.kind === "execute_tool" && command.toolName === (documentRef ? "save_plan_document" : "write_file") &&
    command.target === (documentRef ? documentRef.documentId : ".MAIN/plans/plan.md")
  );
  expect(artifactWrites).toHaveLength(1);
  expect(artifactWrites[0]?.runtimeOwnedPlanArtifact).toBe(true);
  expect(artifactWrites[0]?.status).toBe("succeeded");
  const artifactReceipt = receipts.find((receipt: any) => receipt.idempotencyKey === artifactWrites[0].idempotencyKey);
  expect(artifactReceipt).toMatchObject({ kind: "execute_tool", status: "succeeded" });
  if (documentRef) {
    const saved = events.find((event: any) => event.type === "tool.completed" && event.idempotencyKey === artifactWrites[0].idempotencyKey);
    expect(saved?.status).toBe("succeeded");
    expect(saved?.evidence).toEqual(expect.arrayContaining([{ id: `plan-artifact:${sealed.id}:${sealed.revision}`,
      kind: "tool", target: documentRef.path, version: documentRef.contentHash }]));
    const record = JSON.parse(saved?.modelContent || "null");
    expect(record?.planDocument).toEqual(documentRef);
    expect(record?.markdown).toBe(sealed.markdown);
  }
  expect(commands.filter((command: any) =>
    command.kind === "execute_tool" && isWorkspaceMutationToolName(String(command.toolName || "")) &&
    !(documentRef === undefined && command.toolName === "write_file" && command.target === ".MAIN/plans/plan.md" && command.runtimeOwnedPlanArtifact === true)
  )).toHaveLength(0);

  const committedProjections = (runtime?.projections || []).filter(
    (projection: { audience?: string; dedupeKey?: string; markdown?: string }) =>
      projection.audience === "chat_milestone" &&
      projection.dedupeKey === commit.chat.dedupeKey &&
      projection.markdown === commit.chat.markdown,
  );
  expect(committedProjections).toHaveLength(1);
  const visibleMilestones = (runtime?.presentation?.chatMilestones || []).filter(
    (projection: { markdown?: string }) =>
      projection.markdown === commit.chat.markdown,
  );
  expect(visibleMilestones).toHaveLength(1);
  return runtime;
}

async function readRuntimeV2PlanReviewSnapshot(page: Page): Promise<any> {
  return page.evaluate(() => {
    const bridge = (window as any).__CODELY_E2E__;
    const snapshot = bridge.getSnapshot();
    const aggregate = bridge.readOnlySnapshot().aggregate;
    if (!aggregate || aggregate.turn.turnId !== snapshot.runtimeV2?.turnId || aggregate.run?.identity.runId !== snapshot.runtimeV2?.runId) {
      throw new Error("REAL_PLAN_REVIEW_SNAPSHOT_OWNER_MISMATCH");
    }
    return { ...snapshot, activeActionRequest: bridge.structuredChoiceSnapshot(),
      runtimeV2: { ...snapshot.runtimeV2, events: aggregate.events } };
  });
}

function assertFirstPlanWorkspaceTurnAdmission(snapshot: any): string {
  const acceptanceReceipt = snapshot?.lastWorkspaceInstructionAcceptance?.accepted
    ? snapshot.lastWorkspaceInstructionAcceptance.receipt
    : null;
  const admittedTurnId = String(acceptanceReceipt?.turnId || "");
  const admittedReceiptId = String(acceptanceReceipt?.receiptId || "");
  const admittedClientSubmissionId = String(acceptanceReceipt?.clientSubmissionId || "");
  const admittedTurn = (snapshot?.conversationTurnPreview || []).find(
    (turn: { id?: string }) => turn.id === admittedTurnId,
  );
  const ownedUserBlocks = (snapshot?.taskFlowPreview || []).filter(
    (block: { turnId?: string; type?: string }) =>
      block.type === "user" && block.turnId === admittedTurnId,
  );
  const receipt = (snapshot?.workspaceInstructionLedger || []).find(
    (entry: { receiptId?: string; turnId?: string; clientSubmissionId?: string }) =>
      entry.receiptId === admittedReceiptId &&
      entry.turnId === admittedTurnId &&
      entry.clientSubmissionId === admittedClientSubmissionId,
  );
  const admissionDiagnostic = JSON.stringify({
    admittedTurnId,
    activeTurnId: snapshot?.currentTurnId ?? null,
    currentWorkspace: snapshot?.currentWorkspace ?? null,
    currentSessionId: snapshot?.currentSessionId ?? null,
    dispatchError: snapshot?.dispatchError ?? null,
    acceptance: snapshot?.lastWorkspaceInstructionAcceptance ?? null,
    ledger: snapshot?.workspaceInstructionLedger ?? [],
    turns: snapshot?.conversationTurns ?? null,
  });
  expect(admittedTurnId, admissionDiagnostic).not.toBe("");
  expect(admittedReceiptId).not.toBe("");
  expect(admittedClientSubmissionId).not.toBe("");
  expect(admittedTurn?.workspaceInstructionSource).toBe("composer");
  expect(String(admittedTurn?.title || "").trim()).not.toBe("");
  expect(admittedTurn?.intent).toBe("plan");
  expect(admittedTurn?.displayIntent).toBe("plan");
  expect(admittedTurn?.userPrompt).toBe(realOmlxRequest);
  expect(String(admittedTurn?.status || "").trim()).not.toBe("");
  expect(snapshot?.conversationTurns).toBe(1);
  expect(ownedUserBlocks).toHaveLength(1);
  expect(receipt).toEqual(expect.objectContaining({
    receiptId: admittedReceiptId,
    turnId: admittedTurnId,
    clientSubmissionId: admittedClientSubmissionId,
    userBlockId: ownedUserBlocks[0]?.id,
  }));
  expect(admittedTurn?.blockIds).toContain(ownedUserBlocks[0]?.id);
  expect(snapshot?.lastWorkspaceInstructionAcceptance).toEqual(expect.objectContaining({
    accepted: true,
    receipt: expect.objectContaining({
      receiptId: admittedReceiptId,
      turnId: admittedTurnId,
      clientSubmissionId: admittedClientSubmissionId,
      userBlockId: ownedUserBlocks[0]?.id,
    }),
  }));
  return admittedTurnId;
}

test.describe.configure({
  timeout: Math.max(1_200_000, realOmlxExecutionTimeoutMs + 180_000),
});
test.skip(!runRealOmlx, "Set MAIN_REAL_OMLX_E2E=1 to run real local OMLX plan-flow validation.");

test.beforeEach(async ({ page }, testInfo) => {
  const breakoutColdRestore = breakoutResumeSessionId > 0 && testInfo.title.startsWith("real OMLX Breakout incident Plan");
  const customWorkspace = process.env.REAL_OMLX_WORKSPACE;
  const workspacePath = customWorkspace && process.env.MAIN_DETERMINISTIC_PAUSE_E2E === "1"
    ? await fs.mkdtemp(path.join(path.resolve(customWorkspace), "independent-test-")) : customWorkspace
    ? path.resolve(customWorkspace)
    : await fs.mkdtemp(path.join(os.tmpdir(), "e2e-real-omlx-"));
  // The real project-open ingress canonicalizes the workspace before it
  // constructs Session owners. Preserve that contract in the host fixture.
  const workspace = await fs.realpath(workspacePath);
  (page as any).__realOmlxWorkspace = workspace;
  if (process.env.MAIN_DETERMINISTIC_PAUSE_E2E === "1") await fs.writeFile(path.join(workspace, "fixture.txt"), "Deterministic production boundary fixture.\n");
  const providerWire: any[] = [];
  let breakoutConfirmationReplayed = false;
  (page as any).__realOmlxProviderWire = providerWire;
  const webInvocations: RealOmlxWebInvocation[] = [];
  (page as any).__realOmlxWebInvocations = webInvocations;
  const productionTools = realOmlxFixture === "unity";
  // This disposable database starts empty, unlike the already-running MAIN
  // installation being reproduced. Finish its schema bootstrap before UI
  // persistence and Session list requests begin concurrently. Do not retry a
  // save or weaken CAS when initialization fails.
  if (productionTools) await invokeRuntimeToolBridge(workspace, "list_project_sessions");
  const skillIds = (process.env.MAIN_TEST_SKILL_PACKAGE_IDS || "").split(",").filter(Boolean);
  const skills = productionTools ? await Promise.all(skillIds.map(async packageId => {
    const meta = await invokeRuntimeToolBridge(workspace, "inspect_global_skill_package", { packageId });
    return { id: packageId, name: meta.name, desc: "Installed Unity Skills", type: "package", active: true,
      packageStorage: { kind: "global", packageId }, entryPoint: meta.entryPoint, entryPoints: meta.entryPoints };
  })) : undefined;
  await page.exposeFunction("__MAIN_E2E_NATIVE_TOOL", (cmd: string, args: unknown) => invokeRuntimeToolBridge(workspace, cmd, args));
  const csvSeedFiles: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "csv-direct-edit-recovery-fixture",
      private: true,
      scripts: { test: "node tests/creator-mapping.test.mjs" },
    }, null, 2) + "\n",
    "tests/creator-mapping.test.mjs": [
      "import assert from 'node:assert/strict';",
      "import { normalizeCsvOrder } from '../src/hooks/useCsvParser.ts';",
      "",
      "// Check behavior so equivalent implementations remain valid.",
      "for (const [row, expected] of [",
      "  [{ creator: 'alice' }, 'alice'],",
      "  [{ 创建者: '林' }, '林'],",
      "  [{ creator: 'alice', 创建者: '林' }, 'alice'],",
      "  [{ creator: '', 创建者: '林' }, '林'],",
      "  [{}, ''],",
      "]) {",
      "  assert.equal(normalizeCsvOrder(row).creatorName, expected, 'normalizeCsvOrder must map CSV creator values to creatorName');",
      "}",
      "",
    ].join("\n"),
    "src/hooks/useCsvParser.ts": [
      "export interface CsvOrder {",
      "  creator?: string;",
      "  creatorName?: string;",
      "}",
      "",
      "export function normalizeCsvOrder(row: Record<string, string>): CsvOrder {",
      "  return {",
      "    creator: row.creator || row['创建者'] || '',",
      "  };",
      "}",
      "",
    ].join("\n"),
    "src/store/dashboardStore.ts": "export const creatorField = 'creatorName';\n",
    "src/hooks/useChartData.ts": [
      "import type { CsvOrder } from './useCsvParser';",
      "export function buildCourseRanking(orders: CsvOrder[]) {",
      "  return orders.map((order) => ({ name: order.creatorName || order.creator || 'unknown', amount: 1 }));",
      "}",
    ].join("\n"),
    "src/types/order.ts": "export interface Order { creatorName: string; amount: number; status?: string; }\n",
    "src/App.tsx": "export function App() { return <main className=\"app-shell\"><section className=\"dashboard-panel\" /></main>; }\n",
    "src/index.css": [
      ":root { color-scheme: light; background: #ffffff; color: #111827; }",
      "[data-theme='dark'] { color-scheme: dark; background: #ffffff; color: #e5e7eb; }",
      ".dashboard-panel { background: #ffffff; border: 1px solid #e5e7eb; }",
    ].join("\n"),
    "src/components/Dashboard/CourseBarChart.tsx": "export function CourseBarChart() { return <div data-chart=\"course\" />; }\n",
    "src/components/Dashboard/TrendLineChart.tsx": "export function TrendLineChart() { return <div data-chart=\"trend\" />; }\n",
    "src/components/Dashboard/StatusPieChart.tsx": "export function StatusPieChart() { return <div data-chart=\"status\" />; }\n",
    "src/components/FileUploader/DragUpload.tsx": "export function DragUpload() { return <input type=\"file\" />; }\n",
    "cn_tutorial_orders_by_creator_20260512.csv": "creator,amount\nalice,12\n",
  };
  const mdViewerSeedFiles: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "md-viewer-recovery-fixture",
      private: true,
      scripts: {
        build: "tsc --noEmit",
        dev: "vite --port 1420",
      },
    }, null, 2) + "\n",
    "index.html": "<!doctype html><main><div id=\"toolbar\"></div><div id=\"status\"></div></main><script type=\"module\" src=\"/src/main.js\"></script>\n",
    "src/components/toolbar.js": [
      "export function renderToolbar(root) {",
      "  root.innerHTML = [",
      "    '<button id=\"btn-new\">New</button>',",
      "    '<button id=\"btn-open\">Open</button>',",
      "    '<button id=\"btn-save\">Save</button>',",
      "  ].join('');",
      "}",
      "",
    ].join("\n"),
    "src/main.js": [
      "import { renderToolbar } from './components/toolbar.js';",
      "",
      "const status = document.getElementById('status');",
      "renderToolbar(document.getElementById('toolbar'));",
      "",
      "export function initToolbar() {",
      "  const actions = {",
      "    'new-btn': () => { status.textContent = 'new'; },",
      "    'open-btn': () => { status.textContent = 'open'; },",
      "    'save-btn': () => { status.textContent = 'save'; },",
      "  };",
      "  for (const [id, handler] of Object.entries(actions)) {",
      "    document.getElementById(id)?.addEventListener('click', handler);",
      "  }",
      "}",
      "",
      "initToolbar();",
      "",
    ].join("\n"),
  };
  const seedFiles = realOmlxFixture === "md-viewer"
    ? mdViewerSeedFiles
    : csvSeedFiles;
  if (!customWorkspace) {
    for (const [relative, content] of Object.entries(seedFiles)) {
      const absolute = path.join(workspace, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");
    }
  }

  const resolveDiskPath = (rawPath: string) => {
    const candidate = path.isAbsolute(String(rawPath || ""))
      ? path.resolve(String(rawPath))
      : path.resolve(workspace, String(rawPath || "."));
    if (!isPathInsideWorkspace(candidate, workspace)) {
      throw new Error(`E2E_WORKSPACE_PATH_OUT_OF_SCOPE: ${rawPath}`);
    }
    return candidate;
  };

  let workspaceInventoryPromise: Promise<RealOmlxWorkspaceInventory> | null = null;
  const getWorkspaceInventory = () => {
    workspaceInventoryPromise ??= collectBoundedRealOmlxWorkspaceFiles(workspace, {
      maxFiles: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxWorkspaceFiles,
    });
    return workspaceInventoryPromise;
  };
  const invalidateWorkspaceInventory = () => {
    workspaceInventoryPromise = null;
  };
  let acceptanceState = createRealOmlxAcceptanceState();
  await page.exposeFunction("__MAIN_E2E_RECORD_ACCEPTANCE_EVENT", async (
    source: string,
    message: unknown,
  ) => {
    acceptanceState = recordRealOmlxAcceptanceDebugEvent(
      acceptanceState,
      source,
      message,
    );
    return acceptanceState;
  });

  await page.exposeFunction("__MAIN_E2E_DISK_READ", async (rawPath: string) => {
    const result = await readBoundedRealOmlxWorkspaceTextFile(workspace, rawPath, {
      maxBytes: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxExplicitReadBytes,
    });
    if (!result.ok) {
      throw new Error(
        `E2E_WORKSPACE_READ_BLOCKED: ${result.path || rawPath} (${result.reason}, ${result.sizeBytes} bytes)`,
      );
    }
    return result.content;
  });
  await page.exposeFunction("__MAIN_E2E_DISK_WRITE", async (rawPath: string, content: string, createNew = false) => {
    const absolute = resolveDiskPath(rawPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, { encoding: "utf8", flag: createNew ? "wx" : "w" });
    invalidateWorkspaceInventory();
    return null;
  });
  await page.exposeFunction("__MAIN_E2E_DISK_METADATA", async (rawPath: string) => {
    const absolute = resolveDiskPath(rawPath);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`FILE_METADATA_NOT_FOUND: ${rawPath}`);
      }
      throw error;
    }
    if (!stat.isFile()) throw new Error(`FILE_METADATA_UNAVAILABLE: ${rawPath} is not a file`);
    return { path: rawPath, sizeBytes: stat.size, modifiedMs: stat.mtimeMs };
  });
  await page.exposeFunction("__MAIN_E2E_CHECK_SOURCE_SYNTAX", (
    rawPath: string,
    content: string,
  ) => checkRealOmlxSourceSyntax(rawPath, content));
  await page.exposeFunction("__MAIN_E2E_DISK_GLOB", async () => await getWorkspaceInventory());
  await page.exposeFunction("__MAIN_E2E_DISK_SEARCH_FILES", async () => {
    const inventory = await getWorkspaceInventory();
    return {
      ...selectBoundedRealOmlxSearchFiles(inventory.files, {
        maxFiles: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFiles,
      }),
      inventoryTruncated: inventory.truncated,
    };
  });
  await page.exposeFunction("__MAIN_E2E_DISK_READ_TEXT_BATCH", async (rawPaths: string[]) =>
    await readBoundedRealOmlxWorkspaceTextFiles(workspace, rawPaths, {
      concurrency: REAL_OMLX_WORKSPACE_PROXY_LIMITS.searchReadConcurrency,
      maxFileBytes: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFileBytes,
      maxFiles: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchFiles,
      maxTotalBytes: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxSearchTotalBytes,
    })
  );
  await page.exposeFunction("__MAIN_E2E_DISK_READ_WINDOW", async (
    rawPath: string,
    options: Record<string, unknown>,
  ) => await readRealOmlxWorkspaceFileWindow(workspace, rawPath, {
    startLine: Number(options?.startLine) || undefined,
    endLine: Number(options?.endLine) || undefined,
    maxLines: Number(options?.maxLines) || undefined,
    maxChars: Number(options?.maxChars) || undefined,
    maxScanBytes: REAL_OMLX_WORKSPACE_PROXY_LIMITS.maxWindowScanBytes,
  }));
  await page.exposeFunction("__MAIN_E2E_DISK_LIST", async (rawPath: string) => {
    const absolute = resolveDiskPath(rawPath);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const child = path.join(absolute, entry.name);
      const relativePath = path.relative(workspace, child).replace(/\\/g, "/");
      if (entry.isDirectory() && shouldPruneRealOmlxWorkspaceDirectory(relativePath)) return [];
      if (!entry.isDirectory() && !entry.isFile()) return [];
      return [{
        name: entry.name,
        path: relativePath,
        is_dir: entry.isDirectory(),
      }];
    });
  });
  const initialWorkspaceInventory = await getWorkspaceInventory();
  if (customWorkspace && initialWorkspaceInventory.files.length === 0) {
    throw new Error(
      "E2E_REAL_OMLX_CUSTOM_WORKSPACE_EMPTY: copy the real fixture into REAL_OMLX_WORKSPACE before starting validation.",
    );
  }
  const leakedIgnoredPath = initialWorkspaceInventory.files.find((filePath) =>
    /(?:^|\/)(?:node_modules|target|dist|build|\.git|\.MAIN)(?:\/|$)/i.test(filePath) ||
    /^src-tauri\/(?:gen|icons)\//i.test(filePath)
  );
  if (leakedIgnoredPath) {
    throw new Error(`E2E_WORKSPACE_INVENTORY_PRUNE_FAILED: ${leakedIgnoredPath}`);
  }
  console.log(`[real-omlx-workspace-inventory] ${JSON.stringify({
    files: initialWorkspaceInventory.files.length,
    maxFiles: initialWorkspaceInventory.maxFiles,
    truncated: initialWorkspaceInventory.truncated,
    visitedDirectories: initialWorkspaceInventory.visitedDirectories,
    prunedDirectories: initialWorkspaceInventory.prunedDirectories,
    skippedEntries: initialWorkspaceInventory.skippedEntries,
  })}`);
  const fixtureMutationBaseline = realOmlxFixture === "unity" || process.env.REAL_OMLX_BOUND_EDITOR_MCP_URL
    ? {} : await readFixtureMutationContents(workspace);
  await page.exposeFunction("__MAIN_E2E_INSPECT_FIXTURE_MUTATION", async () =>
    await inspectFixtureMutation(workspace, fixtureMutationBaseline)
  );
  let requireDirectEditRepair = false;
  await page.exposeFunction("__MAIN_E2E_REQUIRE_DIRECT_EDIT_REPAIR", async () => {
    if (realOmlxFixture !== "csv") throw new Error("DIRECT_EDIT_REPAIR_REQUIRES_CSV_FIXTURE");
    await prepareCsvDirectEditRepairFixture(workspace);
    invalidateWorkspaceInventory();
    requireDirectEditRepair = true;
  });
  await page.exposeFunction("__MAIN_E2E_RUN_VERIFICATION", async (rawCommand: string) => {
    const command = String(rawCommand || "").trim();
    console.log(`[real-omlx-validation-command] ${JSON.stringify({
      command: command.slice(0, 1_000),
    })}`);
    if (!isFinitePlanValidationCommand(command)) {
      // Ordinary authorized shell tools have process receipts, not CSV
      // acceptance. Runtime independently decides whether a command can
      // discharge validation debt; the fixture must preserve that distinction.
      const result = await runRealOmlxWorkspaceCommand(workspace, command);
      return JSON.stringify({ command, cwd: workspace, ...result, success: result.exitCode === 0 && !result.timedOut });
    }
    const mutationState = await inspectFixtureMutation(
      workspace,
      fixtureMutationBaseline,
    );
    const isFiniteVerification = isFinitePlanValidationCommand(command);
    const commandResult = isFiniteVerification
      ? await runRealOmlxWorkspaceCommand(workspace, command)
      : null;
    const directEditVerification = requireDirectEditRepair
      ? await verifyCsvDirectEditRepairFixture(workspace)
      : null;
    const exitCode = commandResult?.exitCode === 0 &&
      !commandResult.timedOut &&
      (directEditVerification ? directEditVerification.passed : mutationState.satisfied) &&
      isFiniteVerification
      ? 0
      : commandResult?.exitCode || 1;
    const semanticSummary = exitCode === 0
      ? directEditVerification ? "Fresh independent CSV behavior and TypeScript verification passed." : `Fresh fixture verification passed: ${mutationState.detail}.`
      : [
          "FRESH_FIXTURE_ACCEPTANCE_FAILED: the finite command ran, but the current source still violates these user-visible acceptance conditions:",
          directEditVerification ? "CSV behavior and the public parser type contract must both pass the real checks below." : mutationState.detail,
        ].join("\n");
    return JSON.stringify({
      command,
      cwd: workspace,
      exitCode,
      timedOut: commandResult?.timedOut || false,
      durationMs: commandResult?.durationMs || 0,
      success: exitCode === 0,
      stdout: [
        commandResult?.stdout || "",
        ...(exitCode === 0 ? [semanticSummary] : []),
      ].filter(Boolean).join("\n"),
      stderr: [
        commandResult?.stderr || "",
        ...(exitCode === 0 ? [] : [semanticSummary]),
        ...(directEditVerification && !directEditVerification.passed ? [
          directEditVerification.behavior.stdout,
          directEditVerification.behavior.stderr,
          directEditVerification.typecheck.stdout,
          directEditVerification.typecheck.stderr,
        ] : []),
      ].filter(Boolean).join("\n"),
    });
  });

  await page.exposeFunction("__MAIN_E2E_PROXY_REQUEST", async (args: Record<string, unknown>) => {
    const url = String(args.url || "");
    const method = String(args.method || "POST").toUpperCase();
    const response = await fetch(url, {
      method,
      headers: args.headers as Record<string, string>,
      body: method === "GET" || method === "HEAD"
        ? undefined
        : typeof args.body === "string"
          ? args.body
          : undefined,
    });
    const text = await response.text();
    console.log(`[real-omlx-proxy] ${response.status} ${url} ${text.slice(0, 240).replace(/\s+/g, " ")}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    return contentType.toLowerCase().includes("text/event-stream")
      ? `__CONTENT_TYPE__:${contentType}\n${text}`
      : text;
  });

  await page.exposeFunction("__MAIN_E2E_PROXY_REQUEST_DETAILED", async (args: Record<string, unknown>) => {
    const url = String(args.url || "");
    const response = await fetch(url, {
      method: String(args.method || "POST"),
      headers: args.headers as Record<string, string>,
      body: typeof args.body === "string" ? String(args.body) : undefined,
    });
    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    console.log(`[real-omlx-proxy-detailed] ${response.status} ${url} ${text.slice(0, 160).replace(/\s+/g, " ")}`);
    return {
      status: response.status,
      ok: response.ok,
      body: text,
      content_type: response.headers.get("content-type") || null,
      headers,
    };
  });

  type RealOmlxChatStream = {
    reader: ReadableStreamDefaultReader<Uint8Array> | null;
    decoder: TextDecoder;
    controller: AbortController;
    url: string;
    model: string;
    canceled: boolean;
    capture: ReturnType<typeof createRealOmlxStreamCapture>;
    inactivity: ReturnType<typeof createRealOmlxStreamInactivity>;
  };
  const chatStreams = new Map<string, RealOmlxChatStream>();
  const canceledBeforeOpen = new Set<string>();
  const finishStreamEvidence = async (stream: RealOmlxChatStream, complete: boolean, reason: string | null) => {
    try { await stream.capture.finish(complete, reason, stream.inactivity.phase); }
    catch (error) { console.warn(`[real-omlx-stream-evidence-error] ${String(error)}`); }
  };
  const cancelChatStream = async (streamId: string, reason: string) => {
    const stream = chatStreams.get(streamId);
    if (!stream) { canceledBeforeOpen.add(streamId); return false; }
    stream.canceled = true;
    chatStreams.delete(streamId);
    stream.controller.abort(reason);
    void stream.reader?.cancel(reason).catch(() => {});
    await finishStreamEvidence(stream, false, reason);
    return true;
  };
  (page as any).__realOmlxCloseChatStreams = async () => {
    await Promise.all([...chatStreams.keys()].map(id => cancelChatStream(id, "outer_test_finished")));
  };
  const summarizeRuntimeV2ToolCalls = (text: string) => {
    const calls = new Map<number, { name: string; arguments: string }>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const deltas = parsed?.choices?.[0]?.delta?.tool_calls;
        if (!Array.isArray(deltas)) continue;
        for (const delta of deltas) {
          const index = Number(delta?.index) || 0;
          const current = calls.get(index) || {
            name: "",
            arguments: "",
          };
          current.name += String(delta?.function?.name || "");
          current.arguments += String(delta?.function?.arguments || "");
          calls.set(index, current);
        }
      } catch {
        // The diagnostic is best-effort and must never affect the transport.
      }
    }
    return [...calls.values()].map((call) => {
      let argumentSummary: unknown = "";
      try {
        const parsed = JSON.parse(call.arguments || "{}");
        argumentSummary =
          call.name === "read_file"
            ? Object.fromEntries(
                [
                  "path",
                  "start_line",
                  "end_line",
                  "max_lines",
                  "max_chars",
                ].flatMap((key) =>
                  Object.prototype.hasOwnProperty.call(parsed, key)
                    ? [[key, parsed[key]]]
                    : []
                ),
              )
            : call.name === "grep_search"
              ? {
                  path: String(parsed.path || ".").slice(0, 240),
                  query: String(parsed.query || parsed.pattern || "")
                    .slice(0, 500),
                }
            : call.name === "run_command"
              ? {
                  command: String(parsed.command || parsed.cmd || "")
                    .slice(0, 1_000),
                  timeout_ms: parsed.timeout_ms,
                }
            : call.name === "record_execution_contract"
              ? parsed
              : {
                  keys: Object.keys(parsed).sort(),
                };
      } catch {
        argumentSummary = {
          invalidJsonPreview: call.arguments.slice(0, 240),
        };
      }
      return {
        name: call.name,
        argumentHash: createHash("sha256")
          .update(`${call.name}:${call.arguments}`)
          .digest("hex"),
        arguments: argumentSummary,
      };
    });
  };
  const summarizeRuntimeV2ReasoningTail = (text: string) => {
    let reasoning = "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta;
        reasoning += String(
          delta?.reasoning_content || delta?.reasoning || "",
        );
        if (reasoning.length > 8_000) reasoning = reasoning.slice(-8_000);
      } catch {
        // The diagnostic is best-effort and must never affect the transport.
      }
    }
    return reasoning.replace(/\s+/g, " ").trim().slice(-2_000);
  };
  const summarizeRuntimeV2ContentTail = (text: string) => {
    let content = "";
    const finishReasons = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const choice = JSON.parse(payload)?.choices?.[0];
        content += String(choice?.delta?.content || "");
        if (content.length > 8_000) content = content.slice(-8_000);
        if (choice?.finish_reason) finishReasons.add(String(choice.finish_reason));
      } catch {
        // The diagnostic is best-effort and must never affect the transport.
      }
    }
    return {
      chars: content.length,
      finishReasons: [...finishReasons],
      tail: content.replace(/\s+/g, " ").trim().slice(-2_000),
    };
  };
  await page.exposeFunction("__MAIN_E2E_CHAT_STREAM_OPEN", async (args: Record<string, unknown>) => {
    const streamId = String(args.streamId || args.stream_id || "");
    const url = String(args.url || "");
    const bodyText = String(args.body || "");
    let model = "";
    let parsedBody: Record<string, unknown> | null = null;
    try {
      parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
      model = String(parsedBody.model || "");
    } catch {
      // Keep logging best-effort; invalid JSON will fail at the endpoint.
    }
    const responseFormat = parsedBody?.response_format as { type?: string; json_schema?: { name?: string } } | undefined;
    const toolNames: string[] = (parsedBody?.tools as any[] || []).map(tool => tool.function?.name);
    const replayConfirmation = breakoutReplayConfirmation && !breakoutColdRestore && !breakoutConfirmationReplayed &&
      testInfo.title.startsWith("real OMLX Breakout incident Plan") &&
      toolNames.includes("ask_plan_questions") &&
      (parsedBody?.messages as any[] || []).some(message =>
        message.role === "user" && typeof message.content === "string" && message.content.includes(breakoutTask));
    const responseOrigin = replayConfirmation ? "recorded_breakout_confirmation" : "real_omlx";
    providerWire.push({ at: new Date().toISOString(), streamId, model,
      responseOrigin,
      ...(replayConfirmation ? { sourceSessionId: breakoutConfirmation.sessionId, sourceProviderSequence: breakoutConfirmation.providerSequence } : {}),
      responseFormat: responseFormat?.type, responseSchema: responseFormat?.json_schema?.name,
      toolChoice: parsedBody?.tool_choice, template: parsedBody?.chat_template_kwargs, maxTokens: parsedBody?.max_tokens,
      messageDigest: createHash("sha256").update(JSON.stringify(parsedBody?.messages)).digest("hex"),
      engineVersionFacts: (parsedBody?.messages as any[] || []).flatMap(message =>
        typeof message.content === "string" && message.content.includes("[PROJECT BASELINE FACTS]")
          ? message.content.split("\n").filter(line => /^(runtime|package)=/.test(line)).slice(0, 16)
          : []),
      selectedKnowledgeAnchors: (parsedBody?.messages as any[] || []).map(message => message.content)
        .filter(content => typeof content === "string" && (content.includes("[SELECTED KNOWLEDGE REFERENCE DATA]") || content.includes("[ACTIVE ENGINE MANUAL KNOWLEDGE BASE]"))),
      roles: (parsedBody?.messages as any[] || []).map(message => message.role),
      tools: toolNames });
    const protocolEvidenceDirectory = String(process.env.REAL_OMLX_PROTOCOL_EVIDENCE_DIR || "").trim();
    const protocolEvidencePath = protocolEvidenceDirectory
      ? path.join(protocolEvidenceDirectory, streamId.replace(/[^a-z0-9_-]/gi, "_"))
      : undefined;
    if (protocolEvidencePath && parsedBody) {
      await fs.mkdir(protocolEvidenceDirectory, { recursive: true });
      // Credentials are transport headers; record only the model payload.
      await fs.writeFile(`${protocolEvidencePath}.request.json`, JSON.stringify({
        model: parsedBody.model, messages: parsedBody.messages, tools: parsedBody.tools,
        max_tokens: parsedBody.max_tokens, tool_choice: parsedBody.tool_choice,
        chat_template_kwargs: parsedBody.chat_template_kwargs,
      }, null, 2));
    }
    const requestMessages = Array.isArray(parsedBody?.messages)
      ? parsedBody.messages as Array<Record<string, unknown>>
      : [];
    console.log(`[real-omlx-request] ${JSON.stringify({
      model,
      messages: requestMessages.length,
      approximateMessageChars: requestMessages.reduce(
        (total, message) =>
          total + JSON.stringify(message).length,
        0,
      ),
      tools: Array.isArray(parsedBody?.tools)
        ? parsedBody.tools.length
        : 0,
      toolNames: Array.isArray(parsedBody?.tools)
        ? parsedBody.tools.map((tool) => {
            const record = tool && typeof tool === "object"
              ? tool as Record<string, unknown>
              : {};
            const fn = record.function &&
                typeof record.function === "object"
              ? record.function as Record<string, unknown>
              : {};
            return String(fn.name || "");
          })
        : [],
      toolChoice: parsedBody?.tool_choice ?? null,
      maxTokens: parsedBody?.max_tokens ?? null,
      thinkingBudget: parsedBody?.thinking_budget ?? null,
      temperature: parsedBody?.temperature ?? null,
      topP: parsedBody?.top_p ?? null,
      chatTemplateKwargs: parsedBody?.chat_template_kwargs ?? null,
    })}`);
    const traceContextMode =
      String(process.env.REAL_OMLX_TRACE_CONTEXT || "");
    const traceThisContext =
      traceContextMode === "1" ||
      (
        traceContextMode === "tail" &&
        bodyText.includes("src/main.js") &&
        bodyText.includes("start_line")
      );
    if (
      traceThisContext ||
      bodyText.includes("UNCHANGED_SOURCE_COVERAGE_REUSED") ||
      bodyText.includes("UNCHANGED_SOURCE_REPEAT_REJECTED") ||
      bodyText.includes("UNCHANGED_OBSERVATION_REPEAT_REJECTED") ||
      bodyText.includes("REPEATED_ACTION_REJECTED") ||
      bodyText.includes("ACTION_NOT_EXECUTED")
    ) {
      const messages = Array.isArray(parsedBody?.messages)
        ? parsedBody.messages as Array<Record<string, unknown>>
        : [];
      console.log(`[real-omlx-repeat-context] ${JSON.stringify(
        messages.slice(-8).map((message) => ({
          role: String(message.role || ""),
          toolCallId: String(message.tool_call_id || ""),
          toolCalls: Array.isArray(message.tool_calls)
            ? message.tool_calls.map((call) => {
                const record = call && typeof call === "object"
                  ? call as Record<string, unknown>
                  : {};
                const fn = record.function && typeof record.function === "object"
                  ? record.function as Record<string, unknown>
                  : {};
                return {
                  id: String(record.id || ""),
                  name: String(fn.name || ""),
                  argumentsPreview: String(fn.arguments || "")
                    .slice(0, 1_200),
                };
              })
            : [],
          repeatCodes: String(message.content || "").match(
            /UNCHANGED_SOURCE_COVERAGE_REUSED|UNCHANGED_SOURCE_REPEAT_REJECTED|UNCHANGED_OBSERVATION_REPEAT_REJECTED|REPEATED_ACTION_REJECTED|ACTION_NOT_EXECUTED/g,
          ) || [],
          systemInstructionTail: String(message.role || "") === "system"
            ? String(message.content || "").slice(-2_000)
            : "",
          toolResultHeader: String(message.role || "") === "tool"
            ? String(message.content || "")
              .split("---CONTENT START---", 1)[0]
              .slice(0, 1_200)
            : "",
        })),
      )}`);
    }
    const contractErrors = [
      ...bodyText.matchAll(
        /RUNTIME_V2_EXECUTION_CONTRACT_INVALID:[^"\\\n]{1,240}/g,
      ),
    ].map((match) => match[0]);
    if (contractErrors.length > 0) {
      console.log(
        `[real-omlx-contract-retry] ${JSON.stringify(
          [...new Set(contractErrors)].slice(-4),
        )}`,
      );
    }
    const requestedTimeoutMs = typeof args.timeoutMs === "number"
      ? args.timeoutMs
      : Number.NaN;
    // Mirror the product contract: an omitted provider timeout means no
    // per-request deadline. The finite Playwright poll/test timeout remains
    // the outer harness boundary and will close the browser/fetch if needed.
    const timeoutMs = Number.isFinite(requestedTimeoutMs) &&
        requestedTimeoutMs > 0
      ? Math.max(1_000, Math.trunc(requestedTimeoutMs))
      : null;
    const controller = new AbortController();
    const stream: RealOmlxChatStream = {
      reader: null,
      decoder: new TextDecoder(),
      controller,
      url,
      model,
      canceled: false,
      capture: createRealOmlxStreamCapture(protocolEvidencePath),
      inactivity: createRealOmlxStreamInactivity(timeoutMs),
    };
    // Register the lease before waiting for response headers. OMLX can spend
    // substantial time in prefill, and cancellation must still reach that
    // in-flight fetch instead of becoming a no-op before a reader exists.
    chatStreams.set(streamId, stream);
    try {
      if (canceledBeforeOpen.delete(streamId)) {
        stream.canceled = true;
        throw new Error("chat_stream_canceled_before_headers");
      }
      if (replayConfirmation) {
        breakoutConfirmationReplayed = true;
        console.log(`[real-omlx-recorded-confirmation] ${JSON.stringify({
          sessionId: breakoutConfirmation.sessionId, providerSequence: breakoutConfirmation.providerSequence,
          decisionSequence: breakoutConfirmation.decisionSequence, streamId,
        })}`);
      }
      const response = replayConfirmation
        ? breakoutConfirmationStream(model)
        : await stream.inactivity.wait(() => fetch(url, {
            method: "POST",
            headers: args.headers as Record<string, string>,
            body: bodyText,
            signal: controller.signal,
          }));
      stream.inactivity.headersReceived();
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      if (!response.body) throw new Error(`HTTP ${response.status}: response body is not streamable`);
      if (chatStreams.get(streamId) !== stream) {
        controller.abort();
        throw new Error("chat_stream_canceled_before_headers");
      }
      stream.reader = response.body.getReader();
      return { status: response.status };
    } catch (error) {
      if (chatStreams.get(streamId) === stream) chatStreams.delete(streamId);
      controller.abort();
      await finishStreamEvidence(stream, false, String(error));
      if (stream.canceled) return { status: 0, canceled: true };
      throw error;
    }
  });
  await page.exposeFunction("__MAIN_E2E_CHAT_STREAM_READ", async (streamId: string) => {
    const stream = chatStreams.get(String(streamId));
    if (!stream?.reader) return { done: true, chunk: "", canceled: true };
    try {
      const { done, value } = await stream.inactivity.wait(() => stream.reader!.read());
      // A cancelled lease may settle its pending read later. It cannot emit EOF
      // or overwrite the incomplete evidence of that exact cancelled lease.
      if (chatStreams.get(String(streamId)) !== stream) return { done: true, chunk: "", canceled: true };
      stream.inactivity.observeChunk(value?.byteLength || 0);
      const chunk = stream.decoder.decode(value || new Uint8Array(), { stream: !done });
      stream.capture.append(chunk, value?.byteLength || 0);
      if (done) {
        await finishStreamEvidence(stream, true, null);
        if (chatStreams.get(String(streamId)) === stream) chatStreams.delete(String(streamId));
        console.log(`[real-omlx-stream] 200 ${stream.url} model=${stream.model} chars=${stream.capture.chars} ${stream.capture.preview.replace(/\s+/g, " ")}`);
        const toolCalls = summarizeRuntimeV2ToolCalls(
          stream.capture.responseText,
        );
        if (toolCalls.length > 0) {
          console.log(
            `[real-omlx-tool-calls] ${JSON.stringify(toolCalls)}`,
          );
        }
        if (process.env.REAL_OMLX_LOG_REASONING_TAIL === "1") {
          const reasoningTail = summarizeRuntimeV2ReasoningTail(
            stream.capture.responseText,
          );
          if (reasoningTail) {
            console.log(`[real-omlx-reasoning-tail] ${reasoningTail}`);
          }
          const contentTail = summarizeRuntimeV2ContentTail(
            stream.capture.responseText,
          );
          console.log(
            `[real-omlx-content-tail] ${JSON.stringify(contentTail)}`,
          );
        }
      }
      return { done, chunk };
    } catch (error) {
      if (chatStreams.get(String(streamId)) === stream) chatStreams.delete(String(streamId));
      stream.controller.abort();
      void stream.reader.cancel("runtime_v2_stream_request_timeout").catch(() => {});
      await finishStreamEvidence(stream, false, String(error));
      if (stream.canceled) return { done: true, chunk: "", canceled: true };
      throw error;
    }
  });
  await page.exposeFunction("__MAIN_E2E_CHAT_STREAM_CANCEL", async (streamId: string) =>
    cancelChatStream(String(streamId), "runtime_v2_stream_canceled"));

  await page.exposeFunction("__MAIN_E2E_WEB_READ", async (cmd: string, args: Record<string, any>, metadata: any) => {
    const invocation: RealOmlxWebInvocation = { cmd, args: structuredClone(args), owner: metadata?.owner || null,
      commandKey: metadata?.commandKey || null, status: "pending", startedAt: Date.now() };
    webInvocations.push(invocation);
    const binary = path.resolve("src-tauri/target/debug/examples/read_only_web_bridge");
    try {
    const body: any = await new Promise((resolve, reject) => {
      const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`Web bridge exited ${code}: ${errors.slice(0, 300)}`));
        try { const result = JSON.parse(output); if (result.ok) resolve(result.body); else reject(new Error(result.error)); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ cmd, args }));
    });
    invocation.status = "fulfilled";
    invocation.responseProvider = body?.provider;
    invocation.fallbackProvider = body?.fallbackProvider;
    return body;
    } catch (error) {
      invocation.status = "rejected";
      invocation.error = String(error);
      throw error;
    } finally { invocation.finishedAt = Date.now(); }
  });

  await page.addInitScript(({ workspace, endpoint, apiKey, devServerUrl, fixture, limits, productionTools, skills, planOnly, breakoutColdRestore }) => {
    const debugEntries = ((window as any).__REAL_OMLX_DEBUG_LOGS__ ??= []);
    (window as any).__REAL_OMLX_ACCEPTANCE_STATE__ ??= {
      authoringContractIds: [],
      evidenceBundleHashes: [],
      observedSubagentPreferences: [],
      spawnedScopes: [],
      joinedSubagentIds: [],
      joinedScopeKeys: [],
      consumedScopeKeys: [],
    };
    const acceptanceEventSources = new Set([
      "agent.plan_authoring_contract_injected",
      "agent.plan_evidence_bundle_ready",
      "agent.plan_evidence_bundle_injected",
      "agent.task_orchestrator_phase",
      "agent.semantic_collaboration_task_spawned",
      "agent.semantic_collaboration_evidence_consumed",
      "parent_join_injected",
      "parent_resume",
    ]);
    const canceledStreamIds = new Set<string>();
    const readText = async (path: string) => {
      return await (window as any).__MAIN_E2E_DISK_READ(path);
    };
    const readWorkspaceInventory = async () => {
      const inventory = await (window as any).__MAIN_E2E_DISK_GLOB();
      return Array.isArray(inventory)
        ? { files: inventory, truncated: false, maxFiles: inventory.length }
        : inventory;
    };
    const readSearchFileSelection = async () => {
      const selection = await (window as any).__MAIN_E2E_DISK_SEARCH_FILES();
      return Array.isArray(selection)
        ? { files: selection, truncated: false, inventoryTruncated: false }
        : selection;
    };
    const readTextBatch = async (paths: string[]) =>
      await (window as any).__MAIN_E2E_DISK_READ_TEXT_BATCH(paths);
    const normalizedWorkspacePath = (value: unknown) => String(value || ".")
      .replace(/\\/g, "/")
      .replace(String(workspace).replace(/\\/g, "/"), "")
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "");
    const isPathInRequestedScope = (filePath: string, requestedPath: unknown) => {
      const normalizedFile = normalizedWorkspacePath(filePath);
      const normalizedScope = normalizedWorkspacePath(requestedPath);
      return !normalizedScope || normalizedScope === "." ||
        normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`);
    };
    const writeText = async (path: string, content: string, createNew = false) => {
      await (window as any).__MAIN_E2E_DISK_WRITE(path, content, createNew);
    };
    // A neutral startup scope avoids a fresh seeded epoch for the archived
    // Session. The actual workspace picker then opens the saved project.
    (window as any).__REAL_OMLX_WORKSPACE__ = breakoutColdRestore ? `${workspace}-cold-bootstrap` : workspace;
    (window as any).__REAL_OMLX_CONFIG__ = { endpoint, apiKey, productionTools, skills };

    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    const callbacks = new Map<number, unknown>();
    const eventListeners = new Map<number, { event: string; handlerId: number }>();
    let callbackId = 1;
    const emitTauriEvent = (event: string, payload: unknown) => {
      for (const listener of eventListeners.values()) {
        if (listener.event !== event) continue;
        const callback = callbacks.get(listener.handlerId);
        if (typeof callback === "function") {
          callback({ event, id: listener.handlerId, payload });
        }
      }
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
    let ptyActive = false;
    let ptyBuffer = "";
    let ptyForegroundPid: number | null = null;
    let ptyShellAvailable = true;
    let ptyForegroundState: "busy" | "idle" | "unknown" | "stopped" = "idle";
    let ptyForegroundGeneration = 0;
    const deliveredControlIds = new Set<string>();
    const appendPtyOutput = (value: string) => {
      ptyBuffer += value;
      emitTauriEvent("pty-data", { chunk: value });
    };
    const ptyReadResult = (startOffset: number, maxCharsRaw?: unknown) => {
      const boundedStart = Math.max(0, Math.min(Math.floor(startOffset), ptyBuffer.length));
      const maxChars = Math.max(100, Math.min(Number(maxCharsRaw) || 8_000, 200_000));
      const available = ptyBuffer.slice(boundedStart);
      const text = available.slice(0, maxChars);
      return {
        text,
        startOffset: boundedStart,
        endOffset: boundedStart + text.length,
        truncated: text.length < available.length,
        bufferStartOffset: 0,
        bufferEndOffset: ptyBuffer.length,
      };
    };
    const ptyStatus = () => ({
      active: ptyActive,
      running: ptyActive,
      pid: ptyActive ? 4100 : null,
      foregroundPid: ptyForegroundPid,
      shellAvailable: ptyShellAvailable,
      foregroundState: ptyForegroundState,
      foregroundGeneration: ptyForegroundGeneration,
      exitCode: null,
      bufferStartOffset: 0,
      bufferEndOffset: ptyBuffer.length,
      bufferBytes: ptyBuffer.length,
      tail: ptyBuffer.slice(-8_000),
    });
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (breakoutColdRestore && cmd === "plugin:dialog|open") return workspace;
      if (breakoutColdRestore && ["list_project_sessions", "rebuild_project_sessions_index"].includes(cmd)) {
        if (args?.workspace !== workspace) return [];
        const sessions = await (window as any).__MAIN_E2E_NATIVE_TOOL("list_project_sessions", args);
        return sessions.map(({ messages, runtimeSnapshot, ...metadata }: any) => ({ ...metadata, storageStatus: "ok" }));
      }
      if (breakoutColdRestore && cmd === "load_project_session_page") {
        throw new Error("Test bridge exposes the production SessionStore full-snapshot fallback.");
      }
      if (cmd === "list_all_session_snapshots" || cmd === "list_legacy_session_files") return [];
      if (cmd === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
      if (["save_plan_document", "read_plan_document", "list_plan_documents", "inspect_project_init_target", "commit_project_init", "knowledge_list_bases", "knowledge_list_presets", "knowledge_bootstrap_preset", "knowledge_set_base_enabled", "knowledge_list_sources", "knowledge_create_base", "knowledge_import_source", "knowledge_search", "knowledge_get_excerpt"].includes(cmd)) {
        return await (window as any).__MAIN_E2E_NATIVE_TOOL(cmd, args || {});
      }
      if (["ingest_attachment_file", "get_chat_temp_root"].includes(cmd)) {
        return await (window as any).__MAIN_E2E_NATIVE_TOOL(cmd, args || {});
      }
      if ((window as any).__MAIN_E2E_NATIVE_SESSION_RESTORE__ === true &&
          ["load_project_session", "load_project_session_meta", "load_project_session_page"].includes(cmd)) {
        const calls = ((window as any).__MAIN_E2E_SESSION_RESTORE_CALLS__ ||= []);
        const call: any = { cmd, args, status: "pending" };
        calls.push(call);
        try {
          const result = await (window as any).__MAIN_E2E_NATIVE_TOOL(cmd, args || {});
          call.status = "fulfilled";
          call.sessionId = result?.id;
          call.storageRevision = result?.storageRevision;
          return result;
        } catch (error) {
          call.status = "rejected";
          call.error = String(error);
          throw error;
        }
      }
      if (planOnly && ["run_command", "write_file", "write_file_atomic", "write_file_create_new", "replace_in_file", "spawn_pty", "write_pty"].includes(cmd)) {
        throw new Error(`PLAN_ONLY_UNEXPECTED_EFFECT: ${cmd}`);
      }
      if (productionTools && ["shell_permission_preflight", "run_command", "get_system_memory", "inspect_global_skill_package", "read_global_skill_package_file", "save_project_session", "load_project_session", "load_project_session_meta", "list_project_sessions"].includes(cmd)) {
        return await (window as any).__MAIN_E2E_NATIVE_TOOL(cmd, args || {});
      }
      if (productionTools && ["browser_evaluate", "spawn_pty", "write_pty"].includes(cmd)) throw new Error(`PRODUCTION_TEST_CAPABILITY_UNAVAILABLE: ${cmd}`);
      if (cmd === "web_search" || cmd === "web_fetch") {
        const aggregate = (window as any).__CODELY_E2E__?.readOnlySnapshot?.().aggregate;
        const key = cmd === "web_search" ? "query" : "url";
        const pending = (aggregate?.scheduledCommands || []).filter((command: any) =>
          command.payload.toolName === cmd && command.payload.arguments?.[key] === args?.[key]);
        return await (window as any).__MAIN_E2E_WEB_READ(cmd, args, {
          owner: aggregate ? { turn: aggregate.turn, run: aggregate.run?.identity } : null,
          commandKey: pending.length === 1 ? pending[0].idempotencyKey : null,
        });
      }
      if (cmd === "append_debug_log") {
        const raw = args || {};
        const message = String(raw.message || "");
        debugEntries.push({
          timestamp: String(raw.timestamp || ""),
          level: String(raw.level || ""),
          source: String(raw.source || ""),
          message: message.length <= limits.maxDebugMessageChars
            ? message
            : `${message.slice(0, limits.maxDebugMessageChars)}...<e2e-debug-truncated:${message.length}>`,
        });
        if (debugEntries.length > limits.maxDebugEntries) {
          debugEntries.splice(0, debugEntries.length - limits.maxDebugEntries);
        }
        if (acceptanceEventSources.has(String(raw.source || ""))) {
          (window as any).__REAL_OMLX_ACCEPTANCE_STATE__ = await (
            window as any
          ).__MAIN_E2E_RECORD_ACCEPTANCE_EVENT(String(raw.source || ""), raw.message);
        }
        return null;
      }
      if (cmd === "plugin:event|listen") {
        const handlerId = Number(args?.handler ?? callbackId++);
        eventListeners.set(handlerId, {
          event: String(args?.event || ""),
          handlerId,
        });
        return handlerId;
      }
      if (cmd === "plugin:event|unlisten") {
        eventListeners.delete(Number(args?.eventId ?? args?.handler));
        return null;
      }
      if (cmd === "get_system_memory") return {
        total_gb: 64,
        available_gb: 48,
        total_bytes: 64 * 1024 ** 3,
        available_bytes: 48 * 1024 ** 3,
      };
      if (cmd === "list_project_sessions") return [];
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path || workspace);
      if (cmd === "spawn_pty") {
        ptyActive = true;
        ptyForegroundPid = null;
        ptyShellAvailable = true;
        ptyForegroundState = "idle";
        ptyForegroundGeneration = 0;
        deliveredControlIds.clear();
        return null;
      }
      if (cmd === "resize_pty") return null;
      if (cmd === "get_pty_status") return ptyStatus();
      if (cmd === "write_pty") {
        if (!ptyActive) throw new Error("PTY not started");
        const input = String(args?.input || "");
        const controlId = String(args?.controlId || "");
        if (controlId && deliveredControlIds.has(controlId)) {
          return {
            accepted: false,
            duplicate: true,
            deliveryState: "duplicate",
            foregroundPid: ptyForegroundPid,
            foregroundState: ptyForegroundState,
            foregroundGeneration: ptyForegroundGeneration,
          };
        }
        if (controlId) deliveredControlIds.add(controlId);
        if (input.includes("\u0003")) {
          appendPtyOutput("^C\n");
          ptyForegroundPid = null;
          ptyShellAvailable = true;
          ptyForegroundState = "idle";
          return {
            accepted: true,
            duplicate: false,
            deliveryState: "delivered",
            foregroundPid: ptyForegroundPid,
            foregroundState: ptyForegroundState,
            foregroundGeneration: ptyForegroundGeneration,
          };
        }
        if (args?.allowForegroundInput !== true && args?.userTerminal !== true) {
          ptyForegroundGeneration += 1;
          deliveredControlIds.clear();
        }
        appendPtyOutput(input);
        if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|preview|start|serve)\b|\bvite\b/i.test(input)) {
          appendPtyOutput(`\nVITE v6.0.0 ready in 120 ms\n\n  Local: ${devServerUrl}\n`);
          ptyForegroundPid = 4102;
          ptyShellAvailable = false;
          ptyForegroundState = "busy";
        }
        return {
          accepted: true,
          duplicate: false,
          deliveryState: "delivered",
          foregroundPid: ptyForegroundPid,
          foregroundState: ptyForegroundState,
          foregroundGeneration: ptyForegroundGeneration,
        };
      }
      if (cmd === "read_pty_buffer") {
        const maxChars = Math.max(100, Math.min(Number(args?.maxChars) || ptyBuffer.length || 8_000, 200_000));
        return ptyBuffer.slice(-maxChars);
      }
      if (cmd === "read_pty_since") {
        return ptyReadResult(Number(args?.offset) || 0, args?.maxChars);
      }
      if (cmd === "read_pty_tail") {
        const maxChars = Math.max(100, Math.min(Number(args?.maxChars) || 8_000, 200_000));
        const startOffset = Math.max(0, ptyBuffer.length - maxChars);
        return ptyReadResult(startOffset, maxChars);
      }
      if (cmd === "clear_pty_buffer") {
        ptyBuffer = "";
        return ptyReadResult(0, args?.maxChars);
      }
      if (cmd === "cancel_proxy_request") return null;
      if (cmd === "cancel_chat_stream") {
        const streamId = String(args?.streamId || args?.stream_id || "");
        canceledStreamIds.add(streamId);
        await (window as any).__MAIN_E2E_CHAT_STREAM_CANCEL(streamId);
        return null;
      }
      if (cmd === "proxy_request") return await (window as any).__MAIN_E2E_PROXY_REQUEST(args || {});
      if (cmd === "proxy_request_detailed") return await (window as any).__MAIN_E2E_PROXY_REQUEST_DETAILED(args || {});
      if (cmd === "start_chat_stream") {
        const streamId = String(args?.streamId || args?.stream_id || "");
        if (canceledStreamIds.has(streamId)) return null;
        try {
          const opened = await (window as any).__MAIN_E2E_CHAT_STREAM_OPEN(args || {});
          if (opened?.canceled) canceledStreamIds.add(streamId);
          while (!canceledStreamIds.has(streamId)) {
            const next = await (window as any).__MAIN_E2E_CHAT_STREAM_READ(streamId);
            if (next?.canceled) { canceledStreamIds.add(streamId); break; }
            if (next?.chunk) {
              if (/"(?:content|reasoning_content|reasoning)"\s*:\s*"[^"\s]/.test(next.chunk)) {
                (window as any).__MAIN_E2E_CHAT_TRANSPORT_CHUNKS = ((window as any).__MAIN_E2E_CHAT_TRANSPORT_CHUNKS || 0) + 1;
              }
              emitTauriEvent("chat-stream-chunk", { stream_id: streamId, chunk: next.chunk });
            }
            if (next?.done) break;
          }
          emitTauriEvent("chat-stream-done", {
            stream_id: streamId,
            status: canceledStreamIds.has(streamId) ? "cancelled" : "ok",
            error: null,
          });
        } catch (error) {
          if (!canceledStreamIds.has(streamId)) emitTauriEvent("chat-stream-done", {
            stream_id: streamId,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }
      if (cmd === "get_project_skeleton") {
        const inventory = await readWorkspaceInventory();
        const filePaths = Array.isArray(inventory?.files) ? inventory.files : [];
        const visiblePaths = filePaths
          .filter((filePath: string) =>
            !/(?:^|\/)\.[^/]+(?:\/|$)/.test(filePath) &&
            !/(?:^|\/)package-lock\.json$/.test(filePath)
          )
          .slice(0, 120);
        return [
          ".",
          ...visiblePaths.map((filePath: string) => `- ${filePath}`),
          ...(inventory?.truncated ? [`... (workspace inventory capped at ${inventory.maxFiles} files)`] : []),
        ].join("\n");
      }
      if (cmd === "list_directory") {
        const path = String(args?.path || ".");
        try {
          return await (window as any).__MAIN_E2E_DISK_LIST(path === workspace ? "." : path);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error || "unknown error");
          throw new Error(
            `E2E_${String(fixture || "workspace").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_LIST_DIRECTORY_FAILED: ${path}: ${detail}`,
          );
        }
      }
      if (cmd === "glob_search") {
        const requestedGlob = String(args?.glob || args?.pattern || args?.query || args?.path || "**/*")
          .replace(/\\/g, "/")
          .replace(/^\.\//, "");
        const escapeRegexChar = (char: string) => /[\\^$.[\]()+|]/.test(char) ? `\\${char}` : char;
        const globToRegex = (pattern: string) => {
          let source = "^";
          for (let index = 0; index < pattern.length; index += 1) {
            const char = pattern[index];
            const next = pattern[index + 1];
            if (char === "*" && next === "*") {
              if (pattern[index + 2] === "/") {
                source += "(?:.*/)?";
                index += 2;
              } else {
                source += ".*";
                index += 1;
              }
            } else if (char === "*") {
              source += "[^/]*";
            } else if (char === "?") {
              source += "[^/]";
            } else if (char === "{") {
              const close = pattern.indexOf("}", index + 1);
              if (close > index) {
                source += `(?:${pattern.slice(index + 1, close).split(",").map((part) =>
                  part.split("").map(escapeRegexChar).join("")
                ).join("|")})`;
                index = close;
              } else {
                source += "\\{";
              }
            } else {
              source += escapeRegexChar(char);
            }
          }
          return new RegExp(`${source}$`, "i");
        };
        const matcher = globToRegex(requestedGlob || "**/*");
        const inventory = await readWorkspaceInventory();
        return (Array.isArray(inventory?.files) ? inventory.files : [])
          .filter((filePath: string) => !/(?:^|\/)\.[^/]+(?:\/|$)/.test(filePath))
          .filter((filePath: string) => matcher.test(filePath))
          .slice(0, limits.maxGlobResults);
      }
      if (cmd === "grep_search") {
        const query = String(args?.query || args?.pattern || "");
        const selection = await readSearchFileSelection();
        const requestedPath = args?.path || ".";
        const scopedFiles = (Array.isArray(selection?.files) ? selection.files : [])
          .filter((filePath: string) => isPathInRequestedScope(filePath, requestedPath));
        const batch = await readTextBatch(scopedFiles);
        let matcher: RegExp | null = null;
        try {
          matcher = query ? new RegExp(query, "i") : null;
        } catch {
          matcher = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
        }
        const hits: string[] = [];
        let outputChars = 0;
        let truncated = Boolean(selection?.truncated || selection?.inventoryTruncated || batch?.truncated);
        for (const entry of Array.isArray(batch?.files) ? batch.files : []) {
          const lines = String(entry.content || "").split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (matcher && !matcher.test(line)) continue;
            const hit = `${entry.path}:${index + 1}:${line}`;
            if (
              hits.length >= limits.maxSearchResults ||
              outputChars + hit.length + 1 > limits.maxGrepOutputChars
            ) {
              truncated = true;
              break;
            }
            hits.push(hit);
            outputChars += hit.length + 1;
          }
          if (hits.length >= limits.maxSearchResults || outputChars >= limits.maxGrepOutputChars) break;
        }
        if (truncated) hits.push("... (E2E workspace search truncated at bounded file/result limits)");
        return hits.join("\n");
      }
      if (cmd === "code_ast_query") {
        const filePath = String(args?.path || "");
        const content = await readText(filePath);
        const symbols = String(content).split(/\r?\n/).flatMap((line, index) => {
          const match = line.match(/\b(?:export\s+)?(?:async\s+)?(interface|type|class|function|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
          if (!match) return [];
          return [{
            name: match[2],
            kind: match[1],
            syntaxKind: match[1] === "interface" ? "interface_declaration" : `${match[1]}_declaration`,
            startLine: index + 1,
            startColumn: 1,
            endLine: index + 1,
            signature: line.trim(),
          }];
        });
        return {
          path: filePath,
          language: filePath.endsWith(".tsx") ? "tsx" : "typescript",
          rootKind: "program",
          hasErrors: false,
          errorCount: 0,
          symbols,
          truncated: false,
          note: "E2E structured AST fixture",
        };
      }
      if (cmd === "find_symbol_references") {
        const symbol = String(args?.symbol || "");
        const requestedPath = String(args?.path || "");
        const selection = await readSearchFileSelection();
        const filePaths = (Array.isArray(selection?.files) ? selection.files : [])
          .filter((filePath: string) => /\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|cs)$/.test(filePath))
          .filter((filePath: string) => isPathInRequestedScope(filePath, requestedPath));
        const batch = await readTextBatch(filePaths);
        const occurrences: Array<Record<string, unknown>> = [];
        let totalOccurrences = 0;
        for (const entry of Array.isArray(batch?.files) ? batch.files : []) {
          const filePath = String(entry.path || "");
          const content = String(entry.content || "");
          String(content).split(/\r?\n/).forEach((line, index) => {
            const column = line.indexOf(symbol);
            if (column < 0) return;
            totalOccurrences += 1;
            if (occurrences.length >= limits.maxSearchResults) return;
            occurrences.push({
              path: filePath,
              language: filePath.endsWith(".tsx") ? "tsx" : "typescript",
              role: /\bimport\b/.test(line)
                ? "import"
                : /\b(?:interface|type|class|function|const|let)\s+/.test(line)
                  ? "definition"
                  : "reference",
              syntaxKind: "identifier",
              line: index + 1,
              column: column + 1,
              context: line.trim(),
            });
          });
        }
        return {
          symbol,
          scope: requestedPath || workspace,
          scannedFiles: Array.isArray(batch?.files) ? batch.files.length : 0,
          skippedFiles: Array.isArray(batch?.skipped) ? batch.skipped.length : 0,
          parseFailures: 0,
          occurrences,
          truncated: Boolean(
            selection?.truncated || selection?.inventoryTruncated || batch?.truncated ||
            totalOccurrences > limits.maxSearchResults
          ),
          note: "E2E structured reference fixture with production-like file and result bounds",
        };
      }
      if (cmd === "build_repository_index") {
        const selection = await readSearchFileSelection();
        const sourceFiles = (Array.isArray(selection?.files) ? selection.files : [])
          .filter((filePath: string) => /\.(?:ts|tsx|js|jsx|mjs|cjs|css|rs|py|json|toml|md)$/.test(filePath));
        const batch = await readTextBatch(sourceFiles);
        const symbols: Array<Record<string, unknown>> = [];
        const imports: Array<Record<string, unknown>> = [];
        const calls: Array<Record<string, unknown>> = [];
        let indexTruncated = Boolean(selection?.truncated || selection?.inventoryTruncated || batch?.truncated);
        for (const entry of Array.isArray(batch?.files) ? batch.files : []) {
          const filePath = String(entry.path || "");
          const content = String(entry.content || "");
          const lines = String(content).split(/\r?\n/);
          lines.forEach((line, index) => {
            const symbol = line.match(/\b(?:export\s+)?(?:function|const|interface|type|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
            if (symbol) {
              if (symbols.length < limits.maxIndexEntries) {
                symbols.push({
                  name: symbol[1],
                  kind: line.includes("interface") ? "interface" : line.includes("type") ? "type" : line.includes("class") ? "class" : line.includes("function") ? "function" : "constant",
                  file: filePath,
                  line: index + 1,
                  signature: line.trim(),
                });
              } else {
                indexTruncated = true;
              }
            }
            const imported = line.match(/from\s+['"]([^'"]+)['"]/);
            if (imported) {
              if (imports.length < limits.maxIndexEntries) {
                imports.push({ from: filePath, to: imported[1], kind: "import", line: index + 1 });
              } else {
                indexTruncated = true;
              }
            }
            for (const call of line.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
              if (calls.length < limits.maxIndexEntries) {
                calls.push({ from: filePath, symbol: call[1], line: index + 1 });
              } else {
                indexTruncated = true;
              }
            }
          });
        }
        return {
          root: workspace,
          generatedAtMs: Date.now(),
          symbols,
          imports,
          calls,
          dependencies: [],
          embeddings: [],
          truncated: indexTruncated,
        };
      }
      if (cmd === "read_file") return await readText(String(args?.path || ""));
      if (cmd === "check_source_syntax") {
        return await (window as any).__MAIN_E2E_CHECK_SOURCE_SYNTAX(
          String(args?.path || ""),
          String(args?.content || ""),
        );
      }
      if (cmd === "read_file_window") {
        const path = String(args?.path || "");
        const windowResult = await (window as any).__MAIN_E2E_DISK_READ_WINDOW(path, {
          startLine: args?.startLine ?? args?.start_line,
          endLine: args?.endLine ?? args?.end_line,
          maxLines: args?.maxLines ?? args?.max_lines,
          maxChars: args?.maxChars ?? args?.max_chars,
        });
        return {
          path,
          content: String(windowResult?.content || ""),
          startLine: Number(windowResult?.startLine || 0),
          endLine: Number(windowResult?.endLine || 0),
          totalLines: Number(windowResult?.totalLines || 0),
          totalChars: Number(windowResult?.totalChars || 0),
          returnedChars: Number(windowResult?.returnedChars || 0),
          truncated: Boolean(windowResult?.truncated),
          nextStartLine: windowResult?.nextStartLine ?? null,
          ...(windowResult?.contentVersion
            ? { contentVersion: String(windowResult.contentVersion) }
            : {}),
        };
      }
      if (cmd === "read_document") {
        const path = String(args?.path || "");
        return {
          path,
          documentType: "csv",
          title: null,
          sourceName: path,
          content: await readText(path),
          truncated: false,
          metadata: {},
        };
      }
      if (cmd === "analyze_tabular_document") {
        return {
          sourceName: String(args?.path || ""),
          documentType: "csv",
          metadata: {
            rowCount: 2,
            columnCount: 2,
            columns: ["creator", "amount"],
            numericColumns: ["amount"],
            categoricalColumns: ["creator"],
            datetimeColumns: [],
          },
          sampleRows: {
            head: [{ creator: "alice", amount: "12" }],
            tail: [{ creator: "alice", amount: "12" }],
          },
        };
      }
      if (cmd === "query_tabular_document") {
        return {
          path: String(args?.path || ""),
          columns: ["creator", "amount"],
          rows: [{ creator: "alice", amount: "12" }],
          totalRows: 1,
          returnedRows: 1,
        };
      }
      if (cmd === "get_file_metadata") {
        const path = String(args?.path || "");
        return await (window as any).__MAIN_E2E_DISK_METADATA(path);
      }
      if (cmd === "write_file" || cmd === "write_file_atomic" || cmd === "write_file_create_new") {
        await writeText(String(args?.path || ""), String(args?.content || ""), cmd === "write_file_create_new");
        return null;
      }
      if (cmd === "shell_permission_preflight") {
        const command = String(args?.command || "");
        return {
          command,
          decision: "allow",
          source: "e2e",
          segmentDecisions: [{
            command,
            decision: "allow",
            riskLevel: "low",
          }],
          riskLevel: "low",
          requiresApproval: false,
        };
      }
      if (cmd === "browser_evaluate") {
        // This fixture validates MAIN's orchestration/evidence contract only.
        // Real HTTP navigation and action semantics are exercised separately
        // by browser-evaluate-script.test.mjs against an actual local server.
        const mutationState = await (window as any).__MAIN_E2E_INSPECT_FIXTURE_MUTATION();
        const splitDirectives = (value: unknown) => String(value || "")
          .split(/\r?\n|;;/g)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
        const parseDirective = (line: string, fallbackKind: string) => {
          const matched = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*([\s\S]*)$/);
          return matched
            ? { kind: String(matched[1]).toLowerCase().replace(/[\s-]+/g, "_"), value: String(matched[2] || "").trim() }
            : { kind: fallbackKind, value: line };
        };
        const roleFor = (value: string) => value.match(/(?:^|[^a-z])(new|open|save)(?:[^a-z]|$)/i)?.[1]?.toLowerCase() || "";
        const actionRows = splitDirectives(args?.actions).map((line, index) => {
          const directive = parseDirective(line, "click");
          const role = roleFor(directive.value);
          const stateful = ["click", "fill", "press", "select_file", "set_input_files", "upload"].includes(directive.kind);
          const ok = !stateful || (mutationState.satisfied === true && Boolean(role));
          return {
            id: `action-${index + 1}`,
            kind: directive.kind,
            value: directive.value,
            ok,
            beforeState: stateful ? { bodyText: "New Open Save", externalDomFingerprint: "before" } : null,
            afterState: stateful && ok
              ? { bodyText: `New Open Save ${role}`, externalDomFingerprint: `after-${role}` }
              : null,
            stateChanged: stateful && ok,
            changedFields: stateful && ok ? ["bodyText", "externalDomFingerprint"] : [],
            nativeChangedFields: [],
            effectChangedFields: stateful && ok ? ["bodyText", "externalDomFingerprint"] : [],
            effectStateChanged: stateful && ok,
          };
        });
        const assertionRows = splitDirectives(args?.checks).map((line) => {
          const directive = line.toLowerCase().replace(/[\s-]+/g, "_") === "no_console_errors"
            ? { kind: "no_console_errors", value: "" }
            : parseDirective(line, "text");
          if (directive.kind === "no_console_errors") {
            return {
              kind: directive.kind,
              value: directive.value,
              passed: true,
              detail: "no console errors",
              beforePassed: true,
              changedAfterAction: false,
              afterActionId: null,
              causallyLinked: false,
            };
          }
          const role = roleFor(directive.value);
          const linkedAction = actionRows.find((action) =>
            action.ok && role && roleFor(String(action.value || "")) === role
          );
          const effectKind = ["text", "not_text", "selector", "not_selector"].includes(directive.kind);
          const passed = Boolean(linkedAction && effectKind);
          return {
            kind: directive.kind,
            value: directive.value,
            passed,
            detail: passed ? "post-action fixture state observed" : "no matching successful fixture action",
            beforePassed: false,
            changedAfterAction: passed,
            afterActionId: linkedAction?.id || null,
            causallyLinked: passed,
          };
        });
        const ok = mutationState.satisfied === true &&
          actionRows.every((action) => action.ok) &&
          assertionRows.every((assertion) => assertion.passed);
        const semanticFailureDetail =
          mutationState.satisfied === true
            ? ""
            : String(
                mutationState.detail ||
                  "The fixture mutation does not satisfy the semantic acceptance oracle.",
              );
        return {
          ok,
          url: String(args?.url || ""),
          finalUrl: String(args?.url || ""),
          status: 200,
          title: "Real OMLX fixture",
          actions: actionRows,
          assertions: assertionRows,
          consoleErrors: [],
          // The fixture oracle stands in for concrete DOM/native failures in
          // this isolated replay. Feed its actionable path:line diagnostics
          // back through the real validation receipt so Runtime v2 can reopen
          // the exact corrective source window instead of learning about the
          // semantic gap only after the Turn has already ended.
          pageErrors: semanticFailureDetail
            ? [semanticFailureDetail]
            : [],
          failedRequests: [],
          textPreview: fixture === "md-viewer" ? "New Open Save" : "creatorName",
          durationMs: 1,
        };
      }
      if (cmd === "run_command") {
        return await (window as any).__MAIN_E2E_RUN_VERIFICATION(String(args?.command || args?.cmd || ""));
      }
      return null;
    };
  }, {
    workspace,
    endpoint: omlxEndpoint,
    apiKey: omlxApiKey,
    devServerUrl: realOmlxDevServerUrl,
    fixture: realOmlxFixture,
    limits: REAL_OMLX_WORKSPACE_PROXY_LIMITS,
    productionTools, skills, planOnly: realOmlxPlanOnly, breakoutColdRestore,
  });
});

async function attachRealOmlxFailureDiagnostics(
  page: Page,
  testInfo: TestInfo,
  workspace: string,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  let snapshot: any = null;
  let presentation: any = null;
  let fixture: any = null;
  try {
    ({ snapshot, presentation } = await page.evaluate(() => {
      const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.() || null;
      const capsule = document.querySelector<HTMLElement>(
        '[data-testid="agent-explanation-capsule"]',
      );
      const visibleProgress = [...document.querySelectorAll<HTMLElement>(
        '[data-testid="progress-block"]',
      )].map((node) => ({
        visible: node.getClientRects().length > 0,
        phase: node.dataset.phase || "",
        status: node.dataset.status || "",
        text: String(node.textContent || "").replace(/\s+/g, " ").trim(),
      }));
      return {
        snapshot,
        presentation: {
          capsule: capsule ? {
            visible: capsule.getClientRects().length > 0,
            text: String(capsule.textContent || "").replace(/\s+/g, " ").trim(),
            guidanceSource: capsule.dataset.guidanceSource || "",
            status: capsule.dataset.capsuleStatus || "",
            turnId: capsule.dataset.turnId || "",
            runId: capsule.dataset.runId || "",
            updatedAt: capsule.dataset.guidanceUpdatedAt || "",
          } : null,
          processTimelineVisible:
            document.querySelector<HTMLElement>('[data-testid="live-turn-process-timeline"]')
              ?.getClientRects().length > 0,
          progress: visibleProgress,
        },
      };
    }));
  } catch (error) {
    presentation = {
      pageInspectionError: error instanceof Error ? error.message : String(error),
    };
  }
  await fs.writeFile(testInfo.outputPath("runtime-failure-snapshot.json"), JSON.stringify({ snapshot, presentation }, null, 2));
  try {
    await fs.access(workspace);
    const inspected = await inspectFixtureMutation(workspace);
    const fileHashes = Object.fromEntries(
      Object.entries(inspected.contents).map(([relativePath, content]) => [
        relativePath,
        {
          bytes: Buffer.byteLength(content, "utf8"),
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ]),
    );
    fixture = {
      workspace,
      satisfied: inspected.satisfied,
      detail: inspected.detail,
      fileHashes,
    };
  } catch (error) {
    fixture = {
      workspace,
      inspectionError: error instanceof Error ? error.message : String(error),
    };
  }
  const attachments = [
    {
      name: "runtime-v2-ledger",
      value: {
        testStatus: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        identity: {
          currentTurnId: snapshot?.currentTurnId || null,
          currentTurnStatus: snapshot?.currentTurnStatus || null,
          currentTurnIntent: snapshot?.currentTurnIntent || null,
          agentStatus: snapshot?.agentStatus || null,
          isGenerating: snapshot?.isGenerating ?? null,
        },
        admission: snapshot?.lastWorkspaceInstructionAcceptance || null,
        runtimeV2: snapshot?.runtimeV2 || null,
      },
    },
    {
      name: "runtime-v2-debug",
      value: {
        runtimeV2: snapshot?.runtimeV2?.debug || [],
        terminalAndErrors: (snapshot?.debugTail || []).filter((entry: { source?: string }) =>
          /runtime_v2|terminal|error|failed|crash|timeout|watchdog/i.test(
            String(entry?.source || ""),
          )
        ).slice(-400),
      },
    },
    {
      name: "runtime-v2-presentation",
      value: {
        ledgerProjection: snapshot?.runtimeV2?.presentation || null,
        browser: presentation,
        taskFlow: (snapshot?.taskFlowPreview || []).filter((block: { turnId?: string }) =>
          block.turnId === snapshot?.currentTurnId
        ),
      },
    },
    {
      name: "fixture-state",
      value: fixture,
    },
  ];
  for (const attachment of attachments) {
    await testInfo.attach(`${attachment.name}.json`, {
      body: Buffer.from(JSON.stringify(attachment.value, null, 2), "utf8"),
      contentType: "application/json",
    });
  }
}

async function expectRealWorkspaceTerminal(page: Page, testInfo: TestInfo, label: string, approveTools = false): Promise<any> {
  let snapshot: any;
  try {
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
      if (approveTools && snapshot.activeActionRequest?.kind === "tool_permission") {
        await page.evaluate(() => (window as any).__CODELY_E2E__.approvePendingTool());
      }
      return !!snapshot.runtimeV2?.terminalOutcome && !snapshot.isGenerating;
    }, { timeout: 120_000, intervals: [500] }).toBe(true);
  } finally {
    snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
    await fs.writeFile(testInfo.outputPath(`${label}.json`), JSON.stringify(snapshot, null, 2));
  }
  expect(snapshot.runtimeV2.terminal.exactlyOnce).toBe(true);
  expectWorkspaceConclusionOrder(snapshot);
  return snapshot;
}

function realWorkspaceToolSucceeded(snapshot: any, toolName: string): boolean {
  const keys = new Set((snapshot.runtimeV2?.commands || []).filter((command: any) => command.toolName === toolName).map((command: any) => command.idempotencyKey));
  return (snapshot.runtimeV2?.events || []).some((event: any) => keys.has(event.idempotencyKey) &&
    ((event.type === "tool.completed" && event.status === "succeeded") || (event.type === "validation.completed" && event.passed === true)));
}

// A caller-provided fixture is never owned by this test. Generated fixtures
// are removed by default so repeated real-model runs do not leave a growing
// collection of stale workspaces; opt in when a failed case needs inspection.
test.afterEach(async ({ page }, testInfo) => {
  const workspace = String((page as any).__realOmlxWorkspace || "").trim();
  try {
    if (workspace) await attachRealOmlxFailureDiagnostics(page, testInfo, workspace);
  } finally {
    await (page as any).__realOmlxCloseChatStreams?.();
  }
  if (String(process.env.REAL_OMLX_WORKSPACE || "").trim()) return;
  if (process.env.MAIN_KEEP_REAL_OMLX_FIXTURE === "1") return;
  if (!workspace) return;
  await fs.rm(workspace, { recursive: true, force: true });
});



for (const model of models) {
  test(`deterministic production repeated mutation rejections recover through validation with ${model}`, async ({ page }, testInfo) => {
    test.skip(process.env.MAIN_DETERMINISTIC_PAUSE_E2E !== "1");
    test.setTimeout(60_000);
    page.on("console", message => { if (message.text().startsWith("[rejection-fixture]")) console.log(message.text()); });
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => {
      let decisions = 0;
      const streams = new Map<string, string[]>();
      (window as any).__MAIN_E2E_CHAT_STREAM_OPEN = async (args: any) => {
        const body = JSON.parse(args.body);
        let content = "";
        let call: any = null;
        if (!(body.tools || []).length && body.messages[0]?.content.includes("Interpret MAIN")) {
          content = JSON.stringify({ semantic: { objective: "Map creator to creatorName and validate", workType: "implement", answerFormat: "report", requiredCapabilities: ["workspace_read", "workspace_write", "command"], forbiddenCapabilities: [], approvalRequiredCapabilities: [] } });
        } else {
          decisions += 1;
          if (decisions === 1) call = { name: "read_file", arguments: { path: "src/hooks/useCsvParser.ts" } };
          else if (decisions <= 4) call = { name: "replace_in_file", arguments: { path: "src/hooks/useCsvParser.ts", search_text: "creator: row.creator || row['创建者'] || '',", replace_text: "creator: row.creator || row['创建者'] || '',\n    creatorName: row.creator || row['创建者'] || ''," } };
          else if (decisions === 5) call = { name: "run_command", arguments: { command: "npm test", description: "Verify creator mapping after the committed mutation" } };
          else content = "已完成 creatorName 映射，npm test 验证通过。";
          console.log("[rejection-fixture]", decisions, call?.name || "final");

        }
        const delta = call ? { tool_calls: [{ index: 0, id: `duplicate-recovery-${decisions}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content };
        streams.set(args.streamId, [`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`]);
        return { status: 200 };
      };
      (window as any).__MAIN_E2E_CHAT_STREAM_READ = async (id: string) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        const chunk = streams.get(id)?.shift();
        return chunk ? { chunk, done: false } : { chunk: "", done: true };
      };
      void (window as any).__CODELY_E2E__.sendDirectEditMessage("直接修复 src/hooks/useCsvParser.ts，将 creator 同时映射到 creatorName，保留 creator 并运行 npm test 验证。不要生成计划。");
    });
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
      await fs.writeFile(testInfo.outputPath("repeated-mutation-latest.json"), JSON.stringify(snapshot, null, 2));
      return !!snapshot.runtimeV2?.terminalOutcome || snapshot.activeActionRequest?.kind === "user_choice";
    }, { timeout: 45_000, intervals: [500] }).toBe(true);
    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
    await fs.writeFile(testInfo.outputPath("repeated-mutation-recovery.json"), JSON.stringify(snapshot, null, 2));
    expect(snapshot.runtimeV2?.terminalOutcome?.resultKind).toBe("success");
    expect(snapshot.runtimeV2.events.filter((event: any) => event.type === "run.paused")).toHaveLength(0);
    const rejected = snapshot.runtimeV2.events.flatMap((event: any) => event.type === "provider.responded" ? event.actionReceipts || [] : []).filter((receipt: any) => receipt.status === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rejected.map((receipt: any) => receipt.actionIdentity)).size).toBe(1);
    expect(rejected.some((receipt: any) => receipt.priorFeedbackObserved)).toBe(true);
    expect(snapshot.runtimeV2.events.filter((event: any) => event.type === "tool.completed" && event.status === "succeeded" && event.evidence?.some((item: any) => item.kind === "mutation"))).toHaveLength(1);
    expect(snapshot.runtimeV2.events.some((event: any) => event.type === "validation.completed" && event.passed)).toBe(true);
    expect(snapshot.runtimeV2.terminal.exactlyOnce).toBe(true);
    expectWorkspaceConclusionOrder(snapshot);
  });

  test(`deterministic production unexecuted Skills recover without replaying failed effects with ${model}`, async ({ page }, testInfo) => {
    test.skip(process.env.MAIN_DETERMINISTIC_PAUSE_E2E !== "1");
    test.setTimeout(90_000);
    const workspace = (page as any).__realOmlxWorkspace as string;
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => {
      const responses = new Map<string, string[]>();
      (window as any).__SKIP_RECOVERY_REQUESTS__ = [];
      (window as any).__MAIN_E2E_CHAT_STREAM_OPEN = async (args: any) => {
        const requests = (window as any).__SKIP_RECOVERY_REQUESTS__;
        requests.push(JSON.parse(args.body));
        const count = requests.length;
        const skills = [{ name: "load_skill", arguments: { skill_id: "s:76d7f9e6" } },
          { name: "load_skill", arguments: { skill_id: "s:e84abf7c" } }];
        const failed = { name: "run_command", arguments: { command: "printf x >> effect.txt; exit 6", description: "Exercise a partial failed effect once" } };
        const calls = count === 1 ? [{ name: "run_command", arguments: { command: "printf denied > /dev/null", description: "Exercise the production path guard" } }, ...skills]
          : count === 2 ? skills : count === 3 ? [failed, { name: "run_command", arguments: { command: "printf y >> downstream.txt", description: "Must not run after a failed predecessor" } }]
          : [failed];
        const delta = { tool_calls: calls.map((call, index) => ({ index, id: `skip-recovery-${count}-${index}`, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
        responses.set(args.streamId || args.stream_id, [`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`]);
      };
      (window as any).__MAIN_E2E_CHAT_STREAM_READ = async (id: string) => { const items = responses.get(id) || []; return items.length ? { chunk: items.shift(), done: false } : { done: true }; };
      (window as any).__MAIN_E2E_CHAT_STREAM_CANCEL = async (id: string) => { responses.delete(id); };
    });
    await page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      useAppStore.getState().sendMessage("读取 Unity 指南并检查命令结果。保留失败证据，不重复副作用。", undefined,
        { resolvedIntent: "execute", runtimeIntentOverride: "execute", skipIntentResolution: true, turnTitle: "生产未执行回执验证", intentSummary: "Verify unexecuted Skill recovery", subagentPreferenceOverride: "forbidden" });
    });
    const snapshot = async () => page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
      const state = useAppStore.getState();
      return { checkpoint: normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[state.currentTurnId!]), request: state.activeActionRequest,
        requests: (window as any).__SKIP_RECOVERY_REQUESTS__, taskFlow: state.taskFlow };
    });
    await expect.poll(async () => (await snapshot()).request?.kind, { timeout: 60_000 }).toBe("user_choice");
    const paused = await snapshot();
    await fs.writeFile(testInfo.outputPath("unexecuted-skill-production.json"), JSON.stringify(paused, null, 2));
    const events = paused.checkpoint!.aggregate.events;
    const skills = events.filter(event => event.type === "tool.completed" && event.presentation?.toolName === "load_skill");
    expect(skills.filter(event => event.status === "blocked" && event.failureReasonCode === "provider_batch_predecessor_failed")).toHaveLength(2);
    expect(skills.filter(event => event.status === "succeeded")).toHaveLength(2);
    expect(events.filter(event => event.type === "tool.completed" && event.failureReasonCode === "command_exit_nonzero")).toHaveLength(1);
    expect(await fs.readFile(path.join(workspace, "effect.txt"), "utf8")).toBe("x");
    expect(await fs.stat(path.join(workspace, "downstream.txt")).then(() => true, () => false)).toBe(false);
    await page.waitForTimeout(750);
    expect((await snapshot()).requests.length).toBe(paused.requests.length);
    expect(paused.requests).toHaveLength(4);
    await page.getByTestId("execution-capsule-reply-option-1").click();
    await expect.poll(async () => (await snapshot()).checkpoint?.aggregate.terminalOutcome?.resultKind).toBe("canceled");
  });

  test(`deterministic production pause recheck and stop preserve one Run with ${model}`, async ({ page }, testInfo) => {
    test.skip(process.env.MAIN_DETERMINISTIC_PAUSE_E2E !== "1");
    test.setTimeout(90_000);
    const workspace = (page as any).__realOmlxWorkspace as string;
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => {
      const responses = new Map<string, string[]>();
      (window as any).__PAUSE_REQUEST_COUNT__ = 0;
      (window as any).__MAIN_E2E_CHAT_STREAM_OPEN = async (args: any) => {
        const count = ++(window as any).__PAUSE_REQUEST_COUNT__;
        const call = count === 1 ? { name: "run_command", arguments: { command: "printf x >> effect.txt", description: "Create one marker" } }
          : count === 4 ? { name: "read_file", arguments: { path: "effect.txt" } }
          : { name: "missing_fixture_tool", arguments: {} };
        const chunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `fixture-call-${count}`, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] };
        responses.set(args.streamId || args.stream_id, [`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`]);
      };
      (window as any).__MAIN_E2E_CHAT_STREAM_READ = async (id: string) => {
        const items = responses.get(id) || [];
        return items.length ? { chunk: items.shift(), done: false } : { done: true };
      };
      (window as any).__MAIN_E2E_CHAT_STREAM_CANCEL = async (id: string) => { responses.delete(id); };
    });
    await page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      useAppStore.getState().sendMessage("执行一次本地命令创建 effect.txt，然后检查实际内容。遇到不可用工具请保留真实回执。", undefined,
        { resolvedIntent: "execute", runtimeIntentOverride: "execute", skipIntentResolution: true, turnTitle: "生产暂停验证", intentSummary: "Verify durable execution pause", subagentPreferenceOverride: "forbidden" });
    });
    const state = async () => page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
      const s = useAppStore.getState();
      return { checkpoint: normalizeRuntimeV2Checkpoint(s.runtimeV2Checkpoints[s.currentTurnId!]), request: s.activeActionRequest,
        generating: s.isGenerating, requests: (window as any).__PAUSE_REQUEST_COUNT__, events: s.runtimeEvents, taskFlow: s.taskFlow };
    });
    await expect.poll(async () => (await state()).request?.kind, { timeout: 45_000 }).toBe("user_choice");
    const first = await state();
    await page.waitForTimeout(500);
    expect((await state()).requests).toBe(first.requests);
    expect(await fs.readFile(path.join(workspace, "effect.txt"), "utf8")).toBe("x");
    await page.getByTestId("execution-capsule-reply-option-0").click();
    await expect.poll(async () => (await state()).checkpoint?.aggregate.events.filter(event => event.type === "run.resumed").length, { timeout: 45_000 }).toBe(1);
    await expect.poll(async () => {
      const current = await state();
      return current.request?.kind === "user_choice" && current.request.requestId !== first.request?.requestId;
    }, { timeout: 45_000 }).toBe(true);
    const second = await state();
    expect(second.checkpoint?.aggregate.run?.identity.runId).toBe(first.checkpoint?.aggregate.run?.identity.runId);
    expect(second.checkpoint?.aggregate.events.filter(event => event.type === "run.started")).toHaveLength(1);
    expect(await fs.readFile(path.join(workspace, "effect.txt"), "utf8")).toBe("x");
    await page.getByTestId("execution-capsule-reply-option-1").click();
    await expect.poll(async () => (await state()).checkpoint?.aggregate.terminalOutcome?.resultKind).toBe("canceled");
    const final = await state();
    expect(final.checkpoint?.aggregate.events.filter(event => event.type === "run.completed")).toHaveLength(1);
    expect(final.checkpoint?.aggregate.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    await expect.poll(async () => (await state()).taskFlow.filter(block => block.type === "agent" && block.visibility === "assistant_final").length).toBe(1);
    await fs.writeFile(testInfo.outputPath("pause-recheck-stop.json"), JSON.stringify(final, null, 2));
  });

  test(`deterministic production intent clarification pauses and resumes one Run with ${model}`, async ({ page }, testInfo) => {
    test.skip(process.env.MAIN_DETERMINISTIC_PAUSE_E2E !== "1");
    test.setTimeout(90_000);
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => {
      const responses = new Map<string, string[]>();
      (window as any).__CLARIFICATION_REQUESTS__ = [];
      (window as any).__MAIN_E2E_CHAT_STREAM_OPEN = async (args: any) => {
        const requests = (window as any).__CLARIFICATION_REQUESTS__;
        requests.push(JSON.parse(args.body));
        const count = requests.length;
        const clarification = { kind: "target_ambiguity", field: "target", evidence: "staging or production", question: "请选择检查目标。", choices: ["staging", "production"] };
        const content = count === 1 ? JSON.stringify({ semantic: { objective: "检查用户选择的目标", workType: "operate", answerFormat: "report",
          requiredCapabilities: ["command"], forbiddenCapabilities: [], approvalRequiredCapabilities: [] }, confidence: 0.9, needsUserChoice: true, question: clarification.question, clarification }) : null;
        const call = count === 2 ? { name: "run_command", arguments: { command: "printf chosen-target", description: "Inspect selected target" } }
          : { name: "missing_fixture_tool", arguments: {} };
        const delta = content ? { content } : { tool_calls: [{ index: 0, id: `clarification-${count}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] };
        responses.set(args.streamId || args.stream_id, [`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: content ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`]);
      };
      (window as any).__MAIN_E2E_CHAT_STREAM_READ = async (id: string) => { const items = responses.get(id) || []; return items.length ? { chunk: items.shift(), done: false } : { done: true }; };
      (window as any).__MAIN_E2E_CHAT_STREAM_CANCEL = async (id: string) => { responses.delete(id); };
      (window as any).__CODELY_E2E__.sendDirectEditMessage("Inspect staging or production; I have not selected the target.");
    });
    const state = async () => page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
      const s = useAppStore.getState();
      return { checkpoint: normalizeRuntimeV2Checkpoint(s.runtimeV2Checkpoints[s.currentTurnId!]), request: s.activeActionRequest, generating: s.isGenerating,
        requests: (window as any).__CLARIFICATION_REQUESTS__, taskFlow: s.taskFlow };
    });
    await expect.poll(async () => (await state()).request?.kind, { timeout: 45_000 }).toBe("user_choice");
    const paused = await state();
    expect(paused.checkpoint?.aggregate.run?.blocker?.reasonCode).toBe("intent_clarification");
    expect(paused.requests).toHaveLength(1);
    await page.waitForTimeout(500);
    expect((await state()).requests).toHaveLength(1);
    expect(paused.checkpoint?.aggregate.terminalOutcome).toBeNull();
    await page.getByTestId("execution-capsule-reply-option-0").click();
    await expect.poll(async () => (await state()).checkpoint?.aggregate.events.filter(event => event.type === "run.resumed").length, { timeout: 45_000 }).toBe(1);
    await expect.poll(async () => { const s = await state(); return s.request?.kind === "user_choice" && s.request.requestId !== paused.request?.requestId; }, { timeout: 45_000 }).toBe(true);
    const resumed = await state();
    expect(resumed.checkpoint?.aggregate.run?.identity.runId).toBe(paused.checkpoint?.aggregate.run?.identity.runId);
    expect(resumed.checkpoint?.aggregate.events.filter(event => event.type === "run.started")).toHaveLength(1);
    expect(resumed.requests[1].messages).toContainEqual({ role: "user", content: "staging" });
    expect(resumed.checkpoint?.aggregate.events.find(event => event.type === "run.decision_recorded")).toMatchObject({ choice: "recheck", reply: "staging" });
    await fs.writeFile(testInfo.outputPath("production-clarification.json"), JSON.stringify(resumed, null, 2));
    await page.getByTestId("execution-capsule-reply-option-1").click();
    await expect.poll(async () => (await state()).checkpoint?.aggregate.terminalOutcome?.resultKind).toBe("canceled");
  });

  test(`real OMLX Unity Execute uses production tool boundaries with ${model}`, async ({ page }, testInfo) => {
    test.skip(realOmlxFixture !== "unity");
    test.setTimeout(realOmlxExecutionTimeoutMs + 360_000);
    const workspace = (page as any).__realOmlxWorkspace as string;
    const evidenceDir = process.env.REAL_OMLX_EVIDENCE_DIR || testInfo.outputPath("unity-evidence");
    await fs.mkdir(evidenceDir, { recursive: true });
    const wire = (page as any).__realOmlxProviderWire as any[];
    const navigations: Array<{ at: number; url: string; afterSubmission: boolean }> = [];
    let submitted = false;
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) navigations.push({ at: Date.now(), url: frame.url(), afterSubmission: submitted });
    });
    const original = await fs.readFile(process.env.MAIN_ORNITH_REQUEST_FILE!, "utf8");
    const request = original.replaceAll("/Users/michael/Documents/Unity/TestCli", workspace);
    await fs.writeFile(path.join(evidenceDir, "request.txt"), request);
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => (window as any).__CODELY_E2E__?.setPreferSubagents?.(true));
    submitted = true;
    const admission = await page.evaluate(async text => {
      const bridge = (window as any).__CODELY_E2E__;
      await bridge?.sendDirectEditMessage?.(text);
      return bridge?.lastWorkspaceInstructionAcceptance;
    }, request);
    await fs.writeFile(path.join(evidenceDir, "submission-admission.json"), JSON.stringify(admission || null, null, 2));
    const targetTurnId = admission?.receipt?.turnId || null;
    const snapshot = async () => page.evaluate(async targetTurnId => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
      const state = useAppStore.getState();
      const owner = targetTurnId || state.currentTurnId;
      const checkpoint = owner ? normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[owner]) : null;
      return { checkpoint, targetTurnId, currentTurnId: state.currentTurnId, conversationTurns: state.conversationTurns, currentSessionId: state.currentSessionId, agentStatus: state.agentStatus, isGenerating: state.isGenerating, activeActionRequest: state.activeActionRequest,
        taskFlow: state.taskFlow, runtimeEvents: state.runtimeEvents, debug: (window as any).__REAL_OMLX_DEBUG_LOGS__,
        dispatchError: (window as any).__CODELY_E2E__?.dispatchError };
    }, targetTurnId);
    let final: any = null;
    let runtimeWaitError: string | null = null;
    try {
      await expect.poll(async () => {
        final = await snapshot();
        if (navigations.some(item => item.afterSubmission)) return "host_reloaded";
        return observeRuntimeTask(final).state;
      }, { timeout: realOmlxExecutionTimeoutMs }).not.toBe("running");
    } catch (error) { runtimeWaitError = String(error); } finally {
      final = await snapshot();
      if (navigations.some(item => item.afterSubmission)) runtimeWaitError = "The test page navigated after submission; this is a host interruption, not model completion.";
      await fs.writeFile(path.join(evidenceDir, "browser-lifecycle.json"), JSON.stringify({ navigations, stable: !navigations.some(item => item.afterSubmission) }, null, 2));
      if (final.checkpoint?.aggregate.run?.status === "paused") {
        const before = wire.length;
        await page.waitForTimeout(1_500);
        final.pauseQuiet = { before, after: wire.length, passed: before === wire.length };
      }
      const stepPresentation = await page.locator('[data-testid="live-turn-step"], [data-testid="turn-archive-step"]').evaluateAll(rows => rows.map(row => ({
        status: row.getAttribute("data-status"),
        summary: (row.querySelector('[data-testid="turn-archive-step-toggle"]') as HTMLElement | null)?.innerText || "",
      })));
      await fs.writeFile(path.join(evidenceDir, "ui-step-presentation.json"), JSON.stringify({ steps: stepPresentation,
        protocolCodesInSummary: stepPresentation.filter(row => /TOOL_(?:ERROR|BLOCKED|NOT_EXECUTED|RESULT_EMPTY)|READ_FILE_RESULT|FILE_UNCHANGED_STUB|provider_batch_predecessor_(?:failed|unsettled)|provider-call-[\w-]+|"type":"skill\.loaded"|main-skill:\/\//.test(row.summary)),
      }, null, 2));
      await fs.writeFile(path.join(evidenceDir, "runtime.json"), JSON.stringify(final, null, 2));
      await fs.writeFile(path.join(evidenceDir, "outbound-protocol.json"), JSON.stringify(wire, null, 2));
      await page.screenshot({ path: path.join(evidenceDir, "main.png"), fullPage: true });
    }
    const observation = observeRuntimeTask(final);
    let persistedSession: any = null;
    let persistenceError: string | null = null;
    try {
      await expect.poll(async () => {
        persistedSession = await invokeRuntimeToolBridge(workspace, "load_project_session", { sessionId: final.currentSessionId });
        const checkpoints = Object.values(persistedSession?.runtimeSnapshot?.runtimeV2Checkpoints || {}) as any[];
        const owner = targetTurnId || final.currentTurnId;
        const turn = persistedSession?.runtimeSnapshot?.conversationTurns?.find((item: any) => item.id === owner);
        return final.checkpoint ? checkpoints.some(checkpoint => checkpoint.owner?.turnId === owner && !checkpoint.aggregate && !checkpoint.scheduledCommands &&
          checkpoint.events?.length >= final.checkpoint.events.length)
          : turn?.runtimeOutcome?.status === "completed" && turn.runtimeOutcome.runId === observation.outcome?.runId;
      }, { timeout: 15_000 }).toBe(true);
    } catch (error) { persistenceError = String(error); }
    await fs.writeFile(path.join(evidenceDir, "persisted-session-before-cleanup.json"), JSON.stringify(persistedSession, null, 2));
    const aggregate = final.checkpoint?.aggregate;
    const outcome = observation.outcome;
    const validators = aggregate?.events.filter((event: any) => event.type === "validation.completed" && event.passed) || [];
    let cleanupError: string | null = null;
    const acceptance: any = { outcome, observation, runtimeWaitError, persistenceError, paused: aggregate?.run?.blocker || null, pauseQuiet: final.pauseQuiet,
      passedValidations: validators.length, unityVerification: "pending", cleanup: { required: observation.shouldCancel } };
    // Save the original task verdict before cleanup. A cleanup failure must
    // never erase admission, tool or functional failure evidence.
    await fs.writeFile(path.join(evidenceDir, "acceptance.json"), JSON.stringify(acceptance, null, 2));
    if (observation.shouldCancel) {
      try {
        await page.evaluate(async targetTurnId => { const { useAppStore } = await import("/src/store/useAppStore.ts"); const state = useAppStore.getState(); const owner = targetTurnId || state.currentTurnId; if (owner) state.closeTurnAsCanceled(owner, { reason: "user_cancelled", message: "Validation ended; evidence retained." }); }, targetTurnId);
        await expect.poll(async () => observeRuntimeTask(await snapshot()).outcome?.resultKind, { timeout: 30_000 }).toBe("canceled");
      } catch (error) { cleanupError = String(error); }
    }
    const cleaned = await snapshot();
    await fs.writeFile(path.join(evidenceDir, "cleanup.json"), JSON.stringify({ ...cleaned, cleanupError, skippedAlreadyTerminal: !observation.shouldCancel }, null, 2));
    persistedSession = await invokeRuntimeToolBridge(workspace, "load_project_session", { sessionId: final.currentSessionId }).catch(error => ({ loadError: String(error) }));
    await fs.writeFile(path.join(evidenceDir, "persisted-session.json"), JSON.stringify(persistedSession, null, 2));
    try { Object.assign(acceptance, await verifyUnityCollector(workspace, evidenceDir)); }
    catch (error) { Object.assign(acceptance, { userInteractionVerified: false, gaps: [String(error)] }); }
    Object.assign(acceptance, { unityVerification: "completed", cleanup: { required: observation.shouldCancel, error: cleanupError, observation: observeRuntimeTask(cleaned) } });
    await fs.writeFile(path.join(evidenceDir, "acceptance.json"), JSON.stringify(acceptance, null, 2));
    expect(runtimeWaitError, runtimeWaitError || "Runtime settled").toBeNull();
    expect(persistenceError, persistenceError || "Canonical ledger persisted").toBeNull();
    expect(cleanupError, cleanupError || "Cleanup preserved the task verdict").toBeNull();
    expect(observation.consistencyErrors).toEqual([]);
    expect(outcome?.resultKind, JSON.stringify(acceptance)).toBe("success");
    expect(acceptance.sceneSaved).toBe(true);
    expect(acceptance.userInteractionVerified, JSON.stringify(acceptance.gaps)).toBe(true);
  });

  test(`real OMLX MAIN plan/approve/execute reaches one structural terminal outcome with ${model}`, async ({ page }, testInfo) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    const originalMutationContents = await readFixtureMutationContents(workspace);
    const originalPlanOnlyWorkspaceFingerprint = realOmlxPlanOnly
      ? await fingerprintPlanOnlyWorkspace(workspace)
      : "";
    const replayImages = await loadRealOmlxReplayImages();
    const approvedBrowserRequestIds = new Set<string>();
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[real-omlx-invoke] append_debug_log")) return;
      console.log(`[browser:${message.type()}] ${text}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[browser:pageerror] ${error.message}`);
    });
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);

    const immediateAdmissionSnapshot = await page.evaluate(async ({ text, images, preferSubagents }) => {
      const bridge = (window as any).__CODELY_E2E__;
      if (preferSubagents) bridge?.setPreferSubagents?.(true);
      try {
        await Promise.resolve(bridge?.sendCloudMessage?.(text, images));
      } catch (error) {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      }
      return bridge?.getSnapshot?.();
    }, {
      text: realOmlxRequest,
      images: replayImages,
      preferSubagents: realOmlxPreferSubagents,
    });

    const admittedPlanTurnId = assertFirstPlanWorkspaceTurnAdmission(
      immediateAdmissionSnapshot,
    );
    expect((immediateAdmissionSnapshot?.conversationTurnPreview || []).find(
      (turn: { id?: string }) => turn.id === admittedPlanTurnId,
    )?.runtimeEngineVersion).toBe("v2");

    await settleVisiblePlanInterview(page, testInfo, "executable", {
      label: "main-plan-executable-interview",
      timeoutMs: realOmlxPlanTimeoutMs,
    });

    let lastPlanPollSignature = "";
    let lastPlanTerminalSignature = "";
    let lastPlanDebugSignature = "";
    try {
      await expect
        .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        const planPollDiagnostic = {
          agentStatus: snapshot?.agentStatus,
          isGenerating: snapshot?.isGenerating,
          currentTurnStatus: snapshot?.currentTurnStatus,
          planStage: snapshot?.planStage,
          runtimePhase: snapshot?.runtimeV2?.phase || null,
          workPlanStatus: snapshot?.runtimeV2?.workPlan?.status || null,
          hasReviewCommit: Boolean(snapshot?.runtimeV2?.planReviewCommit),
          showPlanPanel: snapshot?.showPlanPanel,
          rightPanelTab: snapshot?.rightPanelTab,
          showDiff: snapshot?.showDiff,
          showTerminal: snapshot?.showTerminal,
          planPanelMounted: snapshot?.planPanelMounted,
          planPanelDocumentKind: snapshot?.planPanelDocumentKind,
          planPanelPresentation: snapshot?.planPanelPresentation,
          planPanelActionKind: snapshot?.planPanelActionKind,
          viewportWidth: snapshot?.viewportWidth,
          rightPanelWidth: snapshot?.rightPanelWidth,
          sidebarWidth: snapshot?.sidebarWidth,
          markerStatus: snapshot?.harnessRunMarker?.status || null,
          markerRunId:
            snapshot?.harnessRunMarker?.activeRunId ||
            snapshot?.harnessRunMarker?.outerRunId ||
            null,
          checkpointCache: snapshot?.runtimeV2CheckpointCache || null,
        };
        const planPollSignature = JSON.stringify(planPollDiagnostic);
        if (planPollSignature !== lastPlanPollSignature) {
          console.log(`[real-omlx-plan-poll:${model}] ${planPollSignature.slice(0, 1_000)}`);
          lastPlanPollSignature = planPollSignature;
        }
        const debugDigest = summarizePlanDebugTail(snapshot?.debugTail || []);
        const debugSignature = JSON.stringify(debugDigest);
        if (debugSignature && debugSignature !== "[]" && debugSignature !== lastPlanDebugSignature) {
          console.log(`[real-omlx-plan-runtime:${model}] ${debugSignature.slice(-6_000)}`);
          lastPlanDebugSignature = debugSignature;
        }
        if (snapshot?.dispatchError) throw new Error(`dispatch_error:${snapshot.dispatchError}`);
        if (
          snapshot?.runtimeV2?.phase === "reviewing" &&
          snapshot?.runtimeV2?.workPlan?.status === "pending_review" &&
          snapshot?.runtimeV2?.sealedWorkPlan?.status === "pending_review" &&
          snapshot?.runtimeV2?.planReviewCommit &&
          snapshot?.isGenerating === false &&
          snapshot?.agentStatus === "pending_review" &&
          snapshot?.currentTurnStatus === "awaiting_approval" &&
          reviewablePlanStages.has(String(snapshot?.planStage || ""))
        ) {
          return "artifact_ready";
        }
        if (
          snapshot?.isGenerating === false &&
          snapshot?.runtimeV2?.terminal?.exactlyOnce === true &&
          !snapshot?.runtimeV2?.planReviewCommit
        ) {
          const terminal =
            `terminal_without_v2_review:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}`;
          if (terminal !== lastPlanTerminalSignature) {
            console.log(`[real-omlx-plan-terminal:${model}] ${terminal}`);
            console.log(`[real-omlx-plan-debug:${model}] ${JSON.stringify(summarizePlanDebugTail(snapshot?.debugTail || []))}`);
            console.log(`[real-omlx-plan-flow:${model}] ${JSON.stringify(snapshot?.taskFlowPreview || [])}`);
            lastPlanTerminalSignature = terminal;
          }
          throw new Error(terminal);
        }
        return "running";
      }, { timeout: realOmlxPlanTimeoutMs })
      .toBe("artifact_ready");
    } catch (error) {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      console.log(`[real-omlx-plan-timeout-debug:${model}] ${JSON.stringify(summarizePlanDebugTail(snapshot?.debugTail || [])).slice(-12_000)}`);
      console.log(`[real-omlx-plan-timeout-runtime-v2:${model}] ${JSON.stringify(snapshot?.runtimeV2?.debug || []).slice(-12_000)}`);
      console.log(`[real-omlx-plan-timeout-flow:${model}] ${JSON.stringify(snapshot?.taskFlowPreview || []).slice(-12_000)}`);
      throw error;
    }

    const planSnapshot = await readRuntimeV2PlanReviewSnapshot(page);
    const planRuntime = expectRuntimeV2PlanReviewContract(planSnapshot, {
      turnId: admittedPlanTurnId,
    });
    const sealedWorkPlan = planRuntime.sealedWorkPlan;
    const reviewCommit = planRuntime.planReviewCommit;
    const plan = String(sealedWorkPlan.markdown || "");
    if (reviewCommit.artifact.documentRef) {
      const reference = reviewCommit.artifact.documentRef;
      const saved = await page.evaluate(reference =>
        (window as any).__MAIN_E2E_NATIVE_TOOL("read_plan_document", { reference }), reference);
      expect(saved.markdown).toBe(plan);
      expect(saved.contentHash).toBe(reference.contentHash);
      expect(await fs.readFile(reference.path, "utf8")).toBe(plan);
    }
    const planTaskQualityGaps = isMdViewerSavePathIncident
      ? getMdViewerWorkPlanGaps(sealedWorkPlan)
      : realOmlxFixture === "snake"
        ? getSnakeWorkPlanGaps(sealedWorkPlan)
        : [
          ...(realOmlxPlanExpectation.test(plan)
            ? []
            : [`plan does not match ${realOmlxPlanExpectation.source}`]),
          ...realOmlxPlanExpectAll.flatMap((expectation) =>
            expectation.test(plan)
              ? []
              : [`plan does not match ${expectation.source}`]
          ),
        ];
    console.log(`[real-omlx-task-quality-plan:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      gaps: planTaskQualityGaps,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(
        planTaskQualityGaps,
        "Optional task-quality oracle rejected the model-authored plan.",
      ).toEqual([]);
    }
    expect(plan).not.toMatch(/用户目标：\s*(?:\n|$)/);
    expect(plan).not.toMatch(/以落实已批准目标|落实已批准方案中涉及|Apply the approved plan change/i);
    expect(plan).not.toMatch(/直接相关的最小改动|写入前先用证据确认|依据证据：已搜索文件|依据证据：已查看目录/i);
    expect(plan).not.toMatch(/(?:已读证据|证据引用|Read Evidence)[\s\S]{0,800}\.MAIN\/plans\/plan\.md/i);
    expect(planSnapshot?.planArtifacts || []).toHaveLength(0);
    expect(sealedWorkPlan.draft.validations.some(
      (validation: { kind?: string; required?: boolean }) =>
        validation.required === true &&
        ["finite_command", "browser", "desktop"].includes(
          String(validation.kind || ""),
        ),
    )).toBe(true);
    if (requireSemanticTaskQuality) {
      expect(sealedWorkPlan.draft.validations.some(
        (validation: { command?: string; kind?: string; required?: boolean }) =>
          validation.kind === "finite_command" &&
          validation.required === true &&
          isFinitePlanValidationCommand(String(validation.command || "")),
      )).toBe(true);
    }
    const workPlanEvidenceTargets = new Set(
      sealedWorkPlan.evidence.map(
        (entry: { target: string }) => String(entry.target || "").trim(),
      ),
    );
    expect(sealedWorkPlan.evidence.some(
      (entry: { target?: string; version?: string }) =>
        String(entry.target || "").trim().length > 0 &&
        String(entry.version || "").trim().length > 0,
    )).toBe(true);
    const missingConfiguredEvidenceTargets = realOmlxPlanEvidenceTargets.filter(
      (target) => !workPlanEvidenceTargets.has(target),
    );
    console.log(`[real-omlx-task-quality-evidence:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      missingTargets: missingConfiguredEvidenceTargets,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(
        missingConfiguredEvidenceTargets,
        "Optional task-quality oracle requires exact configured evidence targets.",
      ).toEqual([]);
    }
    if (realOmlxFixture === "snake") {
      console.log(`[real-omlx-plan-collaboration:${model}] ${JSON.stringify({
        subagents: (planRuntime?.subagents || []).map((job: any) => ({
          id: job.id,
          status: job.status,
          reportSubmitted: job.reportSubmitted,
          requestOpenedAt: job.requestOpenedAt,
          firstTokenAt: job.firstTokenAt,
          closedAt: job.closedAt,
        })),
        childEvents: (planRuntime?.events || []).filter((event: any) =>
          String(event?.type || "").startsWith("subagent")
        ).map((event: any) => ({
          type: event.type,
          sequence: event.sequence,
          jobId: event.jobId,
          status: event.status,
          reportSubmitted: !!event.report,
          evidenceCount: Array.isArray(event.evidence)
            ? event.evidence.length
            : undefined,
        })),
      })}`);
      expectRuntimeV2ReadOnlyCollaboration(
        planRuntime,
        {
          requireObservedChild: true,
          requireAdoptedChildEvidence: true,
        },
      );
    } else if (realOmlxPreferSubagents) {
      expectRuntimeV2ReadOnlyCollaboration(planRuntime);
    }
    const persistedPlan = await fs.readFile(
      path.isAbsolute(reviewCommit.artifact.path) ? reviewCommit.artifact.path : path.join(workspace, reviewCommit.artifact.path),
      "utf8",
    );
    expect(persistedPlan).toBe(plan);
    expect(reviewCommit.artifact.content).toBe(plan);
    console.log(`[real-omlx-plan-panel:${model}] ${JSON.stringify({
      showPlanPanel: planSnapshot?.showPlanPanel,
      rightPanelTab: planSnapshot?.rightPanelTab,
      showDiff: planSnapshot?.showDiff,
      showTerminal: planSnapshot?.showTerminal,
      planPanelMounted: planSnapshot?.planPanelMounted,
      planPanelDocumentKind: planSnapshot?.planPanelDocumentKind,
      planPanelPresentation: planSnapshot?.planPanelPresentation,
      planPanelActionKind: planSnapshot?.planPanelActionKind,
      viewportWidth: planSnapshot?.viewportWidth,
      rightPanelWidth: planSnapshot?.rightPanelWidth,
      sidebarWidth: planSnapshot?.sidebarWidth,
      harnessRunMarker: planSnapshot?.harnessRunMarker || null,
      runtimeV2CheckpointCache:
        planSnapshot?.runtimeV2CheckpointCache || null,
      transitions: (planSnapshot?.planPanelTransitions || []).slice(-12),
    })}`);
    await expect(page.getByTestId("plan-review-panel")).toBeVisible();
    await expect(page.getByTestId("plan-review-panel")).toContainText(
      sealedWorkPlan.draft.objective,
    );
    const planMilestoneHeading = String(reviewCommit.chat.markdown || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
      .find(Boolean) || sealedWorkPlan.draft.objective;
    const visiblePlanMilestone = page.locator(
      `[data-testid="assistant-update"][data-turn-id="${admittedPlanTurnId}"]`,
    ).filter({ hasText: planMilestoneHeading }).last();
    await expect(visiblePlanMilestone).toBeVisible();
    expect(reviewablePlanStages.has(String(planSnapshot?.planStage || ""))).toBe(true);
    const planChatText = (planRuntime.presentation?.chatMilestones || [])
      .map((milestone: { markdown?: string }) => String(milestone.markdown || ""))
      .join("\n");
    console.log(`[real-omlx-plan-artifact:${model}]\n${plan}`);
    console.log(`[real-omlx-chat-plan:${model}] ${planChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(planChatText.trim().length).toBeGreaterThan(0);
    if (requireSemanticTaskQuality) {
      expect(planChatText).toMatch(realOmlxPlanOnly
        ? /read_file|grep_search|code_ast_query|读取|搜索|计划|根因|修复/i
        : realOmlxFixture === "md-viewer"
        ? /read_file|list_directory|读取|计划|main\.js|toolbar|按钮/i
        : realOmlxFixture === "snake"
          ? /read_file|list_directory|读取|计划|snake\.py|test_snake\.py|README|贪吃蛇/i
        : /read_file|list_directory|读取|计划|CSV|useCsvParser|creator/i);
    }
    expect(planChatText).not.toMatch(forbiddenChatNoise);
    if (expectAgentExplanation) {
      expect((planSnapshot?.agentTexts || []).join("\n")).toMatch(
        realOmlxFixture === "md-viewer"
          ? /问题|分析|修复|toolbar|按钮|main\.js/i
          : realOmlxFixture === "snake"
            ? /分析|实现|计划|snake\.py|test_snake\.py|贪吃蛇/i
          : /问题|分析|修复|Dashboard|CSV|深色|creator/i,
      );
    }

    if (realOmlxPlanOnly) {
      await expect.poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
        if (snapshot?.isGenerating === false && snapshot?.agentStatus === "pending_review") {
          return "pending_review";
        }
        if (snapshot?.isGenerating === false) {
          return `terminal_without_review:${snapshot?.currentTurnStatus}:${snapshot?.agentStatus}`;
        }
        return "running";
      }, { timeout: 120_000 }).toBe("pending_review");
      const finalPlanSnapshot = await readRuntimeV2PlanReviewSnapshot(page);
      expect(finalPlanSnapshot?.agentStatus).toBe("pending_review");
      expect(finalPlanSnapshot?.currentTurnStatus).toBe("awaiting_approval");
      expect(finalPlanSnapshot?.currentTurnId).toBe(admittedPlanTurnId);
      expect(String(finalPlanSnapshot?.currentTurnTitle || "").trim()).not.toBe("");
      expect(finalPlanSnapshot?.currentTurnIntent).toBe("plan");
      expect(finalPlanSnapshot?.planArtifacts || []).toHaveLength(0);
      const finalPlanRuntime = expectRuntimeV2PlanReviewContract(finalPlanSnapshot, {
        turnId: admittedPlanTurnId,
      });
      expect(finalPlanRuntime.sealedWorkPlan.digest).toBe(sealedWorkPlan.digest);
      expect(finalPlanRuntime.planReviewCommit).toEqual(reviewCommit);
      expect(reviewablePlanStages.has(String(finalPlanSnapshot?.planStage || ""))).toBe(true);
      expect(JSON.stringify(finalPlanSnapshot?.debugTail || [])).not.toMatch(
        /plan_generation_failed|plan_evidence_materialization_exhausted/i,
      );
      expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(originalPlanOnlyWorkspaceFingerprint);
      const artifact = test.info().outputPath("plan-review-lifecycle.json");
      await fs.writeFile(artifact, JSON.stringify(finalPlanSnapshot, null, 2));
      await test.info().attach("plan-review-lifecycle", { path: artifact, contentType: "application/json" });
      if (requireSemanticTaskQuality && isMdViewerSavePathIncident) {
        expect(
          getMdViewerWorkPlanGaps(finalPlanRuntime.sealedWorkPlan),
          "Optional task-quality oracle requires the review authority to retain the expected repair graph.",
        ).toEqual([]);
        if (/\bopenFile\b/.test(plan)) {
          expect(plan).toMatch(/openFile[^\n]{0,180}(?:未被调用|无调用|无引用|非主因|死代码|not\s+(?:called|referenced|the\s+cause)|dead\s+code)/i);
        }
      }
      return;
    }

    const approvalDispatch = await page.evaluate(() => {
      const bridge = (window as any).__CODELY_E2E__;
      const result = bridge?.approvePlan?.();
      Promise.resolve(result).catch((error) => {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      });
      return result;
    });
    console.log(`[real-omlx-approval-dispatch:${model}] ${JSON.stringify(approvalDispatch).slice(0, 2_000)}`);

    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
      const runtime = snapshot?.runtimeV2;
      return (
        snapshot?.isPlanApproved === true &&
        runtime?.turnId === admittedPlanTurnId &&
        runtime?.workPlan?.status === "approved" &&
        runtime?.eventTypes?.includes("work_plan.approved") &&
        [
          "preparing",
          "observing",
          "acting",
          "validating",
          "finalizing",
          "completed",
        ].includes(String(runtime?.phase || ""))
      )
        ? "execution_started"
        : `waiting:${runtime?.phase}:${runtime?.workPlan?.status}:${snapshot?.isGenerating}`;
    }, { timeout: 30_000 }).toBe("execution_started");

    let earlyExecutionSnapshot: any = null;
    try {
      await expect
        .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        earlyExecutionSnapshot = snapshot;
        if (snapshot?.dispatchError) throw new Error(`dispatch_error:${snapshot.dispatchError}`);
        if (await approveReviewedExecutionPermission(
          page, testInfo, workspace, { plan: sealedWorkPlan, commit: reviewCommit }, approvedBrowserRequestIds,
        )) return "running";
        const mutationState = await inspectFixtureMutation(workspace, originalMutationContents);
        if (mutationState.changedFiles.length > 0) return "mutated";
        if (snapshot?.runtimeV2?.terminal?.exactlyOnce === true) {
          console.log(
            `[real-omlx-execute-safe-pause:${model}] ${
              JSON.stringify(runtimeV2FailureDiagnostic(snapshot?.runtimeV2))
            }`,
          );
          return "safe_pause";
        }
        return "running";
        }, { timeout: realOmlxExecutionTimeoutMs })
        .toMatch(/^(?:mutated|safe_pause)$/);
    } catch (error) {
      const snapshot = earlyExecutionSnapshot || await page.evaluate(() =>
        (window as any).__CODELY_E2E__?.getSnapshot?.()
      );
      console.log(`[real-omlx-execute-timeout:${model}] ${JSON.stringify({
        agentStatus: snapshot?.agentStatus,
        currentTurnStatus: snapshot?.currentTurnStatus,
        planStage: snapshot?.planStage,
        activeActionRequest: snapshot?.activeActionRequest,
        runtimeV2: snapshot?.runtimeV2,
      }).slice(-40_000)}`);
      throw error;
    }

    const mutationAfterEarlyOutcome = await inspectFixtureMutation(workspace, originalMutationContents);
    if (mutationAfterEarlyOutcome.changedFiles.length === 0) {
      expect(mutationAfterEarlyOutcome.contents).toEqual(originalMutationContents);
      const resultKind = String(
        earlyExecutionSnapshot?.runtimeV2?.terminalOutcome?.resultKind || "",
      ) as "success" | "partial" | "blocked" | "error" | "canceled";
      expect(resultKind).not.toBe("success");
      expectCanonicalRuntimeV2Terminal(earlyExecutionSnapshot, {
        turnId: admittedPlanTurnId,
        resultKind,
        strategy: "plan",
      });
      console.log(`[real-omlx-task-quality-execute:${model}] ${JSON.stringify({
        required: requireSemanticTaskQuality,
        resultKind,
        gaps: [mutationAfterEarlyOutcome.detail],
      })}`);
      if (requireSemanticTaskQuality) expect(mutationAfterEarlyOutcome.satisfied, mutationAfterEarlyOutcome.detail).toBe(true);
      return;
    }

    expect(mutationAfterEarlyOutcome.changedFiles.length).toBeGreaterThan(0);
    console.log(`[real-omlx-task-quality-execute:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      satisfied: mutationAfterEarlyOutcome.satisfied,
      changedFiles: mutationAfterEarlyOutcome.changedFiles,
      detail: mutationAfterEarlyOutcome.detail,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(
        mutationAfterEarlyOutcome.satisfied,
        `Optional task-quality oracle rejected the workspace outcome:\n${mutationAfterEarlyOutcome.detail}`,
      ).toBe(true);
    }

    let terminalExecutionSnapshot: any = null;
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
        if (await approveReviewedExecutionPermission(
          page, testInfo, workspace, { plan: sealedWorkPlan, commit: reviewCommit }, approvedBrowserRequestIds,
        )) return "running";
        if (snapshot?.runtimeV2?.terminal?.exactlyOnce === true) {
          terminalExecutionSnapshot = snapshot;
          return "completed";
        }
        return "running";
      }, { timeout: 300_000 })
      .toBe("completed");

    const executionResultKind = String(
      terminalExecutionSnapshot?.runtimeV2?.terminalOutcome?.resultKind || "",
    ) as "success" | "partial" | "blocked" | "error" | "canceled";
    if (executionResultKind !== "success") {
      console.log(
        `[real-omlx-execute-terminal:${model}] ${
          JSON.stringify(runtimeV2FailureDiagnostic(terminalExecutionSnapshot?.runtimeV2))
        }`,
      );
      expectCanonicalRuntimeV2Terminal(terminalExecutionSnapshot, {
        turnId: admittedPlanTurnId,
        resultKind: executionResultKind,
        strategy: "plan",
      });
      if (requireSemanticTaskQuality) expect(executionResultKind).toBe("success");
      return;
    }

    const bodyText = await page.locator("body").innerText();
    const executionSnapshot = terminalExecutionSnapshot;
    const executionRuntime = expectCanonicalRuntimeV2Terminal(executionSnapshot, {
      turnId: admittedPlanTurnId,
      resultKind: "success",
      strategy: "plan",
    });
    expectSuccessfulPlanExecutionOrder(executionRuntime);
    expect(executionRuntime.workPlan).toMatchObject({
      ...reviewCommit.authority,
      status: "approved",
    });
    expect(executionRuntime.sealedWorkPlan).toEqual(sealedWorkPlan);
    expect(executionRuntime.planReviewCommit).toEqual(reviewCommit);
    const executionChatText = [
      ...(executionRuntime.presentation?.chatMilestones || []).map(
        (entry: { markdown?: string }) => String(entry.markdown || ""),
      ),
      ...(executionRuntime.presentation?.finals || []).map(
        (entry: { markdown?: string }) => String(entry.markdown || ""),
      ),
    ].join("\n");
    console.log(`[real-omlx-chat-execute:${model}] ${executionChatText.slice(0, 1200).replace(/\s+/g, " ")}`);
    expect(executionChatText.trim().length).toBeGreaterThan(0);
    if (requireSemanticTaskQuality) {
      expect(executionChatText).toMatch(/已完成|完成|修改|修复|验证|completed|validated/i);
    }
    const mutationCommands = (executionRuntime.commands || []).filter(
      (command: { kind?: string; toolName?: string; status?: string }) =>
        command.kind === "execute_tool" &&
        ["apply_patch", "replace_in_file", "write_file", "write_file_atomic"].includes(
          String(command.toolName || ""),
        ) &&
        command.status === "succeeded",
    );
    expect(mutationCommands.length).toBeGreaterThan(0);
    expect(mutationCommands.every((command: { idempotencyKey?: string }) =>
      (executionRuntime.receipts || []).some((receipt: {
        idempotencyKey?: string;
        kind?: string;
        status?: string;
      }) =>
        receipt.idempotencyKey === command.idempotencyKey &&
        receipt.kind === "execute_tool" &&
        receipt.status === "succeeded"
      )
    )).toBe(true);
    expect(executionRuntime.evidence.some((entry: { kind?: string; target?: string }) =>
      entry.kind === "mutation" &&
      mutationAfterEarlyOutcome.changedFiles.some((file) =>
        String(entry.target || "").includes(file)
      )
    )).toBe(true);
    const successfulValidations = (executionRuntime.commands || []).filter(
      (command: { kind?: string; status?: string }) =>
        command.kind === "execute_validation" && command.status === "succeeded",
    );
    expect(successfulValidations.length).toBeGreaterThan(0);
    expect(successfulValidations.every((command: { idempotencyKey?: string }) =>
      (executionRuntime.receipts || []).some((receipt: {
        idempotencyKey?: string;
        kind?: string;
        status?: string;
      }) =>
        receipt.idempotencyKey === command.idempotencyKey &&
        receipt.kind === "execute_validation" &&
        receipt.status === "succeeded"
      )
    )).toBe(true);
    expect(executionRuntime.events.some(
      (event: { type?: string; passed?: boolean }) =>
        event.type === "validation.completed" && event.passed === true,
    )).toBe(true);
    expect(executionRuntime.evidence.some(
      (entry: { kind?: string }) => entry.kind === "validation",
    )).toBe(true);
    const finiteValidation = [...successfulValidations].reverse().find(
      (command: { toolName?: string; target?: string }) =>
        command.toolName === "run_command" &&
        isFinitePlanValidationCommand(String(command.target || "")),
    );
    if (requireSemanticTaskQuality) expect(finiteValidation).toBeTruthy();
    if (finiteValidation) {
      const validationCommand = String(finiteValidation.target || "");
      const independentValidation = await runRealOmlxWorkspaceCommand(
        workspace,
        validationCommand,
      );
      expect(
        independentValidation.exitCode,
        [
          `Independent replay validation failed: ${validationCommand}`,
          independentValidation.stdout,
          independentValidation.stderr,
        ].filter(Boolean).join("\n"),
      ).toBe(0);
    }
    if (requireSemanticTaskQuality && realOmlxFixture === "md-viewer") {
      expect(successfulValidations.some(
        (command: { toolName?: string }) => command.toolName === "browser_evaluate",
      )).toBe(true);
      expect(getMdViewerExecutionGaps({
        caller: await fs.readFile(path.join(workspace, "src/main.js"), "utf8"),
        editor: await fs.readFile(path.join(workspace, "src/components/editor.js"), "utf8"),
        handler: await fs.readFile(path.join(workspace, "src-tauri/src/main.rs"), "utf8"),
        toolbar: await fs.readFile(path.join(workspace, "src/components/toolbar.js"), "utf8"),
      })).toEqual([]);
    }
    expect(JSON.stringify(executionRuntime.debug || [])).not.toMatch(
      /READ_FILE_NOT_AVAILABLE_IN_RECOVERY|DEV_SERVER_NOT_READY|server (?:is )?occupied/i,
    );
    expect(executionChatText).not.toMatch(forbiddenChatNoise);
    const terminalTurnId = String(executionSnapshot?.currentTurnId || "");
    expect(terminalTurnId).toBe(admittedPlanTurnId);
    expect(executionRuntime.presentation?.finals || []).toHaveLength(1);
    const finalMarkdown = String(
      executionRuntime.presentation.finals[0]?.markdown || "",
    );
    expect(finalMarkdown.trim().length).toBeGreaterThan(0);
    if (requireSemanticTaskQuality) {
      expect(finalMarkdown).toMatch(
        /完成|修改|修复|验证|passed|updated|fixed|implemented|validated/i,
      );
    }
    expect(finalMarkdown).not.toContain("agent_loop_completed");
    await expect(page.locator(
      `[data-testid="assistant-final"][data-turn-id="${terminalTurnId}"]`,
    )).toBeVisible();
    expect(bodyText).not.toMatch(forbiddenChatNoise);
    if (realOmlxFixture === "snake") {
      const acceptance = await inspectSnakeAcceptance(workspace);
      console.log(`[real-omlx-snake-plan-acceptance:${model}] ${JSON.stringify({
        gaps: acceptance.gaps,
        files: acceptance.files,
        testCount: acceptance.testCount,
        compileExitCode: acceptance.compile.exitCode,
        testExitCode: acceptance.tests.exitCode,
        importExitCode: acceptance.importCheck.exitCode,
      })}`);
      expect(
        acceptance.gaps,
        [
          "Independent Snake acceptance rejected the approved plan outcome.",
          acceptance.tests.stdout,
          acceptance.tests.stderr,
        ].filter(Boolean).join("\n"),
      ).toEqual([]);
    }
  });

  test(`real OMLX Direct Edit repairs a failed finite validation with ${model}`, async ({ page }, testInfo) => {
    test.skip(!runDirectEditRecovery || realOmlxFixture !== "csv");
    const workspace = (page as any).__realOmlxWorkspace as string;
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    if (process.env.REAL_OMLX_TOOL_PROTOCOL === "xml") {
      await page.evaluate(() => (window as any).__CODELY_E2E__.setRealToolProtocol("xml"));
    }
    await page.evaluate(async () => {
      await (window as any).__MAIN_E2E_REQUIRE_DIRECT_EDIT_REPAIR?.();
      const bridge = (window as any).__CODELY_E2E__;
      Promise.resolve(bridge?.sendDirectEditMessage?.(
        "先运行 npm test 确认当前失败，再直接修改 src/hooks/useCsvParser.ts，把 CSV creator 映射为 Dashboard 使用的 creatorName，并保留测试要求的 CSV source 来源及公开类型契约。真实修复后再运行 npm test 验证直到通过。不要修改测试或 package.json，不要生成计划。",
      )).catch((error) => {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      });
    });

    let terminalSnapshot: any = null;
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.());
      await fs.writeFile(testInfo.outputPath("direct-execute-latest.json"), JSON.stringify(snapshot, null, 2));
      if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
      if (snapshot?.runtimeV2?.terminalOutcome && snapshot?.isGenerating === false) {
        terminalSnapshot = snapshot;
        return "terminal";
      }
      return "running";
    }, { timeout: realOmlxExecutionTimeoutMs }).toBe("terminal");
    console.log(`[real-omlx-direct-edit:${model}] ${JSON.stringify({
      currentTurnStatus: terminalSnapshot?.currentTurnStatus,
      agentStatus: terminalSnapshot?.agentStatus,
      toolBlocks: terminalSnapshot?.toolBlocks,
      debugTail: terminalSnapshot?.debugTail,
    }).slice(-40_000)}`);
    expectRuntimeV2TurnPresentationStatus(terminalSnapshot);
    const terminalTurnId = String(terminalSnapshot?.currentTurnId || "");
    expect(terminalTurnId).not.toBe("");
    const finalAssistantMessage = page.locator(
      `[data-testid="assistant-final"][data-turn-id="${terminalTurnId}"]`,
    );
    await expect(finalAssistantMessage).toBeVisible();
    const finalAssistantText = String(await finalAssistantMessage.textContent() || "").trim();
    const completionArtifact = testInfo.outputPath("direct-execute-completion.json");
    await fs.writeFile(completionArtifact, JSON.stringify({ runtimeV2: terminalSnapshot?.runtimeV2, finalAssistantText, currentTurnStatus: terminalSnapshot?.currentTurnStatus, agentStatus: terminalSnapshot?.agentStatus, isGenerating: terminalSnapshot?.isGenerating }, null, 2));
    await testInfo.attach("direct-execute-completion.json", { path: completionArtifact, contentType: "application/json" });
    expect(finalAssistantText.length).toBeGreaterThan(0);
    expect(finalAssistantText).not.toContain("agent_loop_completed");
    expect((terminalSnapshot?.taskFlowPreview || []).some((block: { turnId?: string; type?: string; visibility?: string; content?: string }) =>
      block.turnId === terminalTurnId &&
      block.type === "agent" &&
      block.visibility === "assistant_final" &&
      String(block.content || "").trim().length > 0
    )).toBe(true);

    const independentVerification = await verifyCsvDirectEditRepairFixture(workspace);
    await fs.writeFile(testInfo.outputPath("direct-edit-independent-verification.json"), JSON.stringify(independentVerification, null, 2));
    expect(independentVerification.behavior.exitCode, independentVerification.behavior.stdout + independentVerification.behavior.stderr).toBe(0);
    expect(independentVerification.typecheck.exitCode, independentVerification.typecheck.stdout + independentVerification.typecheck.stderr).toBe(0);
    expect(independentVerification.passed).toBe(true);

    const snapshot = terminalSnapshot;
    const runtimeEvents = snapshot?.runtimeV2?.events || [];
    const failedValidationIndex = runtimeEvents.findIndex((entry: Record<string, unknown>) =>
      entry.type === "validation.completed" && entry.passed === false
    );
    const repairMutationIndex = runtimeEvents.findIndex((entry: Record<string, unknown>, index: number) =>
      index > failedValidationIndex &&
      entry.type === "tool.completed" &&
      entry.status === "succeeded" &&
      Array.isArray(entry.evidence) &&
      entry.evidence.some((evidence: { kind?: string }) => evidence.kind === "mutation")
    );
    const successfulValidationIndex = runtimeEvents.findIndex((entry: Record<string, unknown>, index: number) =>
      index > repairMutationIndex &&
      entry.type === "validation.completed" && entry.passed === true
    );
    expect(failedValidationIndex).toBeGreaterThanOrEqual(0);
    expect(repairMutationIndex).toBeGreaterThan(failedValidationIndex);
    expect(successfulValidationIndex).toBeGreaterThan(repairMutationIndex);
    expect((snapshot?.debugTail || []).some((entry: Record<string, unknown>) =>
      entry.source === "agent.tool_calls_detected" &&
      Array.isArray(entry.names) &&
      entry.names.includes("execute_command")
    )).toBe(false);

    expect(snapshot?.runtimeV2?.terminalOutcome?.resultKind).toBe("success");
    expect(snapshot?.runtimeV2?.recovery?.exhausted || null).toBeNull();
  });

  test(`real OMLX Snake Execute completes with ${model}`, async ({ page }) => {
    test.skip(!runSnakeExecuteReplay);
    const workspace = (page as any).__realOmlxWorkspace as string;
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[real-omlx-invoke] append_debug_log")) return;
      console.log(`[browser:${message.type()}] ${text}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[browser:pageerror] ${error.message}`);
    });
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => (window as any).__CODELY_E2E__?.setPreferSubagents?.(false));

    const immediateSnapshot = await page.evaluate(async (text) => {
      const bridge = (window as any).__CODELY_E2E__;
      try {
        await bridge?.sendDirectEditMessage?.(text);
      } catch (error) {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      }
      return bridge?.getSnapshot?.();
    }, realOmlxRequest);
    expect(immediateSnapshot?.dispatchError).toBeNull();
    expect(immediateSnapshot?.lastWorkspaceInstructionAcceptance?.accepted).toBe(true);
    const admittedTurnId = String(
      immediateSnapshot?.lastWorkspaceInstructionAcceptance?.receipt?.turnId || "",
    );
    expect(admittedTurnId).not.toBe("");
    const expectedIntent = "execute";
    const admittedTurn = (immediateSnapshot?.conversationTurnPreview || []).find(
      (turn: { id?: string }) => turn.id === admittedTurnId,
    );
    expect(admittedTurn?.intent).toBe(expectedIntent);
    expect(admittedTurn?.displayIntent).toBe(expectedIntent);
    expect(admittedTurn?.runtimeEngineVersion).toBe("v2");

    let terminalSnapshot: any = null;
    let lastProgressSignature = "";
    let lastDebugCount = 0;
    try {
      await expect.poll(async () => {
        const snapshot = await page.evaluate(() =>
          (window as any).__CODELY_E2E__?.getSnapshot?.()
        );
        if (snapshot?.dispatchError) {
          await page.evaluate(() => (window as any).__CODELY_E2E__?.stopGeneration?.());
          throw new Error(`dispatch_error:${snapshot.dispatchError}`);
        }
        const runtime = snapshot?.runtimeV2;
        const commands = Array.isArray(runtime?.commands) ? runtime.commands : [];
        const latestCommand = commands.at(-1) || null;
        const progress = {
          isGenerating: snapshot?.isGenerating,
          agentStatus: snapshot?.agentStatus,
          turnStatus: snapshot?.currentTurnStatus,
          phase: runtime?.phase || null,
          eventCount: runtime?.events?.length || 0,
          commandCount: commands.length,
          latestCommand: latestCommand
            ? {
                kind: latestCommand.kind,
                toolName: latestCommand.toolName,
                target: String(latestCommand.target || "").slice(0, 240),
                status: latestCommand.status,
              }
            : null,
          terminal: runtime?.terminalOutcome?.resultKind || null,
        };
        const signature = JSON.stringify(progress);
        if (signature !== lastProgressSignature) {
          console.log(`[real-omlx-snake-progress:${model}] ${signature}`);
          lastProgressSignature = signature;
        }
        const debugTail = Array.isArray(snapshot?.debugTail) ? snapshot.debugTail : [];
        if (debugTail.length > lastDebugCount) {
          const newEntries = debugTail.slice(lastDebugCount)
            .filter((entry: { source?: string; level?: string }) =>
              /runtime_v2|provider|tool_execution|mutation|validation|recovery|terminal|workspace_instruction/i
                .test(String(entry?.source || "")) ||
              /warn|error/i.test(String(entry?.level || ""))
            )
            .slice(-20)
            .map((entry: { source?: string; level?: string; message?: unknown }) => ({
              source: String(entry?.source || ""),
              level: String(entry?.level || ""),
              message: String(entry?.message || "").slice(0, 900),
            }));
          if (newEntries.length > 0) {
            console.log(
              `[real-omlx-snake-runtime:${model}] ${JSON.stringify(newEntries).slice(-12_000)}`,
            );
          }
          lastDebugCount = debugTail.length;
        }
        if (runtime?.terminal?.exactlyOnce === true) {
          terminalSnapshot = snapshot;
          return "terminal";
        }
        return "running";
      }, { timeout: realOmlxExecutionTimeoutMs, intervals: [1_000] }).toBe("terminal");
    } catch (error) {
      await page.evaluate(() => (window as any).__CODELY_E2E__?.stopGeneration?.());
      const stopped = await page.evaluate(() =>
        (window as any).__CODELY_E2E__?.getSnapshot?.()
      );
      console.log(`[real-omlx-snake-stopped:${model}] ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        runtimeV2: stopped?.runtimeV2 || null,
        debugTail: (stopped?.debugTail || []).slice(-80),
      }).slice(-80_000)}`);
      throw error;
    }

    expect(terminalSnapshot?.currentTurnId).toBe(admittedTurnId);
    expect(terminalSnapshot?.currentTurnIntent).toBe(expectedIntent);
    const runtime = expectCanonicalRuntimeV2Terminal(terminalSnapshot, {
      turnId: admittedTurnId,
      resultKind: "success",
    });
    expect(runtime?.strategy).toBe("execute");
    expect(runtime?.evidence?.some((entry: { kind?: string }) =>
      entry.kind === "mutation"
    )).toBe(true);
    expect(runtime?.evidence?.some((entry: { kind?: string }) =>
      entry.kind === "validation"
    )).toBe(true);

    const acceptance = await inspectSnakeAcceptance(workspace);
    console.log(`[real-omlx-snake-quality:${model}] ${JSON.stringify({
      gaps: acceptance.gaps,
      files: acceptance.files,
      testCount: acceptance.testCount,
      compile: {
        exitCode: acceptance.compile.exitCode,
        stdout: acceptance.compile.stdout.slice(-2_000),
        stderr: acceptance.compile.stderr.slice(-2_000),
      },
      tests: {
        exitCode: acceptance.tests.exitCode,
        stdout: acceptance.tests.stdout.slice(-4_000),
        stderr: acceptance.tests.stderr.slice(-4_000),
      },
      importCheck: {
        exitCode: acceptance.importCheck.exitCode,
        stdout: acceptance.importCheck.stdout.slice(-1_000),
        stderr: acceptance.importCheck.stderr.slice(-1_000),
      },
    }).slice(-30_000)}`);
    expect(
      acceptance.gaps,
      "The independent Python Snake quality gate found missing basic behavior.",
    ).toEqual([]);
    await expect(page.locator(
      `[data-testid="assistant-final"][data-turn-id="${admittedTurnId}"]`,
    )).toBeVisible();
  });

  test(`real OMLX Execute completes the MD Viewer incident with ${model}`, async ({ page }) => {
    test.skip(!runExecuteIncidentReplay || realOmlxFixture !== "md-viewer");
    const workspace = (page as any).__realOmlxWorkspace as string;
    const originalMutationContents = await readFixtureMutationContents(workspace);
    const originalMainSource = originalMutationContents["src/main.js"] || "";
    const replayImages = await loadRealOmlxReplayImages();
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);

    const immediateSnapshot = await page.evaluate(async ({
      text,
      images,
      preferSubagents,
    }) => {
      const bridge = (window as any).__CODELY_E2E__;
      if (preferSubagents) bridge?.setPreferSubagents?.(true);
      try {
        await bridge?.sendDirectEditMessage?.(text, images);
      } catch (error) {
        bridge.dispatchError = error instanceof Error ? error.message : String(error);
      }
      return bridge?.getSnapshot?.();
    }, {
      text: realOmlxRequest,
      images: replayImages,
      // Grant collaboration permission for this production incident. Runtime
      // still exposes spawn_subagent only when the active provider lane has a
      // real child-request slot after reserving the parent.
      preferSubagents: true,
    });

    expect(immediateSnapshot?.dispatchError).toBeNull();
    expect(immediateSnapshot?.lastWorkspaceInstructionAcceptance?.accepted).toBe(true);
    expect(immediateSnapshot?.conversationTurns).toBe(1);
    const admittedTurnId = String(
      immediateSnapshot?.lastWorkspaceInstructionAcceptance?.receipt?.turnId || "",
    );
    const admittedTurn = (immediateSnapshot?.conversationTurnPreview || []).find(
      (turn: { id?: string }) => turn.id === admittedTurnId,
    );
    expect(admittedTurnId).not.toBe("");
    expect(admittedTurn?.intent).toBe("execute");
    expect(admittedTurn?.displayIntent).toBe("execute");
    expect(admittedTurn?.userPrompt).toBe(realOmlxRequest);
    expect(String(admittedTurn?.title || "").trim()).not.toBe("");
    expect(admittedTurn?.runtimeEngineVersion).toBe("v2");

    let observedRuntimeStart = false;
    let terminalSnapshot: any = null;
    let latestRuntimeSnapshot: any = immediateSnapshot;
    let latestActiveRuntimeSnapshot: any =
      immediateSnapshot?.runtimeV2 ? immediateSnapshot : null;
    const capsuleTimeline: Array<{
      text: string;
      source: string;
      status: string;
      runId: string;
      turnId: string;
      updatedAt: string;
    }> = [];
    const visibleTimeline: Array<{
      phase: string;
      status: string;
      text: string;
    }> = [];
    const admissionStartedAt = Date.now();
    try {
      await expect.poll(async () => {
        const observation = await page.evaluate(() => {
          const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
          const shell = document.querySelector<HTMLElement>(
            '[data-testid="agent-explanation-capsule"]',
          );
          const guidance = shell?.querySelector<HTMLElement>(
            '[data-testid="capsule-guidance-label"]',
          );
          const status = shell?.querySelector<HTMLElement>(
            '[data-testid="capsule-status-label"]',
          );
          const progress = [...document.querySelectorAll<HTMLElement>(
            [
              '[data-testid="progress-block"]',
              '[data-testid="live-turn-step"]',
              '[data-testid="turn-archive-step"]',
            ].join(','),
          )].filter((node) => node.getClientRects().length > 0).map((node) => ({
            phase: node.dataset.phase || node.dataset.kind || "",
            status: node.dataset.status || "",
            text: String(node.textContent || "").replace(/\s+/g, " ").trim(),
          }));
          return {
            snapshot,
            capsule: shell ? {
              text: String(guidance?.textContent || status?.textContent || "")
                .replace(/\s+/g, " ")
                .trim(),
              source: shell.dataset.guidanceSource || "",
              status: shell.dataset.capsuleStatus || "",
              runId: shell.dataset.runId || "",
              turnId: shell.dataset.turnId || "",
              updatedAt: shell.dataset.guidanceUpdatedAt || "",
            } : null,
            progress,
          };
        });
        const snapshot = observation?.snapshot;
        const capsule = observation?.capsule;
        if (
          capsule?.text &&
          (
            capsuleTimeline.length === 0 ||
            capsuleTimeline[capsuleTimeline.length - 1]?.text !== capsule.text ||
            capsuleTimeline[capsuleTimeline.length - 1]?.updatedAt !== capsule.updatedAt
          )
        ) {
          capsuleTimeline.push(capsule);
        }
        for (const progress of observation?.progress || []) {
          if (
            progress.text &&
            !visibleTimeline.some((entry) =>
              entry.phase === progress.phase &&
              entry.status === progress.status &&
              entry.text === progress.text
            )
          ) {
            visibleTimeline.push(progress);
          }
        }
        latestRuntimeSnapshot = snapshot;
        if (snapshot?.runtimeV2) {
          latestActiveRuntimeSnapshot = snapshot;
        }
        if (snapshot?.dispatchError) return `dispatch_error:${snapshot.dispatchError}`;
        if (snapshot?.runtimeV2?.eventTypes?.includes("run.started")) {
          observedRuntimeStart = true;
        }
        if (
          observedRuntimeStart &&
          snapshot?.runtimeV2?.terminal?.exactlyOnce === true
        ) {
          terminalSnapshot = snapshot;
          return "terminal";
        }
        if (!observedRuntimeStart && Date.now() - admissionStartedAt > 15_000) {
          return "admitted_without_runtime_start";
        }
        return "running";
      }, { timeout: realOmlxExecutionTimeoutMs }).toBe("terminal");
    } catch (error) {
      const activeSnapshot =
        latestActiveRuntimeSnapshot || latestRuntimeSnapshot;
      console.log(`[real-omlx-execute-timeout:${model}] ${JSON.stringify({
        currentTurnStatus: latestRuntimeSnapshot?.currentTurnStatus,
        currentTurnIntent: latestRuntimeSnapshot?.currentTurnIntent,
        currentTurnTitle: latestRuntimeSnapshot?.currentTurnTitle,
        agentStatus: latestRuntimeSnapshot?.agentStatus,
        isGenerating: latestRuntimeSnapshot?.isGenerating,
        activeRuntimeV2: activeSnapshot?.runtimeV2,
        capsuleTimeline: capsuleTimeline.slice(-40),
        visibleTimeline: visibleTimeline.slice(-80),
        debugTail: (activeSnapshot?.debugTail || [])
          .filter((entry: { source?: string }) =>
            /runtime_v2|terminal|error|failed|recovery|timeout|watchdog/i.test(
              String(entry?.source || ""),
            )
          )
          .slice(-120),
      }).slice(-120_000)}`);
      throw error;
    }

    const finalFixtureState = await inspectFixtureMutation(
      workspace,
      originalMutationContents,
    );
    console.log(`[real-omlx-capsule-timeline:${model}] ${JSON.stringify(
      capsuleTimeline.slice(-40),
    ).slice(0, 30_000)}`);
    console.log(`[real-omlx-acceptance-gaps:${model}] ${JSON.stringify({
      satisfied: finalFixtureState.satisfied,
      changedFiles: finalFixtureState.changedFiles,
      detail: finalFixtureState.detail,
    })}`);
    console.log(`[real-omlx-execute-incident:${model}] ${JSON.stringify({
      currentTurnStatus: terminalSnapshot?.currentTurnStatus,
      currentTurnIntent: terminalSnapshot?.currentTurnIntent,
      currentTurnTitle: terminalSnapshot?.currentTurnTitle,
      agentStatus: terminalSnapshot?.agentStatus,
      runtimeV2: terminalSnapshot?.runtimeV2,
      capsuleTimeline: capsuleTimeline.slice(-40),
      visibleTimeline: visibleTimeline.slice(-80),
    }).slice(-40_000)}`);

    expectRuntimeV2TurnPresentationStatus(terminalSnapshot);
    expect(terminalSnapshot?.currentTurnIntent).toBe("execute");
    expect(String(terminalSnapshot?.currentTurnTitle || "").trim()).not.toBe("");
    const terminalTurnId = String(terminalSnapshot?.currentTurnId || "");
    expect(terminalTurnId).not.toBe("");
    expect(terminalTurnId).toBe(admittedTurnId);
    const runtimeV2 = expectCanonicalRuntimeV2Terminal(terminalSnapshot, {
      turnId: terminalTurnId,
      resultKind: "success",
    });
    const finalAssistantMessage = page.locator(
      `[data-testid="assistant-final"][data-turn-id="${terminalTurnId}"]`,
    );
    await expect(finalAssistantMessage).toBeVisible();
    const finalAssistantText = String(
      await finalAssistantMessage.textContent() || "",
    ).trim();
    expect(finalAssistantText.length).toBeGreaterThan(0);
    const finalSummaryTaskQualityGaps =
      getMdViewerFinalSummaryGaps(finalAssistantText);
    console.log(`[real-omlx-task-quality-summary:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      gaps: finalSummaryTaskQualityGaps,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(
        finalSummaryTaskQualityGaps,
        `Optional task-quality oracle rejected the final summary:\n${finalAssistantText}`,
      ).toEqual([]);
    }

    const mutationCommands = (runtimeV2.commands || []).filter(
      (command: { kind?: string; toolName?: string; status?: string }) =>
        command.kind === "execute_tool" &&
        ["apply_patch", "replace_in_file", "write_file", "write_file_atomic"].includes(
          String(command.toolName || ""),
        ) &&
        command.status === "succeeded",
    );
    expect(mutationCommands.length).toBeGreaterThan(0);
    expect(runtimeV2.evidence.some((evidence: { kind?: string }) =>
      evidence.kind === "mutation"
    )).toBe(true);
    const passedParentValidations = (runtimeV2.events || []).filter(
      (event: { type?: string; passed?: boolean }) =>
        event.type === "validation.completed" &&
        event.passed === true,
    );
    const passedChildValidations = (runtimeV2.events || []).flatMap(
      (event: {
        type?: string;
        status?: string;
        report?: unknown;
        validationReceipts?: Array<{
          passed?: boolean;
          authority?: unknown;
        }>;
      }) =>
        event.type === "subagent.completed" &&
          event.status === "completed" &&
          !!event.report
          ? (event.validationReceipts || []).filter((receipt) =>
              receipt.passed === true && !!receipt.authority
            )
          : [],
    );
    expect(
      passedParentValidations.length + passedChildValidations.length,
    ).toBeGreaterThan(0);
    expect(runtimeV2.evidence.some((evidence: { kind?: string }) =>
      evidence.kind === "validation"
    )).toBe(true);
    const successfulValidationCommands = (runtimeV2.commands || [])
      .filter((command: {
        kind?: string;
        status?: string;
      }) =>
        command.kind === "execute_validation" &&
        command.status === "succeeded"
      );
    const finalFiniteValidation = [...successfulValidationCommands]
      .reverse()
      .find((command: { toolName?: string; target?: string }) =>
        command.toolName === "run_command" &&
        isFinitePlanValidationCommand(String(command.target || ""))
      );
    const finalValidationCommand = String(
      finalFiniteValidation?.target || "",
    ).trim();
    if (requireSemanticTaskQuality) {
      expect(finalFiniteValidation).toBeTruthy();
      expect(isFinitePlanValidationCommand(finalValidationCommand)).toBe(true);
    }
    if (finalValidationCommand) {
      const independentFinalValidation = await runRealOmlxWorkspaceCommand(
        workspace,
        finalValidationCommand,
      );
      expect(
        independentFinalValidation.exitCode,
        [
          `Final replay validation failed: ${finalValidationCommand}`,
          independentFinalValidation.stdout,
          independentFinalValidation.stderr,
        ].filter(Boolean).join("\n"),
      ).toBe(0);
    }

    const finalMainSource = await fs.readFile(path.join(workspace, "src/main.js"), "utf8");
    expect(finalMainSource).not.toBe(originalMainSource);
    const incidentTaskQualityGaps = getMdViewerExecutionGaps({
      caller: finalMainSource,
      editor: await fs.readFile(path.join(workspace, "src/components/editor.js"), "utf8"),
      handler: await fs.readFile(path.join(workspace, "src-tauri/src/main.rs"), "utf8"),
      toolbar: await fs.readFile(path.join(workspace, "src/components/toolbar.js"), "utf8"),
    });
    console.log(`[real-omlx-task-quality-incident:${model}] ${JSON.stringify({
      required: requireSemanticTaskQuality,
      gaps: incidentTaskQualityGaps,
    })}`);
    if (requireSemanticTaskQuality) {
      expect(finalMainSource).toMatch(/\bfilePath\s*:/);
      expect(finalMainSource).not.toMatch(/\bfile_path\s*:/);
      expect(incidentTaskQualityGaps).toEqual([]);
    }

    const runtimeDebugText = JSON.stringify(runtimeV2.debug || []);
    expectRuntimeV2ReadOnlyCollaboration(runtimeV2);
    expect(runtimeV2.presentation?.timeline?.length || 0).toBeGreaterThan(0);
    expect((runtimeV2.presentation?.timeline || []).every(
      (entry: { title?: string; status?: string; toolCallId?: string }) =>
        String(entry.title || "").trim().length > 0 &&
        ["done", "failed"].includes(String(entry.status || "")) &&
        String(entry.toolCallId || "").trim().length > 0,
    )).toBe(true);
    expect(visibleTimeline.length).toBeGreaterThan(0);
    expect(visibleTimeline.some((entry) => entry.text.trim().length > 0)).toBe(true);
    const concreteCapsuleTimeline = capsuleTimeline.filter((entry) =>
      entry.source !== "status" &&
      entry.text !== "正在执行" &&
      entry.text !== "Executing"
    );
    expect(concreteCapsuleTimeline.length).toBeGreaterThan(0);
    expect(new Set(concreteCapsuleTimeline.map((entry) => entry.text)).size)
      .toBeGreaterThan(1);
    expect(concreteCapsuleTimeline.some((entry) => entry.source === "runtime_v2"))
      .toBe(true);
    const commandTokens = (runtimeV2.commands || []).flatMap((command: {
      toolName?: string;
      target?: string;
    }) => [
      String(command.toolName || "").trim(),
      path.basename(String(command.target || "").trim()),
    ]).filter((token: string) => token.length >= 4);
    expect(concreteCapsuleTimeline.some((entry) =>
      commandTokens.some((token: string) => entry.text.includes(token))
    )).toBe(true);
    expect(concreteCapsuleTimeline.every((entry) =>
      entry.turnId === terminalTurnId &&
      !/(?:\.\.\.|…)\s*$/.test(entry.text)
    )).toBe(true);
    expect(concreteCapsuleTimeline
      .filter((entry) => entry.source !== "phase")
      .every((entry) =>
        entry.runId.trim().length > 0 &&
        entry.updatedAt.trim().length > 0
      )).toBe(true);
    const projectedMutations = (runtimeV2.presentation?.timeline || []).filter(
      (entry: { toolName?: string; status?: string }) =>
        /^(?:replace_in_file|write_file|apply_patch)$/.test(
          String(entry.toolName || ""),
        ) &&
        entry.status === "done",
    );
    expect(projectedMutations.some((entry: {
      diff?: { old?: string; new?: string; path?: string } | null;
    }) =>
      !!entry.diff &&
      typeof entry.diff.old === "string" &&
      typeof entry.diff.new === "string" &&
      String(entry.diff.path || "").trim().length > 0
    )).toBe(true);
    expect(runtimeDebugText).not.toMatch(
      /RUNTIME_V2_STALE_RUN_CHECKPOINT|runtime_v2_checkpoint_projection_conflict|runtime_v2_checkpoint_persist_failed|runtime_v2_tool_execution_rejected/,
    );
  });


}

const explicitSubagentModel = String(process.env.OMLX_SUBAGENT_MODEL || "").trim();
if (runRealOmlx && explicitSubagentModel && explicitSubagentModel !== models[0]) {
  throw new Error("Real OMLX validation requires parent and subagents to share the one explicitly loaded model.");
}
const subagentModel = explicitSubagentModel || models[0];

test(`real OMLX starts semantic collaboration after runtime admission with ${subagentModel}`, async ({ page }, testInfo) => {
  test.skip(realOmlxFixture !== "csv");
  await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(subagentModel)}`);
  await page.evaluate(() => (window as any).__CODELY_E2E__.setPreferSubagents(true));
  const prompt = [
    "请比较 src/hooks/useCsvParser.ts 与 src/hooks/useChartData.ts 的 creatorName 数据契约，并生成一份只读整改计划。",
    "把 parser 的独立只读调查交给一个子智能体，主体调查 consumer；收集两个文件的证据并汇合后再形成计划，不修改工作区。",
  ].join("\n");
  await page.evaluate((text) => {
    const bridge = (window as any).__CODELY_E2E__;
    Promise.resolve(bridge.sendCloudMessage(text)).catch((error) => { bridge.dispatchError = String(error); });
  }, prompt);
  await settleVisiblePlanInterview(page, testInfo, "executable", {
    label: "collaboration-admission-interview",
    timeoutMs: 180_000,
    ready: snapshot => (snapshot.runtimeV2?.events || []).some((event: any) =>
      event.type === "subagent.telemetry" && event.telemetry?.phase === "first_token"
    ),
  });
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
    if (snapshot.dispatchError) throw new Error(snapshot.dispatchError);
    const runtime = snapshot.runtimeV2;
    const started = (runtime?.events || []).some((event: any) =>
      event.type === "subagent.telemetry" && event.telemetry?.phase === "first_token"
    );
    return started || !!runtime?.terminalOutcome || runtime?.phase === "reviewing";
  }, { timeout: 180_000, intervals: [500] }).toBe(true);
  const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
  await fs.writeFile(testInfo.outputPath("collaboration-admission-v2.json"), JSON.stringify(snapshot, null, 2));
  const runtime = snapshot.runtimeV2;
  expect(runtime.strategy).toBe("plan");
  expect(snapshot.preferSubagents).toBe(true);
  const scheduled = runtime.events.filter((event: any) => event.type === "subagents.scheduled");
  expect(scheduled.length).toBeGreaterThan(0);
  expect(runtime.commands.some((command: any) => command.kind === "schedule_subagents" && command.status === "succeeded")).toBe(true);
  expect(runtime.events.some((event: any) => event.type === "subagent.telemetry" && event.telemetry.phase === "first_token")).toBe(true);
  expect(runtime.subagents.some((job: any) =>
    job.parentRunId === runtime.runId && job.sourceToolCallId &&
    job.accessMode === "read" && job.allowedPaths.length > 0 && Number.isFinite(job.firstTokenAt)
  )).toBe(true);
  expect(runtime.events[0].type).toBe("turn.admitted");
  expect(runtime.events.findIndex((event: any) => event.type === "run.started"))
    .toBeLessThan(runtime.events.findIndex((event: any) => event.type === "subagents.scheduled"));
  await page.evaluate(() => (window as any).__CODELY_E2E__.stopGeneration());
  await expect.poll(async () => {
    const stopped = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
    return !stopped.isGenerating && stopped.runtimeV2?.terminalOutcome?.resultKind === "canceled" && stopped.runtimeV2.terminal.exactlyOnce;
  }, { timeout: 60_000 }).toBe(true);
});

test(`real OMLX ordinary Execute starts a proactive read-only subagent with ${subagentModel}`, async ({ page }, testInfo) => {
  test.skip(realOmlxFixture !== "csv");
  test.skip(!!process.env.REAL_OMLX_WORKSPACE, "Proactive collaboration regression uses its own disposable project.");
  test.setTimeout(150_000);
  const workspace = (page as any).__realOmlxWorkspace as string;
  const editorVersionPath = "ProjectSettings/ProjectVersion.txt";
  const lockPath = "Packages/packages-lock.json";
  const packageName = "com.unity.render-pipelines.universal";
  await fs.mkdir(path.join(workspace, "ProjectSettings"), { recursive: true });
  await fs.mkdir(path.join(workspace, "Packages"), { recursive: true });
  await fs.writeFile(path.join(workspace, editorVersionPath), "m_EditorVersion: 2022.3.62t16\nm_TuanjieEditorVersion: 1.10.4\n");
  await fs.writeFile(path.join(workspace, lockPath), JSON.stringify({ dependencies: { [packageName]: { version: "14.2.0-t1" } } }));
  await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(subagentModel)}`);
  await page.evaluate(() => {
    const bridge = (window as any).__CODELY_E2E__;
    bridge.setPreferSubagents(true);
    void bridge.sendRealMessage(
      "直接修复 CSV creatorName 映射。先读取 src/hooks/useCsvParser.ts 确认现有字段映射，再修改解析器并运行 npm test。只改解析器，不生成计划。",
      { resolvedIntent: "execute", runtimeIntentOverride: "execute", skipIntentResolution: true },
    );
  });
  let runtime: any;
  try {
    await expect.poll(async () => {
      runtime = (await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot())).runtimeV2;
      const jobs = runtime?.events.flatMap((event: any) => event.jobs || []) || [];
      const proactive = jobs.find((job: any) => job.scopeKey?.startsWith("proactive:"));
      return !!(proactive && runtime.subagents.some((job: any) => job.id === proactive.id && job.firstTokenAt))
        || !!runtime?.terminalOutcome;
    }, { timeout: 100_000, intervals: [500] }).toBe(true);
    expect(runtime.strategy).toBe("execute");
    expect(runtime.workPlan).toBeNull();
    const proactive = runtime.events.flatMap((event: any) => event.jobs || [])
      .find((job: any) => job.scopeKey?.startsWith("proactive:"));
    expect(proactive).toMatchObject({ accessMode: "read", allowedPaths: expect.arrayContaining([editorVersionPath, lockPath]) });
    expect(runtime.subagents.find((job: any) => job.id === proactive.id)?.firstTokenAt).toBeGreaterThan(0);
    const scheduled = runtime.events.find((event: any) => event.jobs?.some((job: any) => job.id === proactive.id));
    const completed = runtime.events.find((event: any) => event.type === "subagent.completed" && event.jobId === proactive.id);
    const parentReadsBeforeSchedule = runtime.commands.filter((command: any) => command.sequence < scheduled.sequence &&
      command.toolName === "read_file" && command.status === "succeeded").map((command: any) => command.target);
    expect(parentReadsBeforeSchedule).toContain("src/hooks/useCsvParser.ts");
    expect(parentReadsBeforeSchedule).not.toContain(editorVersionPath);
    expect(parentReadsBeforeSchedule).not.toContain(lockPath);
    expect(runtime.events.some((event: any) => event.type === "command.scheduled" && event.commandKind === "request_model" &&
      event.sequence > scheduled.sequence && (!completed || event.sequence < completed.sequence))).toBe(true);
  } finally {
    await fs.writeFile(testInfo.outputPath("proactive-execute-v2.json"), JSON.stringify(runtime || {}, null, 2));
    await page.evaluate(() => (window as any).__CODELY_E2E__.stopGeneration());
  }
});

test(`real OMLX adaptively admits a third subagent with ${subagentModel}`, async ({ page }, testInfo) => {
  test.skip(realOmlxFixture !== "csv");
  await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(subagentModel)}`);
  await page.evaluate(() => (window as any).__CODELY_E2E__.setPreferSubagents(true));
  const prompt = [
    "请为 CSV creatorName 数据链路生成一个可审批的整改计划。",
    "把以下三个互不重叠的调查范围分别交给三个只读子智能体，由 runtime 按实测容量调度并汇合，不修改文件：",
    "1. Euler：scope_key=csv-parser，scope=只分析 CSV 字段归一化，allowed_paths=src/hooks/useCsvParser.ts，expected_output=指出字段映射缺口并给出文件证据。",
    "2. Mendel：scope_key=chart-consumer，scope=只分析图表消费 creatorName 的逻辑，allowed_paths=src/hooks/useChartData.ts,src/store/dashboardStore.ts，expected_output=说明消费端契约并给出文件证据。",
    "3. Herschel：scope_key=type-contract，scope=只分析订单类型中的 creatorName 契约，allowed_paths=src/types/order.ts，expected_output=说明类型约束并给出文件证据。",
    "主体只负责读取 cn_tutorial_orders_by_creator_20260512.csv、整合三个结果和形成计划；不要重读子智能体租约路径。",
    "在输出计划前必须调用 wait_subagents 汇合三个结果。此轮只做计划，不修改文件。",
  ].join("\n");
  await page.evaluate((text) => {
    const bridge = (window as any).__CODELY_E2E__;
    Promise.resolve(bridge.sendCloudMessage(text)).catch((error) => { bridge.dispatchError = String(error); });
  }, prompt);
  await settleVisiblePlanInterview(page, testInfo, "executable", {
    label: "three-subagent-executable-interview",
    timeoutMs: Math.min(600_000, realOmlxPlanTimeoutMs),
  });
  let maxInFlight = 0;
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
    if (snapshot.dispatchError) throw new Error(snapshot.dispatchError);
    const runtime = snapshot.runtimeV2;
    maxInFlight = Math.max(maxInFlight, Number(runtime?.subagentConcurrency?.peakInFlight) || 0);
    return (runtime?.phase === "reviewing" && runtime?.workPlan?.status === "pending_review" &&
      !!runtime?.planReviewCommit && !snapshot.isGenerating) || !!runtime?.terminalOutcome;
  }, { timeout: Math.min(600_000, realOmlxPlanTimeoutMs), intervals: [1000] }).toBe(true);
  const snapshot = await readRuntimeV2PlanReviewSnapshot(page);
  await fs.writeFile(testInfo.outputPath("three-subagent-plan-v2.json"), JSON.stringify(snapshot, null, 2));
  const runtime = expectRuntimeV2PlanReviewContract(snapshot, { turnId: snapshot.currentTurnId });
  expect(snapshot.agentStatus).toBe("pending_review");
  expect(snapshot.currentTurnStatus).toBe("awaiting_approval");
  expectRuntimeV2ReadOnlyCollaboration(runtime, { requireObservedChild: true, requireAdoptedChildEvidence: true });
  const expectedScopeKeys = new Set(["csv-parser", "chart-consumer", "type-contract"]);
  const selectedRuns = runtime.subagents.filter((job: any) => expectedScopeKeys.has(job.scopeKey));
  expect(selectedRuns).toHaveLength(3);
  expect(new Set(selectedRuns.map((job: any) => job.scopeKey))).toEqual(expectedScopeKeys);
  expect(selectedRuns.every((job: any) => job.status === "completed" && job.reportSubmitted)).toBe(true);
  for (const job of selectedRuns) {
    const completion = runtime.events.find((event: any) => event.type === "subagent.completed" && event.jobId === job.id);
    expect(completion.status).toBe("completed");
    expect(completion.report).toBeTruthy();
    expect(completion.evidence.length).toBeGreaterThan(0);
    expect(completion.jobId === job.id && completion.evidence.every((entry: any) =>
      entry.kind === "subagent" &&
      typeof entry.id === "string" && entry.id.startsWith("child:") &&
      job.allowedPaths.includes(entry.target) &&
      typeof entry.version === "string" && entry.version.trim().length > 0 &&
      runtime.evidence.some((canonical: any) =>
        canonical.kind === "subagent" && canonical.id === entry.id &&
        canonical.target === entry.target && canonical.version === entry.version
      )
    )).toBe(true);
  }
  expect(maxInFlight).toBeGreaterThanOrEqual(2);
  expect(runtime.subagentConcurrency.observedWithParent).toBeGreaterThanOrEqual(2);
  expect(runtime.subagentConcurrency.peakInFlight).toBeLessThanOrEqual(3);
  const candidateEvidenceTargets = new Set(runtime.sealedWorkPlan.evidence.map((entry: any) => entry.target));
  for (const target of ["src/hooks/useCsvParser.ts", "src/hooks/useChartData.ts", "src/store/dashboardStore.ts", "src/types/order.ts"]) {
    expect(candidateEvidenceTargets.has(target)).toBe(true);
  }
  const plan = runtime.sealedWorkPlan.markdown;
  expect(plan).toMatch(/useCsvParser|creatorName/);
  expect(plan).toMatch(/useChartData|dashboardStore/);
  expect(plan).toMatch(/src\/types\/order\.ts/);
  expect(plan).toMatch(/(?:normalizeCsvOrder|归一化)[^\n]{0,180}creatorName|creatorName[^\n]{0,180}(?:normalizeCsvOrder|归一化)/i);
  expect(plan).not.toMatch(/(?:移除|删除|去掉|remove|delete|drop)[^\n]{0,120}creatorName/i);
});

async function expectRealReadOnlyCancellation(page: Page, testInfo: TestInfo) {
  // Cancel while the real local provider is streaming, through the same
  // Store transaction as the desktop Stop button. Queue/CAS durability is
  // covered separately because this browser fixture disables recording.
  const priorChunks = await page.evaluate(() => (window as any).__MAIN_E2E_CHAT_TRANSPORT_CHUNKS || 0);
  await page.evaluate(() => (window as any).__CODELY_E2E__.sendReadOnlyMessage("请详细推导一个通用算法，枚举并解释前 100 个质数的试除过程和每一步的正确性，分步骤完整输出。无需联网。"));
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot());
    const chunks = await page.evaluate(() => (window as any).__MAIN_E2E_CHAT_TRANSPORT_CHUNKS || 0);
    return snapshot.isGenerating && !snapshot.aggregate?.terminalOutcome && chunks > priorChunks;
  }, { timeout: 180_000, intervals: [250] }).toBe(true);
  await page.evaluate(() => (window as any).__CODELY_E2E__.stopGeneration());
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot());
    return snapshot.aggregate?.terminalOutcome?.resultKind === "canceled" && !snapshot.isGenerating && snapshot.agentStatus === "idle";
  }, { timeout: 60_000, intervals: [250] }).toBe(true);
  const canceled = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot());
  expect(canceled.finals).toHaveLength(1);
  expect(Date.parse(canceled.session.updatedAt)).toBeGreaterThan(Date.UTC(2025, 0, 1));
  expect(canceled.aggregate.events.filter((event: any) => event.type === "run.completed" || event.type === "turn.completed").map((event: any) => event.type)).toEqual(["run.completed", "turn.completed"]);
  await fs.writeFile(testInfo.outputPath("chat-canceled.json"), JSON.stringify(canceled, null, 2));
}

function expectWorkspaceConclusionOrder(snapshot: any): void {
  const events = (snapshot.runtimeV2?.events || []).filter((event: any) =>
    event.type === "run.completed" || event.type === "turn.completed" ||
    (event.type === "projection.published" && event.audience === "final" && event.projectionKind === "final")
  );
  expect(events.map((event: any) => event.type)).toEqual(["run.completed", "projection.published", "turn.completed"]);
}

for (const model of models) {
  test(`real OMLX workspace game design continuity through Composer with ${model}`, async ({ page }, testInfo) => {
    // A real dense local model may spend most of a request on reasoning and
    // then need a complete-answer recovery. Allow both within each window.
    test.setTimeout(110 * 60_000);
    const stopOnMutationPressure = process.env.REAL_OMLX_DESIGN_AUDIT_STOP_ON_MUTATION_PRESSURE === "1";
    const hasRequiredMutationPressure = (snapshot: any) => (snapshot.runtimeV2?.debug || []).some((entry: any) =>
      entry.source?.endsWith("runtime_v2_context_prepared") &&
      entry.data?.toolChoice === "required" &&
      Array.isArray(entry.data?.allowedToolNames) && entry.data.allowedToolNames.length > 0 &&
      entry.data.allowedToolNames.every((name: string) => ["replace_in_file", "apply_patch", "delete_workspace_path"].includes(name))
    );
    const fullPrompts = [
      "我打算用unity开发一款游戏，我有一些想法请帮我一起完善游戏设计的部分，请跟我一起讨论并给我提出一些建议并记录我的选择，最后我们会生成一份游戏开发文档。",
      "我的核心想法是一个海岛送货游戏，玩家接委托、规划路线并发现新岛屿。我希望体验轻松，开发规模适合一个人。你觉得最值得先确定什么？先不写代码，也不要现在生成完整文档。",
      "先确定 PC、单人和俯视角。节奏上暂时选每天必须完成送货指标，给玩家一点压力。战斗和收费方式先不确定。请记录我的选择，并帮我看看这些选择有什么取舍。",
      "我改主意了，取消每日必须达标，改成自由安排送货，不完成也没有惩罚。平台和视角保持之前的决定。这样核心循环应该怎么调整？请更新记录。",
      "先别写文档，请回顾我们已经确认的决定、改过的决定，以及还没有决定的部分。不要替我补齐空白。",
      "成长机制我决定选船舶升级，具体包括货舱容量和航行速度；暂不加入角色技能树。战斗和收费方式继续待定。请记录这个决定，并简短指出它对之前核心循环的影响。",
      "现在请根据刚才的讨论生成第一版游戏开发文档，直接在聊天中给出 Markdown 正文。明确区分已确认设计和待定问题，把修改后的决定作为当前版本。不要写代码或创建 Unity 工程。",
    ];
    const focusedRevisions = process.env.REAL_OMLX_DESIGN_FOCUSED_REVISIONS === "1";
    const prompts = focusedRevisions ? [
      fullPrompts[0],
      "我的核心想法是一个海岛送货游戏，玩家接委托、规划路线并发现新岛屿。我希望体验轻松，开发规模适合一个人。先确定 PC、单人和俯视角。节奏上暂时选每天必须完成送货指标，给玩家一点压力。战斗和收费方式先不确定。请记录我的选择，并帮我看看这些选择有什么取舍。先不写代码，也不要现在生成完整文档。",
      `${fullPrompts[3]}成长机制我决定选船舶升级，具体包括货舱容量和航行速度；暂不加入角色技能树。战斗和收费方式继续待定。请更新记录，并区分已确认设计、建议和未决定的部分。`,
      fullPrompts[6],
    ] : fullPrompts;
    const records: Array<Record<string, any>> = [];
    const transcriptPath = testInfo.outputPath("unity-design-conversation.json");
    const saveTranscript = async () => {
      await fs.writeFile(transcriptPath, JSON.stringify({
        model, submission: "native workspace Composer; no resolvedIntent override or intent-resolution bypass",
        recording: "browser fixture disables session recording; this test evaluates same-session conversational continuity, not cold restore",
        focusedRevisions, prompts, records,
      }, null, 2));
      await fs.writeFile(testInfo.outputPath("unity-design-conversation.md"), records.map((record, index) =>
        `## Round ${index + 1}\n\nUser:\n\n${record.prompt}\n\nMAIN (${record.intent}/${record.strategy}):\n\n${record.answer || "[no final answer]"}\n`
      ).join("\n"));
    };
    try {
      await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
      await expect.poll(() => page.evaluate(() => !!(window as any).__CODELY_E2E__?.getSnapshot)).toBe(true);
      const initial = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
      expect(initial.workflowMode).toBe("edit");
      expect(initial.currentWorkspace).toBeTruthy();
      expect(initial.conversationTurns).toBe(0);
      const readmePath = process.env.REAL_OMLX_WORKSPACE && realOmlxMutationFile === "README.md"
        ? path.join(initial.currentWorkspace, "README.md") : null;
      const originalReadme = readmePath ? await fs.readFile(readmePath, "utf8") : null;
      // The shared execution fixture starts with auto-review enabled. Use the
      // actual UI to start with the product's default review setting. Later
      // turns enable auto-review to prove permission does not change intent.
      const reviewToggle = page.getByTestId("composer-auto-review-toggle");
      await expect(reviewToggle).toHaveAttribute("aria-pressed", "true");
      await reviewToggle.click();
      await expect(reviewToggle).toHaveAttribute("aria-pressed", "false");
      for (const [index, prompt] of prompts.entries()) {
        const previousTurnId = records.at(-1)?.snapshot?.currentTurnId || null;
        const previousRunId = records.at(-1)?.snapshot?.runtimeV2?.runId || null;
        if (index === 3) {
          page.once("dialog", async (dialog) => {
            expect(dialog.message()).toMatch(/Auto Review|自动审查/);
            await dialog.accept();
          });
          await reviewToggle.click();
          await expect(reviewToggle).toHaveAttribute("aria-pressed", "true");
        }
        await expect(reviewToggle).toHaveAttribute("aria-pressed", String(index >= 3));
        await page.getByTestId("composer-textarea").fill(prompt);
        await page.getByTestId("composer-send-button").click();
        await expect.poll(async () => {
          const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
          return snapshot.conversationTurns > index &&
            !!snapshot.currentTurnId && snapshot.currentTurnId !== previousTurnId &&
            !!snapshot.runtimeV2?.runId && snapshot.runtimeV2.runId !== previousRunId &&
            snapshot.currentTurnPrompt === prompt &&
            snapshot.runtimeV2?.turnId === snapshot.currentTurnId && (
            (!!snapshot.runtimeV2?.terminalOutcome && !snapshot.isGenerating && snapshot.agentStatus === "idle") ||
            !!snapshot.activeActionRequest ||
            (stopOnMutationPressure && hasRequiredMutationPressure(snapshot))
          );
        }, { timeout: 900_000, intervals: [1000] }).toBe(true);
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
        const finals = (snapshot.runtimeV2?.projections || []).filter((projection: any) => projection.audience === "final" && projection.kind === "final");
        records.push({
          prompt, autoReview: index >= 3, intent: snapshot.currentTurnIntent, strategy: snapshot.runtimeV2?.strategy,
          answer: finals.map((projection: any) => projection.markdown).join("\n\n"),
          terminalOutcome: snapshot.runtimeV2?.terminalOutcome || null,
          activeActionRequest: snapshot.activeActionRequest,
          snapshot,
        });
        await fs.writeFile(testInfo.outputPath(`unity-design-round-${index + 1}.json`), JSON.stringify(snapshot, null, 2));
        await saveTranscript();
        console.log(`[unity-design-round] ${JSON.stringify({ round: index + 1, intent: snapshot.currentTurnIntent, strategy: snapshot.runtimeV2?.strategy, resultKind: snapshot.runtimeV2?.terminalOutcome?.resultKind, activeAction: snapshot.activeActionRequest?.kind || null, answerChars: String(records.at(-1)?.answer || "").length })}`);
        if (stopOnMutationPressure && hasRequiredMutationPressure(snapshot)) {
          await page.evaluate(() => (window as any).__CODELY_E2E__.stopGeneration());
          await expect.poll(async () => {
            const canceled = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
            return canceled.runtimeV2?.terminalOutcome?.resultKind === "canceled" && !canceled.isGenerating && canceled.agentStatus === "idle";
          }, { timeout: 30_000, intervals: [250] }).toBe(true);
          await fs.writeFile(testInfo.outputPath("unity-design-audit-canceled.json"), JSON.stringify(await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot()), null, 2));
          throw new Error("DISCUSSION_ROUTED_TO_REQUIRED_MUTATION: stopped the real run after capturing mutation-only execution pressure.");
        }
        expect(snapshot.currentWorkspace).toBe(initial.currentWorkspace);
        expect(snapshot.currentSessionId).toBe(initial.currentSessionId);
        expect(snapshot.currentTurnPrompt).toBe(prompt);
        expect(snapshot.isGenerating).toBe(false);
        expect(snapshot.agentStatus).toBe("idle");
        expect(["chat", "analyze"]).toContain(snapshot.runtimeV2?.strategy);
        expect(snapshot.activeActionRequest, "Design discussion should not require an execution/plan approval").toBeNull();
        expect((snapshot.runtimeV2?.evidence || []).filter((item: any) => item.kind === "mutation")).toHaveLength(0);
        expect((snapshot.runtimeV2?.commands || []).filter((command: any) =>
          ["write_file", "replace_in_file", "apply_patch", "delete_workspace_path", "run_command"].includes(command.toolName)
        )).toHaveLength(0);
        if (readmePath) expect(await fs.readFile(readmePath, "utf8")).toBe(originalReadme);
        await expect.poll(async () => {
          const latest = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
          return !latest.isGenerating && latest.agentStatus === "idle";
        }, { timeout: 30_000, intervals: [250] }).toBe(true);
        expect(snapshot.runtimeV2?.terminalOutcome?.resultKind).toBe("success");
        expect(finals).toHaveLength(1);
        expect(snapshot.runtimeV2?.terminal?.exactlyOnce).toBe(true);
        expectWorkspaceConclusionOrder(snapshot);
      }
      await page.screenshot({ path: testInfo.outputPath("unity-design-completed.png"), fullPage: true });
      await testInfo.attach("unity-design-conversation", { path: transcriptPath, contentType: "application/json" });
    } catch (error) {
      const failure = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot());
      await fs.writeFile(testInfo.outputPath("unity-design-failure.json"), JSON.stringify(failure, null, 2));
      await saveTranscript();
      await page.screenshot({ path: testInfo.outputPath("unity-design-failure.png"), fullPage: true });
      if (failure?.isGenerating) await page.evaluate(() => (window as any).__CODELY_E2E__?.stopGeneration());
      throw error;
    }
  });

  test(`real OMLX workspace scoped discussion through Composer with ${model}`, async ({ page }, testInfo) => {
    test.skip(!process.env.REAL_OMLX_WORKSPACE || realOmlxMutationFile !== "README.md");
    test.setTimeout(12 * 60_000);
    const prompt = "请帮我完善项目设计，跟我讨论并记录我的选择，以后再生成 README.md。";
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await expect.poll(() => page.evaluate(() => !!(window as any).__CODELY_E2E__?.getSnapshot)).toBe(true);
    const initial = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
    expect(initial.workflowMode).toBe("edit");
    const readmePath = path.join(initial.currentWorkspace, "README.md");
    const before = await fs.readFile(readmePath, "utf8");
    // A workspace scope and permission to run tools do not request a source edit.
    await expect(page.getByTestId("composer-auto-review-toggle")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("composer-textarea").fill(prompt);
    await page.getByTestId("composer-send-button").click();
    try {
      await expect.poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
        return snapshot.conversationTurns === 1 && !!snapshot.currentTurnId &&
          snapshot.currentTurnId !== initial.currentTurnId && snapshot.currentTurnPrompt === prompt &&
          !!snapshot.runtimeV2?.runId && snapshot.runtimeV2.runId !== initial.runtimeV2?.runId &&
          snapshot.runtimeV2.turnId === snapshot.currentTurnId &&
          ((!!snapshot.runtimeV2.terminalOutcome && !snapshot.isGenerating && snapshot.agentStatus === "idle") ||
            !!snapshot.activeActionRequest);
      }, { timeout: Math.min(600_000, realOmlxExecutionTimeoutMs), intervals: [1000] }).toBe(true);
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
      await fs.writeFile(testInfo.outputPath("workspace-scoped-discussion.json"), JSON.stringify(snapshot, null, 2));
      expect(snapshot.currentWorkspace).toBe(initial.currentWorkspace);
      expect(snapshot.currentSessionId).toBe(initial.currentSessionId);
      expect(["chat", "analyze"]).toContain(snapshot.runtimeV2?.strategy);
      expect(snapshot.activeActionRequest).toBeNull();
      expect(snapshot.isGenerating).toBe(false);
      expect(snapshot.agentStatus).toBe("idle");
      expect(snapshot.runtimeV2?.terminalOutcome?.resultKind).toBe("success");
      expect(snapshot.runtimeV2?.terminal?.exactlyOnce).toBe(true);
      expectWorkspaceConclusionOrder(snapshot);
      expect((snapshot.runtimeV2?.evidence || []).filter((item: any) => item.kind === "mutation")).toHaveLength(0);
      expect((snapshot.runtimeV2?.commands || []).filter((command: any) =>
        ["write_file", "replace_in_file", "apply_patch", "delete_workspace_path", "run_command"].includes(command.toolName)
      )).toHaveLength(0);
      const finals = (snapshot.runtimeV2?.projections || []).filter((item: any) => item.audience === "final" && item.kind === "final");
      expect(finals).toHaveLength(1);
      expect(finals[0].markdown.trim().length).toBeGreaterThan(0);
      expect(await fs.readFile(readmePath, "utf8")).toBe(before);
      await page.screenshot({ path: testInfo.outputPath("workspace-scoped-discussion-completed.png"), fullPage: true });
    } catch (error) {
      const failure = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot());
      await fs.writeFile(testInfo.outputPath("workspace-scoped-discussion-failure.json"), JSON.stringify(failure, null, 2));
      if (failure?.isGenerating) await page.evaluate(() => (window as any).__CODELY_E2E__?.stopGeneration());
      throw error;
    }
  });

  test(`real OMLX workspace explicit edit through Composer with ${model}`, async ({ page }, testInfo) => {
    test.skip(!process.env.REAL_OMLX_WORKSPACE || realOmlxMutationFile !== "README.md");
    test.setTimeout(20 * 60_000);
    const workspace = (page as any).__realOmlxWorkspace as string;
    const forceWriteFileReplacement = process.env.REAL_OMLX_WRITE_FILE_REPLACEMENT === "1";
    const editRequest = forceWriteFileReplacement
      ? "请先完整读取 README.md 的当前内容，然后使用 write_file 完整写回原有内容，并在文件末尾另起一行添加 Design validation complete.。必须保留原有内容，此次请使用 write_file，不使用 replace_in_file 或 apply_patch。"
      : "请直接修改 README.md，在文件末尾另起一行添加 Design validation complete.，保留原有内容。";
    const prompt = `${editRequest}然后运行 node -e \"const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.ok(fs.readFileSync('README.md', 'utf8').includes('Design validation complete.'))\" 验证结果。不要生成计划。完成后说明修改与验证结果。`;
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await expect.poll(() => page.evaluate(() => !!(window as any).__CODELY_E2E__?.getSnapshot)).toBe(true);
    const initial = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
    expect(initial.workflowMode).toBe("edit");
    const before = await fs.readFile(path.join(workspace, "README.md"), "utf8");
    await expect(page.getByTestId("composer-auto-review-toggle")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("composer-textarea").fill(prompt);
    await page.getByTestId("composer-send-button").click();
    try {
      await expect.poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
        return snapshot.conversationTurns === 1 && !!snapshot.currentTurnId &&
          snapshot.currentTurnId !== initial.currentTurnId && snapshot.currentTurnPrompt === prompt &&
          !!snapshot.runtimeV2?.runId && snapshot.runtimeV2.runId !== initial.runtimeV2?.runId &&
          snapshot.runtimeV2.turnId === snapshot.currentTurnId &&
          !!snapshot.runtimeV2.terminalOutcome && !snapshot.isGenerating && snapshot.agentStatus === "idle";
      }, { timeout: Math.min(900_000, realOmlxExecutionTimeoutMs), intervals: [1000] }).toBe(true);
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
      await fs.writeFile(testInfo.outputPath("workspace-explicit-edit.json"), JSON.stringify(snapshot, null, 2));
      expect(snapshot.currentTurnPrompt).toBe(prompt);
      expect(snapshot.runtimeV2?.strategy).toBe("execute");
      expect(snapshot.runtimeV2?.terminalOutcome?.resultKind).toBe("success");
      expect(snapshot.runtimeV2?.terminal?.exactlyOnce).toBe(true);
      expectWorkspaceConclusionOrder(snapshot);
      const after = await fs.readFile(path.join(workspace, "README.md"), "utf8");
      expect(after.startsWith(before.trimEnd())).toBe(true);
      expect(after.slice(before.trimEnd().length).trim()).toBe("Design validation complete.");
      const events = snapshot.runtimeV2?.events || [];
      if (forceWriteFileReplacement) {
        const commands = new Map((snapshot.runtimeV2?.commands || [])
          .map((command: any) => [command.idempotencyKey, command]));
        const sourceReadIndex = events.findIndex((event: any) =>
          event.type === "tool.completed" && event.status === "succeeded" &&
          (commands.get(event.idempotencyKey) as any)?.toolName === "read_file" &&
          (event.evidence || []).some((item: any) => item.kind === "source" && item.target === "README.md")
        );
        const writeFileIndex = events.findIndex((event: any) =>
          event.type === "tool.completed" && event.status === "succeeded" &&
          (commands.get(event.idempotencyKey) as any)?.toolName === "write_file" &&
          (event.evidence || []).some((item: any) => item.kind === "mutation" && item.target === "README.md")
        );
        expect(sourceReadIndex).toBeGreaterThanOrEqual(0);
        expect(writeFileIndex).toBeGreaterThan(sourceReadIndex);
      }
      const mutationIndex = events.findLastIndex((event: any) =>
        event.type === "tool.completed" && event.status === "succeeded" &&
        (event.evidence || []).some((item: any) => item.kind === "mutation")
      );
      expect(mutationIndex).toBeGreaterThanOrEqual(0);
      expect(events.some((event: any, index: number) =>
        index > mutationIndex && event.type === "validation.completed" && event.passed === true
      )).toBe(true);
      expect((snapshot.runtimeV2?.projections || []).filter((item: any) => item.audience === "final" && item.kind === "final")).toHaveLength(1);
      await page.screenshot({ path: testInfo.outputPath("workspace-explicit-edit-completed.png"), fullPage: true });
    } catch (error) {
      const failure = await page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot());
      await fs.writeFile(testInfo.outputPath("workspace-explicit-edit-failure.json"), JSON.stringify(failure, null, 2));
      if (failure?.isGenerating) await page.evaluate(() => (window as any).__CODELY_E2E__.stopGeneration());
      throw error;
    }
  });

  test(`real OMLX Chat web and ordinary multi-turn replies reach idle with ${model}`, async ({ page }, testInfo) => {
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) console.log(`[chat-test-navigation] ${frame.url()}`); });
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    await expect.poll(() => page.evaluate(() => !!(window as any).__CODELY_E2E__?.prepareReadOnlyChat)).toBe(true);
    const telemetry = await createRealOmlxChatTelemetry(page, testInfo);
    let sendSequence = 0;
    let expectWebReads = true;
    try {
    const send = async (text: string, interpretIntent = false) => {
      const sendId = ++sendSequence;
      const before = await telemetry.capture(`send-${sendId}-before`, { text, interpretIntent }, true);
      const prior = before.readOnly.turnCount;
      const dispatchAcknowledgement = await page.evaluate(({ text, interpretIntent }) => (window as any).__CODELY_E2E__.sendReadOnlyMessage(text, interpretIntent), { text, interpretIntent });
      await telemetry.capture(`send-${sendId}-ack`, { text, interpretIntent, dispatchAcknowledgement }, true);
      await expect.poll(async () => {
        const snapshot = (await telemetry.capture(`send-${sendId}-poll`, { text, interpretIntent })).readOnly;
        return !!snapshot.pendingRunDecision || (snapshot.turnCount > prior && !!snapshot.aggregate?.terminalOutcome && snapshot.agentStatus === "idle" && !snapshot.isGenerating);
      }, { timeout: Math.min(900_000, realOmlxExecutionTimeoutMs), intervals: [1000] }).toBe(true);
      const settled = await telemetry.capture(`send-${sendId}-settled`, { text, interpretIntent }, true);
      const snapshot = settled.readOnly;
      const policy = canonicalChatNetworkRead(snapshot.aggregate);
      expect(policy.enabled).toBe(expectWebReads);
      if (expectWebReads) expect(policy.provider).toBe("bing");
      const artifact = testInfo.outputPath(`chat-${policy.enabled ? "web" : "offline"}-${snapshot.turnCount}.json`);
      await fs.writeFile(artifact, JSON.stringify(snapshot, null, 2));
      await testInfo.attach(path.basename(artifact), { path: artifact, contentType: "application/json" });
      expect(snapshot.pendingRunDecision, "semantic admission must complete without an unexpected mode/clarification choice").toBeNull();
      const scopeEvidence = expectGlobalReadOnlyChatReply({ before, settled, interpretIntent });
      await fs.writeFile(path.join(telemetry.directory, `send-${sendId}-read-only-scope.json`), JSON.stringify(scopeEvidence, null, 2));
      const webEvidence = expectActualWebReadProviders(snapshot.aggregate, (page as any).__realOmlxWebInvocations);
      await fs.writeFile(path.join(telemetry.directory, `send-${sendId}-web-provider.json`), JSON.stringify(webEvidence, null, 2));
      expect(snapshot.aggregate.terminalOutcome.resultKind).toBe("success");
      expect(snapshot.finals).toHaveLength(1);
      expect(snapshot.finals[0].trim().length).toBeGreaterThan(0);
      expect(snapshot.session.title).not.toMatch(/^\s*[{[]|<think|<analysis/i);
      const terminalEvents = snapshot.aggregate.events.filter((event: any) => event.type === "run.completed" || event.type === "turn.completed" || (event.type === "projection.published" && event.projection.kind === "final"));
      expect(terminalEvents.map((event: any) => event.type)).toEqual(["run.completed", "projection.published", "turn.completed"]);
      return snapshot;
    };
    await page.evaluate(() => (window as any).__CODELY_E2E__.prepareReadOnlyChat(true, "bing"));
    // Keep the original live-finance query as a search capability diagnostic,
    // then Stop it. Live prices/financial answer quality are not a success gate.
    const marketText = "汇添富科创芯片ETF联接C（020629）今天上午的行情怎么样？";
    const marketBefore = await telemetry.capture("market-search-before", { text: marketText, interpretIntent: true }, true);
    const marketAck = await page.evaluate(text => (window as any).__CODELY_E2E__.sendReadOnlyMessage(text, true), marketText);
    await telemetry.capture("market-search-ack", { dispatchAcknowledgement: marketAck }, true);
    let searched: any = null;
    await expect.poll(async () => {
      const observed = await telemetry.capture("market-search-poll", { diagnostic: "search capability, not financial task success" });
      const current = observed.readOnly;
      expect(current.pendingRunDecision).toBeNull();
      const aggregate = current.aggregate;
      if (!aggregate) return false;
      const searches = aggregate.events.filter((event: any) => event.type === "command.scheduled" && event.command.payload.toolName === "web_search");
      const receipt = aggregate.events.find((event: any) => event.type === "tool.completed" && searches.some((entry: any) => entry.command.idempotencyKey === event.idempotencyKey));
      const call = receipt && ((page as any).__realOmlxWebInvocations as RealOmlxWebInvocation[]).find(entry =>
        entry.cmd === "web_search" && entry.commandKey === receipt.idempotencyKey && entry.status !== "pending");
      if (receipt && call) { searched = observed; return true; }
      if (aggregate.terminalOutcome) throw new Error("MARKET_SEARCH_DIAGNOSTIC_ENDED_WITHOUT_REAL_SEARCH_RECEIPT");
      return false;
    }, { timeout: Math.min(900_000, realOmlxExecutionTimeoutMs), intervals: [100] }).toBe(true);
    const marketScope = expectGlobalReadOnlyChatReply({ before: marketBefore, settled: searched, interpretIntent: true });
    const marketWeb = expectActualWebReadProviders(searched.readOnly.aggregate, (page as any).__realOmlxWebInvocations, false);
    expect(marketWeb.policy).toEqual({ enabled: true, provider: "bing" });
    expect(marketWeb.invocations.some(call => call.cmd === "web_search" && call.status !== "pending")).toBe(true);
    expect(searched.readOnly.aggregate.terminalOutcome, "the search diagnostic must still be live when Stop is pressed").toBeNull();
    await page.getByTestId("composer-stop-button").click();
    await expect.poll(async () => {
      const observed = await telemetry.capture("market-search-stop-poll");
      return observed.readOnly.aggregate?.terminalOutcome?.resultKind === "canceled" &&
        !observed.readOnly.isGenerating && observed.readOnly.agentStatus === "idle";
    }, { timeout: 60_000, intervals: [250] }).toBe(true);
    const stoppedMarket = await telemetry.capture("market-search-canceled", undefined, true);
    expectGlobalReadOnlyChatReply({ before: marketBefore, settled: stoppedMarket, interpretIntent: true });
    expect(stoppedMarket.readOnly.aggregate.run.identity).toEqual(searched.readOnly.aggregate.run.identity);
    expect(stoppedMarket.readOnly.finals).toHaveLength(1);
    expect(stoppedMarket.snapshot.runtimeV2.terminal.exactlyOnce).toBe(true);
    expect(stoppedMarket.readOnly.aggregate.events.filter((event: any) => event.type === "run.completed" || event.type === "turn.completed" ||
      (event.type === "projection.published" && event.projection.kind === "final")).map((event: any) => event.type))
      .toEqual(["run.completed", "projection.published", "turn.completed"]);
    await fs.writeFile(path.join(telemetry.directory, "market-search-capability-diagnostic.json"), JSON.stringify({
      purpose: "Original financial query: actual selected-provider search and user Stop; not financial task success",
      scope: marketScope, web: marketWeb, beforeStop: searched, canceled: stoppedMarket,
    }, null, 2));
    const web = await send("请联网搜索 MDN 的 structuredClone 文档，并打开 https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone ，说明 transfer 参数对原 ArrayBuffer 有什么影响。请给出来源链接。", true);
    // The exact source URL is supplied. A direct authorized fetch is a valid
    // evidence path; do not require a redundant discovery tool ceremony.
    expect(web.aggregate.events.some((event: any) => event.type === "tool.completed" && event.presentation?.toolName === "web_fetch" && event.status === "succeeded")).toBe(true);
    expect(web.finals[0]).toMatch(/developer\.mozilla\.org/);
    expect(web.finals[0]).toMatch(/detach|分离|byteLength|无法.{0,12}(?:访问|使用)|不可.{0,8}(?:访问|使用)/i);
    // The short natural continuation now refers to the completed stable MDN
    // task, independently of the canceled financial diagnostic.
    await send("继续", true);
    const followUp = await send("继续依据同一份 MDN 文档回答：如果没有传 transfer，只做普通 structuredClone，原 ArrayBuffer 是否仍然可用？请给来源链接。");
    expect(followUp.finals[0]).toMatch(/developer\.mozilla\.org/);
    expect(followUp.finals[0]).toMatch(/仍|依然|不会|可以|可用|remains|still|not detached/i);
    await page.evaluate(() => (window as any).__CODELY_E2E__.prepareReadOnlyChat(false));
    expectWebReads = false;
    await send("本轮我们讨论一个虚构项目，代号是青岚 742。请记住这个代号并简短回复。无需联网。");
    const ordinary = await send("刚才提到的虚构项目代号是什么？只回答代号。无需联网。");
    expect(ordinary.finals[0]).toMatch(/青岚\s*742/);
    expect(canonicalChatNetworkRead(ordinary.aggregate).enabled).toBe(false);
    expect(ordinary.aggregate.events.some((event: any) => event.type === "command.scheduled" && ["web_search", "web_fetch"].includes(event.command.payload.toolName))).toBe(false);

    await expectRealReadOnlyCancellation(page, testInfo);
    } catch (error) {
      await telemetry.recordFailure(error).catch(diagnosticError => {
        console.warn(`[real-omlx-chat-telemetry-error] ${String(diagnosticError)}`);
      });
      throw error;
    } finally {
      await fs.writeFile(path.join(telemetry.directory, "web-native-invocations.json"),
        JSON.stringify((page as any).__realOmlxWebInvocations || [], null, 2)).catch(diagnosticError => {
          console.warn(`[real-omlx-chat-telemetry-error] ${String(diagnosticError)}`);
        });
      await telemetry.finish().catch(diagnosticError => {
        console.warn(`[real-omlx-chat-telemetry-error] ${String(diagnosticError)}`);
      });
    }
  });

  test(`real OMLX Chat cancellation preserves its terminal with ${model}`, async ({ page }, testInfo) => {
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    await expect.poll(() => page.evaluate(() => !!(window as any).__CODELY_E2E__?.prepareReadOnlyChat)).toBe(true);
    await page.evaluate(() => (window as any).__CODELY_E2E__.prepareReadOnlyChat(false));
    await expectRealReadOnlyCancellation(page, testInfo);
  });

  test(`real OMLX Small-model file mentions and attachments preserve read-only scope with ${model}`, async ({ page }, testInfo) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    const attachment = path.join(workspace, "brief.txt");
    await fs.writeFile(attachment, "Project code: CEDAR-731.\nConfirmed decision: offline storage.\n");
    const before = await fingerprintPlanOnlyWorkspace(workspace);
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(({ mention, attachment }) => {
      const bridge = (window as any).__CODELY_E2E__;
      bridge.setRealInputContext([mention], [attachment]);
      void bridge.sendDirectEditMessage("请只读检查我提及的代码和附件。回答附件中的项目代号、已确认的存储选择，以及代码导出的函数名称。禁止修改文件或运行命令。");
    }, { mention: path.join(workspace, "src/hooks/useCsvParser.ts"), attachment });
    const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "small-model-source-context");
    expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
    const answer = snapshot.runtimeV2.projections.find((item: any) => item.audience === "final")?.markdown || "";
    expect(answer).toMatch(/CEDAR-731/);
    expect(answer).toMatch(/offline|离线/i);
    expect(answer).toContain("normalizeCsvOrder");
    expect(snapshot.runtimeV2.commands.some((command: any) => ["write_file", "replace_in_file", "apply_patch", "run_command"].includes(command.toolName))).toBe(false);
    expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(before);
  });

  test(`real OMLX first runtime request carries exact engine and locked package versions with ${model}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const workspace = (page as any).__realOmlxWorkspace as string;
    await fs.mkdir(path.join(workspace, "ProjectSettings"), { recursive: true });
    await fs.mkdir(path.join(workspace, "Packages"), { recursive: true });
    await fs.writeFile(path.join(workspace, "ProjectSettings/ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.62t16\nm_TuanjieEditorVersion: 1.10.4\n");
    const packageName = "com.unity.render-pipelines.universal";
    await fs.writeFile(path.join(workspace, "Packages/manifest.json"), JSON.stringify({ dependencies: { [packageName]: "14.2.0-t1" } }));
    await fs.writeFile(path.join(workspace, "Packages/packages-lock.json"), JSON.stringify({ dependencies: { [packageName]: { version: "14.2.0-t1" } } }));
    const before = await fingerprintPlanOnlyWorkspace(workspace);
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => {
      void (window as any).__CODELY_E2E__.sendDirectEditMessage(
        "只读核对当前项目的团结引擎、编辑器和 URP 版本，并按三行回答。不要修改工程或运行命令。",
      );
    });
    const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "engine-versions-wire");
    expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
    const firstRuntime = ((page as any).__realOmlxProviderWire as any[]).find(request => request.tools.length > 0);
    expect(firstRuntime?.engineVersionFacts).toEqual(expect.arrayContaining([
      expect.stringContaining('runtime="tuanjie"@"1.10.4"'),
      expect.stringContaining('runtime="unity"@"2022.3.62t16"'),
      expect.stringContaining('package="com.unity.render-pipelines.universal"@"14.2.0-t1"'),
    ]));
    const answer = snapshot.runtimeV2.projections.find((item: any) => item.audience === "final")?.markdown || "";
    for (const version of ["1.10.4", "2022.3.62t16", "14.2.0-t1"]) expect(answer).toContain(version);
    expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(before);
  });

  for (const [request, strategy] of [
    ["修复console窗口里的报错", "execute"],
    ["查看console窗口的报错", "analyze"],
  ] as const) {
    test(`real OMLX Console intent routes ${strategy} with ${model}`, async ({ page }, testInfo) => {
      const boundEditorUrl = String(process.env.REAL_OMLX_BOUND_EDITOR_MCP_URL || "").trim();
      test.skip(!!process.env.REAL_OMLX_WORKSPACE && (!boundEditorUrl || strategy !== "execute"), "The live repair requires an explicitly marked disposable Editor workspace.");
      test.setTimeout(300_000);
      const workspace = (page as any).__realOmlxWorkspace as string;
      const sourcePath = "Assets/ConsoleFixture.cs";
      const sourceFile = path.join(workspace, sourcePath);
      const brokenSource = "public static class ConsoleFixture\n{\n    public static int Read() => 42\n}\n";
      const editorVersion = "2022.3.62t16";
      const projectHash = createHash("sha1").update(`${workspace}/Assets`).digest("hex").slice(0, 16);
      const instanceId = `ConsoleFixture@${projectHash}`;
      const diagnostic = `${sourcePath}(3,35): error CS1002: ; expected`;
      const repairedMethod = /\b(?:Read\(\)\s*=>|return)\s*42\s*;/;
      const shaderPath = "Assets/ConsoleProbe.shader";
      const shaderFile = path.join(workspace, shaderPath);
      const missingInclude = "MAIN_MissingShaderFixture.hlsl";
      const shaderIsFixed = async (source: string) => source.includes("ENDCG") && (!source.includes(missingInclude) ||
        (await fs.stat(path.join(workspace, "Assets", missingInclude)).catch(() => null))?.isFile() === true);
      if (boundEditorUrl) {
        expect(process.env.REAL_OMLX_WORKSPACE).toBeTruthy();
        expect(new URL(boundEditorUrl).hostname).toBe("127.0.0.1");
        expect((await fs.readFile(path.join(workspace, ".main-unity-disposable"), "utf8")).trim()).toBe("isolated test workspace");
        const originalScript = await fs.readFile(sourceFile, "utf8");
        expect(originalScript).not.toMatch(repairedMethod);
        expect(await shaderIsFixed(await fs.readFile(shaderFile, "utf8"))).toBe(false);
        await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
        expect(await page.evaluate(async ({ request, url }) => {
          const host = window as any;
          const invoke = host.__TAURI_INTERNALS__.invoke;
          // The disposable Tuanjie project uses the bound MCP Editor route.
          host.__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => command === "unity_compile_project"
            ? Promise.resolve({ status: "unavailable", message: "UNITY_CLI_UNAVAILABLE: the disposable Editor uses MCP." }) : invoke(command, args);
          if (!(await host.__CODELY_E2E__.setRealMcpFixture(url, true))) return false;
          return host.__CODELY_E2E__.sendDirectEditMessage(request);
        }, { request, url: boundEditorUrl })).toBe(true);
        const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "console-live-editor");
        expect(snapshot.runtimeV2.strategy).toBe("execute");
        expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
        const firstConsole = snapshot.runtimeV2.events.find((event: any) => event.editorConsole);
        expect(firstConsole.editorConsole.complete).toBe(true);
        expect(firstConsole.editorConsole.diagnostics.map((item: any) => item.kind)).toEqual(expect.arrayContaining(["csharp", "shader_import"]));
        const ledger = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot().aggregate);
        const checks = ledger.events.filter((event: any) => event.type === "tool.completed" && event.modelContent &&
          event.presentation?.toolName && ["unity_compile_project", "unity_import_shader"].includes(event.presentation.toolName))
          .map((event: any) => JSON.parse(event.modelContent)).filter((result: any) => result.status === "passed");
        for (const kind of ["csharp", "shader_import"]) {
          const receipt = checks.find((result: any) => result.kind === kind);
          expect(receipt).toMatchObject({ editor: "connected", editorVersion, editorInstanceId: firstConsole.editorConsole.instanceId });
          for (const file of receipt.targets) {
            expect(file.version).toBe(`sha256-${createHash("sha256").update(await fs.readFile(path.join(workspace, file.path))).digest("hex")}`);
          }
        }
        expect(await fs.readFile(sourceFile, "utf8")).toMatch(repairedMethod);
        expect(await shaderIsFixed(await fs.readFile(shaderFile, "utf8"))).toBe(true);
        return;
      }
      const shader = `Shader "Fixture/ConsoleProbe" {
  SubShader { Pass {
    CGPROGRAM
    #pragma vertex vert
    #pragma fragment frag
    #include "${missingInclude}"
    float4 vert(float4 position : POSITION) : SV_POSITION { return position; }
    float4 frag() : SV_Target { return float4(1, 0, 0, 1); }
    ENDCG
  } }
}`;
      await fs.mkdir(path.dirname(sourceFile));
      await fs.writeFile(sourceFile, brokenSource);
      if (strategy === "execute") await fs.writeFile(shaderFile, shader);
      await fs.mkdir(path.join(workspace, "ProjectSettings"));
      await fs.writeFile(path.join(workspace, "ProjectSettings/ProjectVersion.txt"),
        `m_EditorVersion: ${editorVersion}\nm_TuanjieEditorVersion: 1.10.4\n`);
      await fs.mkdir(path.join(workspace, "Packages"), { recursive: true });
      await fs.writeFile(path.join(workspace, "Packages/packages-lock.json"), JSON.stringify({ dependencies: {
        "com.unity.render-pipelines.universal": { version: "14.2.0-t1" },
      } }));
      await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "console-intent-fixture", private: true }));
      const before = await fingerprintPlanOnlyWorkspace(workspace);

      let consoleReads = 0;
      let selectedInstance: string | undefined;
      const server = createServer(async (incoming, response) => {
        let body = "";
        for await (const chunk of incoming) body += chunk;
        const rpc = JSON.parse(body || "{}");
        response.setHeader("content-type", "application/json");
        response.setHeader("mcp-session-id", "console-fixture-session");
        if (rpc.id == null) { response.writeHead(202); response.end(); return; }
        let result: object;
        if (rpc.method === "initialize") {
          result = { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "mcp-for-unity-server", version: "1" } };
        } else if (rpc.method === "tools/list") {
          result = { tools: ["read_console", "set_active_instance"].map(name => ({ name, inputSchema: { type: "object", properties: {} } })) };
        } else if (rpc.method === "resources/read" && rpc.params?.uri === "mcpforunity://instances") {
          result = { contents: [{ text: JSON.stringify({ success: true, instances: [{ id: instanceId, hash: projectHash, unity_version: editorVersion }] }) }] };
        } else if (rpc.method === "tools/call" && rpc.params?.name === "set_active_instance") {
          selectedInstance = rpc.params.arguments?.instance;
          result = { structuredContent: { success: selectedInstance === instanceId, data: { instance: selectedInstance } } };
        } else if (rpc.method === "tools/call" && rpc.params?.name === "read_console" && selectedInstance === instanceId &&
          rpc.params.arguments?.action === "get" && rpc.params.arguments?.format === "json") {
          consoleReads++;
          const source = await fs.readFile(sourceFile, "utf8");
          const entries = repairedMethod.test(source) ? [] : [{ type: "Error", file: sourcePath, line: 3, message: diagnostic }];
          if (strategy === "execute" && !(await shaderIsFixed(await fs.readFile(shaderFile, "utf8")))) {
            entries.push({ type: "Error", file: shaderPath, line: 6,
              message: `Shader error in 'Fixture/ConsoleProbe': Couldn't open include file '${missingInclude}' at ${shaderPath}(6)` });
          }
          const data = rpc.params.arguments?.page_size
            ? { items: entries, cursor: 0, total: entries.length, truncated: false } : entries;
          const log = { success: true, message: `Retrieved ${entries.length} log entries.`, data };
          result = { content: [{ type: "text", text: JSON.stringify(log) }], structuredContent: log };
        } else {
          response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unsupported fixture request" } }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const compileChecks: Array<{ workspace: string; checkKind: string; targets: string[]; expectedVersions: Record<string, string>; shaderImportTargets?: string[] }> = [];
        await page.exposeFunction("__MAIN_E2E_CONSOLE_FIXTURE_COMPILE", async (args: typeof compileChecks[number]) => {
          compileChecks.push(args);
          const isShader = args.checkKind === "shader_import";
          const source = await fs.readFile(isShader ? shaderFile : sourceFile, "utf8");
          const versions = await Promise.all(args.targets.map(async target => ({ path: target,
            version: `sha256-${createHash("sha256").update(await fs.readFile(path.join(workspace, target))).digest("hex")}`,
          })));
          const fixed = isShader ? args.shaderImportTargets?.includes(shaderPath) && await shaderIsFixed(source) : repairedMethod.test(source);
          return { status: fixed ? "passed" : "failed", editor: "connected", editorPid: 4312, editorVersion,
            editorInstanceId: instanceId, kind: args.checkKind, targets: versions, importedPaths: args.shaderImportTargets,
            errorCount: fixed ? 0 : 1, diagnostics: fixed ? [] : [{ file: isShader ? shaderPath : sourcePath,
              line: isShader ? 6 : 3, column: 0, code: isShader ? "SHADER_IMPORT" : "CS1002", message: isShader ? missingInclude : diagnostic }] };
        });
        const { port } = server.address() as { port: number };
        await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
        expect(await page.evaluate(async ({ request, url }) => {
          const host = window as any;
          const bridge = host.__CODELY_E2E__;
          const invoke = host.__TAURI_INTERNALS__.invoke;
          host.__TAURI_INTERNALS__.invoke = (cmd: string, args?: { command?: string }) => {
            if (cmd === "unity_compile_project") return host.__MAIN_E2E_CONSOLE_FIXTURE_COMPILE(args);
            return invoke(cmd, args);
          };
          await bridge.setRealMcpFixture(url);
          return await bridge.sendDirectEditMessage(request);
        }, { request, url: `http://127.0.0.1:${port}/mcp` })).toBe(true);

        const readStrategy = () => page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot().runtimeV2?.strategy ?? null);
        await expect.poll(readStrategy, { timeout: 30_000 }).not.toBeNull();
        expect(await readStrategy()).toBe(strategy);
        const snapshot = await expectRealWorkspaceTerminal(page, testInfo, `console-${strategy}`);
        expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
        expect(consoleReads).toBeGreaterThan(0);
        expect(realWorkspaceToolSucceeded(snapshot, "unity_mcp_console")).toBe(true);
        const { commands, events, evidence, projections } = snapshot.runtimeV2;
        const mutations = events.filter((event: any) => event.type === "tool.completed" &&
          event.evidence?.some((item: any) => item.kind === "mutation"));
        if (strategy === "execute") {
          const consoleKey = commands.find((command: any) => command.toolName === "unity_mcp_console").idempotencyKey;
          const consoleReceipt = events.find((event: any) => event.type === "tool.completed" && event.idempotencyKey === consoleKey);
          expect(mutations[0]?.sequence).toBeGreaterThan(consoleReceipt.sequence);
          const version = `sha256-${createHash("sha256").update(await fs.readFile(sourceFile)).digest("hex")}`;
          const shaderVersion = `sha256-${createHash("sha256").update(await fs.readFile(shaderFile)).digest("hex")}`;
          expect(compileChecks).toEqual(expect.arrayContaining([
            expect.objectContaining({ workspace, checkKind: "csharp", targets: [sourcePath], expectedVersions: { [sourcePath]: version } }),
            expect.objectContaining({ workspace, checkKind: "shader_import", targets: expect.arrayContaining([shaderPath]),
              shaderImportTargets: [shaderPath], expectedVersions: expect.objectContaining({ [shaderPath]: shaderVersion }) }),
          ]));
          expect(realWorkspaceToolSucceeded(snapshot, "unity_compile_project")).toBe(true);
          expect(consoleReceipt.effectKind).toBe("observation");
          expect(events.filter((event: any) => event.type === "turn.completed")).toHaveLength(1);
          expect(projections.find((item: any) => item.audience === "final")?.markdown).toContain("Shader 导入通过");
        } else {
          expect(projections.find((item: any) => item.audience === "final")?.markdown).toContain("CS1002");
          const isEffect = (name: string) => isWorkspaceMutationToolName(name) || name === "run_command";
          expect(commands.some((command: any) => isEffect(command.toolName))).toBe(false);
          expect(((page as any).__realOmlxProviderWire as Array<{ tools: string[] }>).some(wire => wire.tools.some(isEffect))).toBe(false);
          expect(evidence.some((item: any) => item.kind === "mutation")).toBe(false);
          expect(compileChecks).toHaveLength(0);
          expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(before);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }

  test(`real OMLX Small-model XML fallback reads actual workspace source with ${model}`, async ({ page }, testInfo) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    const before = await fingerprintPlanOnlyWorkspace(workspace);
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => {
      const bridge = (window as any).__CODELY_E2E__;
      bridge.setRealToolProtocol("xml");
      void bridge.sendDirectEditMessage("请只读检查 src/hooks/useCsvParser.ts，回答它导出的函数名。必须读取实际文件，不要修改文件或运行命令。");
    });
    const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "small-model-xml");
    expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
    expect(realWorkspaceToolSucceeded(snapshot, "read_file")).toBe(true);
    expect(snapshot.runtimeV2.projections.find((item: any) => item.audience === "final")?.markdown).toContain("normalizeCsvOrder");
    expect(snapshot.runtimeV2.commands.some((command: any) => isWorkspaceMutationToolName(command.toolName) || command.toolName === "run_command")).toBe(false);
    const wire = (page as any).__realOmlxProviderWire as any[];
    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((request) => request.tools.length === 0)).toBe(true);
    await fs.writeFile(testInfo.outputPath("xml-provider-wire.json"), JSON.stringify(wire, null, 2));
    expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(before);
  });

  test(`real OMLX Small-model image input reaches the vision model with ${model}`, async ({ page }, testInfo) => {
    test.skip(!realOmlxImagePath, "Supply the deterministic red-square/blue-circle image through REAL_OMLX_IMAGE_PATH.");
    const images = await loadRealOmlxReplayImages();
    const workspace = (page as any).__realOmlxWorkspace as string;
    const before = await fingerprintPlanOnlyWorkspace(workspace);
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(({ images }) => {
      void (window as any).__CODELY_E2E__.sendDirectEditMessage("请只描述附图中左边与右边图形的形状和颜色。不要读取工作区、修改文件或运行命令。", images);
    }, { images });
    const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "small-model-image");
    expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
    const answer = snapshot.runtimeV2.projections.find((item: any) => item.audience === "final")?.markdown || "";
    expect(answer).toMatch(/红|red/i);
    expect(answer).toMatch(/蓝|blue/i);
    expect(answer).toMatch(/方|square/i);
    expect(answer).toMatch(/圆|circle/i);
    expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(before);
  });

  test(`real OMLX Small-model loads instruction Skills on demand with ${model}`, async ({ page }, testInfo) => {
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => {
      const bridge = (window as any).__CODELY_E2E__;
      bridge.setRealInstructionSkills([{ id: "fixture-review", name: "fixture-review", desc: "Review the CSV creator field contract using the fixture review process.", content: "Read src/hooks/useCsvParser.ts. Report whether creatorName is returned. Include the exact completion marker REVIEW-PINE-864 in your final answer. Do not modify files or run commands.", type: "instruction", active: true }]);
      void bridge.sendDirectEditMessage("请使用 fixture-review 技能检查当前 CSV creator 映射，按技能要求回复。不要修改文件或运行命令。");
    });
    const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "small-model-skill");
    expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
    expect(realWorkspaceToolSucceeded(snapshot, "load_skill")).toBe(true);
    expect(snapshot.runtimeV2.projections.find((item: any) => item.audience === "final")?.markdown).toContain("REVIEW-PINE-864");
  });

  test(`real OMLX Small-model discovers and calls a local MCP tool with ${model}`, async ({ page }, testInfo) => {
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body || "{}");
      requests.push(rpc);
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "fixture-session");
      if (rpc.id == null) { response.writeHead(202); response.end(); return; }
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : rpc.method === "tools/list"
        ? { tools: [{ name: "read_fixture_fact", description: "Read the test fixture token from the MCP service.", inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "text", text: "MCP_FIXTURE_TOKEN: PINE-864" }], isError: false };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
      await page.evaluate(async (url) => {
        const bridge = (window as any).__CODELY_E2E__;
        await bridge.setRealMcpFixture(url);
        void bridge.sendDirectEditMessage("请先调用 tool_search 查询 read_fixture_fact，再调用 fixture MCP 的这个工具。只返回服务实际给出的 token。");
      }, `http://127.0.0.1:${address.port}/mcp`);
      const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "small-model-mcp", true);
      expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
      expect(requests.some(rpc => rpc.method === "initialize")).toBe(true);
      expect(requests.some(rpc => rpc.method === "tools/list")).toBe(true);
      expect(requests.some(rpc => rpc.method === "tools/call" && rpc.params?.name === "read_fixture_fact")).toBe(true);
      expect(realWorkspaceToolSucceeded(snapshot, "tool_search")).toBe(true);
      expect(snapshot.runtimeV2.projections.find((item: any) => item.audience === "final")?.markdown).toContain("PINE-864");
      await fs.writeFile(testInfo.outputPath("small-model-mcp-wire.json"), JSON.stringify(requests, null, 2));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  for (const exactDiscovery of [false, true]) {
  test(`real OMLX Small-model Plan discovers authorized web tools before review${exactDiscovery ? " using an exact discovery query" : ""} with ${model}`, async ({ page }, testInfo) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    await fs.writeFile(path.join(workspace, "README.md"), "# Fixture\n\nThis document will be updated only after plan approval.\n");
    const before = await fingerprintPlanOnlyWorkspace(workspace);
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    await page.getByTestId("composer-web-search-toggle").click();
    await expect(page.getByTestId("composer-web-search-toggle")).toHaveAttribute("aria-pressed", "true");
    const prompt = (exactDiscovery ? "请先调用 tool_search，query 使用 web_fetch，展开后再调用网页抓取工具。计划中的验证可描述批准后执行的有限命令，本轮不要实际执行。" : "") + "请先读取 README.md，再使用 web_fetch 打开 https://example.com/ 获取实际页面标题；如果工具未显示，先用 tool_search 查找。根据这两项证据生成更新 README.md 的可审批计划，正文注明来源 URL 和实际标题。不要修改文件、运行命令或批准计划。";
    await page.evaluate((text) => void (window as any).__CODELY_E2E__.sendCloudMessage(text), prompt);
    await settleVisiblePlanInterview(page, testInfo, "executable", {
      label: exactDiscovery ? "plan-web-exact-executable-interview" : "plan-web-executable-interview",
      timeoutMs: 180_000,
    });
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
      return snapshot.runtimeV2?.phase === "reviewing" || !!snapshot.runtimeV2?.terminalOutcome;
    }, { timeout: 180_000, intervals: [500] }).toBe(true);
    const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
    await fs.writeFile(testInfo.outputPath("small-model-plan-web.json"), JSON.stringify(snapshot, null, 2));
    expect(snapshot.runtimeV2.phase).toBe("reviewing");
    expect(snapshot.runtimeV2.sealedWorkPlan).not.toBeNull();
    const aggregate = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot().aggregate);
    expect(aggregate.turn.turnId).toBe(snapshot.currentTurnId);
    const admittedAt = aggregate.events.find((event: any) => event.type === "turn.admitted")?.at;
    expect(Number.isFinite(admittedAt)).toBe(true);
    const wire = (page as any).__realOmlxProviderWire as any[];
    const firstRuntimeRequest = wire.find(entry => Date.parse(entry.at) >= admittedAt);
    expect(firstRuntimeRequest, "the first request after the exact Turn admission must be recorded").toBeTruthy();
    expect(Array.isArray(firstRuntimeRequest.tools)).toBe(true);
    // The conditional prompt permits direct use when the first real Runtime
    // request already offers web_fetch. The exact-discovery prompt requires
    // tool_search independently of that visibility.
    const requiresDiscovery = exactDiscovery || !firstRuntimeRequest.tools.includes("web_fetch");
    const toolSearchSucceeded = realWorkspaceToolSucceeded(snapshot, "tool_search");
    await fs.writeFile(testInfo.outputPath("plan-web-tool-visibility.json"), JSON.stringify({
      turnId: aggregate.turn.turnId, admittedAt, firstRuntimeRequest, exactDiscovery, requiresDiscovery, toolSearchSucceeded,
    }, null, 2));
    if (requiresDiscovery) expect(toolSearchSucceeded).toBe(true);
    expect(realWorkspaceToolSucceeded(snapshot, "web_fetch")).toBe(true);
    expect(JSON.stringify(snapshot.runtimeV2.sealedWorkPlan)).toMatch(/Example Domain/i);
    expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(before);
    await page.evaluate(() => (window as any).__CODELY_E2E__.stopGeneration());
    const canceled = await expectRealWorkspaceTerminal(page, testInfo, "small-model-plan-web-canceled");
    expect(canceled.runtimeV2.terminalOutcome.resultKind).toBe("canceled");
  });
  }

  for (const decision of ["approve", "deny"] as const) {
    test(`real OMLX Small-model preserves per-call review ${decision} with ${model}`, async ({ page }, testInfo) => {
      await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
      await page.evaluate(() => void (window as any).__CODELY_E2E__.sendDirectEditMessage("请运行 node -e \"console.log('REVIEW-864')\"。每次命令执行前必须等待我单独审批，即使自动批准已开启也一样。不要修改文件。"));
      await expect.poll(async () => {
        const snapshot = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
        return snapshot.activeActionRequest?.kind === "tool_permission";
      }, { timeout: 90_000 }).toBe(true);
      const pending = await page.evaluate(() => (window as any).__CODELY_E2E__.getSnapshot());
      expect(pending.runtimeV2.terminalOutcome).toBeNull();
      expect(realWorkspaceToolSucceeded(pending, "run_command")).toBe(false);
      await page.evaluate((decision) => {
        const bridge = (window as any).__CODELY_E2E__;
        if (decision === "approve") bridge.approvePendingTool(); else bridge.rejectPendingTool();
      }, decision);
      const snapshot = await expectRealWorkspaceTerminal(page, testInfo, `small-model-review-${decision}`);
      expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe(decision === "approve" ? "success" : "blocked");
      expect(realWorkspaceToolSucceeded(snapshot, "run_command")).toBe(decision === "approve");
    });
  }
}

async function settleVisiblePlanInterview(
  page: Page,
  testInfo: TestInfo,
  resultKind: "document" | "executable" = "document",
  options: { label?: string; timeoutMs?: number; ready?: (snapshot: any) => boolean; textAnswer?: string;
    selectChoice?: (question: { id: string; prompt: string; options: Array<{ id: string; label: string }> }) => number;
    answerText?: (question: { id: string; prompt: string }) => string | null } = {},
) {
  const answered = new Map<string, { requestId: string; revision: number }>();
  let owner: { sessionKey: string; turnId: string; runId: string } | undefined;
  let final: any;
  let canonicalEvents: any[] = [];
  try {
    await expect.poll(async () => {
      const observed = await page.evaluate(() => {
        const bridge = (window as any).__CODELY_E2E__;
        return {
          request: bridge.structuredChoiceSnapshot(),
          snapshot: bridge.getSnapshot(),
          aggregate: bridge.readOnlySnapshot().aggregate,
        };
      });
      const request = observed.request;
      final = { ...observed.snapshot, activeActionRequest: observed.request };
      canonicalEvents = observed.aggregate?.events || [];
      await fs.writeFile(testInfo.outputPath(`${options.label || "product-plan-runtime"}-latest.json`),
        JSON.stringify({ snapshot: final, aggregate: observed.aggregate }, null, 2));
      if (request?.kind === "user_choice" && request.status === "pending" && !request.questionnaire) {
        const blocker = observed.aggregate?.run?.blocker;
        throw new Error(`UNEXPECTED_PLAN_BLOCKER: ${JSON.stringify({
          requestId: request.requestId, blockerKind: blocker?.reasonCode || request.kind,
          clarificationKind: blocker?.clarification?.kind || null, title: request.title,
        })}`);
      }
      // The public snapshot intentionally projects event fields. Read the same
      // canonical ledger for typed answers/modelContent without changing it.
      if (final.runtimeV2 && observed.aggregate) {
        expect(observed.aggregate.turn.turnId).toBe(final.runtimeV2.turnId);
        const raw = new Map(canonicalEvents.map((event: any) => [event.eventId, event]));
        final = { ...final, runtimeV2: { ...final.runtimeV2,
          events: (final.runtimeV2.events || []).map((event: any) => ({ ...raw.get(event.eventId), ...event })),
        } };
      }
      if (final.dispatchError) throw new Error(final.dispatchError);
      if (owner) {
        expect(final.currentTurnId).toBe(owner.turnId);
        expect(final.runtimeV2?.runId).toBe(owner.runId);
      }
      const key = `${request?.requestId}:${request?.questionnaire?.revision}`;
      if (request?.kind === "user_choice" && request.questionnaire && !answered.has(key)) {
        expect(["plan_confirmation", "plan_interview", "rules_interview"]).toContain(request.questionnaire.purpose);
        owner ||= { sessionKey: request.sessionKey, turnId: request.turnId, runId: request.runId };
        expect(request.sessionKey).toBe(owner.sessionKey);
        expect(request.turnId).toBe(owner.turnId);
        expect(request.runId).toBe(owner.runId);
        const form = page.getByTestId("structured-user-questionnaire").last();
        await expect(form).toBeVisible();
        for (let index = 0; index < request.questionnaire.questions.length; index++) {
          const question = request.questionnaire.questions[index];
          const field = form.locator("fieldset").nth(index);
          const choices = question.options || [];
          if (question.selectionMode === "text" && options.answerText) {
            const answer = options.answerText(question);
            if (answer !== null) {
              await field.locator("textarea").fill(answer);
              continue;
            }
          }
          if (options.selectChoice) {
            const selected = options.selectChoice(question);
            if (question.selectionMode !== "single" || selected < 0) {
              throw new Error(`UNRECORDED_BREAKOUT_DECISION: ${JSON.stringify({ id: question.id, prompt: question.prompt, choices })}`);
            }
            await field.getByRole("radio").nth(selected).check();
            continue;
          }
          if (question.selectionMode === "text") {
            await field.locator("textarea").fill(options.textAnswer || "目标、边界和验收采用原请求中已明确的内容；没有额外限制，请采用题目中提供的推荐方案。");
          } else if (choices.length) {
            if (question.selectionMode === "single") {
              const selected = question.id === "result_kind" ? choices.findIndex((choice: any) => choice.id === resultKind) : 0;
              expect(selected, `required result_kind ${resultKind} must be offered by the actual questionnaire`).toBeGreaterThanOrEqual(0);
              await field.getByRole("radio").nth(selected).check();
            } else {
              const minimum = Math.max(Number(question.minSelections) || 0, question.required ? 1 : 0);
              const maximum = question.maxSelections ?? choices.length;
              const count = Math.min(maximum, Math.max(minimum, 1));
              expect(count).toBeGreaterThanOrEqual(minimum);
              for (let optionIndex = 0; optionIndex < count; optionIndex++) await field.getByRole("checkbox").nth(optionIndex).check();
              if (!count && question.required && question.allowText) await field.locator("textarea").fill("保留原请求约束，采用推荐方案。");
            }
          } else if (question.allowText) await field.locator("textarea").fill("保留原请求约束，采用推荐方案。");
        }
        answered.set(key, { requestId: request.requestId, revision: request.questionnaire.revision });
        await form.getByRole("button", { name: "确认并继续", exact: true }).click();
        return false;
      }
      const decisions = canonicalEvents.filter((event: any) => event.type === "run.decision_recorded" && event.answer);
      const executableConfirmed = decisions.some((event: any) => event.answer.answers.some((answer: any) =>
        answer.questionId === "result_kind" && answer.selectedValues.includes("executable")
      ));
      if (options.ready && answered.size > 0 && executableConfirmed && options.ready(final)) return true;
      if (resultKind === "executable") {
        if (final.runtimeV2?.terminalOutcome && !final.isGenerating) throw new Error(`Executable Plan ended before review: ${JSON.stringify(final.runtimeV2.terminalOutcome)}`);
        return answered.size > 0 && executableConfirmed && request?.kind === "plan_review" &&
          final.runtimeV2?.phase === "reviewing" && final.runtimeV2?.workPlan?.status === "pending_review" &&
          !!final.runtimeV2?.planReviewCommit && !final.isGenerating && final.agentStatus === "pending_review";
      }
      return !!final.runtimeV2?.terminalOutcome && !final.isGenerating;
    }, { timeout: options.timeoutMs ?? 360_000, intervals: [500] }).toBe(true);
    expect(answered.size, "every new Plan must obtain at least one real user decision").toBeGreaterThan(0);
    for (const answer of answered.values()) {
      const accepted = canonicalEvents.find((event: any) => event.type === "run.decision_recorded" &&
        event.requestId === answer.requestId && event.answer?.revision === answer.revision);
      expect(accepted, "the actual UI answer must be durably accepted by its exact owner").toBeTruthy();
      expect(accepted.run.runId).toBe(owner?.runId);
      expect(canonicalEvents.some((event: any) => event.type === "run.resumed" && event.requestId === answer.requestId && event.run.runId === owner?.runId)).toBe(true);
    }
    expect(canonicalEvents.some((event: any) => event.type === "work_plan.approved"), "interview answers do not approve execution").toBe(false);
    return final;
  } finally {
    await fs.writeFile(testInfo.outputPath(`${options.label || "product-plan-runtime"}.json`), JSON.stringify({ answeredRequests: [...answered.values()], owner, snapshot: final, canonicalEvents }, null, 2));
  }
}

for (const model of models) {
  test(`real OMLX Breakout incident Plan reaches exact review with ${model}`, async ({ page }, testInfo) => {
    test.skip(realOmlxFixture !== "unity" || !process.env.REAL_OMLX_WORKSPACE,
      "Requires a caller-prepared copy of the original Unity project");
    test.setTimeout(realOmlxPlanTimeoutMs + 120_000);
    const workspace = (page as any).__realOmlxWorkspace as string;
    const before = await fingerprintPlanOnlyWorkspace(workspace);
    const replayedDecisionIds = new Set<string>();
    let restatedLegacyRequirement = false;
    const choices = [
      { id: "unity_pipeline", label: /Unity Editor.*(?:自动|验证)|Unity.*(?:自动化|测试运行器)|(?:自动化|编译).*Play\s*Mode/i },
      { id: "reuse_existing", label: /(?:现有|复用|沿用|使用).*CollectorTest|CollectorTest.*(?:搭建|改造|复用)/i },
      { id: "angle_control", label: /角度控制|反弹角度|接触位置|命中位置/ },
      { id: "executable", label: /可审[核阅].*实施计划/ },
    ];
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    if (breakoutResumeSessionId > 0) {
      expect(breakoutReplayConfirmation).toBe(true);
      const loaded = await invokeRuntimeToolBridge(workspace, "load_project_session", { sessionId: breakoutResumeSessionId });
      const runtime = loaded.runtimeSnapshot;
      const stored = normalizeRuntimeV2Checkpoint(runtime.runtimeV2Checkpoints[runtime.currentTurnId]);
      expect(stored?.aggregate.run?.blocker?.reasonCode).toBe("user_questionnaire");
      const priorOwner = stored!.aggregate.run!.identity;
      const priorRequestId = stored!.aggregate.run!.blocker!.requestId;
      await page.getByTestId("sidebar-add-workspace").click();
      await expect.poll(() => page.evaluate(() => {
        const bridge = (window as any).__CODELY_E2E__;
        const aggregate = bridge?.readOnlySnapshot?.().aggregate;
        return {
          owner: aggregate?.run?.identity,
          blocker: aggregate?.run?.blocker?.reasonCode,
          sessionId: bridge?.getSnapshot?.().currentSessionId,
          visibleRequestId: bridge?.structuredChoiceSnapshot?.()?.requestId,
        };
      }), { timeout: 30_000 }).toEqual({
        owner: priorOwner, blocker: "user_questionnaire", sessionId: breakoutResumeSessionId,
        visibleRequestId: priorRequestId,
      });
      expect((page as any).__realOmlxProviderWire).toHaveLength(0);
      await fs.writeFile(testInfo.outputPath("breakout-restored-owner.json"), JSON.stringify({
        sessionId: breakoutResumeSessionId, owner: priorOwner, requestId: priorRequestId, revision: loaded.storageRevision,
      }, null, 2));
    } else {
      const composer = page.getByTestId("composer-textarea");
      await composer.fill(`/计划 ${breakoutTask}`);
      await composer.press("Enter");
    }
    let snapshot;
    try {
      snapshot = await settleVisiblePlanInterview(page, testInfo, "executable", {
        label: "breakout-incident", timeoutMs: realOmlxPlanTimeoutMs,
        answerText: question => {
          if (!breakoutReplayConfirmation || restatedLegacyRequirement || question.prompt !== breakoutLegacyClarifier) return null;
          restatedLegacyRequirement = true;
          return breakoutLegacyRestatement;
        },
        selectChoice: question => {
          if (breakoutReplayConfirmation) {
            if (replayedDecisionIds.has(question.id)) return -1;
            const original = breakoutConfirmation.arguments.questions.find(item => item.id === question.id);
            if (question.id !== "result_kind" && original?.prompt !== question.prompt) return -1;
            const index = question.options.findIndex(option => option.id === breakoutConfirmation.answers[question.id]);
            if (index >= 0) replayedDecisionIds.add(question.id);
            return index;
          }
          const exact = question.options.findIndex(option => choices.some(choice => option.id === choice.id));
          return exact >= 0 ? exact : question.options.findIndex(option => choices.some(choice => choice.label.test(option.label)));
        },
      });
    } finally {
      const wire = (page as any).__realOmlxProviderWire || [];
      await fs.writeFile(testInfo.outputPath("breakout-wire.json"), JSON.stringify(wire.map(({ selectedKnowledgeAnchors, ...entry }: any) => entry), null, 2));
    }
    if (breakoutReplayConfirmation) {
      const wire = (page as any).__realOmlxProviderWire;
      if (breakoutResumeSessionId > 0) {
        expect(restatedLegacyRequirement).toBe(true);
        expect(wire.length).toBeGreaterThan(0);
        expect(wire.every((request: any) => request.responseOrigin === "real_omlx")).toBe(true);
      } else {
        expect([...replayedDecisionIds].sort()).toEqual(Object.keys(breakoutConfirmation.answers).sort());
        const recorded = wire.findIndex((request: any) => request.responseOrigin === "recorded_breakout_confirmation");
        expect(recorded).toBeGreaterThanOrEqual(0);
        expect(wire.filter((request: any) => request.responseOrigin === "recorded_breakout_confirmation")).toHaveLength(1);
        expect(wire.slice(recorded + 1).length).toBeGreaterThan(0);
        expect(wire.slice(recorded + 1).every((request: any) => request.responseOrigin === "real_omlx")).toBe(true);
      }
    }
    const observed = await page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/index.ts");
      const { resolvePlanDocumentFromAggregate } = await import("/src/lib/planDocumentRecords.ts");
      const state = useAppStore.getState();
      const aggregate = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[state.currentTurnId!])!.aggregate;
      return { aggregate, sessionId: state.currentSessionId, document: resolvePlanDocumentFromAggregate(aggregate) };
    });
    expect(observed.document).toBeTruthy();
    const content = await page.evaluate(reference => (window as any).__MAIN_E2E_NATIVE_TOOL("read_plan_document", { reference }), observed.document!.documentRef);
    expect(await fs.readFile(content.path, "utf8")).toBe(content.markdown);
    expect(content.contentHash).toBe(createHash("sha256").update(content.markdown).digest("hex"));
    expect(content.markdown).toMatch(/CollectorTest/);
    expect(content.markdown).toMatch(/(?:砖块|brick).{0,36}(?:分数|计分|得分|score)|(?:分数|计分|得分|score).{0,36}(?:砖块|brick)/i);
    expect(content.markdown).toMatch(/(?:挡板|paddle).{0,60}(?:角度|angle)|(?:角度|angle).{0,60}(?:挡板|paddle)/i);
    const events = observed.aggregate.events;
    if (breakoutReplayConfirmation) {
      const answers = events.flatMap(event => event.type === "run.decision_recorded" && event.answer ? event.answer.answers : []);
      const decisions = answers.filter(answer => !answer.text).map(answer => [answer.questionId, answer.selectedValues]);
      expect(Object.fromEntries(decisions)).toEqual(Object.fromEntries(
        Object.entries(breakoutConfirmation.answers).map(([questionId, selection]) => [questionId, [selection]])));
      expect(answers.flatMap(answer => answer.text ? [answer.text] : [])).toEqual(restatedLegacyRequirement ? [breakoutLegacyRestatement] : []);
    }
    expect(events.filter(event => event.type === "run.started")).toHaveLength(1);
    expect(events.filter(event => event.type === "work_plan.sealed")).toHaveLength(1);
    expect(events.some(event => event.type === "work_plan.approved" || event.type === "turn.completed")).toBe(false);
    expect(events.some(event => event.type === "command.scheduled" && event.command.kind === "execute_tool" &&
      /^(?:run_command|write_file|replace_in_file)$/.test(String(event.command.payload.toolName)))).toBe(false);
    const requiredBehavior = observed.aggregate.sealedWorkPlan!.draft.validations.filter(check =>
      check.required && (check.kind === "desktop" || check.kind === "browser" || (
        check.kind === "finite_command" && analyzeValidationCommand(check.command || "", { cwd: check.cwd }).spec?.segments.some(segment =>
          segment.capability === "test" || segment.capability === "inline_assertion"))));
    expect(requiredBehavior.length).toBeGreaterThan(0);
    expect(requiredBehavior.flatMap(check => check.criterionIds)).toEqual(
      expect.arrayContaining(observed.aggregate.objective.acceptanceCriterionIds || []));
    expect(snapshot.activeActionRequest.kind).toBe("plan_review");
    expect(await fingerprintPlanOnlyWorkspace(workspace)).toBe(before);
    await expect(page.getByRole("button", { name: "审阅并批准", exact: true }).first()).toBeVisible();
    await expect.poll(async () => {
      const saved = await invokeRuntimeToolBridge(workspace, "load_project_session", { sessionId: observed.sessionId });
      return normalizeRuntimeV2Checkpoint(saved?.runtimeSnapshot?.runtimeV2Checkpoints?.[observed.aggregate.turn.turnId],
        observed.aggregate.turn)?.aggregate.planReviewCommit?.artifact.documentRef.contentHash;
    }, { timeout: 15_000 }).toBe(observed.document!.documentRef.contentHash);
    await page.screenshot({ path: testInfo.outputPath("breakout-review.png"), fullPage: true });
  });

  test(`real OMLX Collector Plan completes validation and reaches exact review with ${model}`, async ({ page }, testInfo) => {
    test.skip(realOmlxFixture !== "unity");
    test.setTimeout(realOmlxPlanTimeoutMs + 120_000);
    const useUnitySkill = (process.env.MAIN_TEST_SKILL_PACKAGE_IDS || "").split(",").some(id => id.trim());
    const workspace = (page as any).__realOmlxWorkspace as string;
    const fingerprint = async () => {
      const hash = createHash("sha256");
      for (const directory of ["Assets", "Packages", "ProjectSettings"]) {
        const visit = async (root: string): Promise<void> => {
          for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const target = path.join(root, entry.name);
            if (entry.isDirectory()) await visit(target);
            else if (entry.isFile()) { hash.update(path.relative(workspace, target)); hash.update(await fs.readFile(target)); }
          }
        };
        await visit(path.join(workspace, directory));
      }
      return hash.digest("hex");
    };
    const before = await fingerprint();
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    const input = page.getByTestId("composer-textarea");
    const collectorTask = "构建测试游戏方案：玩家对象命名 Player；三枚金币分别为 Coin_1、Coin_2、Coin_3；控制器类型和根对象名为 CollectorGame，并公开只读 Score/Won 供验证。WASD/方向键移动，碰到金币后金币消失、分数增加；集齐三枚显示胜利；R 键或重开按钮重置玩家、金币、分数和胜利状态。使用项目已启用的新 Input System，基础图形即可，HUD 清楚显示操作和分数。";
    const skillAcceptance = "用 load_skill 阅读所选技能中与 Play Mode 或测试相关的一处说明。计划阶段只读，把技能说明中的验证方法安排为实施步骤。项目尚未实现，可以将新增小型 Play Mode 测试列入计划，覆盖移动、拾取计分、胜利和两种重置。";
    await input.fill(useUnitySkill
      ? `/计划 $unity-cli ${collectorTask}\n${skillAcceptance}`
      : `/计划 ${collectorTask}`);
    await input.press("Enter");
    const snapshot = await settleVisiblePlanInterview(page, testInfo, "executable", {
      label: "collector-plan-validation",
      timeoutMs: realOmlxPlanTimeoutMs,
      textAnswer: "同意把自动验收加入实施范围。请核实项目里已有的测试框架和可用入口，覆盖移动、拾取计分、胜利和两种重置，保留已确认的实现选择。",
    });
    const observed = await page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/index.ts");
      const { resolvePlanDraftFromAggregate, resolvePlanDocumentFromAggregate } = await import("/src/lib/planDocumentRecords.ts");
      const state = useAppStore.getState();
      const aggregate = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[state.currentTurnId!])!.aggregate;
      return { aggregate, sessionId: state.currentSessionId, draft: resolvePlanDraftFromAggregate(aggregate), document: resolvePlanDocumentFromAggregate(aggregate) };
    });
    expect(observed.document).toBeTruthy();
    const content = await page.evaluate(reference => (window as any).__MAIN_E2E_NATIVE_TOOL("read_plan_document", { reference }), observed.document!.documentRef);
    expect(await fs.readFile(content.path, "utf8")).toBe(content.markdown);
    expect(content.contentHash).toBe(createHash("sha256").update(content.markdown).digest("hex"));
    expect(content.markdown).toMatch(/Player/);
    expect(content.markdown).toMatch(/CollectorGame/);
    const events = observed.aggregate.events;
    if (useUnitySkill) {
      const skillCommandKeys = new Set(events.flatMap(event =>
        event.type === "command.scheduled" && event.command.kind === "execute_tool" &&
        event.command.payload.toolName === "load_skill" ? [event.command.idempotencyKey] : []
      ));
      const readUnitySkill = events.some(event => {
        if (event.type !== "tool.completed" || event.status !== "succeeded" ||
            event.receiptOrigin !== "executed" || !skillCommandKeys.has(event.idempotencyKey) || !event.modelContent) return false;
        try {
          const body = JSON.parse(event.modelContent.replace(/^\[E\d+\] [^\n]*\n/, ""));
          return (body.type === "skill.loaded" || body.type === "skill.resource") &&
            body.name === "unity-cli" && body.source === "package" && typeof body.content === "string" && !!body.content.trim();
        } catch {
          return false;
        }
      });
      expect(readUnitySkill, "the Plan ledger must contain an executed Unity CLI Skill document read").toBe(true);
    }
    expect(events.some(event => event.type === "work_plan.approved")).toBe(false);
    expect(observed.aggregate.evidence.some(item => item.kind === "mutation")).toBe(false);
    expect(observed.draft).toBeNull();
    expect(observed.aggregate.phase).toBe("reviewing");
    const behavioralChecks = observed.aggregate.sealedWorkPlan?.draft.validations.filter(check => {
      if (!check.required) return false;
      if (check.kind === "browser" || check.kind === "desktop") return true;
      if (check.kind !== "finite_command" || !check.command) return false;
      const spec = analyzeValidationCommand(check.command, { cwd: check.cwd }).spec;
      return spec?.kind === "finite_command" && spec.segments.some(segment =>
        segment.capability === "test" || segment.capability === "inline_assertion"
      );
    }) || [];
    expect(behavioralChecks, "the Collector plan needs a required behavioral test or interaction").not.toHaveLength(0);
    const coveredCriteria = new Set(behavioralChecks.flatMap(check => check.criterionIds || []));
    expect([...coveredCriteria]).toEqual(expect.arrayContaining(observed.aggregate.objective.acceptanceCriterionIds || []));
    expect(snapshot.activeActionRequest.kind).toBe("plan_review");
    expect(events.filter(event => event.type === "run.started")).toHaveLength(1);
    expect(events.filter(event => event.type === "turn.completed")).toHaveLength(0);
    await expect(page.getByRole("button", { name: "审阅并批准", exact: true }).first()).toBeVisible();
    expect(await fingerprint()).toBe(before);
    let persisted: unknown;
    await expect.poll(async () => {
      const saved = await invokeRuntimeToolBridge(workspace, "load_project_session", { sessionId: observed.sessionId });
      persisted = saved?.runtimeSnapshot?.runtimeV2Checkpoints?.[observed.aggregate.turn.turnId];
      const restored = normalizeRuntimeV2Checkpoint(persisted, observed.aggregate.turn);
      return restored?.aggregate.phase === observed.aggregate.phase && restored.events.length >= observed.aggregate.events.length;
    }, { timeout: 15_000, message: "the actual Session ledger must replay after native JSON persistence" }).toBe(true);
    await fs.writeFile(testInfo.outputPath("collector-plan-persisted.json"), JSON.stringify(persisted, null, 2));
    await fs.writeFile(testInfo.outputPath("collector-plan-acceptance.json"), JSON.stringify({ model, workspace, observed }, null, 2));
    await page.screenshot({ path: testInfo.outputPath("collector-plan-workbench.png"), fullPage: true });
  });

  test(`real OMLX product global Plan interviews and saves an actual document with ${model}`, async ({ page }, testInfo) => {
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => (window as any).__CODELY_E2E__.prepareReadOnlyChat(false));
    const input = page.getByTestId("composer-textarea");
    await input.fill("/计划 为初学者制定三天的本地 Markdown 学习计划，每天30分钟，完全离线，不安装软件。计划代号 LOCAL_LEARNING_842。请确认有价值的取舍后保存文档。");
    await input.press("Enter");
    const snapshot = await settleVisiblePlanInterview(page, testInfo);
    expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
    const events = snapshot.runtimeV2.events;
    expect(events.some((event: any) => event.type === "run.decision_recorded" && event.answer)).toBe(true);
    expect(events.some((event: any) => event.type === "work_plan.approved")).toBe(false);
    const saved = events.filter((event: any) => event.type === "tool.completed" && event.status === "succeeded" && event.modelContent)
      .map((event: any) => { try { return JSON.parse(event.modelContent); } catch { return null; } }).find((value: any) => value?.planDocument);
    expect(saved?.planDocument.owner.workspace).toBeNull();
    const content = await page.evaluate(reference => (window as any).__MAIN_E2E_NATIVE_TOOL("read_plan_document", { reference }), saved.planDocument);
    expect(content.markdown).toContain("LOCAL_LEARNING_842");
    expect(content.markdown).toMatch(/30|三十/);
    expect(content.contentHash).toBe(createHash("sha256").update(content.markdown).digest("hex"));
    expect(await fs.readFile(content.path, "utf8")).toBe(content.markdown);
    await expect(page.getByTestId("plan-document-card")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("product-global-plan-workbench.png"), fullPage: true });
    await page.getByRole("button", { name: "查看文档", exact: true }).click();
    await expect(page.getByRole("dialog").last()).toContainText("LOCAL_LEARNING_842");
  });

  test(`real OMLX product Rules interviews and saves reviewed AGENTS with ${model}`, async ({ page }, testInfo) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "# Project rules\n\nHUMAN_RULE_913: Preserve this existing user rule.\n");
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    const input = page.getByTestId("composer-textarea");
    await input.fill("/规则 保留已有人工规则。为当前项目编写简短开发约束：修改后运行 npm test；不新增第三方运行时依赖；保留原有 CSV 中文字段兼容。先问清必要取舍再起草，审阅后才写AGENTS.md。");
    await input.press("Enter");
    const snapshot = await settleVisiblePlanInterview(page, testInfo, "document", { textAnswer:
      "项目使用现有技术栈和文件组织。开发目标是保持 CSV creator 与中文创建者字段到 creatorName 的映射兼容；每次修改后运行 npm test 验证。禁止新增第三方运行时依赖，修改范围限当前项目，保留现有人工规则 HUMAN_RULE_913。团队采用小范围修改与差异审阅；规则覆盖目标、开发约定、测试命令和上述边界。没有其他新增约束。" });
    expect(snapshot.runtimeV2.terminalOutcome.resultKind).toBe("success");
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("# Project rules\n\nHUMAN_RULE_913: Preserve this existing user rule.\n");
    const dialog = page.getByRole("dialog").last();
    await expect(dialog).toBeVisible();
    const editor = dialog.getByRole("textbox");
    await expect(editor).toHaveValue(/HUMAN_RULE_913/);
    const candidate = await editor.inputValue();
    expect(candidate).toContain("npm test");
    await editor.fill(candidate + "\nEDITOR_RULE_527: Keep changes scoped.\n");
    const save = dialog.getByRole("button", { name: /保存|写入|确认/ }).last();
    await save.click();
    await expect.poll(async () => await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain("EDITOR_RULE_527");
    const actual = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
    expect(actual).toContain("HUMAN_RULE_913");
    expect(actual).toContain("npm test");
    await fs.writeFile(testInfo.outputPath("reviewed-AGENTS.md"), actual);
  });

  test(`real OMLX product selected knowledge reaches the first runtime model request with ${model}`, async ({ page }, testInfo) => {
    const workspace = (page as any).__realOmlxWorkspace as string;
    await fs.writeFile(path.join(workspace, "reference-manual.txt"), "青岚项目的发布暗号为 RAG_CEDAR_864。网络访问由用户在本轮开启；离线模式不会查询网页。\n");
    const base = await invokeRuntimeToolBridge(workspace, "knowledge_create_base", { name: "项目发布资料", description: "Real local text index" });
    const imported = await invokeRuntimeToolBridge(workspace, "knowledge_import_source", { kbId: base.id, path: "reference-manual.txt" });
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&model=${encodeURIComponent(model)}`);
    await page.evaluate(() => (window as any).__CODELY_E2E__.prepareReadOnlyChat(false));
    const input = page.getByTestId("composer-textarea");
    await input.fill("#");
    const picker = page.getByTestId("knowledge-picker");
    await expect(picker).toBeVisible();
    await picker.getByRole("checkbox", { name: imported.source.title, exact: true }).check();
    await picker.getByRole("button", { name: /添加所选/ }).click();
    await input.fill("青岚项目的发布暗号是什么？请引用所选资料，不要联网。");
    await input.press("Enter");
    const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "product-rag");
    const aggregate = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot().aggregate);
    const packet = aggregate.events.find((event: any) => event.type === "turn.admitted")?.knowledgeContext;
    expect(packet?.references).toHaveLength(1);
    expect(packet.references[0].sourceId).toBe(imported.source.id);
    expect(packet.hits[0].text).toContain("RAG_CEDAR_864");
    const answer = snapshot.runtimeV2.projections.find((projection: any) => projection.audience === "final")?.markdown || "";
    expect(answer).toContain("RAG_CEDAR_864");
    const wire = (page as any).__realOmlxProviderWire as any[];
    const admittedAt = aggregate.events.find((event: any) => event.type === "turn.admitted").at;
    // The semantic admission classifier precedes the Turn and receives no
    // reference data. The first task-model request must already contain RAG.
    const firstRuntimeRequest = wire.find(entry => Date.parse(entry.at) >= admittedAt);
    expect(JSON.stringify(firstRuntimeRequest?.selectedKnowledgeAnchors)).toContain("RAG_CEDAR_864");
    await expect(page.getByTestId("knowledge-selection-chips")).toHaveCount(0);
    await input.fill("不用资料，只回复：下一轮正常聊天。");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot().aggregate?.turn?.turnId))
      .not.toBe(aggregate.turn.turnId);
    const next = await expectRealWorkspaceTerminal(page, testInfo, "product-rag-next-message");
    const nextAggregate = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot().aggregate);
    expect(nextAggregate.events.find((event: any) => event.type === "turn.admitted")?.knowledgeContext).toBeUndefined();
    const nextAdmittedAt = nextAggregate.events.find((event: any) => event.type === "turn.admitted").at;
    const nextRuntimeRequest = wire.find(entry => Date.parse(entry.at) >= nextAdmittedAt);
    expect(nextRuntimeRequest.selectedKnowledgeAnchors).toEqual([]);
    expect(nextRuntimeRequest.tools).not.toContain("knowledge_search");
  });
}


for (const model of models) {
  test(`real OMLX workspace FIFO concludes two admitted Turns and roundtrips their actual Rust snapshot with ${model}`, async ({ page }, testInfo) => {
    test.skip(realOmlxFixture !== "csv");
    const workspace = (page as any).__realOmlxWorkspace as string;
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await expect.poll(() => page.evaluate(() => !!(window as any).__CODELY_E2E__?.getSnapshot)).toBe(true);
    const prompts = [
      "这是普通聊天，不需要计划、文件操作或联网。请用三句话说明 Markdown 标题和列表的区别，并在最后写 FIFO_FIRST_731。",
      "这是第二条普通聊天，不需要计划、文件操作或联网。只回复 FIFO_SECOND_942。",
    ];
    const clientIds = [`fifo-first-${Date.now()}`, `fifo-second-${Date.now()}`];
    const admission = await page.evaluate(async ({ prompts, clientIds }) => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
      const observations: any[] = [];
      const observe = () => {
        const state = useAppStore.getState();
        const turns = state.conversationTurns.filter(turn => clientIds.includes(turn.clientSubmissionId || ""));
        const aggregates = turns.map(turn => normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[turn.id])?.aggregate).filter(Boolean);
        const observation = {
          activeTurnIds: aggregates.filter(aggregate => aggregate!.run && !aggregate!.terminalOutcome).map(aggregate => aggregate!.turn.turnId),
          completedTurnIds: aggregates.filter(aggregate => aggregate!.terminalOutcome).map(aggregate => aggregate!.turn.turnId),
          queue: (state.workspaceTurnQueue?.entries || []).filter(entry => clientIds.includes(entry.instruction.clientSubmissionId))
            .map(entry => ({ clientSubmissionId: entry.instruction.clientSubmissionId, turnId: entry.receipt.turnId, status: entry.status })),
        };
        if (JSON.stringify(observations.at(-1)) !== JSON.stringify(observation)) observations.push(observation);
      };
      (window as any).__REAL_FIFO_TRACE__ = observations;
      (window as any).__REAL_FIFO_UNSUBSCRIBE__ = useAppStore.subscribe(observe);
      observe();
      // Use the production receipt/FIFO ingress; no resolved intent, fake
      // completion, queued-message replay helper or seeded Run is supplied.
      const first = await useAppStore.getState().acceptWorkspaceInstruction({ text: prompts[0], source: "composer", clientSubmissionId: clientIds[0] });
      const second = await useAppStore.getState().acceptWorkspaceInstruction({ text: prompts[1], source: "composer", clientSubmissionId: clientIds[1] });
      observe();
      return { first, second };
    }, { prompts, clientIds });
    let final: any;
    let roundtrip: any;
    let restoration: any;
    const snapshot = () => page.evaluate(async clientIds => {
      const { useAppStore, buildSessionRuntimeSnapshotFromStoreState } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/checkpoint.ts");
      const { prepareProjectSessionSnapshotForSave } = await import("/src/lib/ipc.ts");
      const state = useAppStore.getState();
      const turns = state.conversationTurns.filter(turn => clientIds.includes(turn.clientSubmissionId || ""));
      const aggregates = turns.map(turn => normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[turn.id])?.aggregate || null);
      const session = state.sessionsByWorkspace[state.currentWorkspace]?.find(session => session.id === state.currentSessionId);
      const runtimeSnapshot = buildSessionRuntimeSnapshotFromStoreState(state);
      return {
        turns, aggregates, trace: (window as any).__REAL_FIFO_TRACE__,
        currentSessionId: state.currentSessionId, planLifecycle: state.planLifecycle,
        isGenerating: state.isGenerating, agentStatus: state.agentStatus,
        actionRequest: state.activeActionRequest, pendingRunDecision: state.pendingRunDecision,
        queue: state.workspaceTurnQueue, ledger: state.workspaceInstructionLedger,
        // This is the same live snapshot builder and persisted checkpoint
        // codec used by normal session saves. Persistence below is explicit;
        // this case does not claim automatic page reload or crash restore.
        session: session ? prepareProjectSessionSnapshotForSave({ ...session, messages: runtimeSnapshot.taskFlow,
          runtimeSnapshot, updatedAtMs: Date.now() }, null) : null,
      };
    }, clientIds);
    try {
      expect(admission.first).toMatchObject({ accepted: true, disposition: "admitted" });
      expect(admission.second).toMatchObject({ accepted: true, disposition: "admitted" });
      if (!admission.first.accepted || !admission.second.accepted) throw new Error("Both FIFO instructions must be admitted.");
      expect(admission.second.receipt.turnId).not.toBe(admission.first.receipt.turnId);
      expect(admission.second.receipt.sessionKey).toBe(admission.first.receipt.sessionKey);
      expect(admission.second.receipt.sessionEpoch).toBe(admission.first.receipt.sessionEpoch);
      await expect.poll(async () => {
        final = await snapshot();
        if (final.actionRequest || final.pendingRunDecision) return "unexpected_action_required";
        return final.aggregates.length === 2 && final.aggregates.every((aggregate: any) => aggregate?.terminalOutcome) && !final.isGenerating && final.agentStatus === "idle" ? "completed" : "running";
      }, { timeout: Math.min(realOmlxExecutionTimeoutMs, 240_000), intervals: [500] }).toBe("completed");
      expect(final.turns.map((turn: any) => turn.clientSubmissionId)).toEqual(clientIds);
      expect(final.queue?.entries || []).toHaveLength(0);
      expect(final.trace.some((entry: any) => entry.queue.some((queued: any) => queued.clientSubmissionId === clientIds[1]) &&
        !entry.completedTurnIds.includes(admission.first.receipt.turnId)), "the second real instruction must wait in the production FIFO before the first concludes").toBe(true);
      expect(final.trace.every((entry: any) => entry.activeTurnIds.length <= 1), "parent Runs must not overlap").toBe(true);
      const runtimeTimes: Array<{ startedAt: number; completedAt: number }> = [];
      for (let index = 0; index < 2; index++) {
        const aggregate = final.aggregates[index];
        expect(aggregate.turn.turnId).toBe(index === 0 ? admission.first.receipt.turnId : admission.second.receipt.turnId);
        expect(["chat", "analyze", "report", "summarize"]).toContain(aggregate.strategy);
        expect(aggregate.terminalOutcome.resultKind).toBe("success");
        const starts = aggregate.events.filter((event: any) => event.type === "run.started");
        const completions = aggregate.events.filter((event: any) => event.type === "run.completed");
        const turnCompletions = aggregate.events.filter((event: any) => event.type === "turn.completed");
        const finals = aggregate.events.filter((event: any) => event.type === "projection.published" && event.projection.kind === "final" && event.projection.audience === "final");
        expect(starts).toHaveLength(1);
        expect(completions).toHaveLength(1);
        expect(turnCompletions).toHaveLength(1);
        expect(finals).toHaveLength(1);
        expect(finals[0].projection.markdown).toContain(index === 0 ? "FIFO_FIRST_731" : "FIFO_SECOND_942");
        expect(final.ledger.filter((entry: any) => entry.clientSubmissionId === clientIds[index] && entry.receipt.turnId === aggregate.turn.turnId)).toHaveLength(1);
        runtimeTimes.push({ startedAt: starts[0].at, completedAt: turnCompletions[0].at });
      }
      expect(runtimeTimes[1].startedAt).toBeGreaterThanOrEqual(runtimeTimes[0].completedAt);
      expect(final.session).toBeTruthy();
      const previous = await invokeRuntimeToolBridge(workspace, "load_project_session", { sessionId: final.session.id });
      const saveInput = { ...final.session, storageRevision: previous?.storageRevision || 0,
        storageStatus: "ok", recordingDisabled: false };
      const saved = await invokeRuntimeToolBridge(workspace, "save_project_session", { session: saveInput });
      const loaded = await invokeRuntimeToolBridge(workspace, "load_project_session", { sessionId: final.session.id });
      expect(saved.storageRevision).toBe(saveInput.storageRevision + 1);
      expect(loaded.storageRevision).toBe(saved.storageRevision);
      expect(loaded.runtimeSnapshot).toEqual(saveInput.runtimeSnapshot);
      expect(loaded.messages).toEqual(saveInput.messages);
      expect(loaded.runtimeSnapshot.conversationTurns.filter((turn: any) => clientIds.includes(turn.clientSubmissionId)).map((turn: any) => turn.id))
        .toEqual([admission.first.receipt.turnId, admission.second.receipt.turnId]);
      for (const aggregate of final.aggregates) {
        const checkpoint = loaded.runtimeSnapshot.runtimeV2Checkpoints[aggregate.turn.turnId];
        expect(checkpoint.owner).toEqual(aggregate.turn);
        expect(checkpoint.aggregate).toBeUndefined();
        expect(checkpoint.events).toEqual(aggregate.events);
      }
      roundtrip = { scope: "explicit Rust SessionStore save/load", saveInputRevision: saveInput.storageRevision,
        savedRevision: saved.storageRevision, loaded };
      const wire = (page as any).__realOmlxProviderWire as any[];
      const requestsBeforeRestore = wire.length;
      const cleared = await page.evaluate(async ({ loaded, workspace }) => {
        const { useAppStore, buildEmptySessionRuntimeSnapshot } = await import("/src/store/useAppStore.ts");
        const { messages: _messages, runtimeSnapshot: _runtimeSnapshot, ...metadata } = loaded;
        const state = useAppStore.getState();
        (window as any).__MAIN_E2E_NATIVE_SESSION_RESTORE__ = true;
        (window as any).__MAIN_E2E_SESSION_RESTORE_CALLS__ = [];
        // This is a test-only cold-memory boundary, not a reconstructed
        // transcript. Only disk metadata survives; App owns all hydration.
        useAppStore.setState({
          ...buildEmptySessionRuntimeSnapshot(state, "main_mode", { sessionKey: null, sessionEpoch: null, createdAt: Date.now() }),
          currentSessionId: null, runtimeBySessionKey: {}, isGenerating: false, agentStatus: "idle", abortController: null,
          sessionsByWorkspace: { [workspace]: [{ ...metadata, active: false }] },
          activeSessionByWorkspace: { [workspace]: null },
        });
        const empty = useAppStore.getState();
        return { currentSessionId: empty.currentSessionId, taskFlow: empty.taskFlow, conversationTurns: empty.conversationTurns,
          checkpoints: empty.runtimeV2Checkpoints, runtimeBySessionKey: empty.runtimeBySessionKey,
          metadata: empty.sessionsByWorkspace[workspace] };
      }, { loaded, workspace });
      restoration = { scope: "App sidebar selection after clearing live memory; Rust full-snapshot fallback hydration, not a browser reload or native paged restore", cleared, requestsBeforeRestore };
      expect(cleared.taskFlow).toEqual([]);
      expect(cleared.conversationTurns).toEqual([]);
      expect(cleared.checkpoints).toEqual({});
      expect(cleared.runtimeBySessionKey).toEqual({});
      expect(cleared.metadata[0].messages).toBeUndefined();
      expect(cleared.metadata[0].runtimeSnapshot).toBeUndefined();
      await page.getByTestId(`session-item-${loaded.id}`).click();
      await expect.poll(async () => {
        const restored = await snapshot();
        const calls = await page.evaluate(() => (window as any).__MAIN_E2E_SESSION_RESTORE_CALLS__ || []);
        return calls.some((call: any) => call.cmd === "load_project_session" && call.status === "fulfilled") &&
          restored.currentSessionId === loaded.id && restored.aggregates.length === 2 && restored.aggregates.every((aggregate: any) => aggregate?.terminalOutcome?.resultKind === "success");
      }, { timeout: 30_000 }).toBe(true);
      const restored = await snapshot();
      restoration.restored = restored;
      restoration.nativeCalls = await page.evaluate(() => (window as any).__MAIN_E2E_SESSION_RESTORE_CALLS__ || []);
      expect(restored.planLifecycle.sessionEpoch).toBe(admission.first.receipt.sessionEpoch);
      expect(restored.turns.map((turn: any) => turn.id)).toEqual([admission.first.receipt.turnId, admission.second.receipt.turnId]);
      for (let index = 0; index < 2; index++) {
        expect(restored.aggregates[index].turn).toEqual(final.aggregates[index].turn);
        expect(restored.aggregates[index].events).toEqual(final.aggregates[index].events);
      }
      expect(wire.length, "restoring terminal Turns must not automatically ask the model to continue").toBe(requestsBeforeRestore);
      const priorTurnId = restored.aggregates[1].turn.turnId;
      const input = page.getByTestId("composer-textarea");
      await input.fill("这是恢复会话后的普通聊天：第一条聊天末尾的标记是什么？只回答那个标记，不要联网或读文件。");
      await input.press("Enter");
      await expect.poll(() => page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot().aggregate?.turn?.turnId))
        .not.toBe(priorTurnId);
      await expectRealWorkspaceTerminal(page, testInfo, "workspace-restored-followup");
      const followup = await page.evaluate(() => (window as any).__CODELY_E2E__.readOnlySnapshot().aggregate);
      restoration.followup = followup;
      expect(followup.turn.sessionKey).toBe(admission.first.receipt.sessionKey);
      expect(followup.turn.sessionEpoch).toBe(admission.first.receipt.sessionEpoch);
      expect(followup.turn.turnId).not.toBe(priorTurnId);
      expect(followup.terminalOutcome.resultKind).toBe("success");
      const followupFinals = followup.events.filter((event: any) => event.type === "projection.published" && event.projection.kind === "final" && event.projection.audience === "final");
      expect(followupFinals).toHaveLength(1);
      expect(followupFinals[0].projection.markdown).toContain("FIFO_FIRST_731");
    } finally {
      final = await snapshot();
      await page.evaluate(() => { (window as any).__REAL_FIFO_UNSUBSCRIBE__?.(); });
      await fs.writeFile(testInfo.outputPath("workspace-fifo-sidebar-restore.json"), JSON.stringify(restoration || null, null, 2));
      await fs.writeFile(testInfo.outputPath("workspace-fifo-rust-snapshot.json"), JSON.stringify({ admission, final, roundtrip, restoration }, null, 2));
    }
  });

  test(`real OMLX Tuanjie Engine manual preset auto-binding, zero pre-injection standby, navigator Skill, and 3-tier knowledge_search with ${model}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const workspace = (page as any).__realOmlxWorkspace as string;
    const projectSettingsDir = path.join(workspace, "ProjectSettings");
    const packagesDir = path.join(workspace, "Packages");
    await fs.mkdir(projectSettingsDir, { recursive: true });
    await fs.mkdir(packagesDir, { recursive: true });
    const versionFile = "m_EditorVersion: 2022.3.62t16\nm_TuanjieEditorVersion: 1.10.4\n";
    await fs.writeFile(path.join(projectSettingsDir, "ProjectVersion.txt"), versionFile);
    await fs.writeFile(path.join(packagesDir, "manifest.json"), JSON.stringify({
      dependencies: { "com.unity.render-pipelines.universal": "14.2.0-t1" },
    }));

    // 1. Bootstrap BOTH Unity 6 and Tuanjie Engine official manuals and enable both to verify workspace-aware mutual exclusion
    const unity6Base = await invokeRuntimeToolBridge(workspace, "knowledge_bootstrap_preset", { presetId: "unity6" });
    const tuanjieBase = await invokeRuntimeToolBridge(workspace, "knowledge_bootstrap_preset", { presetId: "tuanjie" });
    await invokeRuntimeToolBridge(workspace, "knowledge_set_base_enabled", { kbId: unity6Base.id, enabled: true });
    const enabledTuanjieBase = await invokeRuntimeToolBridge(workspace, "knowledge_set_base_enabled", { kbId: tuanjieBase.id, enabled: true });

    expect(enabledTuanjieBase.presetId).toBe("tuanjie");
    expect(enabledTuanjieBase.enabled).toBe(true);
    expect(enabledTuanjieBase.sourceCount).toBeGreaterThanOrEqual(1);
    expect(enabledTuanjieBase.tocEntryCount).toBeGreaterThanOrEqual(8);

    // 2. Open workspace conversation without manually selecting # in composer
    await page.goto(`/?e2eScenario=real-omlx-plan-flow&workspaceConversation=1&model=${encodeURIComponent(model)}`);
    await expect.poll(() => page.evaluate(() => !!(window as any).__CODELY_E2E__?.getSnapshot)).toBe(true);

    // 2b. Verify KnowledgeModal UI & Preset Cards across Light, Dark, and Black themes
    await page.getByRole("button", { name: /^知识库$|^Knowledge$/i }).click();
    await expect(page.getByText(/官方引擎代码手册|Official Engine Code Manuals/i)).toBeVisible();
    for (const theme of ["light", "dark", "black"] as const) {
      await page.evaluate(async (nextTheme) => {
        const { useAppStore } = await import("/src/store/useAppStore.ts");
        const state = useAppStore.getState();
        state.setConfig({ ...state.config, themeMode: nextTheme });
        document.documentElement.setAttribute("data-theme", nextTheme);
      }, theme);
      await page.waitForTimeout(150);
      await page.screenshot({ path: testInfo.outputPath(`knowledge-modal-${theme}.png`) });
    }
    await page.getByRole("button", { name: /^完成$|^Done$/i }).click();

    const prompt =
      "当前是一个团结引擎 (Tuanjie Engine) 工程。请务必先调用 knowledge_search 工具检索已绑定的团结引擎官方代码手册（例如查询 WeChatWASM OpenHarmony Awaitable），然后依据手册回答团结与 Unity 6 的 Awaitable 差异，以及微信小游戏和 OpenHarmony 的版本或平台注意事项。明确资料与项目版本的差异。只读回答，不修改文件。";
    const input = page.getByTestId("composer-textarea");
    await input.fill(prompt);
    await input.press("Enter");

    const snapshot = await expectRealWorkspaceTerminal(page, testInfo, "tuanjie-engine-manual-simulation");
    const observed = await page.evaluate(async () => {
      const { useAppStore } = await import("/src/store/useAppStore.ts");
      const { normalizeRuntimeV2Checkpoint } = await import("/src/lib/runtime-v2/index.ts");
      const state = useAppStore.getState();
      const aggregate = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints[state.currentTurnId!])?.aggregate;
      return { aggregate };
    });

    const aggregate = observed.aggregate!;
    expect(aggregate).toBeTruthy();
    expect(aggregate.terminalOutcome?.resultKind).toBe("success");

    // 3. Verify Workspace Engine Auto-Detection, Mutual Exclusion & Zero Pre-Turn Injection (state: "standby")
    const admittedEvent = aggregate.events.find((event: any) => event.type === "turn.admitted");
    const packet = admittedEvent?.knowledgeContext;
    expect(packet).toBeTruthy();
    expect(packet.state).toBe("standby");
    expect(packet.hits).toHaveLength(0);
    expect(packet.references).toHaveLength(1);
    expect(packet.references[0]).toMatchObject({
      kind: "base",
      kbId: enabledTuanjieBase.id,
      presetId: "tuanjie",
      activationMode: "workspace_active",
    });

    // 4. Verify First Provider Request Wire: 1-line standby anchor + knowledge_search tool unlocked + Companion Navigator Skill mounted
    const wire = (page as any).__realOmlxProviderWire as any[];
    const admittedAt = admittedEvent.at;
    const firstRuntimeRequest = wire.find((entry) => Date.parse(entry.at) >= admittedAt);
    expect(firstRuntimeRequest).toBeTruthy();
    expect(JSON.stringify(firstRuntimeRequest.selectedKnowledgeAnchors)).toContain("[ACTIVE ENGINE MANUAL KNOWLEDGE BASE]");
    expect(JSON.stringify(firstRuntimeRequest.selectedKnowledgeAnchors)).toContain("tuanjie");
    expect(firstRuntimeRequest.tools).toContain("knowledge_search");
    expect(firstRuntimeRequest.tools).toContain("knowledge_get_excerpt");

    // 5. Verify the model called knowledge_search on demand and produced a grounded Tuanjie Engine response
    expect(realWorkspaceToolSucceeded(snapshot, "knowledge_search")).toBe(true);
    const finalAnswer =
      snapshot.runtimeV2.projections.find((projection: any) => projection.audience === "final")?.markdown || "";
    expect(finalAnswer).toMatch(/2022|Awaitable/i);
    expect(finalAnswer).toMatch(/MINIGAME_SUBPLATFORM_WEIXIN|WeChatWASM|微信小游戏/i);
    expect(finalAnswer).not.toMatch(/\bTUANJIE_WEIXINMINIGAME\b/);
    expect(finalAnswer).toMatch(/TUANJIE_OPENHARMONY|OpenHarmonyJSClass|OpenHarmonyJSObject/i);

    await fs.writeFile(
      testInfo.outputPath("tuanjie-simulation-report.json"),
      JSON.stringify(
        {
          model,
          versionFile: versionFile.trim(),
          unity6Base,
          enabledTuanjieBase,
          admittedKnowledgeContext: packet,
          firstRuntimeRequestTools: firstRuntimeRequest.tools,
          firstRuntimeRequestKnowledgeAnchors: firstRuntimeRequest.selectedKnowledgeAnchors,
          knowledgeSearchSucceeded: realWorkspaceToolSucceeded(snapshot, "knowledge_search"),
          finalAnswer,
        },
        null,
        2,
      ),
    );
  });
}

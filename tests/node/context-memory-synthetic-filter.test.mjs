import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];
      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { buildContextMemoryState, formatContextMemoryPacket } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/contextMemory.ts"),
);

test("synthetic continuation prompts are excluded from durable goal/constraint/decision memory", () => {
  const syntheticPrompt = [
    "请继续执行你的计划。注意以下规则：",
    "1. 不要询问用户指示，你自己做决定并执行。",
    "2. 必须使用 <tool_use> 格式调用工具。",
    "<tool_use>",
    "<tool>read_file</tool>",
    "<parameter name=\"path\">src/foo.ts</parameter>",
    "</tool_use>",
  ].join("\n");

  const state = buildContextMemoryState([
    { role: "user", content: "请修复登录失败问题，并保留现有鉴权约束。" },
    { role: "user", content: syntheticPrompt },
  ]);

  const goals = state.goals.map((item) => item.text).join("\n");
  const constraints = state.constraints.map((item) => item.text).join("\n");
  const decisions = state.decisions.map((item) => item.text).join("\n");

  assert.ok(goals.includes("请修复登录失败问题"));
  assert.equal(goals.includes("不要询问用户指示"), false);
  assert.equal(constraints.includes("不要询问用户指示"), false);
  assert.equal(decisions.includes("tool_use"), false);
});

test("turn intake wrapper contributes only canonical visible user text", () => {
  const wrapped = [
    "[turn_intake]",
    "workflowMode: plan",
    "imageParts: 0",
    "priority: internal runtime guidance must never become durable context.",
    "[user_request]",
    "请修复双击 Markdown 文件后只打开空白窗口的问题。",
    "[/user_request]",
    "[/turn_intake]",
  ].join("\n");
  const state = buildContextMemoryState([{ role: "user", content: wrapped }], { now: 50 });
  assert.equal(state.latestUserRequest?.text, "请修复双击 Markdown 文件后只打开空白窗口的问题。");
  const durable = [...state.goals, ...state.constraints, ...state.decisions].map((item) => item.text).join("\n");
  assert.doesNotMatch(durable, /turn_intake|workflowMode|internal runtime guidance/i);
});

test("execute recovery prompts do not replace the original latest user request", () => {
  const recoveryPrompt = [
    "EXECUTE_RECOVERY: 当前 Execute 回合已经耗尽只读预算，但还没有产生写入、命令或浏览器验证证据。",
    "恢复原因：read_only_budget_exhausted。",
    "恢复工具面：mutation_first。",
    "不要开启新一轮泛读，不要重复读取同一批文件。",
  ].join("\n");
  const approvedRecoveryPrompt = [
    "用户已经批准本轮执行，但上一条回复又输出了新的方案，没有产生真实工具证据。",
    "不要重新规划。现在必须开始最小必要的真实工具动作：写入/替换文件、运行命令、调用 Browser/Playwright 验证，或明确暂停说明具体阻塞。",
  ].join("\n");

  const state = buildContextMemoryState([
    { role: "user", content: "请增加一个新建功能，点击新建后可以创建新的文档。" },
    { role: "user", content: recoveryPrompt },
    { role: "user", content: approvedRecoveryPrompt },
  ], { now: 100 });

  assert.equal(state.latestUserRequest?.text, "请增加一个新建功能，点击新建后可以创建新的文档。");
  const goals = state.goals.map((item) => item.text).join("\n");
  assert.match(goals, /新建功能/);
  assert.doesNotMatch(goals, /EXECUTE_RECOVERY/);
  assert.doesNotMatch(goals, /用户已经批准本轮执行/);
});

test("execute max-iteration boundary prompts do not become durable user goals", () => {
  const state = buildContextMemoryState([
    { role: "user", content: "修复白屏并完成浏览器验证。" },
    {
      role: "user",
      content: [
        "本轮 Execute 已进行 8/8 轮工具循环，接近安全边界。",
        "MAIN 会临时收窄工具面，请继续调用修改工具。",
      ].join("\n"),
    },
  ], { now: 101 });

  assert.equal(state.latestUserRequest?.text, "修复白屏并完成浏览器验证。");
  const goals = state.goals.map((item) => item.text).join("\n");
  assert.doesNotMatch(goals, /8\/8|安全边界|收窄工具面/);
});

test("polluted previous memory entries are cleaned before reuse", () => {
  const previous = {
    version: 1,
    id: "ctx-test",
    updatedAt: Date.now() - 1000,
    goals: [
      { text: "请继续执行你的计划。现在请立即用工具继续执行。", source: { role: "user" }, updatedAt: Date.now() - 900 },
      { text: "完成登录模块修复", source: { role: "user" }, updatedAt: Date.now() - 800 },
    ],
    constraints: [
      { text: "不要询问用户指示，你自己做决定并执行。", source: { role: "user" }, updatedAt: Date.now() - 700 },
      { text: "必须保留现有 API 兼容性", source: { role: "user" }, updatedAt: Date.now() - 600 },
    ],
    decisions: [
      { text: "Output exactly one <tool_use> block", source: { role: "assistant" }, updatedAt: Date.now() - 500 },
      { text: "选择先跑回归测试再提交", source: { role: "user" }, updatedAt: Date.now() - 400 },
    ],
    progress: [],
    evidence: [],
    files: [],
    blockers: [],
    nextSteps: [
      { text: "Now immediately continue using tools.", source: { role: "user" }, updatedAt: Date.now() - 300 },
      { text: "下一步：修复回调超时", source: { role: "assistant" }, updatedAt: Date.now() - 200 },
    ],
    openQuestions: [],
  };

  const state = buildContextMemoryState([], { previous });
  const goals = state.goals.map((item) => item.text).join("\n");
  const constraints = state.constraints.map((item) => item.text).join("\n");
  const decisions = state.decisions.map((item) => item.text).join("\n");
  const nextSteps = state.nextSteps.map((item) => item.text).join("\n");

  assert.equal(goals.includes("请继续执行你的计划"), false);
  assert.ok(goals.includes("完成登录模块修复"));
  assert.equal(constraints.includes("不要询问用户指示"), false);
  assert.ok(constraints.includes("必须保留现有 API 兼容性"));
  assert.equal(decisions.includes("Output exactly one <tool_use> block"), false);
  assert.ok(decisions.includes("选择先跑回归测试再提交"));
  assert.equal(nextSteps.includes("Now immediately continue using tools"), false);
  assert.ok(nextSteps.includes("下一步：修复回调超时"));
});

test("context memory carryover preserves real latest request and drops recovery latest request", () => {
  const previousPacket = [
    "[System: ContextState",
    "ContextMemoryState v1 id=ctx-test updatedAt=1",
    "Latest user request: 请增加一个新建功能，点击新建后可以创建新的文档。",
    "Goals:",
    "- 请增加一个新建功能，点击新建后可以创建新的文档。 [m1]",
    "Use this as compact historical state only; prioritize the latest messages and current workspace evidence.]",
  ].join("\n");
  const pollutedPacket = [
    "[System: ContextState",
    "ContextMemoryState v1 id=ctx-test updatedAt=2",
    "Latest user request: EXECUTE_RECOVERY: 当前 Execute 回合已经耗尽只读预算，但还没有产生写入、命令或浏览器验证证据。",
    "Goals:",
    "- EXECUTE_RECOVERY: 当前 Execute 回合已经耗尽只读预算。 [m2]",
    "Use this as compact historical state only; prioritize the latest messages and current workspace evidence.]",
  ].join("\n");

  const state = buildContextMemoryState([
    { role: "user", content: previousPacket },
    { role: "user", content: pollutedPacket },
  ], { now: 200 });

  assert.equal(state.latestUserRequest?.text, "请增加一个新建功能，点击新建后可以创建新的文档。");
  const packet = formatContextMemoryPacket(state);
  assert.match(packet, /Latest user request: 请增加一个新建功能/);
  assert.doesNotMatch(packet, /Latest user request: EXECUTE_RECOVERY/);
});

test("context memory carryover does not ingest its own section headers", () => {
  const previousPacket = [
    "[System: ContextState",
    "ContextMemoryState v1 id=ctx-test updatedAt=1",
    "Latest user request: 继续修复 UI",
    "Goals:",
    "- 完成本轮步骤呈现 [m2]",
    "Hard constraints:",
    "- Constraints: [m1] [m1]",
    "- 必须保留工具证据 [m3]",
    "Decisions:",
    "- Decisions: [m1] [m1] [m1]",
    "- 选择 B 方案 [m4]",
    "Verified evidence:",
    "- read_file src/main.js; status=observed; 2719 chars; hash=abc; excerpt=[MAIN_TOOL_FEEDBACK_V1] {\"version\":1} [read_file, src/main.js, hash=abc, m7]",
    "Relevant files:",
    "- src/main.js via read_file; hash=abc; 2719 chars [read_file, src/main.js, hash=abc, m7]",
    "Use this as compact historical state only; prioritize the latest messages and current workspace evidence.]",
  ].join("\n");

  const state = buildContextMemoryState([{ role: "user", content: previousPacket }], { now: 10 });
  const decisions = state.decisions.map((item) => item.text).join("\n");
  const constraints = state.constraints.map((item) => item.text).join("\n");
  const packet = formatContextMemoryPacket(state);

  assert.match(decisions, /选择 B 方案/);
  assert.doesNotMatch(decisions, /^Decisions:/m);
  assert.doesNotMatch(decisions, /\[m1\].*\[m1\]/);
  assert.match(constraints, /必须保留工具证据/);
  assert.doesNotMatch(constraints, /^Constraints:/m);
  assert.doesNotMatch(packet, /Decisions:\s*\[m1\]/);
  assert.doesNotMatch(packet, /Constraints:\s*\[m1\]/);
});

test("tool feedback envelopes produce compact evidence without raw JSON headers", () => {
  const callA = {
    id: "call_a",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/main.js" }),
    },
  };
  const callB = {
    id: "call_b",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/main.js" }),
    },
  };

  const state = buildContextMemoryState([
    { role: "assistant", content: "", tool_calls: [callA] },
    {
      role: "tool",
      tool_call_id: "call_a",
      content: '[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"completed","tool_call_id":"call_a","tool":"read_file","target":"src/main.js","summary":"READ src/main.js: 120 lines"}\nconsole.log("one");',
    },
    { role: "assistant", content: "", tool_calls: [callB] },
    {
      role: "tool",
      tool_call_id: "call_b",
      content: '[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"completed","tool_call_id":"call_b","tool":"read_file","target":"src/main.js","summary":"READ src/main.js: updated window"}\nconsole.log("two");',
    },
  ], { now: 20 });

  assert.equal(state.files.filter((item) => item.path === "src/main.js").length, 1);
  assert.equal(state.evidence.filter((item) => item.source.toolName === "read_file" && item.source.path === "src/main.js").length, 1);
  const evidence = state.evidence.map((item) => item.text).join("\n");
  assert.match(evidence, /summary=READ src\/main\.js: updated window/);
  assert.doesNotMatch(evidence, /MAIN_TOOL_FEEDBACK_V1/);
  assert.doesNotMatch(evidence, /"version"/);
});

test("legacy repeated provider ids keep each result paired with its own tool and feedback target", () => {
  const repeatedId = "native_call_1";
  const state = buildContextMemoryState([
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: repeatedId,
        function: {
          name: "read_file",
          // Simulate stale legacy arguments: the runtime feedback envelope is
          // authoritative for the observation that actually completed.
          arguments: JSON.stringify({ path: "src/stale-a.ts" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: repeatedId,
      content: `[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"completed","tool_call_id":"${repeatedId}","tool":"read_file","target":"src/a.ts","summary":"read A"}\nexport const a = 1;`,
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: repeatedId,
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({ path: "src/stale-b.ts" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: repeatedId,
      content: `[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"completed","tool_call_id":"${repeatedId}","tool":"replace_in_file","target":"src/b.ts","summary":"changed B"}\nREPLACE_IN_FILE_RESULT path: src/b.ts`,
    },
  ], { now: 25 });

  assert.deepEqual(
    state.files.map((item) => item.path).sort(),
    ["src/a.ts", "src/b.ts"],
  );
  assert.equal(
    state.evidence.some((item) => item.source.toolName === "read_file" && item.source.path === "src/a.ts"),
    true,
  );
  assert.equal(
    state.evidence.some((item) => item.source.toolName === "replace_in_file" && item.source.path === "src/b.ts"),
    true,
  );
  assert.equal(state.files.some((item) => /stale-[ab]\.ts/.test(item.path)), false);
});

test("legacy repeated provider ids without envelopes pair results by occurrence", () => {
  const repeatedId = "native_call_1";
  const state = buildContextMemoryState([
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: repeatedId,
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "src/a.ts" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: repeatedId,
      content: "READ_FILE_RESULT path: src/a.ts\nexport const a = 1;",
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: repeatedId,
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({ path: "src/b.ts" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: repeatedId,
      content: "REPLACE_IN_FILE_RESULT path: src/b.ts",
    },
  ], { now: 26 });

  assert.equal(
    state.evidence.some((item) => item.source.toolName === "read_file" && item.source.path === "src/a.ts"),
    true,
  );
  assert.equal(
    state.evidence.some((item) => item.source.toolName === "replace_in_file" && item.source.path === "src/b.ts"),
    true,
  );
  assert.deepEqual(state.files.map((item) => item.path).sort(), ["src/a.ts", "src/b.ts"]);
});

test("blocked mutation feedback cannot become a changed relevant file", () => {
  const call = {
    id: "call_blocked_replace",
    function: {
      name: "replace_in_file",
      arguments: JSON.stringify({
        path: "src/main.js",
        old_string: "before",
        new_string: "after",
      }),
    },
  };

  const state = buildContextMemoryState([
    { role: "assistant", content: "", tool_calls: [call] },
    {
      role: "tool",
      tool_call_id: "call_blocked_replace",
      content: '[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"blocked","tool_call_id":"call_blocked_replace","tool":"replace_in_file","target":"src/main.js","summary":"Tool unavailable for this turn phase"}\nThe requested mutation did not execute.',
    },
  ], { now: 30 });

  assert.equal(
    state.files.some((item) => item.path === "src/main.js"),
    false,
    "policy feedback must not claim a relevant file was changed",
  );
  assert.equal(
    state.evidence.some((item) => /replace_in_file src\/main\.js; status=changed/.test(item.text)),
    false,
  );
  assert.equal(
    state.blockers.some((item) => /replace_in_file src\/main\.js/.test(item.text)),
    true,
    "the blocked attempt remains available as a diagnostic",
  );
});

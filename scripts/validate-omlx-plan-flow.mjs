#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import ts from "typescript";

const execFile = promisify(execFileCallback);
const workspaceRoot = process.cwd();
const endpoint = (process.env.OMLX_BASE_URL || "http://127.0.0.1:8000/v1").replace(/\/+$/, "");
const apiKey = process.env.OMLX_API_KEY || "mmnn";
const models = (process.env.OMLX_MODELS || "gemma-4-26b-a4b-it-8bit,Qwen3.6-35B-A3B-6bit")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const headers = {
  "content-type": "application/json",
  "authorization": `Bearer ${apiKey}`,
  "x-api-key": apiKey,
};

const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
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

const {
  applyWorkspacePatch,
  previewApplyPatch,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/applyPatchTool.ts"));

const tools = [
  {
    type: "function",
    function: {
      name: "repo_map_search",
      description: "Search MAIN built-in repo map for symbols/files/line numbers.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          kind: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map_context",
      description: "Build compact repo-map context for a task without reading whole files.",
      parameters: {
        type: "object",
        required: ["task"],
        properties: {
          task: { type: "string" },
          max_nodes: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a workspace file.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Search workspace text.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          path: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a Codex-style patch after approval.",
      parameters: {
        type: "object",
        required: ["patch"],
        properties: {
          patch: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Replace exact text in a workspace file after approval.",
      parameters: {
        type: "object",
        required: ["path", "search_text", "replace_text"],
        properties: {
          path: { type: "string" },
          search_text: { type: "string" },
          replace_text: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write full file content after approval.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      },
    },
  },
];

function fail(message, detail = {}) {
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

async function requestJson(path, init = {}) {
  const requestHeaders = { ...headers, ...(init.headers || {}) };
  const args = [
    "-sS",
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
  ];
  if (init.method) args.push("-X", init.method);
  for (const [name, value] of Object.entries(requestHeaders)) {
    args.push("-H", `${name}: ${value}`);
  }
  if (init.body !== undefined) {
    args.push("--data-binary", String(init.body));
  }
  args.push(`${endpoint}${path}`);

  let stdout;
  try {
    ({ stdout } = await execFile("curl", args, { maxBuffer: 30 * 1024 * 1024 }));
  } catch (error) {
    fail(`curl request failed for ${path}`, {
      stderr: String(error.stderr || ""),
      stdout: String(error.stdout || "").slice(0, 500),
      message: error.message,
    });
  }
  const marker = "\n__HTTP_STATUS__:";
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) {
    fail(`Missing HTTP status from ${path}`, { stdout: stdout.slice(0, 500) });
  }
  const text = stdout.slice(0, markerIndex);
  const status = Number(stdout.slice(markerIndex + marker.length).trim());
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    fail(`Non-JSON response from ${path}`, { status, text: text.slice(0, 500) });
  }
  if (status < 200 || status >= 300) {
    fail(`HTTP ${status} from ${path}`, { json });
  }
  return json;
}

function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function validateNoProtocolNoise(model, probeName, content) {
  const text = String(content || "");
  if (/(?:<user_options|<\/?option\b|<tool_use|<tool_call|\[PROPOSAL)/i.test(text)) {
    fail(`${model} ${probeName} leaked protocol/noise text`, { content: text.slice(0, 800) });
  }
  if (/^\s*कल\s*$/m.test(text)) {
    fail(`${model} ${probeName} leaked a bare short foreign-script token`, { content: text.slice(0, 800) });
  }
  if (/(?:用户目标|User goal)\s*[:：]\s*(?:$|\n)/i.test(text)) {
    fail(`${model} ${probeName} produced an empty user goal`, { content: text.slice(0, 800) });
  }
  const genericApprovedGoalLine = text
    .split(/\r?\n/)
    .find((line) =>
      /(?:以落实已批准目标|落实已批准方案中涉及|Apply the approved plan change|for the approved goal)/i.test(line) &&
      !/(?:问题|错误|低劣|模糊|缺乏|避免|不要|不应|拒绝|污染|反例|症状|bad|vague|generic|avoid|do not|should not|reject|problem|issue)/i.test(line)
    );
  if (genericApprovedGoalLine) {
    fail(`${model} ${probeName} produced generic approved-goal filler`, {
      line: genericApprovedGoalLine,
      content: text.slice(0, 800),
    });
  }
  if (/(?:已读证据|证据引用|Read Evidence|Evidence References|References)[\s\S]{0,800}\b\.?MAIN\/plans\/plan\.md\b/i.test(text)) {
    fail(`${model} ${probeName} used plan.md as evidence`, { content: text.slice(0, 800) });
  }
}

function validateToolCalls(model, probeName, toolCalls, { forbidMutation = false } = {}) {
  for (const call of toolCalls || []) {
    const name = call?.function?.name || call?.name || "";
    const args = parseToolArgs(call?.function?.arguments || call?.arguments);
    if (forbidMutation && (name === "write_file" || name === "replace_in_file" || name === "apply_patch")) {
      fail(`${model} ${probeName} attempted mutation during plan probe`, { name, args });
    }
    if (name === "apply_patch") {
      const isCodexPatch = typeof args.patch === "string" && /\*\*\* Begin Patch[\s\S]*\*\*\* End Patch/.test(args.patch);
      const isUnifiedDiff = typeof args.patch === "string" && /^---\s+\S+[\s\S]*^\+\+\+\s+\S+[\s\S]*^@@/m.test(args.patch);
      if (!isCodexPatch && !isUnifiedDiff) {
        fail(`${model} ${probeName} emitted malformed apply_patch`, { args });
      }
    }
    if (name === "write_file" && typeof args.content !== "string") {
      fail(`${model} ${probeName} emitted write_file without content`, { args });
    }
    if (name === "replace_in_file") {
      if (typeof args.path !== "string" || typeof args.search_text !== "string" || typeof args.replace_text !== "string") {
        fail(`${model} ${probeName} emitted malformed replace_in_file`, { args });
      }
      if (!args.search_text || args.search_text === args.replace_text) {
        fail(`${model} ${probeName} emitted empty/no-op replace_in_file`, { args });
      }
    }
  }
}

async function chat(model, messages, { maxTokens = 900 } = {}) {
  return requestJson("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
  });
}

function firstMessage(json) {
  return json?.choices?.[0]?.message || {};
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function safeWorkspacePath(root, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe workspace path: ${relativePath}`);
  }
  const absolute = path.resolve(root, normalized);
  const rootWithSep = path.resolve(root) + path.sep;
  if (absolute !== path.resolve(root) && !absolute.startsWith(rootWithSep)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return { normalized, absolute };
}

async function seedDiskWorkspace(model) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `main-omlx-${model.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}-`));
  await fs.mkdir(path.join(root, "src/hooks"), { recursive: true });
  await fs.mkdir(path.join(root, "src/store"), { recursive: true });
  await fs.mkdir(path.join(root, ".MAIN/index"), { recursive: true });
  const parser = [
    "export interface RawCourseOrder {",
    "  creator?: string;",
    "  creator_name?: string;",
    "  '创建人'?: string;",
    "  sales?: string;",
    "}",
    "",
    "export interface CourseOrder {",
    "  creatorName: string;",
    "  amount: number;",
    "}",
    "",
    "export function parseCourseOrders(rows: RawCourseOrder[]): CourseOrder[] {",
    "  return rows.map((row) => ({",
    "    creatorName: \"\",",
    "    amount: Number(row.sales || 0),",
    "  }));",
    "}",
    "",
  ].join("\n");
  const store = [
    "import type { CourseOrder } from '../hooks/useCsvParser';",
    "",
    "export function summarizeCreators(rows: CourseOrder[]): string[] {",
    "  return rows.map((row) => row.creatorName).filter(Boolean);",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(path.join(root, "src/hooks/useCsvParser.ts"), parser, "utf8");
  await fs.writeFile(path.join(root, "src/store/dashboardStore.ts"), store, "utf8");
  await fs.writeFile(path.join(root, ".MAIN/index/repo_map.db"), JSON.stringify({
    files: ["src/hooks/useCsvParser.ts", "src/store/dashboardStore.ts"],
    symbols: [
      { name: "parseCourseOrders", kind: "function", path: "src/hooks/useCsvParser.ts", line: 13 },
      { name: "CourseOrder", kind: "interface", path: "src/hooks/useCsvParser.ts", line: 8 },
      { name: "summarizeCreators", kind: "function", path: "src/store/dashboardStore.ts", line: 3 },
    ],
    calls: [
      { from: "summarizeCreators", to: "creatorName", from_path: "src/store/dashboardStore.ts", to_path: "src/hooks/useCsvParser.ts" },
    ],
  }), "utf8");
  return {
    root,
    target: "src/hooks/useCsvParser.ts",
    original: parser,
    originalHash: sha256(parser),
  };
}

async function readWorkspaceFile(root, relativePath) {
  const { absolute } = safeWorkspacePath(root, relativePath);
  return fs.readFile(absolute, "utf8");
}

async function writeWorkspaceFile(root, relativePath, content) {
  const { absolute } = safeWorkspacePath(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

async function executeWorkspaceTool(workspace, call) {
  const name = call.name;
  const args = call.args || {};
  if (name === "repo_map_search") {
    const query = String(args.query || "").toLowerCase();
    return JSON.stringify({
      status: "ok",
      results: [
        { path: "src/hooks/useCsvParser.ts", symbol: "parseCourseOrders", kind: "function", line: 13 },
        { path: "src/store/dashboardStore.ts", symbol: "summarizeCreators", kind: "function", line: 3 },
      ].filter((item) =>
        !query ||
        item.path.toLowerCase().includes(query) ||
        item.symbol.toLowerCase().includes(query) ||
        "creator csv course order parser".includes(query)
      ),
    });
  }
  if (name === "repo_map_context") {
    return JSON.stringify({
      status: "ok",
      task: args.task || "",
      files: [
        { path: "src/hooks/useCsvParser.ts", reason: "parseCourseOrders maps CSV rows into CourseOrder.creatorName", lineRange: "13-17" },
        { path: "src/store/dashboardStore.ts", reason: "dashboard consumes CourseOrder.creatorName", lineRange: "3-4" },
      ],
    });
  }
  if (name === "grep_search") {
    const query = String(args.query || "");
    const files = ["src/hooks/useCsvParser.ts", "src/store/dashboardStore.ts"];
    const matches = [];
    for (const file of files) {
      const text = await readWorkspaceFile(workspace.root, file);
      text.split(/\r?\n/).forEach((line, index) => {
        if (!query || line.includes(query)) matches.push(`${file}:${index + 1}:${line}`);
      });
    }
    return matches.slice(0, 20).join("\n") || "NO_MATCHES";
  }
  if (name === "read_file") {
    const file = String(args.path || "");
    return `READ_FILE_RESULT path: ${file}\n---CONTENT START---\n${await readWorkspaceFile(workspace.root, file)}---CONTENT END---`;
  }
  if (name === "replace_in_file") {
    const file = String(args.path || "");
    const searchText = String(args.search_text || "");
    const replaceText = String(args.replace_text || "");
    if (!file || !searchText || searchText === replaceText) {
      throw new Error("invalid replace_in_file arguments");
    }
    const current = await readWorkspaceFile(workspace.root, file);
    if (!current.includes(searchText)) {
      throw new Error("search_text mismatch; write not performed");
    }
    const next = current.replace(searchText, replaceText);
    if (next === current) throw new Error("empty replacement");
    await writeWorkspaceFile(workspace.root, file, next);
    return `WRITE_OK replace_in_file ${file} sha256=${sha256(next)}`;
  }
  if (name === "write_file") {
    const file = String(args.path || "");
    if (typeof args.content !== "string" || !args.content) {
      throw new Error("write_file missing content");
    }
    const current = await readWorkspaceFile(workspace.root, file).catch(() => "");
    if (current === args.content) throw new Error("write_file no-op identical content");
    await writeWorkspaceFile(workspace.root, file, args.content);
    return `WRITE_OK write_file ${file} sha256=${sha256(args.content)}`;
  }
  if (name === "apply_patch") {
    if (typeof args.patch !== "string") throw new Error("apply_patch missing patch");
    const preview = await previewApplyPatch(args.patch, async (file) => readWorkspaceFile(workspace.root, file));
    if (!preview.ok) throw new Error(preview.error || "invalid patch");
    const result = await applyWorkspacePatch(args.patch, {
      readFile: async (file) => readWorkspaceFile(workspace.root, file),
      writeFile: async (file, content) => writeWorkspaceFile(workspace.root, file, content),
      deleteFile: async (file) => {
        const { absolute } = safeWorkspacePath(workspace.root, file);
        await fs.unlink(absolute);
      },
    });
    if (!result.ok) throw new Error(result.error || "apply_patch failed");
    return `WRITE_OK apply_patch ${result.changes.map((change) => change.path).join(", ")} sha256=${sha256(await readWorkspaceFile(workspace.root, workspace.target))}`;
  }
  throw new Error(`Unsupported tool in disk validation: ${name}`);
}

function makeToolCall(name, args, id = `text_call_${Math.random().toString(16).slice(2)}`) {
  return { id, name, args };
}

function extractTextToolCalls(content) {
  const text = String(content || "");
  const calls = [];
  const xmlPattern = /<tool_use\b[^>]*>([\s\S]*?)<\/tool_use>/gi;
  let xmlMatch;
  while ((xmlMatch = xmlPattern.exec(text))) {
    const body = xmlMatch[1];
    const name = body.match(/<tool>\s*([\w.-]+)\s*<\/tool>/i)?.[1] ||
      body.match(/<name>\s*([\w.-]+)\s*<\/name>/i)?.[1];
    if (!name) continue;
    const args = {};
    const parameterPattern = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
    let parameterMatch;
    while ((parameterMatch = parameterPattern.exec(body))) {
      args[parameterMatch[1]] = parameterMatch[2].trim();
    }
    calls.push(makeToolCall(name, args));
  }

  const patchMatch = text.match(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/);
  if (patchMatch && !calls.some((call) => call.name === "apply_patch")) {
    calls.push(makeToolCall("apply_patch", { patch: patchMatch[0] }));
  }

  for (const fnName of ["apply_patch", "replace_in_file", "write_file", "read_file", "repo_map_search", "repo_map_context", "grep_search"]) {
    const pattern = new RegExp(`${fnName}\\s*\\(\\s*({[\\s\\S]*?})\\s*\\)`, "i");
    const match = text.match(pattern);
    if (!match) continue;
    try {
      calls.push(makeToolCall(fnName, JSON.parse(match[1])));
    } catch {
      // Ignore malformed text-call JSON; the recovery loop will reprompt.
    }
  }
  return calls;
}

function extractToolCalls(message) {
  const native = (message.tool_calls || [])
    .map((call, index) => makeToolCall(
      call?.function?.name || call?.name || "",
      parseToolArgs(call?.function?.arguments || call?.arguments),
      call?.id || `native_call_${index}`,
    ))
    .filter((call) => call.name);
  if (native.length > 0) return { native: true, calls: native };
  return { native: false, calls: extractTextToolCalls(message.content) };
}

function isDiskWriteSatisfied(content) {
  const text = String(content || "");
  return (
    /creatorName\s*:\s*(?!["'`]\s*["'`])/.test(text) &&
    /row\.(?:creator|creator_name)|row\[['"]创建人['"]\]/.test(text)
  );
}

async function runDiskWriteProbe(model) {
  const workspace = await seedDiskWorkspace(model);
  const messages = [
    {
      role: "system",
      content: [
        "You are MAIN approved Execute mode running inside a temporary workspace.",
        "Use tool calls to make real disk changes. Prefer `apply_patch`; `replace_in_file` and `write_file` are available when appropriate.",
        "Do not output full replacement files in chat. Do not claim success until a write tool reports WRITE_OK.",
        "Use repo_map tools for structure and avoid rereading files already supplied in evidence unless exact current content is needed after a patch mismatch.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Approved task: fix CSV creator mapping in `src/hooks/useCsvParser.ts`.",
        "Confirmed evidence digest:",
        "- repo_map_context: `parseCourseOrders` in src/hooks/useCsvParser.ts lines 13-17 maps rows into CourseOrder.",
        "- Dashboard store consumes `CourseOrder.creatorName`; blank creatorName breaks creator ranking.",
        "Current exact target snippet:",
        "```ts",
        "export function parseCourseOrders(rows: RawCourseOrder[]): CourseOrder[] {",
        "  return rows.map((row) => ({",
        "    creatorName: \"\",",
        "    amount: Number(row.sales || 0),",
        "  }));",
        "}",
        "```",
        "Required change: set `creatorName` from `row.creator_name || row.creator || row['创建人'] || 'Unknown'` while preserving amount.",
        "Now execute. The next assistant response should call `apply_patch` or another write tool.",
      ].join("\n"),
    },
  ];
  const toolSequence = [];
  const visibleTexts = [];
  let nativeToolMessagesSupported = true;

  for (let step = 0; step < 6; step += 1) {
    const json = await chat(model, messages, { maxTokens: 1200 });
    const message = firstMessage(json);
    const content = message.content || "";
    if (content) {
      visibleTexts.push(content.slice(0, 1000));
      validateNoProtocolNoise(model, `disk-write-step-${step}`, content.replace(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g, ""));
    }
    validateToolCalls(model, `disk-write-step-${step}`, message.tool_calls);

    const extracted = extractToolCalls(message);
    if (extracted.calls.length === 0) {
      messages.push({ role: "assistant", content: content || "" });
      messages.push({
        role: "user",
        content: "MAIN did not receive a tool call. Continue now with exactly one write tool call: apply_patch, replace_in_file, or write_file. Do not explain.",
      });
      continue;
    }

    if (extracted.native && nativeToolMessagesSupported) {
      messages.push({
        role: "assistant",
        content: content || null,
        tool_calls: extracted.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args || {}),
          },
        })),
      });
    } else {
      messages.push({ role: "assistant", content: content || `[tool calls: ${extracted.calls.map((call) => call.name).join(", ")}]` });
    }

    for (const call of extracted.calls) {
      toolSequence.push(call.name);
      let resultContent;
      try {
        resultContent = await executeWorkspaceTool(workspace, call);
      } catch (error) {
        resultContent = `TOOL_ERROR ${call.name}: ${error.message}`;
      }
      if (extracted.native && nativeToolMessagesSupported) {
        messages.push({ role: "tool", tool_call_id: call.id, content: resultContent });
      } else {
        messages.push({ role: "user", content: `TOOL RESULT for ${call.name}:\n${resultContent}` });
      }
    }

    const current = await readWorkspaceFile(workspace.root, workspace.target);
    if (current !== workspace.original && isDiskWriteSatisfied(current)) {
      return {
        workspace: workspace.root,
        target: workspace.target,
        originalHash: workspace.originalHash,
        finalHash: sha256(current),
        toolSequence,
        finalExcerpt: current.split(/\r?\n/).slice(12, 18).join("\n"),
        visibleTexts: visibleTexts.slice(-2),
      };
    }

    messages.push({
      role: "user",
      content: "The file has not passed verification yet. Use cached context and issue a concrete write tool call now.",
    });
  }

  const finalText = await readWorkspaceFile(workspace.root, workspace.target);
  fail(`${model} did not complete real disk write validation`, {
    workspace: workspace.root,
    target: workspace.target,
    toolSequence,
    finalHash: sha256(finalText),
    finalText,
    visibleTexts,
  });
}

async function runPlanProbe(model) {
  const json = await chat(model, [
    {
      role: "system",
      content: [
        "你是 MAIN 的 Plan 模式代理。批准前只能定向读取和生成可审批计划，不能修改源码。",
        "输出必须是正常 Markdown 或合法 OpenAI tool_calls，不能输出 XML 工具协议、<user_options>、[PROPOSAL START]、半截标签或短小乱码。",
        "计划必须包含明确问题、修复目标、影响文件、验证方式和默认假设；不要把 .MAIN/plans/plan.md 当成证据。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "真实问题：检查并修复 MAIN 调试日志中的 Plan/Approve/Execute 问题。",
        "日志摘录：",
        "1. 生成的 plan.md 出现空用户目标：`- 用户目标：`。",
        "2. 计划关键改动是 `更新 src/hooks/useCsvParser.ts 以落实已批准目标`，目标不明确。",
        "3. grep 证据污染：`MAIN/plans/plan.md:7:- 数据失效原因...` 被当作新证据。",
        "4. UI 短暂出现 `कल`，随后被重置。",
        "5. 批准执行后 replace_in_file 失败：search_text 与文件内容不一致；write_file 缺少 content。",
        "请生成真实修复计划。不要调用 write_file/replace_in_file。",
      ].join("\n"),
    },
  ]);
  const message = firstMessage(json);
  const content = message.content || "";
  validateNoProtocolNoise(model, "plan", content);
  validateToolCalls(model, "plan", message.tool_calls, { forbidMutation: true });
  if (content && !/(?:修复|计划|验证|useCsvParser|Plan|Test Plan|Validation)/i.test(content)) {
    fail(`${model} plan probe returned unrelated content`, { content: content.slice(0, 800) });
  }
  return { contentChars: String(content).length, toolCalls: (message.tool_calls || []).map((call) => call.function?.name || call.name) };
}

async function runExecutionRecoveryProbe(model) {
  const json = await chat(model, [
    {
      role: "system",
      content: [
        "你是 MAIN 批准后的执行代理。用户已经批准计划，但失败 patch 之后必须恢复。",
        "如果 replace_in_file 的 search_text 不匹配，下一步应定向 read_file 一次，然后用精确 patch、验证或明确阻塞。",
        "不要输出协议噪声。不要生成缺少 content 的 write_file。不要生成空变更。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "已批准计划：修复 src/hooks/useCsvParser.ts 中 CSV 字段映射与 Dashboard store 预期不一致的问题。",
        "执行历史：replace_in_file 失败，错误为 `search_text 与文件内容不一致，未执行写入`。",
        "失败参数：path=src/hooks/useCsvParser.ts search_text=`const rows = parseCsv(text);` replace_text=`const rows = parseCsv(text, mapping);`。",
        "现在继续执行，给出下一步或合法工具调用。",
      ].join("\n"),
    },
  ]);
  const message = firstMessage(json);
  const content = message.content || "";
  validateNoProtocolNoise(model, "execute-recovery", content);
  validateToolCalls(model, "execute-recovery", message.tool_calls);
  return { contentChars: String(content).length, toolCalls: (message.tool_calls || []).map((call) => call.function?.name || call.name) };
}

async function main() {
  const modelList = await requestJson("/models");
  const available = new Set((modelList?.data || []).map((item) => item.id));
  for (const model of models) {
    if (!available.has(model)) {
      fail(`Required OMLX model is not available: ${model}`, { available: [...available] });
    }
  }

  const results = [];
  for (const model of models) {
    const plan = await runPlanProbe(model);
    const recovery = await runExecutionRecoveryProbe(model);
    const diskWrite = await runDiskWriteProbe(model);
    results.push({ model, plan, recovery, diskWrite });
  }

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    models,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    endpoint,
    models,
    error: error.message,
    detail: error.detail || {},
  }, null, 2));
  process.exit(1);
});

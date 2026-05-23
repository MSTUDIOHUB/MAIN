#!/usr/bin/env node

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

const tools = [
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
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    fail(`Non-JSON response from ${path}`, { status: response.status, text: text.slice(0, 500) });
  }
  if (!response.ok) {
    fail(`HTTP ${response.status} from ${path}`, { json });
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
    if (forbidMutation && (name === "write_file" || name === "replace_in_file")) {
      fail(`${model} ${probeName} attempted mutation during plan probe`, { name, args });
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
    results.push({ model, plan, recovery });
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

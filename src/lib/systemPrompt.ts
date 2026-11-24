// lib/systemPrompt.ts
// Builds a compact, intent-scoped system contract. Runtime code owns enforcement,
// recovery, approval, and durable progress; this prompt only states model-facing invariants.

import type { Lang, Skill } from "./appTypes";
import type { ResolvedInstructionSet } from "./instructions";
import { mapLegacyNexusModeToMainMode, type MainModeKey } from "./mainModes";
import {
  getApplicableProtocolPackagesForWorkspace,
  getProtocolPackageEntryPath,
} from "./protocolPackages";
import {
  buildEffectiveTurnContract,
  resolveRunIntentFromLegacyWorkflowMode,
  type CommandDirective,
  type EffectiveTurnContract,
  type ResolvedUserIntent,
} from "./runIntent";
import type { GameEngine, PromptLanguageStrategy } from "./toolCapabilities";
import type { ToolDefinition } from "./toolSchemas";
import { buildWebResearchDateContext } from "./webResearchGuard";
/** Generated MAIN instructions should normally stay below this target. */
export const SYSTEM_PROMPT_TARGET_CHARS = 12_000;
/** Hard ceiling including injected workspace instructions and templates. */
export const SYSTEM_PROMPT_MAX_CHARS = 32_000;

export const MAIN_MODE_PROMPTS: Record<MainModeKey, string> = {
  main_mode: "MAIN coordinates scoped analysis, implementation, validation, and reporting for the current user request.",
};

export type GameEnginePromptContext = {
  engine?: GameEngine | string | null;
};

export type McpPriorityPromptContext = {
  engineMcpFirst?: boolean;
  engine?: GameEngine | string | null;
  unityConsoleFirst?: boolean;
  connectedServerNames?: string[];
};

export type LanguageContract = {
  displayLanguage?: Lang;
  resolvedResponseLanguage?: Lang;
};

export type ToolProtocolCardProfile = {
  activeProfile?: "local" | "cloud";
  provider?: string | null;
  model?: string | null;
  toolProtocol?: string | null;
  nativeToolsEnabled?: boolean;
  workflowMode?: "chat" | "edit" | "plan";
  availableToolNames?: string[];
  /** Exact active definitions. Native and XML paths must derive from these schemas. */
  toolDefinitions?: ToolDefinition[];
  /** Runtime compaction may omit prose descriptions while retaining exact signatures. */
  descriptionMaxChars?: number;
  language?: Lang;
};

function languageName(language: Lang | undefined, fallback: Lang = "zh"): string {
  return (language === "en" ? "en" : language === "zh" ? "zh" : fallback) === "en"
    ? "English"
    : "简体中文";
}

export function detectInstructionLanguage(
  _model: string | null | undefined,
  preferredResponseLanguage: Lang,
  strategy: PromptLanguageStrategy,
  _provider?: string,
): "en" | "zh" {
  if (strategy === "pure_user_language") return preferredResponseLanguage === "en" ? "en" : "zh";
  if (strategy === "pure_english" || strategy === "english_core_localized_output") return "en";
  // `model_aware` is retained as a persisted setting name, but instruction
  // language is deliberately model-neutral. Switching local models must not
  // silently change the guidance contract.
  return preferredResponseLanguage === "en" ? "en" : "zh";
}

export function buildLanguageContract(input: {
  displayLanguage?: Lang;
  resolvedResponseLanguage?: Lang;
}): string {
  const displayLanguage = input.displayLanguage === "en" ? "en" : "zh";
  const responseLanguage = input.resolvedResponseLanguage === "en" ? "en" : "zh";
  return [
    "[LANGUAGE]",
    `displayLanguage=${displayLanguage}; resolvedResponseLanguage=${responseLanguage}.`,
    `Write all user-visible prose, plans, summaries, and approval choices in ${languageName(responseLanguage)}.`,
    "Keep tool names, JSON/XML keys, code, commands, identifiers, and paths unchanged.",
  ].join("\n");
}

function schemaTypeName(schema: { type?: string; enum?: string[] } | undefined): string {
  if (!schema) return "value";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.join("|");
  return schema.type || "value";
}

function compactSchemaSignature(tool: ToolDefinition): string {
  const properties = tool.function.parameters?.properties || {};
  const required = new Set(tool.function.parameters?.required || []);
  const args = Object.entries(properties)
    .map(([name, schema]) => `${name}${required.has(name) ? "" : "?"}: ${schemaTypeName(schema)}`)
    .join(", ");
  return `${tool.function.name}(${args})`;
}

function compactSchemaDescription(description: string, maxChars = 180): string {
  const normalized = String(description || "").replace(/\s+/g, " ").trim();
  if (maxChars <= 0) return "";
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function schemaExampleValue(name: string, schema: { type?: string; enum?: string[] }): string {
  if (schema.enum?.length) return String(schema.enum[0]);
  if (schema.type === "boolean") return "true";
  if (schema.type === "number" || schema.type === "integer") return "1";
  if (name === "path") return "src/example.ts";
  if (name === "cwd" || name === "workdir") return ".";
  if (name === "url") return "https://example.com";
  if (name === "patch") return "*** Begin Patch\n*** End Patch";
  return "value";
}

function selectExampleDefinition(definitions: ToolDefinition[]): ToolDefinition | null {
  if (definitions.length === 0) return null;
  return definitions.find((tool) => tool.function.name === "read_file") || definitions[0] || null;
}

function buildXmlExample(tool: ToolDefinition | null, fallbackName: string): string[] {
  if (!tool) {
    return fallbackName
      ? ["<tool_call>", JSON.stringify({ name: fallbackName, arguments: {} }), "</tool_call>"]
      : [];
  }
  const required = new Set(tool.function.parameters?.required || []);
  const entries = Object.entries(tool.function.parameters?.properties || {})
    .filter(([name]) => required.has(name))
    .slice(0, 4);
  const exampleArgs: Record<string, unknown> = {};
  for (const [name, schema] of entries) {
    const raw = schemaExampleValue(name, schema);
    if (schema.type === "boolean") exampleArgs[name] = raw === "true";
    else if (schema.type === "number" || schema.type === "integer") exampleArgs[name] = Number(raw);
    else exampleArgs[name] = raw;
  }
  return [
    "<tool_call>",
    JSON.stringify({ name: tool.function.name, arguments: exampleArgs }),
    "</tool_call>",
  ];
}

export function buildToolProtocolCard(profile: ToolProtocolCardProfile): string {
  const language = profile.language === "en" ? "en" : "zh";
  const availableNames = [...new Set((profile.availableToolNames || []).filter(Boolean))];
  const availableSet = new Set(availableNames);
  const definitions = (profile.toolDefinitions || [])
    .filter((tool) => availableSet.has(tool.function.name));
  const rawProtocol = String(profile.toolProtocol || "auto").toLowerCase();
  // Protocol selection follows the capability surface, not model/provider
  // identity. The same active tools therefore produce the same contract for
  // every model.
  const usesXml = rawProtocol === "xml" || (
    profile.nativeToolsEnabled !== true &&
    (rawProtocol === "auto" || rawProtocol === "")
  );

  if (!usesXml && profile.nativeToolsEnabled) {
    return [
      "[TOOLS]",
      `protocol=native; available=${availableNames.join(", ") || "none"}.`,
      availableSet.has("tool_search")
        ? (language === "zh"
            ? "默认仅暴露高频核心工具；若需要更多专业工具（如 git、浏览器、表格、子代理、MCP 工具），请先调用 tool_search 解锁。"
            : "Only core tools are exposed by default; call tool_search to discover and unlock specialized or MCP tools on demand.")
        : "",
      language === "zh"
        ? "工具 schema 是名称、参数和描述的唯一事实来源。需要工具时直接发起 native tool call；不要在正文伪造 JSON/XML 或输出 `[Tool call: ...]`。"
        : "The native schemas are the sole source of truth for tool names, arguments, and descriptions. Call tools directly via native tool calls; do not emit pseudo JSON/XML or `[Tool call: ...]` in prose.",
    ].filter(Boolean).join("\n");
  }

  if (availableNames.length === 0) {
    return [
      "[TOOLS]",
      "protocol=xml-text; available=none.",
      language === "zh"
        ? "本轮没有工具。不要输出 XML、伪工具调用或假装已经读取、修改、运行或验证。"
        : "No tools are available this turn. Do not emit XML, pseudo calls, or pretend to have read, changed, run, or validated anything.",
    ].join("\n");
  }

  const catalog = definitions.length > 0
    ? definitions.map((tool) => {
        const description = compactSchemaDescription(
          tool.function.description,
          profile.descriptionMaxChars,
        );
        return `- ${compactSchemaSignature(tool)}${description ? ` — ${description}` : ""}`;
      })
    : availableNames.map((name) => `- ${name}()`);
  const example = buildXmlExample(selectExampleDefinition(definitions), availableNames[0] || "");
  return [
    "[TOOLS]",
    "protocol=xml-text.",
    language === "zh"
      ? "需要工具时输出一个完整的 `<tool_call>{\"name\": \"...\", \"arguments\": {...}}</tool_call>` 块，参数名必须与下列目录一致："
      : "When a tool is needed, output a complete `<tool_call>{\"name\": \"...\", \"arguments\": {...}}</tool_call>` block matching the catalog below:",
    ...catalog,
    "Example:",
    ...example,
    language === "zh"
      ? "禁止输出 `[Tool call: ...]` 或自然语言工具占位符。"
      : "Never emit `[Tool call: ...]` or a prose placeholder for a tool call.",
  ].join("\n");
}

const WORKSPACE_IGNORE_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".idea", ".vscode", ".vs", "dist", "build",
  "out", "bin", "obj", "target", "vendor", "__pycache__", ".next", ".nuxt", ".cache",
  ".turbo", "coverage", ".gradle", ".dart_tool", ".fvm", ".DS_Store",
]);

export function formatWorkspaceTree(entries: Array<{ name: string; isDirectory: boolean }>): string {
  return entries
    .filter((entry) => !WORKSPACE_IGNORE_DIRS.has(entry.name) && !entry.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((entry) => `${entry.isDirectory ? "[D]" : "[F]"} ${entry.name}`)
    .join("\n");
}

export function buildSubagentSystemPrompt(input: {
  workspace: string;
  language: Lang;
  availableToolNames: string[];
  scopeKey: string;
  allowedPaths: string[];
  accessMode: "read" | "write";
}): string {
  const outputLanguage = languageName(input.language);
  const writeMode = input.accessMode === "write";
  return [
    "You are a fresh one-shot MAIN subagent executing one immutable semantic task. Your runtime identity will be permanently closed afterward.",
    `Workspace: ${input.workspace || "none"}`,
    `Scope: ${input.scopeKey}`,
    `Access mode: ${input.accessMode}`,
    `Allowed paths: ${input.allowedPaths.join(", ") || "none"}`,
    `Available tools: ${input.availableToolNames.join(", ") || "none"}`,
    writeMode
      ? "Stay inside the exact inherited write lease. Use only the exposed structured read/search/mutation tools; do not run commands, request or expand approval, spawn agents, or address the user."
      : "Stay inside the allowed paths. Read/search only; do not write, run commands, request approval, spawn agents, or address the user.",
    "Return concise task results with exact paths, runtime-backed evidence, uncertainty, and remaining in-scope work.",
    `Write the report in ${outputLanguage}; keep paths and identifiers unchanged.`,
  ].join("\n");
}

function normalizePromptEngine(engine?: string | null): "unity" | "godot" | "unreal" | null {
  const normalized = String(engine || "").trim().toLowerCase();
  if (normalized === "unity" || normalized === "godot" || normalized === "unreal") return normalized;
  return null;
}

function makeSection(title: string, lines: Array<string | null | undefined | false>): string {
  return [`[${title}]`, ...lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0)].join("\n");
}

function compactExternalContent(value: string, maxChars: number): string {
  const content = String(value || "").trim();
  if (content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(0, maxChars - 80))}\n[TRUNCATED BY SYSTEM PROMPT BUDGET]`;
}

function joinWithinPromptBudget(sections: string[]): string {
  const output: string[] = [];
  let used = 0;
  for (const section of sections) {
    const separator = output.length > 0 ? 2 : 0;
    const remaining = SYSTEM_PROMPT_MAX_CHARS - used - separator;
    if (remaining <= 0) break;
    const fitted = section.length <= remaining
      ? section
      : compactExternalContent(section, remaining);
    if (!fitted) break;
    output.push(fitted);
    used += separator + fitted.length;
    if (fitted.length < section.length) break;
  }
  return output.join("\n\n");
}

function buildIntentModule(input: {
  intent: ResolvedUserIntent;
  contract: EffectiveTurnContract;
}): string {
  const { intent, contract } = input;

  if (intent === "plan") {
    return makeSection("PLAN", [
      "The runtime injects a versioned PLAN AUTHORING CONTRACT before every model step. Treat its canonical objective, acceptance criteria, current stage, and explicit violations as the single planning protocol.",
      "Follow the fixed sequence: understand the objective, gather only decision-changing read-only evidence, draft against the declared criteria, revise only declared violations, then stop for review.",
      "Before the first action, identify the exact objective, known inputs, and smallest material unknown from that contract. Do not begin with an unconstrained draft or broad repository scan.",
      "The quality gate checks the criteria disclosed before drafting. A rejection may request evidence or revision, but must not silently redefine the user's task or acceptance boundary.",
      "Do not turn your own read/check/fix ordering into user choices. Ask only when a user-owned product, scope, technology, or priority decision blocks the plan.",
      "When ready, submit one complete typed Plan graph through the transport declared by the latest injected [PLAN AUTHORING CONTRACT], then stop. MAIN runtime, not the model, validates it and renders `.MAIN/plans/plan.md`.",
      "For a multi-step turn, optionally give a brief user-facing update only when a material finding changes the plan. Do not narrate file reads, searches, or tool names.",
      "Do not edit source files or write plan artifacts before approval.",
    ]);
  }

  if (intent === "execute") {
    return makeSection("EXECUTE", [
      "Use the exposed tools to read relevant files, make targeted edits, and run verification checks.",
      "Prefer replace_in_file for focused edits and write_file for new files or full rewrites. A successful write proves only that exact mutation.",
      "Do not stop after describing intended steps when a tool can perform the next action directly.",
    ]);
  }


  const approvalNeeded = contract.operationApprovalState !== "approved" && contract.mutationExpected;
  return makeSection(`TURN INTENT: ${intent.toUpperCase()}`, [
    "Answer, explain, inspect, analyze, summarize, or report from available evidence.",
    "Use safe read-only tools autonomously when they materially improve accuracy; do not ask permission merely to use a safe fallback reader.",
    approvalNeeded
      ? "A real mutation is not approved in this turn. Explain the proposed operation and emit one `<user_options>` choice with `action=\"approve_operation_once\"`; stop after the options."
      : "If a needed mutation or command is not exposed, state the exact capability or approval blocker instead of pretending it ran.",
  ]);
}

function buildGameEngineMcpModule(
  context: GameEnginePromptContext | undefined,
  priority: McpPriorityPromptContext | undefined,
): string {
  const engine = normalizePromptEngine(context?.engine || priority?.engine);
  const connected = (priority?.connectedServerNames || []).join(", ") || "none";
  const lines = [
    `engine: ${engine || "unconfigured"}`,
    `connectedMcpServers: ${connected}`,
    "Prefer matching engine MCP/editor tools for live scene, asset, console, and editor state; use workspace files for source and configuration evidence.",
    "Inspect current editor state before mutation and validate the resulting engine state after mutation when the connected tools expose those operations.",
  ];
  if (engine === "unity" && priority?.unityConsoleFirst) {
    lines.push("For Unity console diagnostics, call read_console first. Do not start with a project skeleton or local log scan; use script_apply_edits for supported C# edits when available.");
  }
  if (engine === "godot") {
    lines.push("For Godot work, inspect scene trees, nodes, resources, scripts, and editor output before editing `.tscn`, `.tres`, or `.gd` files.");
  }
  if (engine === "unreal") {
    lines.push("For Unreal work, inspect the current Actor, level, asset or Blueprint references and Output Log before editing.");
  }
  return makeSection("GAME ENGINE MCP", lines);
}

function buildInstructionSections(
  skills: Skill[],
  workspace: string,
  resolvedInstructions?: ResolvedInstructionSet | null,
): string[] {
  const sections: string[] = [];
  if (resolvedInstructions?.layers.length) {
    const content = resolvedInstructions.layers.map((layer) => {
      const source = layer.source.path && !layer.source.path.startsWith("skill:")
        ? ` (${layer.source.path})`
        : "";
      return `### ${layer.title}${source}\n${layer.content}`;
    }).join("\n\n");
    sections.push(makeSection("WORKSPACE INSTRUCTIONS", [compactExternalContent(content, 10_000)]));
  } else {
    const active = skills.filter((skill) => skill.active && (!skill.type || skill.type === "instruction"));
    if (active.length) {
      const content = active.map((skill) => `### ${skill.name}\n${skill.content}`).join("\n\n");
      sections.push(makeSection("ACTIVE WORKFLOW SKILLS", [compactExternalContent(content, 10_000)]));
    }
  }

  if (resolvedInstructions?.templates.length) {
    const templates = resolvedInstructions.templates
      .map((template) => `### ${template.title}\n${template.content}`)
      .join("\n\n");
    sections.push(makeSection("WORKSPACE TEMPLATES", [compactExternalContent(templates, 5_000)]));
  }

  const packages = getApplicableProtocolPackagesForWorkspace(skills, workspace);
  if (packages.length) {
    const entries = packages.map((pkg) => {
      const entry = getProtocolPackageEntryPath(pkg) || pkg.entryPoint || "SKILL.md";
      return `- ${pkg.name}: ${entry}`;
    });
    sections.push(makeSection("ACTIVE PROFESSIONAL PROTOCOLS", [
      ...entries,
      "Read an exact entry path only when relevant. If it is missing, check its package root once; do not scan the workspace repeatedly.",
    ]));
  }
  return sections;
}

export function buildSystemPrompt(
  skills: Skill[],
  workspace: string,
  mainModeKey: MainModeKey | string = "main_mode",
  workspaceTree?: string,
  _customToolNames?: string[],
  _mcpToolNames?: string[],
  workflowMode?: "chat" | "edit" | "plan",
  uiLanguage: Lang = "zh",
  resolvedInstructions?: ResolvedInstructionSet | null,
  gameEngineContext?: GameEnginePromptContext,
  turnIntentOverride?: ResolvedUserIntent,
  promptLanguageStrategy: PromptLanguageStrategy = "english_core_localized_output",
  availableToolNames?: string[],
  commandDirective?: CommandDirective | null,
  mcpPriorityContext?: McpPriorityPromptContext,
  languageContract?: LanguageContract,
  toolProtocolProfile?: Omit<ToolProtocolCardProfile, "availableToolNames" | "workflowMode" | "language">,
  effectiveTurnContract?: EffectiveTurnContract,

): string {
  const displayLanguage = languageContract?.displayLanguage === "en" ? "en" : "zh";
  const responseLanguage = languageContract?.resolvedResponseLanguage
    ? (languageContract.resolvedResponseLanguage === "en" ? "en" : "zh")
    : (uiLanguage === "en" ? "en" : "zh");
  const instructionLanguage = detectInstructionLanguage(
    toolProtocolProfile?.model,
    responseLanguage,
    promptLanguageStrategy,
    toolProtocolProfile?.provider || toolProtocolProfile?.activeProfile,
  );
  const intent = turnIntentOverride || resolveRunIntentFromLegacyWorkflowMode(workflowMode || "chat");
  const contract = effectiveTurnContract || buildEffectiveTurnContract({
    conversationIntent: intent,
    runtimeIntent: intent,
    commandDirective,
  });
  const tools = availableToolNames || [];
  const toolSet = new Set(tools);
  const normalizedMode = mapLegacyNexusModeToMainMode(mainModeKey);
  const sections: string[] = [];

  sections.push(makeSection("ROLE", [
    MAIN_MODE_PROMPTS[normalizedMode],
    "Work on the user's actual request, using supplied text, screenshots, attachments, paths, and logs as primary turn context.",
    "Gather the smallest evidence that can decide the next action. Do not replace the user's goal with a convenient nearby edit.",
  ]));

  sections.push(makeSection("TURN CONTRACT", [
    `intent=${contract.runtimeIntent}.`,
    commandDirective && commandDirective.kind !== "none"
      ? `commandDirective=${commandDirective.kind}${commandDirective.action ? `/${commandDirective.action}` : ""}${commandDirective.target ? `; target=${commandDirective.target}` : ""}.`
      : null,
  ]));

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const dayNamesEn = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayNamesZh = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const dayOfWeek = displayLanguage === "en" ? dayNamesEn[now.getDay()] : dayNamesZh[now.getDay()];
  const currentDate = `${dateStr} (${dayOfWeek})`;

  sections.push(makeSection("ENVIRONMENT", [
    `Current local date: ${currentDate}. Anchor all relative time references (e.g. today, this week, next week, current year) to this date.`,
    workspace
      ? `Workspace root: ${workspace}. Resolve relative file and command paths from this root.`
      : "No workspace is bound. Do not infer or scan a recent project; use only explicitly supplied context and exposed external readers.",
    "When `[turn_intake]` is present, its `[user_request]`, images, attachments, and @files define this turn's objective and evidence.",
    workspaceTree ? `Shallow workspace map:\n${compactExternalContent(workspaceTree, 2_000)}` : null,
  ]));

  sections.push(buildLanguageContract({
    displayLanguage,
    resolvedResponseLanguage: responseLanguage,
  }));

  sections.push(makeSection("AUTONOMY AND SAFETY", [
    "Use exposed read-only tools without step-by-step consent. The runtime enforces intent-scoped tool exposure and approvals for mutations, commands, browser control, desktop control, external writes, and destructive operations.",
    "Never bypass a missing file tool with shell paging or shell-based source writes. Use the structured file tools when exposed.",
    "Treat existing workspace changes as user-owned. Scope edits to the request and do not revert unrelated work.",
    "Do not create `.MAIN/steering` or steering documents unless the user explicitly requests them. Already injected workspace instructions are authoritative; do not rescan for them.",
  ]));

  sections.push(buildToolProtocolCard({
    ...toolProtocolProfile,
    workflowMode,
    availableToolNames: tools,
    language: instructionLanguage,
  }));

  sections.push(buildIntentModule({ intent, contract }));

  sections.push(makeSection("COMPLETION", [
    "Track every requested outcome, not merely whether any tool succeeded. A mutation, command, or read is evidence for only the outcome it actually addresses.",
    "Before reporting completion, confirm that each requested outcome has corresponding artifact/diff evidence and that required validation ran successfully.",
    "If another safe edit is still needed during validation, request that edit tool; the runtime may reopen the mutation phase for distinct remaining outcomes while each cycle yields new evidence or a materially changed validation result.",
    "If work cannot continue, still close the Turn with an explicit result and state the unresolved outcome, attempted evidence, and blocker. Application lifecycle is completed, paused for a real external action, or aborted; execution errors are completed(error), not a top-level failed state.",
  ]));

  if (toolSet.has("web_search") || toolSet.has("web_fetch")) {
    sections.push(makeSection("WEB RESEARCH", [
      buildWebResearchDateContext(instructionLanguage),
      "Use web tools for current or externally sourced facts. Prefer primary sources, distinguish event date from publication date, and cite source URLs in the final answer.",
    ]));
  }

  if (["analyze_tabular_document", "query_tabular_document", "read_document"].some((name) => toolSet.has(name))) {
    sections.push(makeSection("TABULAR", [
      "For CSV/TSV/XLSX or aggregate reporting, establish table structure, key fields, types, missing values, and aggregation semantics before drawing conclusions.",
      "Prefer analyze_tabular_document for overview, query_tabular_document for filters/aggregates, and bounded read_document windows for raw rows.",
    ]));
  }

  if (gameEngineContext?.engine || mcpPriorityContext?.engineMcpFirst) {
    sections.push(buildGameEngineMcpModule(gameEngineContext, mcpPriorityContext));
  }


  sections.push(...buildInstructionSections(skills, workspace, resolvedInstructions));
  return joinWithinPromptBudget(sections);
}

// lib/systemPrompt.ts
// Builds a compact, intent-scoped system contract. Runtime code owns enforcement,
// recovery, approval, and durable progress; this prompt only states model-facing invariants.

import type { Lang, Skill } from "./appTypes";
import type { ResolvedInstructionSet } from "./instructions";
import type { PendingSlashCommand, StudioAgentKey, StudioConfig } from "./gameStudio/catalog";
import { mapLegacyNexusModeToMainMode, type MainModeKey } from "./mainModes";
import { getCachedCapabilities, heuristicDetectCapabilities } from "./modelProbe";
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
import type { PromptLanguageStrategy } from "./toolCapabilities";
import type { ToolDefinition } from "./toolSchemas";
import { buildWebResearchDateContext } from "./webResearchGuard";
import type { GoalTurnContract } from "./goalState";

/** Generated MAIN instructions should normally stay below this target. */
export const SYSTEM_PROMPT_TARGET_CHARS = 12_000;
/** Hard ceiling including injected workspace instructions and templates. */
export const SYSTEM_PROMPT_MAX_CHARS = 32_000;

export const MAIN_MODE_PROMPTS: Record<MainModeKey, string> = {
  main_mode: "MAIN coordinates scoped analysis, implementation, validation, and reporting for the current user request.",
  game_studio: "Game Studio coordinates design, engineering, art, QA, release, and engine-specific editor workflows.",
  image_studio: "Image Studio belongs to the image runtime; do not enter the ordinary code-agent loop.",
};

export type GameStudioPromptContext = {
  initialized?: boolean;
  activeStudioAgentKey?: StudioAgentKey;
  pendingSlashCommand?: PendingSlashCommand | null;
  studioConfig?: StudioConfig | null;
};

export type McpPriorityPromptContext = {
  gameStudioMcpFirst?: boolean;
  unityMcpFirst?: boolean;
  engine?: "unity" | "godot" | "unreal" | string | null;
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
  modelProtocolNotes?: string[];
  workflowMode?: "chat" | "edit" | "plan";
  availableToolNames?: string[];
  /** Exact active definitions. Native and XML paths must derive from these schemas. */
  toolDefinitions?: ToolDefinition[];
  language?: Lang;
};

function languageName(language: Lang | undefined, fallback: Lang = "zh"): string {
  return (language === "en" ? "en" : language === "zh" ? "zh" : fallback) === "en"
    ? "English"
    : "简体中文";
}

export function detectInstructionLanguage(
  model: string | null | undefined,
  preferredResponseLanguage: Lang,
  strategy: PromptLanguageStrategy,
  provider?: string,
): "en" | "zh" {
  if (strategy === "pure_user_language") return preferredResponseLanguage === "en" ? "en" : "zh";
  if (strategy === "pure_english" || strategy === "english_core_localized_output") return "en";
  if (!model) return preferredResponseLanguage === "en" ? "en" : "zh";

  if (provider) {
    const cacheKey = `probe:${provider.toLowerCase()}:${model.toLowerCase()}`;
    const cached = getCachedCapabilities(cacheKey);
    if (cached) return cached.instructionLanguage;
  }
  return heuristicDetectCapabilities(model, preferredResponseLanguage).instructionLanguage;
}

function resolveCapabilityLevel(
  model: string | undefined,
  provider: string | undefined,
  preferredResponseLanguage: Lang,
): number {
  if (!model) return 2;
  if (provider) {
    const cached = getCachedCapabilities(`probe:${provider.toLowerCase()}:${model.toLowerCase()}`);
    if (cached) return cached.capabilityLevel;
  }
  return heuristicDetectCapabilities(model, preferredResponseLanguage).capabilityLevel;
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

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

function compactSchemaDescription(description: string): string {
  const normalized = String(description || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
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
      ? ["<tool_use>", `<tool>${xmlEscape(fallbackName)}</tool>`, "</tool_use>"]
      : [];
  }
  const required = new Set(tool.function.parameters?.required || []);
  const entries = Object.entries(tool.function.parameters?.properties || {})
    .filter(([name]) => required.has(name))
    .slice(0, 4);
  return [
    "<tool_use>",
    `<tool>${xmlEscape(tool.function.name)}</tool>`,
    ...entries.map(([name, schema]) => (
      `<parameter name=\"${xmlEscape(name)}\">${xmlEscape(schemaExampleValue(name, schema))}</parameter>`
    )),
    "</tool_use>",
  ];
}

export function buildToolProtocolCard(profile: ToolProtocolCardProfile): string {
  const language = profile.language === "en" ? "en" : "zh";
  const availableNames = [...new Set((profile.availableToolNames || []).filter(Boolean))];
  const availableSet = new Set(availableNames);
  const definitions = (profile.toolDefinitions || [])
    .filter((tool) => availableSet.has(tool.function.name));
  const rawProtocol = String(profile.toolProtocol || "auto").toLowerCase();
  const usesXml = rawProtocol === "xml" || (
    profile.activeProfile === "local" &&
    profile.nativeToolsEnabled !== true &&
    (rawProtocol === "auto" || rawProtocol === "")
  );
  const provider = `${profile.activeProfile || "unknown"}/${profile.provider || "unknown"}`;
  const modelNotes = (profile.modelProtocolNotes || [])
    .map((note) => String(note || "").trim())
    .filter(Boolean)
    .slice(0, 2);

  if (!usesXml && profile.nativeToolsEnabled) {
    return [
      "[TOOLS]",
      `profile=${provider}; protocol=native; available=${availableNames.join(", ") || "none"}.`,
      language === "zh"
        ? "工具 schema 是名称、参数和描述的唯一事实来源。需要工具时直接发起 native tool call；不要在正文复制工具目录、伪造 JSON/XML 或输出 `[Tool call: ...]`。"
        : "The native schemas are the sole source of truth for tool names, arguments, and descriptions. Call tools directly; do not copy a tool catalog into prose or emit pseudo JSON/XML or `[Tool call: ...]`.",
      ...modelNotes.map((note) => `Provider normalization: ${note}`),
    ].join("\n");
  }

  if (availableNames.length === 0) {
    return [
      "[TOOLS]",
      `profile=${provider}; protocol=xml-text; available=none.`,
      language === "zh"
        ? "本轮没有工具。不要输出 XML、伪工具调用或假装已经读取、修改、运行或验证。"
        : "No tools are available this turn. Do not emit XML, pseudo calls, or pretend to have read, changed, run, or validated anything.",
    ].join("\n");
  }

  const catalog = definitions.length > 0
    ? definitions.map((tool) => {
        const description = compactSchemaDescription(tool.function.description);
        return `- ${compactSchemaSignature(tool)}${description ? ` — ${description}` : ""}`;
      })
    : availableNames.map((name) => `- ${name}()`);
  const example = buildXmlExample(selectExampleDefinition(definitions), availableNames[0] || "");
  return [
    "[TOOLS]",
    `profile=${provider}; protocol=xml-text.`,
    language === "zh"
      ? "以下目录由本轮真实 schema 动态生成。需要工具时只输出一个完整 XML 工具块，不要混排正文；参数名必须与目录完全一致。"
      : "This catalog is generated from the active schemas. When a tool is needed, output exactly one complete XML block with no surrounding prose; argument names must match the catalog exactly.",
    ...catalog,
    "Example:",
    ...example,
    language === "zh"
      ? "禁止输出 `[Tool call: ...]`、`<tool_code>` 或自然语言工具占位符。"
      : "Never emit `[Tool call: ...]`, `<tool_code>`, or a prose placeholder for a tool call.",
    ...modelNotes.map((note) => `Provider normalization: ${note}`),
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
}): string {
  const outputLanguage = languageName(input.language);
  return [
    "You are a bounded read-only MAIN subagent collecting evidence for one delegated scope.",
    `Workspace: ${input.workspace || "none"}`,
    `Scope: ${input.scopeKey}`,
    `Allowed paths: ${input.allowedPaths.join(", ") || "none"}`,
    `Available tools: ${input.availableToolNames.join(", ") || "none"}`,
    "Stay inside the allowed paths. Read/search only; do not write, run commands, request approval, spawn agents, or address the user.",
    "Return concise findings with exact paths, evidence, uncertainty, and remaining work.",
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
  availableTools: string[];
}): string {
  const { intent, contract, availableTools } = input;
  const available = new Set(availableTools);
  const writeTools = ["apply_patch", "replace_in_file", "write_file"].filter((name) => available.has(name));
  const validationTools = ["run_command", "execute_command", "browser_evaluate", "git_diff"].filter((name) => available.has(name));

  if (intent === "plan") {
    return makeSection("PLAN", [
      "Gather only the read-only evidence needed to remove material uncertainty.",
      "Describe the desired result, grounded current state, affected boundary, implementation path, and executable validation.",
      "Do not turn your own read/check/fix ordering into user choices. Ask only when a user-owned product, scope, technology, or priority decision blocks the plan.",
      "When ready, output one visible `<proposed_plan>` Markdown block and stop. MAIN runtime, not the model, validates and materializes `.MAIN/plans/plan.md`.",
      "Do not edit source files or write plan artifacts before approval.",
    ]);
  }

  if (intent === "execute") {
    return makeSection("EXECUTE", [
      `Available mutation tools: ${writeTools.join(", ") || "none"}.`,
      `Available validation tools: ${validationTools.join(", ") || "none"}.`,
      "Act on the user request with the smallest relevant context reads and targeted edits. Do not stop after narrating intended steps when an exposed tool can perform the next safe action.",
      "Prefer a delta edit over rewriting a large existing file. After editing, inspect the actual diff when available and run the most relevant exposed validation.",
      "A successful write proves only that exact mutation. It does not prove that the user's other requested outcomes are complete.",
    ]);
  }

  if (intent === "goal") {
    return makeSection("GOAL (AUTONOMOUS EXECUTION)", [
      "The Goal runtime owns continuity, budget, checkpoints, pause/resume, and final completion state for the existing goal.",
      "Continue safe in-scope work without asking for ordinary operation approval. Do not create a new goal or emit `approve_operation_once`.",
      "Pause only for a genuine user-owned decision, external blocker, permission boundary, or exhausted runtime contract.",
      "Report `GOAL_COMPLETION_CANDIDATE` only after every completion criterion has runtime evidence.",
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

function buildGameStudioModule(
  context: GameStudioPromptContext | undefined,
  priority: McpPriorityPromptContext | undefined,
): string {
  const engine = normalizePromptEngine(context?.studioConfig?.engine || priority?.engine);
  const connected = (priority?.connectedServerNames || []).join(", ") || "none";
  const lines = [
    "protocolEntry: .protocols/game-studio/SKILL.md",
    `initialized: ${context?.initialized ? "true" : "false"}`,
    `activeStudioAgent: ${context?.activeStudioAgentKey || "studio_auto"}`,
    `pendingSlashCommand: ${context?.pendingSlashCommand?.canonicalCommand || "none"}`,
    `engine: ${engine || "unconfigured"}`,
    "Read the protocol entry and only the relevant on-disk command/agent/template files on demand; do not preload the whole pack.",
    "Use the active specialist as a working perspective while preserving studio-wide coordination.",
  ];
  if (priority?.gameStudioMcpFirst || priority?.unityMcpFirst) {
    lines.push(`connectedMcpServers: ${connected}`);
    lines.push("Prefer matching engine MCP/editor tools for live scene, asset, console, and editor state; use workspace files for source and configuration evidence.");
    if (engine === "unity" && priority.unityConsoleFirst) {
      lines.push("For Unity console diagnostics, call read_console first. Do not start with a project skeleton or local log scan; use script_apply_edits for supported C# edits when available.");
    }
    if (engine === "godot") {
      lines.push("For Godot work, inspect scene trees, nodes, resources, scripts, and editor output before editing `.tscn`, `.tres`, or `.gd` files.");
    }
    if (engine === "unreal") {
      lines.push("For Unreal work, inspect the current Actor, level, asset or Blueprint references and Output Log before editing.");
    }
  }
  return makeSection("MAIN GAME STUDIO", lines);
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
  gameStudioContext?: GameStudioPromptContext,
  turnIntentOverride?: ResolvedUserIntent,
  promptLanguageStrategy: PromptLanguageStrategy = "english_core_localized_output",
  availableToolNames?: string[],
  commandDirective?: CommandDirective | null,
  mcpPriorityContext?: McpPriorityPromptContext,
  languageContract?: LanguageContract,
  toolProtocolProfile?: Omit<ToolProtocolCardProfile, "availableToolNames" | "workflowMode" | "language">,
  effectiveTurnContract?: EffectiveTurnContract,
  goalTurnContract?: GoalTurnContract | null,
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
    `conversationIntent=${contract.conversationIntent}; runtimeIntent=${contract.runtimeIntent}.`,
    `planReviewState=${contract.planReviewState}; operationApprovalState=${contract.operationApprovalState}; allowedToolRisks=${contract.allowedToolRisks}.`,
    `mutationExpected=${contract.mutationExpected}; validationExpected=${contract.validationExpected}; completionEvidence=${contract.completionEvidenceRequired}.`,
    commandDirective && commandDirective.kind !== "none"
      ? `commandDirective=${commandDirective.kind}${commandDirective.action ? `/${commandDirective.action}` : ""}${commandDirective.target ? `; target=${commandDirective.target}` : ""}.`
      : null,
  ]));

  sections.push(makeSection("ENVIRONMENT", [
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
    "Use exposed read-only tools without step-by-step consent. The runtime enforces intent-scoped tool exposure and approvals for mutations, commands, browser control, external writes, and destructive operations.",
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

  sections.push(buildIntentModule({ intent, contract, availableTools: tools }));

  sections.push(makeSection("COMPLETION", [
    "Track every requested outcome, not merely whether any tool succeeded. A mutation, command, or read is evidence for only the outcome it actually addresses.",
    "Before reporting completion, confirm that each requested outcome has corresponding artifact/diff evidence and that required validation ran successfully.",
    "If the model discovers that another safe edit is still needed during validation, request that edit tool; the runtime may reopen mutation once while retaining the pending validation checkpoint.",
    "If work cannot continue, state the exact unresolved outcome, attempted evidence, and blocker. Keep completed, paused, failed, aborted, and no-action outcomes distinct.",
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

  if (normalizedMode === "game_studio") {
    sections.push(buildGameStudioModule(gameStudioContext, mcpPriorityContext));
  } else if (mcpPriorityContext?.unityMcpFirst || mcpPriorityContext?.gameStudioMcpFirst) {
    sections.push(buildGameStudioModule(gameStudioContext, mcpPriorityContext));
  }

  if (intent === "goal" && goalTurnContract?.context) {
    sections.push(makeSection("GOAL RUNTIME CONTRACT", [compactExternalContent(goalTurnContract.context, 5_000)]));
  }

  // Keep provider adaptation structural and bounded; stronger models do not need extra ceremony.
  const capabilityLevel = resolveCapabilityLevel(
    toolProtocolProfile?.model || undefined,
    toolProtocolProfile?.provider || toolProtocolProfile?.activeProfile,
    responseLanguage,
  );
  if (capabilityLevel <= 1) {
    sections.push(makeSection("LOCAL MODEL FOCUS", [
      "Choose one concrete next action at a time. Use exact schema argument names and inspect the latest tool result before selecting the next action.",
    ]));
  }

  sections.push(...buildInstructionSections(skills, workspace, resolvedInstructions));
  return joinWithinPromptBudget(sections);
}

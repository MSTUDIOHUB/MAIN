import type { PendingSlashCommand } from "./gameStudioCatalog";
import type { MainModeKey } from "./mainModes";

export type LegacyWorkflowMode = "chat" | "edit" | "plan";
export type ResolvedUserIntent =
  | "discuss"
  | "plan"
  | "execute"
  | "analyze"
  | "summarize"
  | "report"
  | "studio_workflow";
export type ResolvedRunIntent = ResolvedUserIntent;
export type RunIntentRiskLevel = "low" | "medium" | "high";
export type RunIntentUiCategory = "workflow_mode" | "output_style" | "discussion" | "studio_workflow";
export type RunIntentToolPolicy = "none" | "read_only" | "write" | "plan_gated" | "studio_workflow";
export type PendingRunDecisionKind = "intent_confirmation" | "execution_consent" | "mode_switch";
export type PendingRunDecisionSource = "pre_submit" | "preflight" | "model" | "tool_gate";
export type PendingRunDecisionChoice =
  | ResolvedUserIntent
  | "switch_game_studio"
  | "switch_game_studio_choose_engine"
  | "switch_game_studio_unity"
  | "switch_game_studio_godot"
  | "switch_game_studio_unreal"
  | "stay_main";
export type RunIntentControlAction = "approve_plan" | "resume_plan_execution";
export type CommandDirectiveKind =
  | "none"
  | "shell"
  | "unity"
  | "git"
  | "file_modify"
  | "report"
  | "plan_approval"
  | "plan_resume"
  | "studio"
  | "skill"
  | "knowledge"
  | "mcp";
export type CommandDirectiveSource =
  | "natural_language"
  | "main_shortcut"
  | "studio_slash"
  | "skill_command"
  | "preflight"
  | "continuation"
  | "debug";

export interface CommandDirective {
  kind: CommandDirectiveKind;
  action?: string;
  target?: string;
  source?: CommandDirectiveSource;
  requiresWorkspace?: boolean;
  requiresApproval?: boolean;
  confidence?: number;
  reason?: string;
}

export interface PendingRunDecisionOption {
  id: PendingRunDecisionChoice;
  label: string;
  value: string;
}

export interface RunIntentResolution {
  intent: ResolvedUserIntent;
  reason: string;
  confidence: number;
  bypassMainRouter: boolean;
  riskLevel: RunIntentRiskLevel;
  requiresApproval?: boolean;
  commandDirective?: CommandDirective;
  needsDecision?: boolean;
  suggestedIntent?: ResolvedUserIntent;
  decisionOptions?: ResolvedUserIntent[];
  controlAction?: RunIntentControlAction;
}

export interface IntentPreflightResult {
  intent: ResolvedUserIntent;
  confidence: number;
  title?: string;
  summary?: string;
  reason?: string;
  needsUserChoice?: boolean;
  question?: string;
  options?: PendingRunDecisionOption[];
  outputFormat?: "answer" | "summary" | "report" | "plan" | "analysis" | "execution";
  bypassMainRouter?: boolean;
  needsWorkspaceRead?: boolean;
  riskLevel?: RunIntentRiskLevel;
  requiresApproval?: boolean;
  commandDirective?: CommandDirective;
}

export interface PendingRunDecision {
  kind: PendingRunDecisionKind;
  source: PendingRunDecisionSource;
  originalInput: string;
  originalImages?: string[];
  suggestedIntent: ResolvedUserIntent;
  reason: string;
  title?: string;
  options?: PendingRunDecisionOption[];
  turnId?: string | null;
  toolName?: string;
  target?: string;
}

export type ExecutionConsentPolicy = "ask_per_turn" | "auto_thread";

export interface ResolveTurnRunIntentContext {
  language?: "zh" | "en";
  mainModeKey: MainModeKey;
  parsedStudioCommand?: PendingSlashCommand | null;
  hasPlanArtifacts: boolean;
  planStage:
    | "idle"
    | "requirements"
    | "design"
    | "tasks"
    | "bugfix"
    | "ready_to_execute"
    | "executing"
    | "completed";
  isPlanApproved: boolean;
  previousTurnIntent?: ResolvedRunIntent | null;
}

export interface RunIntentPolicy {
  intent: ResolvedUserIntent;
  workflowMode: LegacyWorkflowMode;
  uiCategory: RunIntentUiCategory;
  toolPolicy: RunIntentToolPolicy;
  requiresPlanApproval: boolean;
  generatesPlanArtifacts: boolean;
  allowsSourceWritesBeforePlanApproval: boolean;
  label: { zh: string; en: string };
  categoryLabel: { zh: string; en: string };
  description: { zh: string; en: string };
}

const RUN_INTENT_POLICIES: Record<ResolvedUserIntent, RunIntentPolicy> = {
  discuss: {
    intent: "discuss",
    workflowMode: "chat",
    uiCategory: "discussion",
    toolPolicy: "none",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: false,
    label: { zh: "讨论", en: "Discuss" },
    categoryLabel: { zh: "普通对话", en: "Conversation" },
    description: {
      zh: "正常问答、解释、头脑风暴和轻量需求澄清。",
      en: "Normal Q&A, explanations, brainstorming, and lightweight clarification.",
    },
  },
  plan: {
    intent: "plan",
    workflowMode: "plan",
    uiCategory: "workflow_mode",
    toolPolicy: "plan_gated",
    requiresPlanApproval: true,
    generatesPlanArtifacts: true,
    allowsSourceWritesBeforePlanApproval: false,
    label: { zh: "计划", en: "Plan" },
    categoryLabel: { zh: "流程模式", en: "Workflow Mode" },
    description: {
      zh: "先生成可审阅方案和关键决策，批准后再执行。",
      en: "Create a reviewable plan and decisions before execution.",
    },
  },
  execute: {
    intent: "execute",
    workflowMode: "edit",
    uiCategory: "workflow_mode",
    toolPolicy: "write",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: true,
    label: { zh: "执行", en: "Execute" },
    categoryLabel: { zh: "流程模式", en: "Workflow Mode" },
    description: {
      zh: "直接进入处理、实现和验证链路。",
      en: "Go directly into implementation, fixes, and verification.",
    },
  },
  analyze: {
    intent: "analyze",
    workflowMode: "chat",
    uiCategory: "output_style",
    toolPolicy: "read_only",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: false,
    label: { zh: "分析", en: "Analyze" },
    categoryLabel: { zh: "输出方式", en: "Output Style" },
    description: {
      zh: "在普通聊天流中做只读检查、验证和诊断。",
      en: "Use the chat flow for read-only inspection, validation, and diagnosis.",
    },
  },
  summarize: {
    intent: "summarize",
    workflowMode: "chat",
    uiCategory: "output_style",
    toolPolicy: "read_only",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: false,
    label: { zh: "总结", en: "Summary" },
    categoryLabel: { zh: "输出方式", en: "Output Style" },
    description: {
      zh: "在普通聊天流中提炼重点、结论和下一步。",
      en: "Use the chat flow to extract key points, conclusions, and next steps.",
    },
  },
  report: {
    intent: "report",
    workflowMode: "chat",
    uiCategory: "output_style",
    toolPolicy: "read_only",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: false,
    label: { zh: "报告", en: "Report" },
    categoryLabel: { zh: "输出方式", en: "Output Style" },
    description: {
      zh: "在普通聊天流中整理结构化 Markdown 报告。",
      en: "Use the chat flow to produce a structured Markdown report.",
    },
  },
  studio_workflow: {
    intent: "studio_workflow",
    workflowMode: "edit",
    uiCategory: "studio_workflow",
    toolPolicy: "studio_workflow",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: true,
    label: { zh: "Game Studio", en: "Game Studio" },
    categoryLabel: { zh: "工作室流程", en: "Studio Workflow" },
    description: {
      zh: "绕过 MAIN 通用路由，按 Game Studio 协议执行。",
      en: "Bypass the MAIN router and execute through the Game Studio protocol.",
    },
  },
};

const STRONG_PLAN_PATTERNS = [
  /先(?:给我|帮我)?(?:一个)?(?:方案|计划|规划|spec|roadmap)/i,
  /先(?:出|做|写)(?:一份)?(?:方案|计划|规划|spec)/i,
  /不要直接(?:实现|修改|动手|写代码)/i,
  /先写(?:requirements|design)/i,
  /先梳理(?:实施方案|方案|设计)/i,
  /\bgive me (?:a )?(?:plan|spec|roadmap) first\b/i,
  /\bplan first\b/i,
  /\bspec first\b/i,
  /\bdon't (?:implement|build|code) (?:it )?yet\b/i,
];

const STRONG_EXECUTE_PATTERNS = [
  /(?:帮我|请|直接|现在)?(?:修改|改一下|改动|处理一下)(?:这个|该|当前)?(?:功能|逻辑|问题|模块|文件)?/i,
  /直接(?:改|做|实现|修|写|上手|处理)/i,
  /帮我(?:实现|修复|修改|改掉|补上|落地)/i,
  /现在就(?:做|改|实现|修复)/i,
  /(?:完成|继续)(?:修改|实现|执行|处理)/i,
  /(?:根据|按照|按).{0,24}(?:design\.md|设计方案|方案).{0,48}(?:完成修改|开始执行|继续执行|执行|实现|落地|修改)/i,
  /(?:提交|commit).{0,16}(?:并|和|然后|&|&&|and).{0,16}(?:推送|push)/i,
  /^(?:帮我|请|直接|现在)?(?:提交|commit)(?:一下)?[。.!！\s]*$/i,
  /(?:帮我|请|直接|现在)?(?:把|将)?.{0,16}(?:git|代码|改动|修改|变更).{0,16}(?:提交|commit)/i,
  /(?:提交|commit).{0,16}(?:git|代码|改动|修改|变更|当前|这些)/i,
  /(?:帮我|请|直接|现在)?(?:把|将)?.{0,12}(?:git\s+)?(?:推送|push)(?:一下|掉|到远程|当前分支)?/i,
  /(?:查看|检查|获取).{0,16}git.{0,24}(?:状态|变更|改动|status|diff)/i,
  /\bgit\s+(?:add|commit|push|status|diff)\b/i,
  /\bcommit (?:and )?push(?: my| the| these)?(?: changes)?\b/i,
  /\bpush (?:my|the|these|current)? ?(?:changes|branch|commits)\b/i,
  /(?:直接|开始|继续|立即|马上|现在)?(?:执行|运行).{0,16}(?:部署脚本|deploy(?:\.sh)?|deployment script|脚本|命令)/i,
  /(?:把|将)?.{0,32}(?:同步|部署|上传|发布).{0,32}(?:服务器|远程|生产|线上|server|remote|production)/i,
  /(?:服务器|远程|生产|线上|server|remote|production).{0,32}(?:同步|部署|上传|发布)/i,
  /\b(?:run|execute|start).{0,24}(?:deploy(?:\.sh)?|deployment script|command)\b/i,
  /\b(?:apply|patch|build it|go implement|implement it|fix it|ship it)\b/i,
];

const GAME_STUDIO_EXECUTE_PATTERNS = [
  /(?:立即|马上|现在|直接|开始|继续)(?:开始)?(?:重构|完善|实现|改造|开发|处理|执行|接入|集成)/i,
  /(?:重构|完善|实现|改造|开发|处理|接入|集成).{0,32}(?:controller|manager|system|SnakeController|SnakeBody|脚本|系统|逻辑|功能|模块)/i,
  /(?:把|将).{0,32}(?:接入|集成|完善|实现|改造|重构)/i,
  /\b(?:implement|refactor|complete|continue|integrate|wire up|build|fix)\b.{0,40}\b(?:controller|manager|system|script|feature|logic)\b/i,
];

const COMPLEX_IMPLEMENTATION_PATTERNS = [
  /生成一套/i,
  /完整(?:的)?(?:系统|框架|项目|模块|流程|架构)/i,
  /(?:代码)?框架/i,
  /包括(?:文件夹|目录|多个文件|完整文件)/i,
  /多文件/i,
  /从零(?:搭建|实现|创建)/i,
  /项目骨架/i,
  /战斗(?:系统|逻辑|框架)/i,
  /回合制(?:战斗|系统|逻辑)/i,
  /\b(?:scaffold|full framework|whole system|multi-file|from scratch|project skeleton)\b/i,
];

const STRONG_SUMMARIZE_PATTERNS = [
  /(?:帮我|请)?(?:总结|概括|归纳|梳理)(?:一下)?/i,
  /(?:给我|输出)(?:一个)?(?:摘要|总结)/i,
  /\b(?:summari[sz]e|sum up|give me a summary|overview)\b/i,
];

const STRONG_ANALYZE_PATTERNS = [
  /(?:帮我|请)?(?:分析|检查|验证|诊断|审查|评估|排查)(?:一下)?/i,
  /(?:仔细|全面|深入)(?:分析|检查|验证|诊断|审查|评估)/i,
  /(?:代码|逻辑|流程|指令|链路|问题).*(?:分析|检查|验证|诊断|审查|评估)/i,
  /(?:分析|检查|验证|诊断|审查|评估).*(?:代码|逻辑|流程|指令|链路|问题)/i,
  /\b(?:analy[sz]e|inspect|review|diagnose|validate|verify|audit|investigate)\b/i,
];

const STRONG_REPORT_PATTERNS = [
  /(?:生成|输出|写(?:一份)?|整理成)(?:分析)?报告/i,
  /汇报材料/i,
  /报告输出/i,
  /\b(?:report|analysis report|write a report|generate a report)\b/i,
];

const WEAK_PLAN_PATTERNS = [
  /\bplan\b/i,
  /\bspec\b/i,
  /\broadmap\b/i,
  /方案/i,
  /规划/i,
];

const APPROVE_PLAN_PATTERNS = [
  /^开始执行[。.! ]*$/i,
  /^(?:好|好的|那就|请)?[，,\s]*(?:可以[，,\s]*)?开始执行(?:设计方案|方案|计划)?了?[。.! ]*$/i,
  /^(?:好|好的|那就|请)?[，,\s]*开始按(?:设计)?方案执行[。.! ]*$/i,
  /^(?:好|好的|那就|请)?[，,\s]*按设计方案开始做[。.! ]*$/i,
  /^(?:好|好的|那就|请)?[，,\s]*批准并开始执行[。.! ]*$/i,
  /^批准(?:执行|计划)?[。.! ]*$/i,
  /^批准进入执行[。.! ]*$/i,
  /^同意(?:执行|这个方案)?[。.! ]*$/i,
  /^(?:请)?(?:根据|按照|按).{0,24}(?:design\.md|设计方案|方案).{0,48}(?:完成修改|开始执行|继续执行|执行|实现|落地|修改)[。.! ]*$/i,
  /^go ahead[.! ]*$/i,
  /^approve(?: the plan)?[.! ]*$/i,
  /^start execution[.! ]*$/i,
];

const RESUME_PLAN_PATTERNS = [
  /继续执行(?:剩余任务)?/i,
  /continue plan/i,
  /continue execution/i,
  /resume execution/i,
  /继续把(?:剩余)?任务做完/i,
];

const EXISTING_PLAN_EXECUTION_PATTERNS = [
  /(?:根据|按照|按).{0,24}(?:\.MAIN[\\/ ]*plans|\.main[\\/ ]*plans|plans\s*(?:文件夹|目录|folder)|计划(?:文件夹|目录)|tasks\.md|\.MAIN[\\/ ]*plans[\\/ ]*tasks\.md).{0,80}(?:完成|执行|继续|落地|处理|实现|推进)/i,
  /(?:完成|执行|继续|落地|处理|实现|推进).{0,60}(?:\.MAIN[\\/ ]*plans|\.main[\\/ ]*plans|plans\s*(?:文件夹|目录|folder)|计划任务|任务清单|tasks\.md)/i,
  /(?:执行|继续|完成).{0,24}(?:计划任务|计划中的任务|任务清单|执行方案和任务|方案和任务)/i,
  /\b(?:execute|resume|continue|finish).{0,40}(?:\.MAIN[\\/ ]*plans|tasks\.md|plan tasks|task list)\b/i,
];

const PREVIOUS_TURN_CONTINUATION_PATTERNS = [
  /^(?:继续|继续吧|接着来|接着写|接着做|继续做|继续处理|继续执行|继续推进|往下继续|接着上面|接着刚才)[。.!！\s]*$/i,
  /^(?:继续|接着)(?:上次|上一轮|之前|刚才|前面|上面)(?:的)?(?:任务|操作|内容|步骤|流程)?[。.!！\s]*$/i,
  /^(?:把|将)?(?:剩下|剩余|未完成|没完成)(?:的)?(?:任务|内容|步骤|操作)?(?:继续)?(?:做完|完成|跑完|执行完)[。.!！\s]*$/i,
  /^(?:继续|接着)(?:运行|测试|验证|执行)(?:一下|它|这个程序|这个文件|前面的内容)?[。.!！\s]*$/i,
  /^(?:go on|continue|keep going|proceed|resume)[.!！\s]*$/i,
  /^(?:continue|resume|finish)(?: the)?(?: previous| last| remaining| unfinished)?(?: task| work| operation| step| execution| validation)?[.!！\s]*$/i,
  /^(?:keep|carry) on(?: with)?(?: the)?(?: previous| last| remaining| unfinished)?(?: task| work| operation| step)?[.!！\s]*$/i,
];

const RESUMABLE_PREVIOUS_TURN_STATUSES = new Set([
  "stopped_no_action",
  "stopped_no_output",
  "error",
]);

const HIGH_RISK_PATTERNS: Array<{ key: string; patterns: RegExp[] }> = [
  {
    key: "broad_refactor",
    patterns: [
      /重构架构|迁移框架|升级核心依赖|从零搭建|全栈|端到端/i,
      /\b(?:architecture refactor|migrate framework|upgrade core dependencies|from scratch|full.?stack|end.?to.?end)\b/i,
    ],
  },
  {
    key: "multi_system",
    patterns: [
      /前端.+后端|数据库.+api|引擎.+ui|规则.+模板.+hooks/i,
      /\b(?:frontend.+backend|database.+api|engine.+ui|rules?.+templates?.+hooks?)\b/i,
    ],
  },
  {
    key: "long_chain",
    patterns: [
      /初始化项目|安装依赖|生成骨架|迁移数据|部署|打包/i,
      /\b(?:initialize project|install dependencies|scaffold|migrate data|deploy|package|release build)\b/i,
    ],
  },
  {
    key: "multi_phase",
    patterns: [
      /整个项目|全部模块|完整流程|一期|pipeline/i,
      /\b(?:whole project|all modules|complete flow|phase one|pipeline)\b/i,
    ],
  },
];

const CONTINUATION_INTENTS = new Set<RunIntentControlAction>(["approve_plan", "resume_plan_execution"]);

export type MainIntentShortcut = Exclude<ResolvedUserIntent, "discuss" | "studio_workflow">;

export interface MainIntentShortcutItem {
  intent: MainIntentShortcut;
  command: string;
  label: string;
  description: string;
  category: RunIntentUiCategory;
  aliases: string[];
  visibleInMenu: boolean;
}

export type ComposerIntentSuggestionKind = "suggestion" | "explicit_conflict";

export interface ComposerIntentSuggestion {
  kind: ComposerIntentSuggestionKind;
  intent: MainIntentShortcut;
  explicitIntent?: MainIntentShortcut;
  inputKey: string;
}

export interface MainDebugShortcut {
  command: "/MDEBUG";
  rest: string;
}

const MAIN_INTENT_SHORTCUTS_ZH: MainIntentShortcutItem[] = [
  {
    intent: "plan",
    command: "/计划",
    label: "计划",
    description: RUN_INTENT_POLICIES.plan.description.zh,
    category: RUN_INTENT_POLICIES.plan.uiCategory,
    aliases: ["plan", "规划", "方案", "spec", "roadmap"],
    visibleInMenu: true,
  },
  {
    intent: "execute",
    command: "/执行",
    label: "执行",
    description: RUN_INTENT_POLICIES.execute.description.zh,
    category: RUN_INTENT_POLICIES.execute.uiCategory,
    aliases: ["execute", "implement", "实现", "处理", "修复"],
    visibleInMenu: false,
  },
  {
    intent: "report",
    command: "/报告",
    label: "报告",
    description: RUN_INTENT_POLICIES.report.description.zh,
    category: RUN_INTENT_POLICIES.report.uiCategory,
    aliases: ["report", "汇报", "分析报告"],
    visibleInMenu: true,
  },
  {
    intent: "analyze",
    command: "/分析",
    label: "分析",
    description: RUN_INTENT_POLICIES.analyze.description.zh,
    category: RUN_INTENT_POLICIES.analyze.uiCategory,
    aliases: ["analyze", "检查", "验证", "诊断", "review", "inspect"],
    visibleInMenu: true,
  },
  {
    intent: "summarize",
    command: "/总结",
    label: "总结",
    description: RUN_INTENT_POLICIES.summarize.description.zh,
    category: RUN_INTENT_POLICIES.summarize.uiCategory,
    aliases: ["summary", "summarize", "摘要", "概括", "归纳"],
    visibleInMenu: true,
  },
];

const MAIN_INTENT_SHORTCUTS_EN: MainIntentShortcutItem[] = [
  {
    intent: "plan",
    command: "/plan",
    label: "Plan",
    description: RUN_INTENT_POLICIES.plan.description.en,
    category: RUN_INTENT_POLICIES.plan.uiCategory,
    aliases: ["计划", "规划", "方案", "spec", "roadmap"],
    visibleInMenu: true,
  },
  {
    intent: "execute",
    command: "/execute",
    label: "Execute",
    description: RUN_INTENT_POLICIES.execute.description.en,
    category: RUN_INTENT_POLICIES.execute.uiCategory,
    aliases: ["执行", "实现", "处理", "修复", "implement"],
    visibleInMenu: false,
  },
  {
    intent: "report",
    command: "/report",
    label: "Report",
    description: RUN_INTENT_POLICIES.report.description.en,
    category: RUN_INTENT_POLICIES.report.uiCategory,
    aliases: ["报告", "汇报", "analysis report"],
    visibleInMenu: true,
  },
  {
    intent: "analyze",
    command: "/analyze",
    label: "Analyze",
    description: RUN_INTENT_POLICIES.analyze.description.en,
    category: RUN_INTENT_POLICIES.analyze.uiCategory,
    aliases: ["分析", "检查", "验证", "诊断", "review", "inspect"],
    visibleInMenu: true,
  },
  {
    intent: "summarize",
    command: "/summarize",
    label: "Summary",
    description: RUN_INTENT_POLICIES.summarize.description.en,
    category: RUN_INTENT_POLICIES.summarize.uiCategory,
    aliases: ["总结", "摘要", "概括", "归纳", "summary"],
    visibleInMenu: true,
  },
];

function normalizeInput(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function matchesAny(input: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function countPatternMatches(input: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(input) ? 1 : 0), 0);
}

function localizeReason(language: "zh" | "en", zh: string, en: string): string {
  return language === "en" ? en : zh;
}

const COMMAND_DIRECTIVE_KINDS = new Set<CommandDirectiveKind>([
  "none",
  "shell",
  "unity",
  "git",
  "file_modify",
  "report",
  "plan_approval",
  "plan_resume",
  "studio",
  "skill",
  "knowledge",
  "mcp",
]);

const COMMAND_DIRECTIVE_SOURCES = new Set<CommandDirectiveSource>([
  "natural_language",
  "main_shortcut",
  "studio_slash",
  "skill_command",
  "preflight",
  "continuation",
  "debug",
]);

function normalizeDirectiveString(value: unknown, maxLength = 96): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function createCommandDirective(
  kind: CommandDirectiveKind,
  patch: Omit<CommandDirective, "kind"> = {},
): CommandDirective {
  return {
    kind,
    source: patch.source ?? "natural_language",
    requiresWorkspace: patch.requiresWorkspace ?? kind !== "none",
    requiresApproval: patch.requiresApproval ?? ["shell", "git", "file_modify", "unity", "studio", "mcp", "skill"].includes(kind),
    confidence: patch.confidence ?? (kind === "none" ? 0.5 : 0.86),
    ...(patch.action ? { action: patch.action } : {}),
    ...(patch.target ? { target: patch.target } : {}),
    ...(patch.reason ? { reason: patch.reason } : {}),
  };
}

export function normalizeCommandDirective(
  value: unknown,
  fallback?: CommandDirective | null,
): CommandDirective | undefined {
  if (!value || typeof value !== "object") return fallback ?? undefined;
  const candidate = value as Partial<CommandDirective>;
  const kind = typeof candidate.kind === "string" && COMMAND_DIRECTIVE_KINDS.has(candidate.kind as CommandDirectiveKind)
    ? candidate.kind as CommandDirectiveKind
    : fallback?.kind;
  if (!kind) return fallback ?? undefined;
  const source = typeof candidate.source === "string" && COMMAND_DIRECTIVE_SOURCES.has(candidate.source as CommandDirectiveSource)
    ? candidate.source as CommandDirectiveSource
    : fallback?.source;
  const confidence = typeof candidate.confidence === "number"
    ? Math.max(0, Math.min(1, candidate.confidence))
    : fallback?.confidence;
  return {
    kind,
    ...(source ? { source } : {}),
    ...(normalizeDirectiveString(candidate.action) ?? fallback?.action
      ? { action: normalizeDirectiveString(candidate.action) ?? fallback?.action }
      : {}),
    ...(normalizeDirectiveString(candidate.target) ?? fallback?.target
      ? { target: normalizeDirectiveString(candidate.target) ?? fallback?.target }
      : {}),
    requiresWorkspace: typeof candidate.requiresWorkspace === "boolean"
      ? candidate.requiresWorkspace
      : fallback?.requiresWorkspace,
    requiresApproval: typeof candidate.requiresApproval === "boolean"
      ? candidate.requiresApproval
      : fallback?.requiresApproval,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(normalizeDirectiveString(candidate.reason, 180) ?? fallback?.reason
      ? { reason: normalizeDirectiveString(candidate.reason, 180) ?? fallback?.reason }
      : {}),
  };
}

function inferGitAction(input: string): string {
  const lower = input.toLowerCase();
  if (/(?:commit|提交).{0,24}(?:push|推送)|(?:push|推送).{0,24}(?:commit|提交)/i.test(input)) return "commit_push";
  if (/\bpush\b|推送/i.test(input)) return "push";
  if (/\bcommit\b|提交/i.test(input)) return "commit";
  if (/\bdiff\b|变更|改动/i.test(input)) return "diff";
  if (/\bstatus\b|状态/i.test(input)) return "status";
  const command = lower.match(/\bgit\s+([a-z-]+)/i)?.[1];
  return command || "git";
}

function inferShellAction(input: string): string {
  if (/deploy|部署|发布|上线/i.test(input)) return "deploy";
  if (/\b(?:test|pytest|vitest|jest|playwright)\b|测试|验证/i.test(input)) return "test";
  if (/\b(?:build|package|release)\b|构建|打包|发布/i.test(input)) return "build";
  if (/\b(?:start|dev|serve)\b|启动|服务/i.test(input)) return "start";
  return "run";
}

function inferUnityAction(input: string): string {
  if (/roslyn|c#|\.cs\b|代码|脚本/i.test(input)) return "code";
  if (/引用|reference|yaml|prefab|预制体|scene|场景|asset|资源/i.test(input)) return "asset_context";
  if (/execute|执行|editor|编辑器/i.test(input)) return "editor_execute";
  return "unity_workflow";
}

export function inferCommandDirective(
  input: string,
  intent: ResolvedUserIntent,
  options: {
    source?: CommandDirectiveSource;
    controlAction?: RunIntentControlAction;
    parsedStudioCommand?: PendingSlashCommand | null;
  } = {},
): CommandDirective {
  const source = options.source ?? "natural_language";
  const normalizedInput = normalizeInput(input);
  const lower = normalizedInput.toLowerCase();

  if (options.controlAction === "approve_plan") {
    return createCommandDirective("plan_approval", {
      source,
      action: "approve_plan",
      requiresWorkspace: false,
      requiresApproval: false,
      confidence: 0.98,
      reason: "The user is approving the current plan.",
    });
  }

  if (options.controlAction === "resume_plan_execution") {
    return createCommandDirective("plan_resume", {
      source,
      action: "resume_plan_execution",
      requiresWorkspace: true,
      requiresApproval: false,
      confidence: 0.96,
      reason: "The user is resuming an approved plan.",
    });
  }

  if (options.parsedStudioCommand?.type === "workflow" || intent === "studio_workflow") {
    return createCommandDirective("studio", {
      source: source === "natural_language" ? "studio_slash" : source,
      action: options.parsedStudioCommand?.type === "workflow" ? options.parsedStudioCommand.slug : "studio_workflow",
      target: options.parsedStudioCommand?.type === "workflow" ? options.parsedStudioCommand.canonicalCommand : undefined,
      requiresWorkspace: true,
      requiresApproval: true,
      confidence: 0.96,
      reason: "MAIN Game Studio command or workflow.",
    });
  }

  if (/\bgit\s+(?:add|commit|push|status|diff|log|branch|checkout|switch|merge|rebase)\b/i.test(normalizedInput) || /(?:提交|推送|查看|检查).{0,16}(?:git|代码|改动|变更|状态)/i.test(normalizedInput) || /(?:提交|commit).{0,16}(?:推送|push)|(?:推送|push).{0,16}(?:提交|commit)|^(?:提交|推送)(?:一下)?$/i.test(normalizedInput) || /(?:commit|push)(?: my| the| these| current)?(?: changes| branch| commits)?/i.test(normalizedInput)) {
    return createCommandDirective("git", {
      source,
      action: inferGitAction(normalizedInput),
      target: "git",
      requiresWorkspace: true,
      requiresApproval: true,
      confidence: 0.94,
      reason: "Git command intent detected.",
    });
  }

  if (/\bunity\b|unity\s*mcp|editor\s*plugin|roslyn|prefab|scene|asset|yaml|\.asmdef\b|\.unity\b|\.prefab\b|预制体|场景|资源|编辑器插件|引用搜索|C#执行|c# 执行/i.test(normalizedInput)) {
    return createCommandDirective("unity", {
      source,
      action: inferUnityAction(normalizedInput),
      target: "unity",
      requiresWorkspace: true,
      requiresApproval: intent === "execute",
      confidence: 0.9,
      reason: "Unity or Unity tooling intent detected.",
    });
  }

  if (/\bmcp\b/i.test(normalizedInput)) {
    return createCommandDirective("mcp", {
      source,
      action: /tool|工具|server|服务器/i.test(normalizedInput) ? "tool_route" : "mcp_context",
      target: "mcp",
      requiresWorkspace: true,
      requiresApproval: intent === "execute",
      confidence: 0.84,
      reason: "MCP tool intent detected.",
    });
  }

  if (/^(?:npm|pnpm|yarn|bun|node|python|python3|pytest|cargo|go|rustc|dotnet|bash|sh|make)\b/i.test(lower) || /\b(?:run|execute|start)\b.{0,24}\b(?:command|script|deploy|test|build|server)\b/i.test(lower) || /(?:执行|运行|启动).{0,16}(?:命令|脚本|测试|构建|服务|部署)/i.test(normalizedInput) || /(?:同步|部署|上传|发布).{0,32}(?:服务器|远程|生产|线上|server|remote|production)|(?:服务器|远程|生产|线上|server|remote|production).{0,32}(?:同步|部署|上传|发布)/i.test(normalizedInput)) {
    return createCommandDirective("shell", {
      source,
      action: inferShellAction(normalizedInput),
      target: normalizeDirectiveString(normalizedInput, 80),
      requiresWorkspace: true,
      requiresApproval: true,
      confidence: 0.9,
      reason: "Shell command intent detected.",
    });
  }

  if (intent === "report" || matchesAny(normalizedInput, STRONG_REPORT_PATTERNS)) {
    return createCommandDirective("report", {
      source,
      action: "generate_report",
      requiresWorkspace: /文件|项目|代码|workspace|repo|仓库|资料|数据/i.test(normalizedInput),
      requiresApproval: false,
      confidence: 0.9,
      reason: "Report generation intent detected.",
    });
  }

  if (/(?:修改|实现|修复|写入|创建|生成|补上|改掉|落地|新增|删除|替换|重构)|\b(?:implement|fix|write|create|generate|update|patch|modify|refactor|delete|replace)\b/i.test(normalizedInput) && (intent === "execute" || intent === "plan")) {
    return createCommandDirective("file_modify", {
      source,
      action: intent === "plan" ? "plan_file_change" : "workspace_file_change",
      requiresWorkspace: true,
      requiresApproval: intent === "execute",
      confidence: 0.86,
      reason: "Workspace file modification intent detected.",
    });
  }

  if (/搜索|检索|引用|查找|索引|\b(?:search|find|references?|index|lookup)\b/i.test(normalizedInput) && intent !== "discuss") {
    return createCommandDirective("knowledge", {
      source,
      action: "workspace_search",
      requiresWorkspace: true,
      requiresApproval: false,
      confidence: 0.78,
      reason: "Workspace knowledge lookup intent detected.",
    });
  }

  return createCommandDirective("none", {
    source,
    requiresWorkspace: false,
    requiresApproval: false,
    confidence: 0.5,
  });
}

function finalizeRunIntentResolution(
  input: string,
  context: ResolveTurnRunIntentContext,
  resolution: Omit<RunIntentResolution, "commandDirective" | "requiresApproval"> & {
    commandDirective?: CommandDirective;
    requiresApproval?: boolean;
  },
): RunIntentResolution {
  const commandDirective =
    resolution.commandDirective ??
    inferCommandDirective(input, resolution.intent, {
      controlAction: resolution.controlAction,
      parsedStudioCommand: context.parsedStudioCommand,
      source: context.parsedStudioCommand?.type === "workflow" ? "studio_slash" : "natural_language",
    });
  return {
    ...resolution,
    commandDirective,
    requiresApproval: resolution.requiresApproval ?? commandDirective.requiresApproval ?? resolution.riskLevel === "high",
  };
}

export function getMainIntentShortcuts(
  language: "zh" | "en" = "zh",
  options: { includeHidden?: boolean } = {},
): MainIntentShortcutItem[] {
  const shortcuts = language === "en" ? MAIN_INTENT_SHORTCUTS_EN : MAIN_INTENT_SHORTCUTS_ZH;
  return options.includeHidden ? shortcuts : shortcuts.filter((item) => item.visibleInMenu);
}

export function getIntentPolicy(intent: ResolvedUserIntent): RunIntentPolicy {
  return RUN_INTENT_POLICIES[intent] ?? RUN_INTENT_POLICIES.discuss;
}

export function getRunIntentLabel(intent: ResolvedUserIntent, language: "zh" | "en" = "zh"): string {
  const label = getIntentPolicy(intent).label;
  return language === "en" ? label.en : label.zh;
}

export function getRunIntentCategoryLabel(intent: ResolvedUserIntent, language: "zh" | "en" = "zh"): string {
  const label = getIntentPolicy(intent).categoryLabel;
  return language === "en" ? label.en : label.zh;
}

export function parseMainIntentShortcut(input: string): { intent: MainIntentShortcut; command: string; rest: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const rawCommand = match[1].trim().toLowerCase();
  const rest = match[2] ?? "";
  for (const item of MAIN_INTENT_SHORTCUTS_ZH) {
    const names = [item.command.slice(1), ...item.aliases].map((value) => value.toLowerCase());
    if (names.includes(rawCommand)) {
      return { intent: item.intent, command: item.command, rest };
    }
  }
  for (const item of MAIN_INTENT_SHORTCUTS_EN) {
    const names = [item.command.slice(1), ...item.aliases].map((value) => value.toLowerCase());
    if (names.includes(rawCommand)) {
      return { intent: item.intent, command: item.command, rest };
    }
  }
  return null;
}

export function parseMainDebugShortcut(input: string): MainDebugShortcut | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/(mdebug)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    command: "/MDEBUG",
    rest: match[2] ?? "",
  };
}

function createOption(intent: ResolvedUserIntent, language: "zh" | "en"): PendingRunDecisionOption {
  const labels: Record<ResolvedUserIntent, { zh: string; en: string; valueZh: string; valueEn: string }> = {
    discuss: {
      zh: "先讨论一下",
      en: "Discuss First",
      valueZh: "先讨论一下具体需求和目标",
      valueEn: "Let's discuss the goal first before doing anything else.",
    },
    plan: {
      zh: "先给方案",
      en: "Plan First",
      valueZh: "先给我一个方案和计划，再决定是否执行",
      valueEn: "Please create a plan first before execution.",
    },
    execute: {
      zh: "直接执行",
      en: "Execute Directly",
      valueZh: "直接开始处理并执行，不需要先出完整方案",
      valueEn: "Handle it directly without a separate planning phase.",
    },
    analyze: {
      zh: "先做分析",
      en: "Analyze First",
      valueZh: "请先进行只读分析、检查和验证，给出结论与建议",
      valueEn: "Please perform read-only analysis, inspection, and validation first.",
    },
    summarize: {
      zh: "先做总结",
      en: "Summarize First",
      valueZh: "先帮我总结重点和结论",
      valueEn: "Summarize the key points and conclusions first.",
    },
    report: {
      zh: "输出正式报告",
      en: "Generate Report",
      valueZh: "请整理成结构化正式报告输出",
      valueEn: "Please produce a structured report.",
    },
    studio_workflow: {
      zh: "按 Game Studio 工作流处理",
      en: "Use Game Studio Workflow",
      valueZh: "请按 MAIN GAME STUDIO 的工作流来处理这个需求",
      valueEn: "Handle this through the MAIN GAME STUDIO workflow.",
    },
  };

  const item = labels[intent];
  return {
    id: intent,
    label: language === "en" ? item.en : item.zh,
    value: language === "en" ? item.valueEn : item.valueZh,
  };
}

function createDecisionOptions(
  intents: ResolvedUserIntent[],
  language: "zh" | "en",
): PendingRunDecisionOption[] {
  const seen = new Set<ResolvedUserIntent>();
  return intents
    .filter((intent) => {
      if (seen.has(intent)) return false;
      seen.add(intent);
      return true;
    })
    .map((intent) => createOption(intent, language));
}

export function createPendingDecisionCopy(
  resolution: Pick<RunIntentResolution, "suggestedIntent" | "decisionOptions" | "riskLevel" | "reason">,
  language: "zh" | "en",
): { title: string; options: PendingRunDecisionOption[]; reason: string } {
  const suggested = resolution.suggestedIntent ?? "discuss";
  const intents: ResolvedUserIntent[] = resolution.decisionOptions?.length
    ? resolution.decisionOptions
    : suggested === "report"
    ? ["summarize", "report", "discuss"]
    : ["plan", "execute", "discuss"];

  const title = suggested === "report"
    ? localizeReason(
        language,
        "这轮更适合先总结，还是直接输出报告？",
        "Should this turn summarize first or produce a report?",
      )
    : resolution.riskLevel === "high"
    ? localizeReason(
        language,
        "这轮任务范围较大，MAIN 应该怎么继续？",
        "This request spans a larger scope. How should MAIN continue?",
      )
    : localizeReason(
        language,
        "这轮任务应该怎么处理？",
        "How should MAIN handle this turn?",
      );

  return {
    title,
    options: createDecisionOptions(intents, language),
    reason: resolution.reason,
  };
}

function isComposerSuggestibleIntent(intent: ResolvedUserIntent): intent is MainIntentShortcut {
  return ["plan", "summarize", "report", "analyze", "execute"].includes(intent);
}

export function resolveComposerIntentSuggestion(params: {
  input: string;
  language?: "zh" | "en";
  mainModeKey: MainModeKey;
  lockedComposerIntent?: MainIntentShortcut | null;
  dismissedSuggestedIntentKey?: string | null;
  hasPlanArtifacts: boolean;
  planStage: ResolveTurnRunIntentContext["planStage"];
  isPlanApproved: boolean;
}): ComposerIntentSuggestion | null {
  const language = params.language === "en" ? "en" : "zh";
  const normalizedInput = params.input.trim();
  if (!normalizedInput) return null;
  if (params.mainModeKey !== "main_mode") return null;
  if (params.lockedComposerIntent) return null;
  if (params.dismissedSuggestedIntentKey === normalizedInput) return null;

  const shortcut = parseMainIntentShortcut(normalizedInput);
  if (shortcut) {
    const rest = shortcut.rest.trim();
    if (!rest) return null;

    const resolution = resolveTurnRunIntent(rest, {
      language,
      mainModeKey: params.mainModeKey,
      parsedStudioCommand: null,
      hasPlanArtifacts: params.hasPlanArtifacts,
      planStage: params.planStage,
      isPlanApproved: params.isPlanApproved,
    });

    if (
      !resolution.needsDecision &&
      resolution.confidence >= 0.9 &&
      isComposerSuggestibleIntent(resolution.intent) &&
      resolution.intent !== shortcut.intent
    ) {
      return {
        kind: "explicit_conflict",
        intent: resolution.intent,
        explicitIntent: shortcut.intent,
        inputKey: normalizedInput,
      };
    }

    return null;
  }

  const resolution = resolveTurnRunIntent(normalizedInput, {
    language,
    mainModeKey: params.mainModeKey,
    parsedStudioCommand: null,
    hasPlanArtifacts: params.hasPlanArtifacts,
    planStage: params.planStage,
    isPlanApproved: params.isPlanApproved,
  });

  if (
    !resolution.needsDecision &&
    resolution.confidence >= 0.9 &&
    isComposerSuggestibleIntent(resolution.intent)
  ) {
    return {
      kind: "suggestion",
      intent: resolution.intent,
      inputKey: normalizedInput,
    };
  }

  return null;
}

export function mapResolvedRunIntentToWorkflowMode(intent: ResolvedUserIntent): LegacyWorkflowMode {
  return getIntentPolicy(intent).workflowMode;
}

export function resolveRunIntentFromLegacyWorkflowMode(
  mode?: LegacyWorkflowMode | null,
): ResolvedUserIntent {
  switch (mode) {
    case "plan":
      return "plan";
    case "edit":
      return "execute";
    default:
      return "discuss";
  }
}

export function resolveConversationTurnIntent(
  turn?: { intent?: ResolvedUserIntent | null; mode?: LegacyWorkflowMode | null } | null,
): ResolvedUserIntent {
  if (turn?.intent) return turn.intent;
  return resolveRunIntentFromLegacyWorkflowMode(turn?.mode ?? "chat");
}

/**
 * preflight 会额外触发一次模型请求。
 * 普通低风险讨论如果在发送前被它阻塞，会让按钮/回车看起来像“卡住”。
 * 因此这里只让真正可能改变后续流程的低置信度请求进入阻塞 preflight。
 */
export function shouldUseBlockingIntentPreflight(
  resolution: RunIntentResolution,
  mainModeKey: MainModeKey,
): boolean {
  if (mainModeKey !== "main_mode") return false;
  if (resolution.bypassMainRouter) return false;
  if (resolution.needsDecision) return false;
  if (resolution.confidence >= 0.9) return false;
  if (getIntentPolicy(resolution.intent).uiCategory === "output_style") return false;

  // region: 热路径保护
  // 普通 discuss 已经会由主模型在系统提示里继续判断真实任务类型，
  // 不值得为了一次额外 preflight 阻塞用户点击发送或回车。
  if (resolution.intent === "discuss" && resolution.riskLevel === "low") {
    return false;
  }
  // endregion

  return true;
}

export function isPlanContinuationAction(
  action: RunIntentControlAction | undefined,
): action is RunIntentControlAction {
  return !!action && CONTINUATION_INTENTS.has(action);
}

export function looksLikePlanContinuationOrApprovalInput(
  input: string,
  context: Pick<ResolveTurnRunIntentContext, "hasPlanArtifacts" | "planStage" | "isPlanApproved">,
): boolean {
  if (!context.hasPlanArtifacts) return false;

  const normalizedInput = normalizeInput(input);
  if (!normalizedInput) return false;

  if (!context.isPlanApproved && matchesAny(normalizedInput, APPROVE_PLAN_PATTERNS)) {
    return true;
  }

  return (
    (context.isPlanApproved || context.planStage === "executing") &&
    matchesAny(normalizedInput, RESUME_PLAN_PATTERNS)
  );
}

export function looksLikePreviousTurnContinuationInput(input: string): boolean {
  const normalizedInput = normalizeInput(input);
  if (!normalizedInput) return false;
  return matchesAny(normalizedInput, PREVIOUS_TURN_CONTINUATION_PATTERNS);
}

export function looksLikeExistingPlanExecutionRequest(input: string): boolean {
  const normalizedInput = normalizeInput(input);
  if (!normalizedInput) return false;
  return matchesAny(normalizedInput, EXISTING_PLAN_EXECUTION_PATTERNS);
}

export function isResumablePreviousTurnStatus(status?: string | null): boolean {
  return !!status && RESUMABLE_PREVIOUS_TURN_STATUSES.has(status);
}

export function shouldContinuePreviousTurnFromInput(
  input: string,
  context: {
    currentTurnIntent?: ResolvedUserIntent | null;
    currentTurnStatus?: string | null;
    hasCurrentTurn?: boolean;
    hasTurnActivity?: boolean;
  },
): boolean {
  if (!looksLikePreviousTurnContinuationInput(input)) return false;
  if (!context.hasCurrentTurn) return false;
  if (!context.currentTurnIntent) return false;
  if (!isResumablePreviousTurnStatus(context.currentTurnStatus)) return false;
  if (context.hasTurnActivity === false) return false;
  return true;
}

export function resolveTurnRunIntent(
  input: string,
  context: ResolveTurnRunIntentContext,
): RunIntentResolution {
  const language = context.language === "en" ? "en" : "zh";
  const normalizedInput = normalizeInput(input);
  const finalize = (resolution: Parameters<typeof finalizeRunIntentResolution>[2]) =>
    finalizeRunIntentResolution(input, context, resolution);

  if (!normalizedInput) {
    return finalize({
      intent: "discuss",
      reason: localizeReason(language, "空输入默认按普通讨论处理。", "Empty input defaults to discuss."),
      confidence: 0.5,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  if (context.parsedStudioCommand?.type === "workflow") {
    return finalize({
      intent: "studio_workflow",
      reason: localizeReason(
        language,
        "检测到 MAIN GAME STUDIO 工作流命令，本轮会直接进入工作室执行链路。",
        "Detected a MAIN GAME STUDIO workflow command, so this turn will go directly into the studio workflow.",
      ),
      confidence: 0.99,
      bypassMainRouter: true,
      riskLevel: "medium",
    });
  }

  if (context.hasPlanArtifacts && !context.isPlanApproved && matchesAny(normalizedInput, APPROVE_PLAN_PATTERNS)) {
    return finalize({
      intent: "plan",
      reason: localizeReason(
        language,
        "检测到你在批准当前计划，系统会直接推进到执行阶段。",
        "Detected plan approval language, so the current plan will move into execution.",
      ),
      confidence: 0.97,
      bypassMainRouter: false,
      riskLevel: "low",
      controlAction: "approve_plan",
    });
  }

  if (
    context.hasPlanArtifacts &&
    (context.isPlanApproved || context.planStage === "executing") &&
    matchesAny(normalizedInput, RESUME_PLAN_PATTERNS)
  ) {
    return finalize({
      intent: "plan",
      reason: localizeReason(
        language,
        "检测到你想继续当前计划执行，会恢复剩余计划任务而不是开启普通新回合。",
        "Detected a request to continue the active plan, so the existing plan execution will resume.",
      ),
      confidence: 0.94,
      bypassMainRouter: false,
      riskLevel: "low",
      controlAction: "resume_plan_execution",
    });
  }

  if (looksLikeExistingPlanExecutionRequest(normalizedInput)) {
    return finalize({
      intent: "plan",
      reason: localizeReason(
        language,
        "检测到你要按现有 `.MAIN/plans` 或任务清单继续执行，本轮会恢复计划执行语义并使用执行工具。",
        "Detected a request to execute the existing `.MAIN/plans` or task list, so this turn will resume plan execution with execute tools.",
      ),
      confidence: 0.95,
      bypassMainRouter: false,
      riskLevel: "medium",
      controlAction: "resume_plan_execution",
    });
  }

  if (matchesAny(normalizedInput, STRONG_REPORT_PATTERNS)) {
    return finalize({
      intent: "report",
      reason: localizeReason(
        language,
        "检测到明确的报告输出请求，本轮会按报告模式处理。",
        "Detected an explicit report request, so this turn will use report mode.",
      ),
      confidence: 0.96,
      bypassMainRouter: false,
      riskLevel: "medium",
    });
  }

  if (matchesAny(normalizedInput, STRONG_SUMMARIZE_PATTERNS)) {
    return finalize({
      intent: "summarize",
      reason: localizeReason(
        language,
        "检测到明确的总结请求，本轮会按总结模式处理。",
        "Detected an explicit summary request, so this turn will use summary mode.",
      ),
      confidence: 0.94,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  if (matchesAny(normalizedInput, STRONG_ANALYZE_PATTERNS)) {
    return finalize({
      intent: "analyze",
      reason: localizeReason(
        language,
        "检测到明确的分析/检查/验证请求，本轮会按只读分析模式处理。",
        "Detected an explicit analysis/inspection/validation request, so this turn will use read-only analysis mode.",
      ),
      confidence: 0.95,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  if (matchesAny(normalizedInput, STRONG_PLAN_PATTERNS)) {
    return finalize({
      intent: "plan",
      reason: localizeReason(
        language,
        "检测到明确的方案/规划请求，本轮会直接进入计划阶段。",
        "Detected an explicit planning/spec request, so this turn will enter plan mode directly.",
      ),
      confidence: 0.96,
      bypassMainRouter: false,
      riskLevel: "medium",
    });
  }

  const complexImplementationMatches = countPatternMatches(normalizedInput, COMPLEX_IMPLEMENTATION_PATTERNS);
  if (complexImplementationMatches >= 2) {
    return finalize({
      intent: "plan",
      reason: localizeReason(
        language,
        "检测到这是多文件/架构级实现请求，本轮会先生成可审批计划，再由用户批准后执行。",
        "Detected a multi-file or architecture-level implementation request, so this turn will create a reviewable plan before execution.",
      ),
      confidence: 0.93,
      bypassMainRouter: false,
      riskLevel: "high",
    });
  }

  if (context.mainModeKey === "game_studio" && matchesAny(normalizedInput, GAME_STUDIO_EXECUTE_PATTERNS)) {
    return finalize({
      intent: "studio_workflow",
      reason: localizeReason(
        language,
        "检测到 Game Studio 中明确的实现/重构/完善请求，本轮会进入工作室执行链路。",
        "Detected an explicit implementation/refactor/completion request inside Game Studio, so this turn will use the studio execution workflow.",
      ),
      confidence: 0.9,
      bypassMainRouter: true,
      riskLevel: "medium",
    });
  }

  if (matchesAny(normalizedInput, STRONG_EXECUTE_PATTERNS)) {
    return finalize({
      intent: "execute",
      reason: localizeReason(
        language,
        "检测到明确的直接执行请求，本轮会直接进入执行流。",
        "Detected an explicit implementation request, so this turn will go straight to execution.",
      ),
      confidence: 0.94,
      bypassMainRouter: false,
      riskLevel: "medium",
    });
  }

  if (matchesAny(normalizedInput, WEAK_PLAN_PATTERNS)) {
    return finalize({
      intent: "discuss",
      reason: localizeReason(
        language,
        "这条消息里出现了方案或计划相关关键词，但目标还不够明确，MAIN 应该先让你确认这轮是继续讨论、先出方案，还是直接处理。",
        "This message contains weak planning keywords, but the goal is still ambiguous. MAIN should confirm whether you want discussion, planning, or direct execution.",
      ),
      confidence: 0.7,
      bypassMainRouter: false,
      riskLevel: "medium",
      needsDecision: true,
      suggestedIntent: "plan",
      decisionOptions: ["plan", "execute", "discuss"],
    });
  }

  let riskMatches = 0;
  for (const group of HIGH_RISK_PATTERNS) {
    if (matchesAny(normalizedInput, group.patterns)) {
      riskMatches += 1;
    }
  }
  if (riskMatches >= 2) {
    return finalize({
      intent: "execute",
      reason: localizeReason(
        language,
        "这条请求涉及较多阶段或系统，MAIN 建议先确认是否进入计划阶段，再决定是否直接实施。",
        "This request spans multiple phases or systems. MAIN should confirm whether to plan first before implementing.",
      ),
      confidence: 0.82,
      bypassMainRouter: false,
      riskLevel: "high",
      needsDecision: true,
      suggestedIntent: "plan",
      decisionOptions: ["plan", "execute", "discuss"],
    });
  }

  if (context.mainModeKey === "game_studio") {
    if (context.previousTurnIntent === "studio_workflow") {
      return finalize({
        intent: "studio_workflow",
        reason: localizeReason(
          language,
          "上一轮为 Game Studio 工作流，本轮延续工作室流程。",
          "The previous turn was a Game Studio workflow, so this turn continues the studio workflow.",
        ),
        confidence: 0.92,
        bypassMainRouter: true,
        riskLevel: "medium",
      });
    }
    return finalize({
      intent: "discuss",
      reason: localizeReason(
        language,
        "Game Studio 普通文本默认先按讨论处理，只有 slash 工作流默认直走执行。",
        "Game Studio plain text defaults to discussion; only slash workflows go straight to execution.",
      ),
      confidence: 0.84,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  return finalize({
    intent: "discuss",
    reason: localizeReason(
      language,
      "没有命中明确的计划、执行、总结或报告信号，本轮先按普通讨论处理。",
      "No strong planning, execution, summary, or report signal was detected, so this turn defaults to discussion.",
    ),
    confidence: 0.74,
    bypassMainRouter: false,
    riskLevel: "low",
  });
}

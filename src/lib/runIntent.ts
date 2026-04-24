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
export type PendingRunDecisionKind = "intent_confirmation" | "execution_consent";
export type PendingRunDecisionSource = "pre_submit" | "preflight" | "model" | "tool_gate";
export type RunIntentControlAction = "approve_plan" | "resume_plan_execution";

export interface PendingRunDecisionOption {
  id: ResolvedUserIntent;
  label: string;
  value: string;
}

export interface RunIntentResolution {
  intent: ResolvedUserIntent;
  reason: string;
  confidence: number;
  bypassMainRouter: boolean;
  riskLevel: RunIntentRiskLevel;
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
}

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
  /直接(?:改|做|实现|修|写|上手|处理)/i,
  /帮我(?:实现|修复|改掉|补上|落地)/i,
  /现在就(?:做|改|实现|修复)/i,
  /\b(?:apply|patch|build it|go implement|implement it|fix it|ship it)\b/i,
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
  /^批准(?:执行|计划)?[。.! ]*$/i,
  /^批准进入执行[。.! ]*$/i,
  /^同意(?:执行|这个方案)?[。.! ]*$/i,
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
  aliases: string[];
}

const MAIN_INTENT_SHORTCUTS_ZH: MainIntentShortcutItem[] = [
  {
    intent: "plan",
    command: "/计划",
    label: "计划",
    description: "先输出方案、步骤和关键决策，不直接动手执行。",
    aliases: ["plan", "规划", "方案", "spec", "roadmap"],
  },
  {
    intent: "report",
    command: "/报告",
    label: "报告",
    description: "整理成结构化正式报告，适合复盘、汇报和交付。",
    aliases: ["report", "汇报", "分析报告"],
  },
  {
    intent: "analyze",
    command: "/分析",
    label: "分析",
    description: "只读检查、验证和诊断，先给结论与建议。",
    aliases: ["analyze", "检查", "验证", "诊断", "review", "inspect"],
  },
  {
    intent: "summarize",
    command: "/总结",
    label: "总结",
    description: "提炼重点、结论和下一步，不展开正式报告。",
    aliases: ["summary", "summarize", "摘要", "概括", "归纳"],
  },
  {
    intent: "execute",
    command: "/执行",
    label: "执行",
    description: "直接进入处理和实现链路，不先输出完整计划。",
    aliases: ["execute", "implement", "实现", "处理", "修复"],
  },
];

const MAIN_INTENT_SHORTCUTS_EN: MainIntentShortcutItem[] = [
  {
    intent: "plan",
    command: "/plan",
    label: "Plan",
    description: "Create a plan, steps, and decisions before execution.",
    aliases: ["计划", "规划", "方案", "spec", "roadmap"],
  },
  {
    intent: "report",
    command: "/report",
    label: "Report",
    description: "Produce a structured report for review or handoff.",
    aliases: ["报告", "汇报", "analysis report"],
  },
  {
    intent: "analyze",
    command: "/analyze",
    label: "Analyze",
    description: "Read-only inspection, validation, diagnosis, and recommendations.",
    aliases: ["分析", "检查", "验证", "诊断", "review", "inspect"],
  },
  {
    intent: "summarize",
    command: "/summarize",
    label: "Summary",
    description: "Extract key points, conclusions, and next steps.",
    aliases: ["总结", "摘要", "概括", "归纳", "summary"],
  },
  {
    intent: "execute",
    command: "/execute",
    label: "Execute",
    description: "Handle and implement directly without a full plan first.",
    aliases: ["执行", "实现", "处理", "修复", "implement"],
  },
];

function normalizeInput(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function matchesAny(input: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function localizeReason(language: "zh" | "en", zh: string, en: string): string {
  return language === "en" ? en : zh;
}

export function getMainIntentShortcuts(language: "zh" | "en" = "zh"): MainIntentShortcutItem[] {
  return language === "en" ? MAIN_INTENT_SHORTCUTS_EN : MAIN_INTENT_SHORTCUTS_ZH;
}

export function getRunIntentLabel(intent: ResolvedUserIntent, language: "zh" | "en" = "zh"): string {
  const labels: Record<ResolvedUserIntent, { zh: string; en: string }> = {
    discuss: { zh: "讨论", en: "Discuss" },
    plan: { zh: "计划", en: "Plan" },
    execute: { zh: "执行", en: "Execute" },
    analyze: { zh: "分析", en: "Analyze" },
    summarize: { zh: "总结", en: "Summary" },
    report: { zh: "报告", en: "Report" },
    studio_workflow: { zh: "Game Studio", en: "Game Studio" },
  };
  return language === "en" ? labels[intent].en : labels[intent].zh;
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

function createOption(intent: ResolvedUserIntent, language: "zh" | "en"): PendingRunDecisionOption {
  const labels: Record<ResolvedUserIntent, { zh: string; en: string; valueZh: string; valueEn: string }> = {
    discuss: {
      zh: "先讨论一下",
      en: "Discuss First",
      valueZh: "先讨论一下具体需求和目标",
      valueEn: "Let's discuss the goal first before doing anything else.",
    },
    plan: {
      zh: "进入计划模式",
      en: "Enter Planning",
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

export function mapResolvedRunIntentToWorkflowMode(intent: ResolvedUserIntent): LegacyWorkflowMode {
  switch (intent) {
    case "plan":
      return "plan";
    case "execute":
    case "studio_workflow":
      return "edit";
    case "analyze":
    default:
      return "chat";
  }
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

export function resolveTurnRunIntent(
  input: string,
  context: ResolveTurnRunIntentContext,
): RunIntentResolution {
  const language = context.language === "en" ? "en" : "zh";
  const normalizedInput = normalizeInput(input);

  if (!normalizedInput) {
    return {
      intent: "discuss",
      reason: localizeReason(language, "空输入默认按普通讨论处理。", "Empty input defaults to discuss."),
      confidence: 0.5,
      bypassMainRouter: false,
      riskLevel: "low",
    };
  }

  if (context.parsedStudioCommand?.type === "workflow") {
    return {
      intent: "studio_workflow",
      reason: localizeReason(
        language,
        "检测到 MAIN GAME STUDIO 工作流命令，本轮会直接进入工作室执行链路。",
        "Detected a MAIN GAME STUDIO workflow command, so this turn will go directly into the studio workflow.",
      ),
      confidence: 0.99,
      bypassMainRouter: true,
      riskLevel: "medium",
    };
  }

  if (context.hasPlanArtifacts && !context.isPlanApproved && matchesAny(normalizedInput, APPROVE_PLAN_PATTERNS)) {
    return {
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
    };
  }

  if (
    context.hasPlanArtifacts &&
    (context.isPlanApproved || context.planStage === "executing") &&
    matchesAny(normalizedInput, RESUME_PLAN_PATTERNS)
  ) {
    return {
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
    };
  }

  if (matchesAny(normalizedInput, STRONG_REPORT_PATTERNS)) {
    return {
      intent: "report",
      reason: localizeReason(
        language,
        "检测到明确的报告输出请求，本轮会按报告模式处理。",
        "Detected an explicit report request, so this turn will use report mode.",
      ),
      confidence: 0.96,
      bypassMainRouter: false,
      riskLevel: "medium",
    };
  }

  if (matchesAny(normalizedInput, STRONG_SUMMARIZE_PATTERNS)) {
    return {
      intent: "summarize",
      reason: localizeReason(
        language,
        "检测到明确的总结请求，本轮会按总结模式处理。",
        "Detected an explicit summary request, so this turn will use summary mode.",
      ),
      confidence: 0.94,
      bypassMainRouter: false,
      riskLevel: "low",
    };
  }

  if (matchesAny(normalizedInput, STRONG_ANALYZE_PATTERNS)) {
    return {
      intent: "analyze",
      reason: localizeReason(
        language,
        "检测到明确的分析/检查/验证请求，本轮会按只读分析模式处理。",
        "Detected an explicit analysis/inspection/validation request, so this turn will use read-only analysis mode.",
      ),
      confidence: 0.95,
      bypassMainRouter: false,
      riskLevel: "low",
    };
  }

  if (matchesAny(normalizedInput, STRONG_PLAN_PATTERNS)) {
    return {
      intent: "plan",
      reason: localizeReason(
        language,
        "检测到明确的方案/规划请求，本轮会直接进入计划阶段。",
        "Detected an explicit planning/spec request, so this turn will enter plan mode directly.",
      ),
      confidence: 0.96,
      bypassMainRouter: false,
      riskLevel: "medium",
    };
  }

  if (matchesAny(normalizedInput, STRONG_EXECUTE_PATTERNS)) {
    return {
      intent: "execute",
      reason: localizeReason(
        language,
        "检测到明确的直接执行请求，本轮会直接进入执行流。",
        "Detected an explicit implementation request, so this turn will go straight to execution.",
      ),
      confidence: 0.94,
      bypassMainRouter: false,
      riskLevel: "medium",
    };
  }

  if (matchesAny(normalizedInput, WEAK_PLAN_PATTERNS)) {
    return {
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
    };
  }

  let riskMatches = 0;
  for (const group of HIGH_RISK_PATTERNS) {
    if (matchesAny(normalizedInput, group.patterns)) {
      riskMatches += 1;
    }
  }
  if (riskMatches >= 2) {
    return {
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
    };
  }

  if (context.mainModeKey === "game_studio") {
    return {
      intent: "discuss",
      reason: localizeReason(
        language,
        "Game Studio 普通文本默认先按讨论处理，只有 slash 工作流默认直走执行。",
        "Game Studio plain text defaults to discussion; only slash workflows go straight to execution.",
      ),
      confidence: 0.84,
      bypassMainRouter: false,
      riskLevel: "low",
    };
  }

  return {
    intent: "discuss",
    reason: localizeReason(
      language,
      "没有命中明确的计划、执行、总结或报告信号，本轮先按普通讨论处理。",
      "No strong planning, execution, summary, or report signal was detected, so this turn defaults to discussion.",
    ),
    confidence: 0.74,
    bypassMainRouter: false,
    riskLevel: "low",
  };
}

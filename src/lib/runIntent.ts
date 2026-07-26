import type { PendingSlashCommand } from "./gameStudio/catalog";
import type { MainModeKey } from "./mainModes";

export type LegacyWorkflowMode = "chat" | "edit" | "plan";
export type ResolvedUserIntent =
  | "respond"
  | "discuss"
  | "plan"
  | "execute"
  | "analyze"
  | "summarize"
  | "report"
  | "studio_workflow"
  | "image_studio"
  | "goal";
export type ResolvedRunIntent = ResolvedUserIntent;

export function isMutationRuntimeIntent(intent: ResolvedUserIntent | string | null | undefined): boolean {
  return intent === "execute" || intent === "goal";
}
export type RunIntentRiskLevel = "low" | "medium" | "high";
export type RunIntentUiCategory = "workflow_mode" | "output_style" | "discussion" | "studio_workflow";
export type RunIntentToolPolicy = "none" | "read_only" | "write" | "plan_gated" | "studio_workflow";
export type EffectiveTurnApprovalState = "not_required" | "needs_approval" | "approved";
export type PlanReviewState = "not_ready" | "awaiting_review" | "approved";
export type OperationApprovalState = EffectiveTurnApprovalState;
export type EffectiveTurnCompletionEvidence =
  | "none"
  | "answer"
  | "plan_artifact"
  | "execution_evidence";
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
  /** Exact user-supplied shell command. Natural-language targets never belong here. */
  exactCommand?: string;
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
  /**
   * A visible message submitted while a workspace is attached is always a
   * workflow Turn. Semantic intent still controls the capability surface; it
   * must not be used as a pre-Turn chat/task gate.
   */
  hasWorkspace?: boolean;
  parsedStudioCommand?: PendingSlashCommand | null;
  hasPlanArtifacts: boolean;
  planStage:
    | "idle"
    | "plan"
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

export interface EffectiveTurnContract {
  conversationIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  /** @deprecated Read operationApprovalState. Kept for persisted prompt/test compatibility. */
  approvalState: EffectiveTurnApprovalState;
  planReviewState: PlanReviewState;
  operationApprovalState: OperationApprovalState;
  allowedToolRisks: RunIntentToolPolicy;
  mutationExpected: boolean;
  validationExpected: boolean;
  completionEvidenceRequired: EffectiveTurnCompletionEvidence;
}

const RUN_INTENT_POLICIES: Record<ResolvedUserIntent, RunIntentPolicy> = {
  respond: {
    intent: "respond",
    workflowMode: "chat",
    uiCategory: "discussion",
    toolPolicy: "read_only",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: false,
    label: { zh: "回复", en: "Respond" },
    categoryLabel: { zh: "自然回复", en: "Natural Response" },
    description: {
      zh: "自然问答、解释、只读检查、澄清和方案交流；需要真实操作时先请求批准。",
      en: "Natural answers, explanations, read-only inspection, clarification, and proposal discussion; ask before real operations.",
    },
  },
  discuss: {
    intent: "discuss",
    workflowMode: "chat",
    uiCategory: "discussion",
    toolPolicy: "read_only",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: false,
    label: { zh: "回复", en: "Respond" },
    categoryLabel: { zh: "自然回复", en: "Natural Response" },
    description: {
      zh: "旧会话兼容别名；新回合使用自然回复。",
      en: "Legacy alias for older sessions; new turns use respond.",
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
  image_studio: {
    intent: "image_studio",
    workflowMode: "chat",
    uiCategory: "workflow_mode",
    toolPolicy: "none",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: false,
    label: { zh: "图像生成", en: "Image Studio" },
    categoryLabel: { zh: "图像工作室", en: "Image Studio" },
    description: {
      zh: "在对话中生成图片",
      en: "Generate an image in the chat",
    },
  },
  goal: {
    intent: "goal",
    workflowMode: "edit",
    uiCategory: "workflow_mode",
    toolPolicy: "write",
    requiresPlanApproval: false,
    generatesPlanArtifacts: false,
    allowsSourceWritesBeforePlanApproval: true,
    label: { zh: "目标", en: "Goal" },
    categoryLabel: { zh: "流程模式", en: "Workflow Mode" },
    description: {
      zh: "设定一个长期目标，Agent 自主循环执行直到完成或达到预算上限。",
      en: "Set a long-term goal. The agent iterates autonomously until the objective is met or the budget is exhausted.",
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
  /^(?:执行|开始执行|继续执行)(?:修复|修改|处理|实现|改动|改造|重构|完善|部署|发布)/i,
  /^(?:请|先|首先|直接|现在)?(?:执行|开始执行|继续执行).{0,32}(?:修复|修改|处理|实现|改动|改造|重构|完善|部署|发布)/i,
  /(?:找到|定位|找出|排查|诊断|分析|检查).{0,40}(?:问题|bug|错误|异常|故障|原因|root cause).{0,80}(?:修复|解决|修改|改掉|处理)/i,
  /(?:找到|定位|找出|排查|诊断|分析|检查).{0,40}(?:问题|bug|错误|异常|故障|原因|root cause).{0,80}(?:并|并且|然后|后|来|并进行)?.{0,16}(?:解决|搞定|处理掉|修好|修掉)/i,
  /^(?:帮我|请|直接|现在)?(?:修复|解决|处理)(?:一下|下)?(?:这个|该|当前)?(?:问题|bug|错误|故障|异常|展示问题|显示问题|逻辑问题|功能问题|页面问题|组件问题)?/i,
  /(?:帮我|请|直接|现在)?(?:修复|解决|改掉).{0,48}(?:问题|bug|错误|故障|异常|展示|显示|逻辑|功能|页面|组件|模块)/i,
  /(?:帮我|请|直接|现在)?(?:修改|改一下|改动|处理一下)(?:这个|该|当前)?(?:功能|逻辑|问题|模块|文件)?/i,
  /(?:帮我|请|直接|现在)?(?:增加|新增|添加|加入|补上|接入).{0,48}(?:功能|按钮|入口|菜单|组件|页面|文档|文件|字段|选项|交互|回调)/i,
  /(?:把|将).{0,48}(?:加上|加入|补上|接入|新增|添加).{0,48}(?:功能|按钮|入口|菜单|组件|页面|文档|文件|字段|选项|交互|回调)/i,
  /直接(?:改|做|实现|修|写|上手|处理)/i,
  /帮我(?:实现|修复|修改|改掉|补上|新增|增加|添加|落地)/i,
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

const WORKSPACE_MUTATION_REQUEST_RE = /(?:修改|实现|修复|解决|处理|写入|创建|生成|补上|改掉|落地|新增|增加|添加|加入|接入|完善|开发|删除|替换|重构)|\b(?:implement|fix|repair|resolve|write|create|generate|update|patch|modify|refactor|delete|remove|replace|add|change)\b/i;

const DIRECT_WORKSPACE_MUTATION_PATTERNS = [
  /^(?:(?:please|kindly|now|directly)\s+|(?:can|could|would|will)\s+you\s+)*(?:implement|fix|repair|resolve|write|create|generate|update|patch|modify|refactor|delete|remove|replace|add|change)\b/i,
  /\b(?:find|locate|identify|investigate|diagnose|analy[sz]e|inspect|trace)\b.{0,80}\b(?:root causes?|causes?|issues?|problems?|bugs?|errors?|failures?|faults?)\b.{0,120}\b(?:implement|fix|repair|resolve|update|patch|modify|refactor|remove|replace|change)\b/i,
  /(?:[.!?;,：，。！？；]\s*|\b(?:and|then|next)\s+)(?:please\s+)?(?:implement|fix|repair|resolve|write|create|generate|update|patch|modify|refactor|delete|remove|replace|add|change)\b/i,
  /^(?:(?:请|帮我|现在|直接|立即|马上|然后|随后|再)\s*)*(?:修改|实现|修复|解决|处理|写入|创建|生成|补上|改掉|落地|新增|增加|添加|加入|接入|完善|开发|删除|替换|重构)/i,
  /(?:[，。！？；：]\s*|(?:并且|然后|随后|再|并)\s*)(?:请|帮我|现在|直接)?\s*(?:修改|实现|修复|解决|处理|写入|创建|生成|补上|改掉|落地|新增|增加|添加|加入|接入|完善|开发|删除|替换|重构)/i,
];

const READ_ONLY_WORKSPACE_CONSTRAINT_PATTERNS = [
  /(?:不要|无需|不需要|请勿|禁止|别).{0,10}(?:修改|实现|修复|解决|处理|写入|创建|生成|改动|新增|添加|删除|替换|重构|执行)/i,
  /(?:只|仅).{0,8}(?:分析|检查|解释|诊断|审查|评估|排查|总结|报告).{0,32}(?:不要|无需|不需要|请勿|禁止|别).{0,16}(?:修改|改动|写入|执行)?/i,
  /\b(?:do not|don't|dont|no need to|without)\s+(?:implementing?|fixing?|repairing?|resolving?|writing?|creating?|generating?|updating?|patching?|modifying?|refactoring?|deleting?|removing?|replacing?|adding?|changing?|running|executing)\b/i,
  /\b(?:only|just)\s+(?:analy[sz]e|inspect|explain|diagnose|review|assess|investigate|summari[sz]e|report)\b.{0,48}\b(?:do not|don't|without)\b/i,
];

function hasReadOnlyWorkspaceConstraint(input: string): boolean {
  return matchesAny(input, READ_ONLY_WORKSPACE_CONSTRAINT_PATTERNS);
}

/**
 * Resolve the requested workspace effect once, before provider/model routing.
 * This signal is shared by Turn intent and command-directive inference so a
 * semantic "find/explain" cue cannot silently erase an explicit edit request.
 */
export function looksLikeExplicitWorkspaceMutationRequest(input: string): boolean {
  const normalizedInput = normalizeInput(input);
  if (!normalizedInput || hasReadOnlyWorkspaceConstraint(normalizedInput)) return false;
  if (matchesAny(normalizedInput, STRONG_PLAN_PATTERNS)) return false;
  if (!WORKSPACE_MUTATION_REQUEST_RE.test(normalizedInput)) return false;
  return (
    matchesAny(normalizedInput, STRONG_EXECUTE_PATTERNS) ||
    matchesAny(normalizedInput, DIRECT_WORKSPACE_MUTATION_PATTERNS)
  );
}

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

const AMBIGUOUS_CHAT_EXECUTION_PATTERNS = [
  /(?:能不能|可以(?:不可以)?|是否可以|要不要|是不是该|需要不需要).{0,48}(?:加|添加|增加|新增|加入|接入|支持|实现|创建|生成|修改|改一下|处理|做一个|弄一个|补上|完善)/i,
  /(?:想要|希望|需要|应该|最好).{0,48}(?:加|添加|增加|新增|加入|接入|支持|实现|创建|生成|修改|处理|做一个|弄一个|补上|完善)/i,
  /(?:加|添加|增加|新增|加入|接入|支持|实现|创建|生成|修改|处理|做一个|弄一个|补上|完善).{0,48}(?:功能|按钮|入口|菜单|组件|页面|文件|文档|字段|选项|交互|逻辑|回调|接口|api|API)/i,
  /\b(?:could|can|should|would you|please)?\s*(?:add|create|implement|support|wire|update|change|modify|build)\b.{0,80}\b(?:feature|button|menu|page|component|file|document|field|option|interaction|callback|api)\b/i,
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
  /(?:继续|恢复|接着).{0,16}(?:完成|执行|推进|落地).{0,16}(?:计划方案|计划|方案|任务)/i,
  /(?:继续|恢复|接着).{0,16}(?:计划方案|计划|方案).{0,16}(?:执行|落地|做完|完成)/i,
  /(?:把|将).{0,8}(?:计划方案|计划|方案|剩余任务).{0,16}(?:继续|接着).{0,16}(?:做完|完成|执行|落地)/i,
  /continue plan/i,
  /continue execution/i,
  /(?:resume|continue|finish).{0,32}(?:plan|plan execution|planned tasks)/i,
  /resume execution/i,
  /继续把(?:剩余)?任务做完/i,
];

const EXISTING_PLAN_EXECUTION_PATTERNS = [
  /(?:根据|按照|按).{0,24}(?:\.MAIN[\\/ ]*plans|\.main[\\/ ]*plans|plans\s*(?:文件夹|目录|folder)|计划(?:文件夹|目录)|tasks\.md|\.MAIN[\\/ ]*plans[\\/ ]*tasks\.md).{0,80}(?:完成|执行|继续|落地|处理|实现|推进)/i,
  /(?:完成|执行|继续|落地|处理|实现|推进).{0,60}(?:\.MAIN[\\/ ]*plans|\.main[\\/ ]*plans|plans\s*(?:文件夹|目录|folder)|计划任务|任务清单|tasks\.md)/i,
  /(?:执行|继续|完成).{0,24}(?:计划任务|计划中的任务|任务清单|执行方案和任务|方案和任务)/i,
  /(?:继续|恢复|接着).{0,16}(?:完成|执行|推进|落地).{0,16}(?:计划方案|计划任务|计划中的任务|计划|方案)/i,
  /(?:继续|恢复|接着).{0,16}(?:计划方案|计划任务|计划|方案).{0,16}(?:执行|落地|做完|完成)/i,
  /(?:把|将).{0,8}(?:计划方案|计划任务|计划|方案|剩余任务).{0,16}(?:继续|接着).{0,16}(?:做完|完成|执行|落地)/i,
  /\b(?:execute|resume|continue|finish).{0,40}(?:\.MAIN[\\/ ]*plans|tasks\.md|plan tasks|task list)\b/i,
  /\b(?:resume|continue|finish).{0,32}(?:the )?(?:approved )?(?:plan|plan execution|planned tasks)\b/i,
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

export type MainIntentShortcut = Exclude<ResolvedUserIntent, "respond" | "discuss" | "execute" | "studio_workflow">;

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
  {
    intent: "image_studio" as any,
    command: "/生图",
    label: "生成图片",
    description: "通过自然语言描述在当前对话中生成图片",
    category: "workflow_mode",
    aliases: ["draw", "image", "画图", "生图"],
    visibleInMenu: true,
  },
  {
    intent: "goal" as MainIntentShortcut,
    command: "/目标",
    label: "目标",
    description: "设定长期目标，Agent 自主循环执行直到完成或预算耗尽。",
    category: "workflow_mode",
    aliases: ["goal", "长任务", "自主执行", "autonomous"],
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
  {
    intent: "image_studio" as any,
    command: "/draw",
    label: "Generate Image",
    description: "Generate an image in the current chat using natural language description.",
    category: "workflow_mode",
    aliases: ["draw", "image", "paint"],
    visibleInMenu: true,
  },
  {
    intent: "goal" as MainIntentShortcut,
    command: "/goal",
    label: "Goal",
    description: "Set a long-term goal, letting the Agent execute autonomously until completion or budget exhaustion.",
    category: "workflow_mode",
    aliases: ["goal", "autonomous", "long task"],
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
    ...(patch.exactCommand ? { exactCommand: patch.exactCommand } : {}),
    ...(patch.reason ? { reason: patch.reason } : {}),
  };
}

export function buildEffectiveTurnContract(input: {
  conversationIntent: ResolvedUserIntent;
  runtimeIntent?: ResolvedUserIntent | null;
  commandDirective?: CommandDirective | null;
  planApproved?: boolean;
  planReviewReady?: boolean;
  executionConsentGranted?: boolean;
  workspaceMutationExpected?: boolean;
  workspaceValidationExpected?: boolean;
}): EffectiveTurnContract {
  const conversationIntent = input.conversationIntent;
  const runtimeIntent =
    input.runtimeIntent ??
    (conversationIntent === "plan" && input.planApproved ? "execute" : conversationIntent);
  const runtimePolicy = getIntentPolicy(runtimeIntent);
  const directiveKind = input.commandDirective?.kind ?? "none";
  const operationDirective =
    directiveKind === "file_modify" ||
    directiveKind === "shell" ||
    directiveKind === "git" ||
    directiveKind === "unity" ||
    directiveKind === "studio" ||
    directiveKind === "mcp" ||
    directiveKind === "plan_resume" ||
    directiveKind === "plan_approval";
  const isUnapprovedPlanDraft =
    conversationIntent === "plan" &&
    runtimeIntent === "plan" &&
    input.planApproved !== true;
  const mutationExpected =
    !isUnapprovedPlanDraft &&
    (
      runtimeIntent === "studio_workflow" ||
      (
        input.planApproved === true &&
        input.workspaceMutationExpected !== false
      ) ||
      directiveKind === "file_modify" ||
      directiveKind === "studio"
    );
  const validationExpected =
    !isUnapprovedPlanDraft &&
    (
      mutationExpected ||
      (
        input.planApproved === true &&
        input.workspaceValidationExpected !== false
      ) ||
      directiveKind === "shell" ||
      directiveKind === "git" ||
      directiveKind === "unity" ||
      directiveKind === "mcp"
    );
  const needsApproval =
    !isUnapprovedPlanDraft &&
    input.executionConsentGranted !== true &&
    (input.commandDirective?.requiresApproval === true || mutationExpected || operationDirective) &&
    !(conversationIntent === "plan" && input.planApproved === true) &&
    directiveKind !== "plan_approval" &&
    directiveKind !== "plan_resume";
  const operationApprovalState: OperationApprovalState =
    isUnapprovedPlanDraft
      ? "not_required"
      : input.executionConsentGranted === true || (mutationExpected && input.planApproved === true)
      ? "approved"
      : needsApproval
      ? "needs_approval"
      : "not_required";
  const planReviewState: PlanReviewState = conversationIntent !== "plan"
    ? "not_ready"
    : input.planApproved === true
    ? "approved"
    : input.planReviewReady === true
    ? "awaiting_review"
    : "not_ready";
  const completionEvidenceRequired: EffectiveTurnCompletionEvidence =
    mutationExpected || validationExpected
      ? "execution_evidence"
      : conversationIntent === "plan"
      ? "plan_artifact"
      : runtimePolicy.toolPolicy === "read_only"
      ? "answer"
      : "none";
  return {
    conversationIntent,
    runtimeIntent,
    approvalState: operationApprovalState,
    planReviewState,
    operationApprovalState,
    allowedToolRisks: runtimePolicy.toolPolicy,
    mutationExpected,
    validationExpected,
    completionEvidenceRequired,
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
    ...(normalizeDirectiveString(candidate.exactCommand, 1_000) ?? fallback?.exactCommand
      ? { exactCommand: normalizeDirectiveString(candidate.exactCommand, 1_000) ?? fallback?.exactCommand }
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

const EXPLICIT_SHELL_COMMAND_RE = /^(?:npm|pnpm|yarn|bun|node|python|python3|pytest|cargo|go|rustc|dotnet|bash|sh|make)\b/i;

export function looksLikeExplicitShellCommandInput(value: unknown): boolean {
  return EXPLICIT_SHELL_COMMAND_RE.test(String(value || "").trim());
}

const UNITY_CONSOLE_DIAGNOSTIC_RE = /console|报错|错误|warning|警告|compile|编译|编译失败|编译错误/i;
const UNITY_CONSOLE_NEGATION_RE = /(?:没有|无|未见|不是|并非|不\s*是|not|no|without).{0,12}(?:console|报错|错误|warning|警告|compile|编译|编译失败|编译错误)|(?:console|报错|错误|warning|警告|compile|编译|编译失败|编译错误).{0,12}(?:没有|无|未见|不是|并非|not|no|without)/i;

export function hasExplicitUnityConsoleDiagnosticCue(input: string): boolean {
  const normalized = normalizeInput(input);
  return UNITY_CONSOLE_DIAGNOSTIC_RE.test(normalized) && !UNITY_CONSOLE_NEGATION_RE.test(normalized);
}

function inferUnityAction(input: string): string {
  if (hasExplicitUnityConsoleDiagnosticCue(input)) return "console_diagnostics";
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
  const workspaceMutationExpected =
    looksLikeExplicitWorkspaceMutationRequest(normalizedInput) ||
    (
      (intent === "execute" || intent === "plan") &&
      WORKSPACE_MUTATION_REQUEST_RE.test(normalizedInput) &&
      !hasReadOnlyWorkspaceConstraint(normalizedInput)
    );
  const explicitShellCommand = looksLikeExplicitShellCommandInput(lower);
  const remoteShellOperation = /(?:同步|部署|上传|发布).{0,32}(?:服务器|远程|生产|线上|server|remote|production)|(?:服务器|远程|生产|线上|server|remote|production).{0,32}(?:同步|部署|上传|发布)/i.test(normalizedInput);
  const naturalShellOperation = /\b(?:run|execute|start)\b.{0,24}\b(?:command|script|deploy|test|build|server)\b/i.test(lower) ||
    /(?:执行|运行|启动).{0,16}(?:命令|脚本|测试|构建|服务|部署)/i.test(normalizedInput);

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

  if (remoteShellOperation) {
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

  if (workspaceMutationExpected) {
    return createCommandDirective("file_modify", {
      source,
      action: intent === "plan" ? "plan_file_change" : "workspace_file_change",
      requiresWorkspace: true,
      requiresApproval: intent === "execute",
      confidence: 0.86,
      reason: "Workspace file modification intent detected.",
    });
  }

  if (explicitShellCommand || naturalShellOperation) {
    return createCommandDirective("shell", {
      source,
      action: inferShellAction(normalizedInput),
      target: normalizeDirectiveString(normalizedInput, 80),
      ...(explicitShellCommand
        ? { exactCommand: normalizeDirectiveString(normalizedInput, 1_000) }
        : {}),
      requiresWorkspace: true,
      requiresApproval: true,
      confidence: 0.9,
      reason: "Shell command intent detected.",
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
  const operationNeedsApproval =
    commandDirective.requiresApproval === true &&
    !resolution.needsDecision &&
    !resolution.controlAction &&
    resolution.intent !== "execute" &&
    resolution.intent !== "studio_workflow" &&
    resolution.intent !== "plan";
  return {
    ...resolution,
    commandDirective,
    requiresApproval: resolution.requiresApproval ?? commandDirective.requiresApproval ?? resolution.riskLevel === "high",
    ...(operationNeedsApproval
      ? {
          needsDecision: true,
          suggestedIntent: "execute" as const,
          decisionOptions: ["execute", resolution.intent === "respond" || resolution.intent === "discuss" ? "respond" : resolution.intent, "respond"]
            .filter((intent, index, array) => array.indexOf(intent) === index) as ResolvedUserIntent[],
        }
      : {}),
  };
}

export function getMainIntentShortcuts(
  language: "zh" | "en" = "zh",
  options: { includeHidden?: boolean; mainModeKey?: MainModeKey } = {},
): MainIntentShortcutItem[] {
  const shortcuts = language === "en" ? MAIN_INTENT_SHORTCUTS_EN : MAIN_INTENT_SHORTCUTS_ZH;
  const visibleShortcuts = options.includeHidden ? shortcuts : shortcuts.filter((item) => item.visibleInMenu);
  const mainModeKey = options.mainModeKey;
  if (!mainModeKey) return visibleShortcuts;
  return visibleShortcuts.filter((item) => isMainIntentShortcutAllowedInMainMode(item.intent, mainModeKey));
}

export function isMainIntentShortcutAllowedInMainMode(intent: MainIntentShortcut, mainModeKey: MainModeKey): boolean {
  if (mainModeKey === "game_studio") return intent === "plan";
  if (mainModeKey === "image_studio") return false;
  return true;
}

export function getIntentPolicy(intent: ResolvedUserIntent): RunIntentPolicy {
  return RUN_INTENT_POLICIES[intent] ?? RUN_INTENT_POLICIES.respond;
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

export function parseMainIntentShortcutForMode(
  input: string,
  mainModeKey: MainModeKey,
): { intent: MainIntentShortcut; command: string; rest: string } | null {
  const parsed = parseMainIntentShortcut(input);
  if (!parsed) return null;
  return isMainIntentShortcutAllowedInMainMode(parsed.intent, mainModeKey) ? parsed : null;
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
    respond: {
      zh: "先自然回复/调整方案",
      en: "Respond / Adjust First",
      valueZh: "先继续自然回复或调整方案，不直接改动代码或运行命令",
      valueEn: "Continue with a natural response or adjust the proposal first, without changing files or running commands.",
    },
    discuss: {
      zh: "先自然回复/调整方案",
      en: "Respond / Adjust First",
      valueZh: "先继续自然回复或调整方案，不直接改动代码或运行命令",
      valueEn: "Continue with a natural response or adjust the proposal first, without changing files or running commands.",
    },
    plan: {
      zh: "先生成 Plan（批准后执行）",
      en: "Plan First",
      valueZh: "先生成可审阅 Plan，等我批准后再执行修改",
      valueEn: "Create a reviewable plan first, then execute after approval.",
    },
    execute: {
      zh: "批准执行本轮操作",
      en: "Approve This Operation",
      valueZh: "我批准本轮开始真实操作，请按当前需求执行并验证结果",
      valueEn: "I approve real operations for this turn. Execute the current request and validate the result.",
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
    image_studio: {
      zh: "生成图片",
      en: "Generate Image",
      valueZh: "在当前对话中生成图片",
      valueEn: "Generate an image in the current chat.",
    },
    goal: {
      zh: "设定目标（自主执行）",
      en: "Set Goal (Autonomous)",
      valueZh: "设定一个长期目标，Agent 将自主循环执行直到完成或预算耗尽",
      valueEn: "Set a long-term goal. The agent will iterate autonomously until the objective is met or the budget runs out.",
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
  const suggested = resolution.suggestedIntent ?? "respond";
  const intents: ResolvedUserIntent[] = resolution.decisionOptions?.length
    ? resolution.decisionOptions
    : suggested === "report"
    ? ["summarize", "report", "respond"]
    : ["execute", "respond", "plan"];

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
        "是否批准 MAIN 开始真实操作？",
        "Approve MAIN to start real operations?",
      );

  return {
    title,
    options: createDecisionOptions(intents, language),
    reason: resolution.reason,
  };
}

function isComposerSuggestibleIntent(intent: ResolvedUserIntent): intent is MainIntentShortcut {
  return ["plan", "summarize", "report", "analyze"].includes(intent);
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
  if (params.mainModeKey !== "main_mode" && params.mainModeKey !== "game_studio") return null;
  if (params.lockedComposerIntent) return null;
  if (params.dismissedSuggestedIntentKey === normalizedInput) return null;

  const shortcut = parseMainIntentShortcutForMode(normalizedInput, params.mainModeKey);
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
      isMainIntentShortcutAllowedInMainMode(resolution.intent, params.mainModeKey) &&
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
    isComposerSuggestibleIntent(resolution.intent) &&
    isMainIntentShortcutAllowedInMainMode(resolution.intent, params.mainModeKey)
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
      return "respond";
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
 * 普通低风险自然回复如果在发送前被它阻塞，会让按钮/回车看起来像“卡住”。
 * 因此这里只让真正可能改变后续流程的低置信度请求进入阻塞 preflight。
 */
export function shouldUseBlockingIntentPreflight(
  resolution: RunIntentResolution,
  mainModeKey: MainModeKey,
  input = "",
): boolean {
  if (mainModeKey !== "main_mode") return false;
  if (resolution.bypassMainRouter) return false;
  if (resolution.needsDecision) return false;
  if (resolution.confidence >= 0.9) return false;
  if (getIntentPolicy(resolution.intent).uiCategory === "output_style") return false;

  // region: 热路径保护
  // 普通自然回复已经会由主模型在系统提示里继续判断真实任务类型，
  // 不值得为了一次额外 preflight 阻塞用户点击发送或回车。
  if ((resolution.intent === "respond" || resolution.intent === "discuss") && resolution.riskLevel === "low") {
    return looksLikeAmbiguousChatExecutionInput(input);
  }
  // endregion

  return true;
}

export function looksLikeAmbiguousChatExecutionInput(input: string): boolean {
  const normalizedInput = normalizeInput(input);
  if (!normalizedInput) return false;
  if (matchesAny(normalizedInput, STRONG_ANALYZE_PATTERNS)) return false;
  if (matchesAny(normalizedInput, STRONG_SUMMARIZE_PATTERNS)) return false;
  if (matchesAny(normalizedInput, STRONG_REPORT_PATTERNS)) return false;
  return matchesAny(normalizedInput, AMBIGUOUS_CHAT_EXECUTION_PATTERNS);
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
  const isWorkspaceTurn = context.hasWorkspace === true;
  const normalizedInput = normalizeInput(input);
  const finalize = (resolution: Parameters<typeof finalizeRunIntentResolution>[2]) =>
    finalizeRunIntentResolution(input, context, resolution);

  if (!normalizedInput) {
    return finalize({
      intent: "respond",
      reason: localizeReason(language, "空输入默认按自然回复处理。", "Empty input defaults to natural response."),
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
      intent: isWorkspaceTurn ? "report" : "respond",
      reason: localizeReason(
        language,
        isWorkspaceTurn
          ? "检测到工作区报告请求；本轮进入只读报告流程。"
          : "检测到报告输出语义，但未使用 /报告；本轮保持自然回复并让模型按请求组织内容。",
        isWorkspaceTurn
          ? "Detected a workspace report request, so this turn enters the read-only report workflow."
          : "Detected report wording without /report; this turn stays in natural response while following the requested format.",
      ),
      confidence: 0.86,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  const hasStrongSummarizeSignal = matchesAny(normalizedInput, STRONG_SUMMARIZE_PATTERNS);
  const hasStrongExecuteSignal =
    matchesAny(normalizedInput, STRONG_EXECUTE_PATTERNS) ||
    looksLikeExplicitWorkspaceMutationRequest(normalizedInput);
  const hasStrongAnalyzeSignal = matchesAny(normalizedInput, STRONG_ANALYZE_PATTERNS);

  if (context.mainModeKey === "main_mode" && hasStrongSummarizeSignal && hasStrongExecuteSignal) {
    return finalize({
      intent: isWorkspaceTurn ? "execute" : "respond",
      reason: localizeReason(
        language,
        isWorkspaceTurn
          ? "同时检测到总结与真实操作信号；工作区回合进入执行流程，具体高风险工具仍按调用审批。"
          : "同时检测到总结与真实操作信号；真实操作需要先得到用户批准。",
        isWorkspaceTurn
          ? "Detected both summary and real-operation signals. The workspace turn enters execution while risky tools remain approval-gated at call time."
          : "Detected both summary and real-operation signals; real operations require user approval first.",
      ),
      confidence: 0.9,
      bypassMainRouter: false,
      riskLevel: "medium",
      ...(isWorkspaceTurn
        ? {}
        : {
            needsDecision: true,
            suggestedIntent: "execute" as const,
            decisionOptions: ["execute", "respond", "summarize"] as ResolvedUserIntent[],
          }),
    });
  }

  if (hasStrongSummarizeSignal) {
    return finalize({
      intent: isWorkspaceTurn ? "summarize" : "respond",
      reason: localizeReason(
        language,
        isWorkspaceTurn
          ? "检测到工作区总结请求；本轮进入只读总结流程。"
          : "检测到总结语义，但未使用 /总结；本轮保持自然回复并按请求提炼内容。",
        isWorkspaceTurn
          ? "Detected a workspace summary request, so this turn enters the read-only summary workflow."
          : "Detected summary wording without /summarize; this turn stays in natural response while summarizing as requested.",
      ),
      confidence: 0.86,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  if (hasStrongExecuteSignal && hasStrongAnalyzeSignal) {
    return finalize({
      intent: "execute",
      reason: localizeReason(
        language,
        "检测到“先定位/分析问题，再修复”的明确执行语义；本轮直接进入可写入与验证的执行链路。",
        "Detected an explicit find/analyze-then-fix request, so this turn goes directly into the execution-capable workflow.",
      ),
      confidence: 0.94,
      bypassMainRouter: false,
      riskLevel: "medium",
    });
  }

  if (hasStrongAnalyzeSignal) {
    return finalize({
      intent: isWorkspaceTurn ? "analyze" : "respond",
      reason: localizeReason(
        language,
        isWorkspaceTurn
          ? "检测到工作区分析/检查请求；本轮进入只读分析流程。"
          : "检测到分析/检查语义，但未使用 /分析；本轮保持自然回复并可进行必要的只读检查。",
        isWorkspaceTurn
          ? "Detected a workspace analysis or inspection request, so this turn enters the read-only analysis workflow."
          : "Detected analysis wording without /analyze; this turn stays in natural response and may use read-only inspection.",
      ),
      confidence: 0.86,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  if (matchesAny(normalizedInput, STRONG_PLAN_PATTERNS)) {
    return finalize({
      intent: isWorkspaceTurn ? "plan" : "respond",
      reason: localizeReason(
        language,
        isWorkspaceTurn
          ? "检测到工作区方案/规划请求；本轮进入正式计划流程。"
          : "检测到方案/规划语义，但未使用 /计划；本轮保持自然回复并在形成方案后跟踪是否执行。",
        isWorkspaceTurn
          ? "Detected a workspace planning request, so this turn enters the formal planning workflow."
          : "Detected planning wording without /plan; this turn stays in natural response and will track execution follow-up if a proposal is produced.",
      ),
      confidence: 0.86,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  const complexImplementationMatches = countPatternMatches(normalizedInput, COMPLEX_IMPLEMENTATION_PATTERNS);
  if (complexImplementationMatches >= 2) {
    return finalize({
      intent: isWorkspaceTurn ? "plan" : "respond",
      reason: localizeReason(
        language,
        isWorkspaceTurn
          ? "检测到多文件/架构级工作区任务；本轮先进入正式计划流程，源码写入仍需计划批准。"
          : "检测到多文件/架构级实现请求；真实操作或正式计划都需要用户选择后继续。",
        isWorkspaceTurn
          ? "Detected a multi-file or architecture-level workspace task. This turn enters formal planning first, and source writes still require plan approval."
          : "Detected a multi-file or architecture-level implementation request; real operations or formal planning require the user to choose first.",
      ),
      confidence: 0.93,
      bypassMainRouter: false,
      riskLevel: "high",
      ...(isWorkspaceTurn
        ? {}
        : {
            needsDecision: true,
            suggestedIntent: "plan" as const,
            decisionOptions: ["plan", "respond", "execute"] as ResolvedUserIntent[],
          }),
    });
  }

  if (context.mainModeKey === "game_studio" && matchesAny(normalizedInput, GAME_STUDIO_EXECUTE_PATTERNS)) {
    return finalize({
      intent: "execute",
      reason: localizeReason(
        language,
        "检测到 Game Studio 中明确的实现、重构或完善请求；本轮直接进入可写入与验证的执行链路。",
        "Detected an explicit implementation, refactor, or completion request inside Game Studio, so this turn goes directly into the execution-capable workflow.",
      ),
      confidence: 0.9,
      bypassMainRouter: false,
      riskLevel: "medium",
    });
  }

  if (hasStrongExecuteSignal) {
    return finalize({
      intent: "execute",
      reason: localizeReason(
        language,
        "检测到明确的修复、实现或真实操作请求；本轮直接进入可写入与验证的执行链路。",
        "Detected an explicit fix, implementation, or real-operation request, so this turn goes directly into the execution-capable workflow.",
      ),
      confidence: 0.94,
      bypassMainRouter: false,
      riskLevel: "medium",
    });
  }

  if (isWorkspaceTurn && looksLikeAmbiguousChatExecutionInput(normalizedInput)) {
    return finalize({
      intent: "execute",
      reason: localizeReason(
        language,
        "检测到工作区中的功能新增或修改请求；本轮进入执行流程，实际变更仍由工具调用审批约束。",
        "Detected a feature addition or modification request in the workspace. This turn enters execution while actual changes remain tool-approval gated.",
      ),
      confidence: 0.9,
      bypassMainRouter: false,
      riskLevel: "medium",
      commandDirective: createCommandDirective("file_modify", {
        source: "natural_language",
        action: "workspace_file_change",
        requiresWorkspace: true,
        requiresApproval: true,
        confidence: 0.9,
        reason: "Workspace feature modification intent detected.",
      }),
    });
  }

  if (matchesAny(normalizedInput, WEAK_PLAN_PATTERNS)) {
    return finalize({
      intent: "respond",
      reason: localizeReason(
        language,
        "这条消息里出现了方案或计划相关关键词；未使用 /计划 时按自然回复处理。",
        "This message contains planning keywords; without /plan it stays in natural response.",
      ),
      confidence: 0.7,
      bypassMainRouter: false,
      riskLevel: "low",
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
      intent: isWorkspaceTurn ? "plan" : "respond",
      reason: localizeReason(
        language,
        isWorkspaceTurn
          ? "这条工作区请求涉及多个阶段或系统；本轮先进入正式计划流程。"
          : "这条请求涉及较多阶段或系统，MAIN 建议先确认是否进入计划阶段，再决定是否直接实施。",
        isWorkspaceTurn
          ? "This workspace request spans multiple phases or systems, so the turn enters formal planning first."
          : "This request spans multiple phases or systems. MAIN should confirm whether to plan first before implementing.",
      ),
      confidence: 0.82,
      bypassMainRouter: false,
      riskLevel: "high",
      ...(isWorkspaceTurn
        ? {}
        : {
            needsDecision: true,
            suggestedIntent: "plan" as const,
            decisionOptions: ["plan", "respond", "execute"] as ResolvedUserIntent[],
          }),
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
      intent: "respond",
      reason: localizeReason(
        language,
        "Game Studio 普通文本默认按自然回复处理，只有 slash 工作流默认直走执行。",
        "Game Studio plain text defaults to natural response; only slash workflows go straight to execution.",
      ),
      confidence: 0.84,
      bypassMainRouter: false,
      riskLevel: "low",
    });
  }

  return finalize({
    intent: "respond",
    reason: localizeReason(
      language,
      "没有命中主动斜杠流程，本轮按自然回复处理。",
      "No explicit slash workflow was detected, so this turn defaults to natural response.",
    ),
    confidence: 0.74,
    bypassMainRouter: false,
    riskLevel: "low",
  });
}

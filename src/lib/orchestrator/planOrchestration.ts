import type { PlanToolActivitySummary } from "../planExecutionRecovery";
import type { PlanEvidenceRecord } from "../planMaterialization";
import {
  hasTurnProvidedContext,
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "../turnIntake";
import type { PlanRuntimePhase, ReplyOption } from "../workflowModels";

type Language = "zh" | "en";
type PlanStage = "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed";

export interface PlanClosureMaterializationInput {
  userGoal: string;
  evidence: string[];
  evidenceRecords: PlanEvidenceRecord[];
  files: string[];
  constraints: string[];
  sanitizer: Record<string, unknown>;
  sanitizerDropped: Array<{ bucket: string; reason: string; preview: string }>;
}

export function buildPlanReadOnlyConvergencePrompt(
  language: Language,
  batchCount: number,
  toolCount: number,
  userContext?: TurnInputContextSignals,
): string {
  const context = normalizeTurnInputContextSignals(userContext);
  const hasProvidedContext = hasTurnProvidedContext(context);
  if (language === "en") {
    return [
      "PLAN_READONLY_CONVERGENCE: The broad discovery budget for this planning turn has been reached, or enough targeted evidence is already available.",
      `Read-only exploration so far: ${batchCount} batch(es), ${toolCount} tool result(s).`,
      hasProvidedContext
        ? `User-provided context exists: ${context.imageParts} image(s), ${context.mentionedFilePaths.length} @ file(s), ${context.attachedFilePaths.length} attachment(s). Treat it as primary evidence.`
        : "",
      context.imageParts > 0
        ? "If you have not already done so, include a concrete 'Screenshot observations' section that states what is visible in the provided image(s) and maps those observations to likely UI/state/code areas."
        : "",
      context.mentionedFilePaths.length > 0 || context.attachedFilePaths.length > 0
        ? "Before any broad discovery, use the exact @ file or attachment paths as primary evidence and name what those files already show."
        : "",
      "Stop broad rereading now. If targeted source/data evidence is still missing, call exactly one specific read/search tool for the missing file, symbol, or dataset, then stop. If the evidence is decision-complete, create or update `.MAIN/plans/plan.md` with `write_file` or `replace_in_file`; this is the only write allowed before approval.",
      "The plan file must include: confirmed findings, unverified hypotheses, evidence already read, tradeoffs, affected files, implementation steps, and validation.",
      "Only use `<user_options>` if there is a real product/design decision the user must make before a plan can be written. Do not offer options that merely ask to continue reading, checking, analyzing, or verifying.",
      "If a blocker remains, name the blocker and the single missing fact needed; do not continue broad file exploration.",
      "Do not edit source files or `tasks.md` before approval.",
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_READONLY_CONVERGENCE: 当前规划回合已经达到宽泛发现预算，或已经具备足够的定向证据。",
    `只读探索累计：${batchCount} 批，${toolCount} 个工具结果。`,
    hasProvidedContext
      ? `用户已提供上下文：${context.imageParts} 张图片、${context.mentionedFilePaths.length} 个 @ 文件、${context.attachedFilePaths.length} 个附件。必须把这些作为优先证据。`
      : "",
    context.imageParts > 0
      ? "如果还没有写过，下一条必须先写出“截图观察到的现象”：具体说明图片中可见的 UI/状态/文本/异常，并把这些现象映射到可能的 UI、状态或代码区域。"
      : "",
    context.mentionedFilePaths.length > 0 || context.attachedFilePaths.length > 0
      ? "在继续大范围发现前，必须优先使用 @ 文件或附件的精确路径作为主要证据，并说明这些文件已经证明了什么。"
      : "",
    "下一步不要继续泛读文件。如果还缺源码/数据定向证据，只能围绕缺失的文件、符号或数据集调用一次具体读取/搜索工具，然后停止；如果证据已经足够，请用 `write_file` 或 `replace_in_file` 创建/更新 `.MAIN/plans/plan.md`；这是批准前唯一允许的写入。",
    "计划文件必须包含：已确认发现、未验证假设、已读证据、方案取舍、影响文件、实施步骤和验证方式。",
    "只有存在真实产品/设计分叉、必须由用户决定后才能写计划时，才允许使用 `<user_options>`；不要给出只是继续读取、检查、分析或验证的选项。",
    "如果仍有阻塞，只说明阻塞点和唯一缺失事实；不要继续大范围探索。",
    "批准前不要修改源码或生成 `tasks.md`。",
  ].filter(Boolean).join("\n");
}

export function buildPlanReadOnlyConvergencePause(
  language: Language,
  batchCount: number,
  toolCount: number,
  userContext?: TurnInputContextSignals,
): {
  text: string;
  options: ReplyOption[];
} {
  const context = normalizeTurnInputContextSignals(userContext);
  const hasProvidedContext = hasTurnProvidedContext(context);
  if (language === "en") {
    return {
      text: [
        "MAIN has collected enough read-only context, but the model kept exploring instead of producing a plan.",
        `Current exploration: ${batchCount} read-only batches, ${toolCount} tool results.`,
        hasProvidedContext ? "The next step should start from the provided image/file context, not from another broad scan." : "",
        "Choose the next direction.",
      ].filter(Boolean).join("\n"),
      options: [
        { label: hasProvidedContext ? "Use provided context for the plan" : "Generate the diagnosis plan", value: hasProvidedContext ? "Please stop broad exploration, first summarize the screenshot/file observations, then generate the diagnosis, tradeoffs, and proposed plan from the evidence already gathered." : "Please stop exploring and generate the diagnosis, tradeoffs, and proposed plan from the evidence already gathered.", action: "adjust_plan" },
        { label: "One targeted evidence pass", value: hasProvidedContext ? "Do one more tightly scoped read-only pass based only on the screenshot/file observations, then immediately stop and summarize the plan." : "Continue one more targeted read-only exploration pass, then stop and summarize the plan.", action: "continue_readonly_once" },
      ],
    };
  }
  return {
    text: [
      "MAIN 已经收集了足够的只读上下文，但模型仍在继续探索，没有产出可审阅方案。",
      `当前探索累计：${batchCount} 批只读工具，${toolCount} 个工具结果。`,
      hasProvidedContext ? "下一步应回到用户提供的图片/文件上下文，而不是继续泛读项目。" : "",
      "请选择下一步方向。",
    ].filter(Boolean).join("\n"),
    options: [
      { label: hasProvidedContext ? "先说明截图观察并生成归因方案" : "生成归因方案", value: hasProvidedContext ? "请停止泛读，先明确列出截图/文件中实际观察到的现象，再基于已有证据生成问题归因、方案取舍和可审批计划。" : "请停止继续探索，直接基于已有证据生成问题归因、方案取舍和可审批计划。", action: "adjust_plan" },
      { label: "只补一个明确证据", value: hasProvidedContext ? "请只围绕截图/文件观察到的现象补充一个精确定向证据，然后立刻停止并生成归因方案。" : "请再做一次定向只读探索，然后立刻停止并总结方案。", action: "continue_readonly_once" },
    ],
  };
}

export function buildPlanPostConvergenceToolRedirectPrompt(input: {
  language: Language;
  toolNames: string[];
  userContext?: TurnInputContextSignals;
  phase?: PlanRuntimePhase;
  qualityGateReason?: string;
  missingSections?: string[];
  rejectCount?: number;
}): string {
  const context = normalizeTurnInputContextSignals(input.userContext);
  const toolList = input.toolNames.slice(0, 6).join(", ");
  const missing = (input.missingSections || []).filter(Boolean).join(", ");
  const reason = input.qualityGateReason || (missing ? `missing:${missing}` : "");
  const phase = input.phase || "drafting";
  if (phase === "needs_rewrite") {
    if (input.language === "en") {
      return [
        "PLAN_NEEDS_REWRITE: The last visible plan draft was structurally incomplete, but this is not a reason to read more files.",
        toolList ? `The attempted read-only tool call(s) were suppressed before execution: ${toolList}.` : "",
        reason ? `Quality gate reason: ${reason}.` : "",
        "Rewrite `.MAIN/plans/plan.md` now with `write_file` or `replace_in_file`. Add the missing user goal/sections from the user request and the evidence already in the transcript.",
        "Do not call read-only tools in the next response unless MAIN explicitly reopens evidence recovery.",
        "Do not edit source files or `tasks.md` before approval.",
      ].filter(Boolean).join("\n");
    }
    return [
      "PLAN_NEEDS_REWRITE: 上一个可见计划草稿只是结构不完整，这不是继续读文件的理由。",
      toolList ? `刚才的只读工具已在执行前静默拦截：${toolList}。` : "",
      reason ? `质量门禁原因：${reason}。` : "",
      "现在直接用 `write_file` 或 `replace_in_file` 重写 `.MAIN/plans/plan.md`：把用户目标和缺失章节补齐，证据只使用当前对话里已经观察/读取到的内容。",
      "下一条不要再调用只读工具；除非 MAIN 明确进入补证据阶段。",
      "批准前不要修改源码或生成 `tasks.md`。",
    ].filter(Boolean).join("\n");
  }
  if (input.language === "en") {
    return [
      "PLAN_READONLY_CONVERGENCE_ENFORCED: Stop calling more read-only discovery tools.",
      toolList ? `The attempted tool call(s) were blocked before execution: ${toolList}.` : "",
      reason ? `Current plan quality gate reason: ${reason}.` : "",
      context.imageParts > 0
        ? "First write a concrete 'Screenshot observations' section: visible UI/text/state, what the user is asking, and which code/state path it points to."
        : "First restate the observed user-provided context and the actual user goal.",
      "Then create or update `.MAIN/plans/plan.md` with `write_file` or `replace_in_file`, including the diagnosis, evidence, affected files, implementation steps, and validation.",
      "If one missing fact truly blocks the plan, ask exactly one concrete question with `<user_options>`; do not offer generic continue-reading options.",
      "Allowed next actions: write/update `.MAIN/plans/plan.md`, or ask one blocking user choice. Do not call get_project_skeleton, list_directory, glob_search, grep_search, read_file, or read_document again in the next response.",
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_READONLY_CONVERGENCE_ENFORCED: 停止继续调用只读发现工具。",
    toolList ? `刚才准备执行的工具已在执行前拦截：${toolList}。` : "",
    reason ? `当前计划质量门禁原因：${reason}。` : "",
    context.imageParts > 0
      ? "下一步必须先写出“截图观察到的现象”：图片中可见的 UI/文本/状态、用户真正要解决的问题，以及它指向的代码/状态链路。"
      : "下一步必须先复述用户提供的上下文和真实目标。",
    "随后用 `write_file` 或 `replace_in_file` 创建/更新 `.MAIN/plans/plan.md`，包含问题归因、已有证据、影响文件、实施步骤和验证方式。",
    "如果确实只有一个缺失事实阻塞方案，只能提出一个具体问题并用 `<user_options>`；不要再给“继续查/继续分析”这类泛化选项。",
    "下一条只允许：写入/更新 `.MAIN/plans/plan.md`，或询问一个真实阻塞选择。不要再次调用 get_project_skeleton、list_directory、glob_search、grep_search、read_file 或 read_document。",
  ].filter(Boolean).join("\n");
}

export function planRuntimePhasePresentation(
  phase: PlanRuntimePhase,
  language: Language,
  reason?: string,
): { kind: "scope" | "context" | "diagnosis" | "implementation" | "validation"; title: string; summary: string } {
  const suffix = reason ? (language === "zh" ? `（${reason}）` : ` (${reason})`) : "";
  switch (phase) {
    case "explore_structure":
      return {
        kind: "scope",
        title: language === "zh" ? "Explore" : "Explore",
        summary: language === "zh" ? `探索项目结构${suffix}` : `Explore project structure${suffix}`,
      };
    case "grounding":
      return {
        kind: "context",
        title: language === "zh" ? "Exploring" : "Exploring",
        summary: language === "zh" ? `先确认截图、附件和最小源码证据${suffix}` : `Ground screenshots, attachments, and minimal source evidence${suffix}`,
      };
    case "synthesis":
      return {
        kind: "diagnosis",
        title: language === "zh" ? "Synthesis" : "Synthesis",
        summary: language === "zh" ? `归纳已确认事实、未验证假设和阻塞点${suffix}` : `Summarize confirmed facts, hypotheses, and blockers${suffix}`,
      };
    case "drafting":
      return {
        kind: "diagnosis",
        title: language === "zh" ? "Drafting" : "Drafting",
        summary: language === "zh" ? `把证据收束为可见审批方案${suffix}` : `Condense evidence into a reviewable visible plan${suffix}`,
      };
    case "needs_evidence":
      return {
        kind: "context",
        title: language === "zh" ? "Needs evidence" : "Needs evidence",
        summary: language === "zh" ? `草稿缺少真实证据，临时开放一次定向只读补证${suffix}` : `The draft needs evidence; reopen one targeted read-only pass${suffix}`,
      };
    case "needs_rewrite":
      return {
        kind: "diagnosis",
        title: language === "zh" ? "Needs rewrite" : "Needs rewrite",
        summary: language === "zh" ? `草稿结构不完整，直接重写可见方案${suffix}` : `The draft is structurally incomplete; rewrite the visible plan${suffix}`,
      };
    case "review_ready":
      return {
        kind: "validation",
        title: language === "zh" ? "Review ready" : "Review ready",
        summary: language === "zh" ? `plan.md 已通过质量门禁，等待审批${suffix}` : `plan.md passed the quality gate and is ready for review${suffix}`,
      };
    case "blocked":
      return {
        kind: "diagnosis",
        title: language === "zh" ? "Blocked" : "Blocked",
        summary: language === "zh" ? `需要一个真实阻塞问题或用户选择${suffix}` : `Needs a real blocker or user decision${suffix}`,
      };
  }
}

export function buildPlanAutoScaffoldPrompt(input: {
  language: Language;
  latestUserPromptText: string;
  recentToolActivity: PlanToolActivitySummary[];
  qualityGateReason?: string;
  missingSections?: string[];
}): string {
  const reason = formatPlanQualityReason({
    reason: input.qualityGateReason,
    missingSections: input.missingSections,
    language: input.language,
  });
  const evidence = summarizeRecentPlanEvidenceForPrompt(input.recentToolActivity, input.language);
  if (input.language === "en") {
    return [
      "PLAN_AUTO_SCAFFOLD: Two low-quality plan drafts were rejected. Stop branching and rewrite `.MAIN/plans/plan.md` using this scaffold. This is the only allowed pre-approval write.",
      reason,
      "",
      "Required scaffold:",
      "# Plan",
      "## User Goal",
      input.latestUserPromptText || "- Restate the user's concrete request from the conversation.",
      "## Screenshot / Attachment Observations",
      "- List only visible or provided facts. If none were provided, write `No screenshot/attachment was provided`.",
      "## Read Evidence",
      evidence,
      "## Confirmed Findings",
      "- Convert only the evidence above into confirmed facts.",
      "## Unverified Hypotheses",
      "- Mark every remaining assumption as unverified; do not execute from it until validated.",
      "## Execution Steps",
      "1. Decision-complete implementation step.",
      "## Affected Files",
      "- path or interface",
      "## Validation Standards",
      "- Exact test/build/manual validation that would prove the fix.",
      "",
      "Write this scaffold to `.MAIN/plans/plan.md` now with `write_file` or `replace_in_file`. Do not call read-only tools unless MAIN has reopened evidence recovery.",
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_AUTO_SCAFFOLD: 连续两个低质量 plan 草稿被拒绝。停止分叉，按下面脚手架重写 `.MAIN/plans/plan.md`；这是批准前唯一允许的写入。",
    reason,
    "",
    "必须使用的脚手架：",
    "# 计划",
    "## 用户目标",
    input.latestUserPromptText || "- 从对话中复述用户的具体请求。",
    "## 截图/附件观察",
    "- 只列可见或已提供事实；如果没有截图/附件，写 `未提供截图/附件`。",
    "## 已读证据",
    evidence,
    "## 已确认事实",
    "- 只能把上面的证据转成已确认事实。",
    "## 未验证假设",
    "- 所有剩余推断都标为未验证；不能把它当作执行依据。",
    "## 执行步骤",
    "1. 写 decision-complete 的实施步骤。",
    "## 影响文件",
    "- path 或接口名。",
    "## 验证标准",
    "- 能证明修复成立的测试/构建/人工验证。",
    "",
    "现在用 `write_file` 或 `replace_in_file` 把这个脚手架写入 `.MAIN/plans/plan.md`。除非 MAIN 已重新开放补证据，否则不要调用只读工具。",
  ].filter(Boolean).join("\n");
}

export function buildPlanEvidenceRecoveryClosurePrompt(input: {
  language: Language;
  recentToolActivity: PlanToolActivitySummary[];
  qualityGateReason?: string;
  missingSections?: string[];
}): string {
  const reason = formatPlanQualityReason({
    reason: input.qualityGateReason,
    missingSections: input.missingSections,
    language: input.language,
  });
  const evidence = summarizeRecentPlanEvidenceForPrompt(input.recentToolActivity, input.language);
  if (input.language === "en") {
    return [
      "PLAN_EVIDENCE_RECOVERY_COMPLETE: The targeted evidence pass is complete.",
      reason,
      "Use the new evidence below and create or update `.MAIN/plans/plan.md` now with `write_file` or `replace_in_file`; do not start another broad exploration pass.",
      evidence,
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_EVIDENCE_RECOVERY_COMPLETE: 定向补证已经完成。",
    reason,
    "现在用下面的新证据通过 `write_file` 或 `replace_in_file` 创建/更新 `.MAIN/plans/plan.md`；不要开启新一轮泛读。",
    evidence,
  ].filter(Boolean).join("\n");
}

export function buildPlanEvidenceRecoveryBlockedPrompt(input: {
  language: Language;
  recentToolActivity: PlanToolActivitySummary[];
  qualityGateReason?: string;
  missingSections?: string[];
}): string {
  const reason = formatPlanQualityReason({
    reason: input.qualityGateReason,
    missingSections: input.missingSections,
    language: input.language,
  });
  const evidence = summarizeRecentPlanEvidenceForPrompt(input.recentToolActivity, input.language);
  if (input.language === "en") {
    return [
      "PLAN_EVIDENCE_RECOVERY_BLOCKED: The one targeted evidence pass did not produce usable evidence.",
      reason,
      "Do not keep calling read-only tools. Either write `.MAIN/plans/plan.md` using only confirmed evidence below, or state the single real blocker as a user-visible question.",
      evidence,
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_EVIDENCE_RECOVERY_BLOCKED: 这一次定向补证没有得到可用证据。",
    reason,
    "不要继续调用只读工具。要么只基于下面已确认的证据写入 `.MAIN/plans/plan.md`，要么把唯一真实阻塞点作为可见问题告诉用户。",
    evidence,
  ].filter(Boolean).join("\n");
}

export function buildPlanFallbackNotice(language: Language, sourceChars: number): string {
  const formatted = sourceChars.toLocaleString();
  return language === "zh"
    ? `模型刚才输出了约 ${formatted} 个字符的规划正文，但还没有写入可审批 \`.MAIN/plans/plan.md\`。MAIN 会要求模型按计划文件重写，或用可点击选项确认关键分叉；不会把工具日志或截断内容强行写成计划。`
    : `The model produced about ${formatted} characters of planning text but did not write a reviewable \`.MAIN/plans/plan.md\`. MAIN will ask the model to rewrite the plan file, or ask for the key decision first; tool logs and truncated text will not be forced into plan files.`;
}

export function buildPlanStreamTimeoutPauseMessage(
  language: Language,
  stage: PlanStage,
): string {
  if (language === "en") {
    return stage === "requirements"
      ? "requirements.md has been generated, but the model did not return the next design step in time. This planning turn is paused; continue with plan.md when ready."
      : "The model did not return the next planning step in time. This planning turn is paused and can be continued.";
  }
  return stage === "requirements"
    ? "已生成 requirements.md，但模型长时间没有返回下一步执行计划。本轮已暂停，你可以继续生成 plan.md。"
    : "模型长时间没有返回下一步规划内容，本轮已暂停，可以继续当前计划阶段。";
}

export function hasGroundedPlanClosureEvidence(
  input: PlanClosureMaterializationInput,
  recentActivity: PlanToolActivitySummary[] = [],
): boolean {
  if (!hasRelevantPlanClosureEvidence(input, recentActivity)) return false;

  const hasNonPlanFile = input.files.some((file) => {
    const target = String(file || "").trim();
    return !!target && !isPlanArtifactPath(target);
  });
  if (hasNonPlanFile) return true;

  const hasSuccessfulReadActivity = recentActivity.some((item) =>
    item.status === "succeeded" &&
    PLAN_EXPLORATION_READ_ONLY_TOOLS.has(item.name) &&
    (!item.target || !isPlanArtifactPath(item.target))
  );
  if (hasSuccessfulReadActivity) return true;

  return input.evidence.some((item) => {
    const text = String(item || "").trim();
    if (!text) return false;
    if (/^(?:模型曾尝试修改|model attempted to modify)/i.test(text)) return false;
    if (/\.MAIN\/plans\/plan\.md/i.test(text) && !/(?:read|读取|search|搜索|evidence|证据|confirmed|已确认)/i.test(text)) return false;
    return true;
  });
}

export function hasRelevantPlanClosureEvidence(
  input: PlanClosureMaterializationInput,
  recentActivity: PlanToolActivitySummary[] = [],
): boolean {
  const goal = String(input.userGoal || "").trim();
  if (!goal) return false;

  const files = [
    ...input.files,
    ...recentActivity.map((item) => item.target || ""),
  ]
    .map((item) => normalizePlanEvidencePath(String(item || "")))
    .filter((item) => item && !isPlanArtifactPath(item));

  const evidenceText = [
    ...input.evidence,
    ...input.constraints,
    ...recentActivity.map((item) => [item.name, item.target, item.detail].filter(Boolean).join(" ")),
    ...files,
  ].join("\n").toLowerCase();

  const explicitPaths = extractExplicitGoalPaths(goal);
  if (explicitPaths.length > 0) {
    return explicitPaths.some((goalPath) =>
      files.some((file) =>
        file === goalPath ||
        file.endsWith(`/${goalPath}`) ||
        file.endsWith(`/${goalPath.split("/").pop() || goalPath}`)
      ) ||
      evidenceText.includes(goalPath)
    );
  }

  const hints = extractGoalRelevanceHints(goal);
  if (hints.some((hint) => evidenceText.includes(hint))) return true;

  const docOnly = files.length > 0 && files.every(isDocumentationEvidenceFile);
  if (docOnly && !goalMentionsDocumentation(goal)) return false;

  const sourceEvidenceCount = files.filter(isImplementationEvidenceFile).length;
  return sourceEvidenceCount >= 2 && input.evidence.length >= 2;
}

export function resolvePlanClosureArtifactKind(
  input: PlanClosureMaterializationInput,
  currentStage: PlanStage,
  recentActivity: PlanToolActivitySummary[] = [],
): "plan" | "design" {
  if (currentStage === "design") return "design";
  const text = [
    input.userGoal,
    ...input.constraints,
    ...input.evidence.slice(0, 6),
  ].join("\n");
  if (
    /\.MAIN\/plans\/design\.md/i.test(text) ||
    /(?:设计方案|设计文档|Design\s+(?:artifact|document|plan)|reviewable,\s*actionable\s*design)/i.test(text) ||
    /(?:框架设计|架构设计|接口设计|代码框架|类图|游戏开发|game\s*dev|architecture|framework|class\s*structure|class\s*diagram)/i.test(text)
  ) {
    return "design";
  }
  if (hasSuccessfulTabularActivity(recentActivity) && /(?:\.csv|\.tsv|\.xlsx|表格|数据|tabular|spreadsheet)/i.test(text)) {
    return "design";
  }
  return "plan";
}

export function hasSuccessfulTabularActivity(recentActivity: PlanToolActivitySummary[]): boolean {
  return recentActivity.some((item) =>
    item.status === "succeeded" &&
    (item.name === "analyze_tabular_document" || item.name === "query_tabular_document")
  );
}

export function countSuccessfulPlanReadEvidence(recentActivity: PlanToolActivitySummary[]): number {
  const signatures = new Set<string>();
  for (const item of recentActivity) {
    if (item.status !== "succeeded" || !PLAN_EVIDENCE_TOOLS.has(item.name)) continue;
    signatures.add([item.name, item.target || "", item.detail || ""].join("|"));
  }
  return signatures.size;
}

export function buildPlanRecoveryPromptFromContext(input: {
  language: Language;
  userPrompt: string;
  sourceText: string;
  toolHighlights: string[];
}): string {
  const bullets = collectFallbackPlanBullets(input.sourceText, input.userPrompt, 6);
  const contextSummary = [
    input.userPrompt ? (input.language === "zh" ? `用户原始目标：${input.userPrompt}` : `Original user goal: ${input.userPrompt}`) : "",
    bullets.length > 0
      ? (input.language === "zh" ? `可用规划要点：\n${bullets.map((item) => `- ${item}`).join("\n")}` : `Useful planning points:\n${bullets.map((item) => `- ${item}`).join("\n")}`)
      : "",
    input.toolHighlights.length > 0
      ? (input.language === "zh" ? `已读取/尝试的上下文：\n${input.toolHighlights.map((item) => `- ${item}`).join("\n")}` : `Context already read/tried:\n${input.toolHighlights.map((item) => `- ${item}`).join("\n")}`)
      : "",
  ].filter(Boolean).join("\n\n");

  if (input.language === "en") {
    return [
      "The previous planning output did not produce a valid reviewable plan. Regenerate the plan correctly now.",
      "",
      contextSummary,
      "",
      "Rules:",
      "- Do not copy tool logs, duplicate-call warnings, hidden thinking, raw source code, or truncation messages into plan files.",
      "- Create or update the default approval artifact `.MAIN/plans/plan.md` directly with `write_file` or `replace_in_file`; this is the only pre-approval write.",
      "- `plan.md` must use the Codex app handoff shape: title, Summary, Key Changes / Implementation Changes, Public APIs / Interfaces / Types, Test Plan, and Assumptions / Defaults.",
      "- Screenshot/attachment observations, read evidence, and confirmed facts belong in the concise Summary only when real; do not inflate them into empty audit sections.",
      "- Every implementation change must point to concrete files, interfaces, data flow, commands, validation, or an explicit default. If public APIs/interfaces/types do not change, say that explicitly.",
      "- Do not include console.log/debug-log suggestions, generalized CSS/store guesses, or probability claims as execution steps unless a cited evidence line supports them; otherwise place them under unverified hypotheses.",
      "- Non-blocking MVP tradeoffs must be written with explicit defaults as assumptions or follow-up enhancements. If a choice blocks execution, ask with `<user_options>` before approval and stop.",
      "- `requirements.md` is optional. Only create it when the user explicitly asks for a requirement ledger or when large/compliance-heavy scope needs traceability; it is never a prerequisite for approval.",
      "- If the plan direction is unclear, ask the user with `<user_options>` and stop. Do not invent a final plan.",
      "- If the direction is clear, write a concise `.MAIN/plans/plan.md` for approval. Do not generate `tasks.md` or edit source files before approval.",
    ].filter(Boolean).join("\n");
  }

  return [
    "上一轮规划没有产出有效的可审批计划。现在请重新生成真正的计划。",
    "",
    contextSummary,
    "",
    "规则：",
    "- 不要把工具日志、重复调用提示、后台思考、原始源码或截断提示写进计划文件。",
    "- 直接用 `write_file` 或 `replace_in_file` 创建/更新默认审批产物 `.MAIN/plans/plan.md`；这是批准前唯一允许的写入。",
    "- `plan.md` 必须使用 Codex app 交接计划结构：标题、摘要、关键实现改动、公共 API/接口/类型、测试方案、假设与默认值。",
    "- 截图/附件观察、已读证据和已确认事实只在确有内容时放进精简摘要，不要撑成空洞审计章节。",
    "- 每个关键实现改动必须指向具体文件、接口、数据流、命令、验证方式或明确默认假设；如果公共 API/接口/类型不变，必须显式写明。",
    "- 没有证据支撑时，不要把 console.log/调试日志建议、泛化 CSS/Store 猜测或概率判断写成执行步骤；只能放入未验证假设。",
    "- 非阻塞 MVP 取舍必须写成带默认值的默认假设或后续增强；真正阻塞执行的选择必须在批准前用 `<user_options>` 提问并停止。",
    "- `requirements.md` 是可选需求台账；只有用户明确要求、范围很大或需要合规/验收追踪时才生成，绝不是审批前置条件。",
    "- 如果设计方向不明确，使用 `<user_options>` 让用户选择并立刻停止；不要编造最终方案。",
    "- 如果方向已经明确，直接写入精简 `.MAIN/plans/plan.md` 等待审批。批准前不要生成 `tasks.md`，不要修改源码。",
  ].filter(Boolean).join("\n");
}

function formatPlanQualityReason(input: {
  reason?: string;
  missingSections?: string[];
  language: Language;
}): string {
  const missing = (input.missingSections || []).filter(Boolean).join(", ");
  const reason = input.reason || (missing ? `missing:${missing}` : "");
  if (!reason) return "";
  return input.language === "zh" ? `质量门禁：${reason}` : `quality gate: ${reason}`;
}

function summarizeRecentPlanEvidenceForPrompt(
  recentToolActivity: PlanToolActivitySummary[],
  language: Language,
): string {
  const rows = recentToolActivity
    .filter((activity) => String(activity.status || "") === "succeeded")
    .slice(-8)
    .map((activity) => {
      const target = activity.target ? ` ${activity.target}` : "";
      const detail = activity.detail ? ` -> ${activity.detail}` : "";
      return `- ${activity.name || "tool"}${target}${detail}`;
    });
  if (rows.length === 0) {
    return language === "zh" ? "- 暂无成功工具证据；只能引用截图/附件和用户原始目标。" : "- No successful tool evidence yet; cite screenshots/attachments and the user goal only.";
  }
  return rows.join("\n");
}

function normalizePlanEvidencePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim()
    .toLowerCase();
}

function isDocumentationEvidenceFile(value: string): boolean {
  return /\.(?:md|mdx|txt|rst)$/i.test(normalizePlanEvidencePath(value));
}

function isImplementationEvidenceFile(value: string): boolean {
  const normalized = normalizePlanEvidencePath(value);
  if (!normalized || isPlanArtifactPath(normalized)) return false;
  if (isDocumentationEvidenceFile(normalized)) return false;
  return /^(?:src|app|lib|components|pages|hooks|store|styles|server|client|packages|apps|tests|scripts)\//i.test(normalized) ||
    /\.(?:tsx?|jsx?|swift|py|rs|go|json|csv|tsv|xlsx|css|scss|html|toml|ya?ml|log)$/i.test(normalized);
}

function goalMentionsDocumentation(goal: string): boolean {
  return /\b(?:readme|docs?|documentation|markdown|mdx?)\b|(?:文档|说明|README|读我|说明文档)/i.test(goal);
}

function extractGoalRelevanceHints(goal: string): string[] {
  const source = String(goal || "");
  const lower = source.toLowerCase();
  const hints = new Set<string>();
  for (const match of lower.matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
    const token = match[0];
    if (!PLAN_GOAL_STOPWORDS.has(token)) hints.add(token);
  }
  for (const term of PLAN_GOAL_DOMAIN_TERMS) {
    if (lower.includes(term.toLowerCase())) hints.add(term.toLowerCase());
  }
  return [...hints].filter((item) => item.length >= 2).slice(0, 12);
}

function extractExplicitGoalPaths(goal: string): string[] {
  return Array.from(String(goal || "").matchAll(/\b[A-Za-z0-9_@./-]+\.(?:tsx?|jsx?|swift|py|rs|go|json|csv|tsv|xlsx|mdx?|css|scss|html|toml|ya?ml|log)\b/g))
    .map((match) => normalizePlanEvidencePath(match[0]))
    .filter(Boolean);
}

function stripControlPromptForPlanFallback(text: string): string {
  return String(text || "")
    .replace(/^本轮处于 PLAN 模式。[\s\S]*?\n\n/i, "")
    .replace(/^This turn is in PLAN mode\.[\s\S]*?\n\n/i, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, " ")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectFallbackPlanBullets(sourceText: string, fallbackPrompt: string, maxBullets = 8): string[] {
  const source = stripControlPromptForPlanFallback(sourceText)
    .replace(/[#>*_`~]/g, " ")
    .replace(/(?:[，,。.\-_]\s*){24,}/g, " ")
    .trim();
  const candidates = source
    .split(/\n+|(?<=[。！？.!?])\s+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
    .filter((line) =>
      line.length >= 8 &&
      line.length <= 180 &&
      !/^(?:让我|但是等等|不过等等|我认为|实际上|用户说|之前的消息|But wait|I think|Actually|The user says)/i.test(line) &&
      !/<\/?(?:user_options|option|plan)\b/i.test(line),
    );

  const bullets: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(candidate);
    if (bullets.length >= maxBullets) break;
  }

  if (bullets.length > 0) return bullets;
  const fallback = stripControlPromptForPlanFallback(fallbackPrompt);
  return fallback
    ? [fallback.length > 160 ? `${fallback.slice(0, 160).trim()}...` : fallback]
    : [];
}

function isPlanArtifactPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().includes(".main/plans/");
}

const PLAN_EXPLORATION_READ_ONLY_TOOLS = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

const PLAN_EVIDENCE_TOOLS = new Set([
  "get_project_skeleton",
  "list_directory",
  "read_file",
  "get_file_outline",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "glob_search",
  "grep_search",
]);

const PLAN_GOAL_STOPWORDS = new Set([
  "please",
  "fix",
  "repair",
  "issue",
  "problem",
  "plan",
  "approve",
  "approved",
  "execute",
  "execution",
  "verify",
  "validation",
  "true",
  "real",
  "file",
  "files",
  "change",
  "changes",
  "update",
  "修改",
  "修复",
  "问题",
  "计划",
  "批准",
  "执行",
  "验证",
  "真实",
  "文件",
]);

const PLAN_GOAL_DOMAIN_TERMS = [
  "csv",
  "tsv",
  "xlsx",
  "dashboard",
  "creator",
  "creatorname",
  "parser",
  "parse",
  "chart",
  "graph",
  "import",
  "export",
  "table",
  "dark",
  "theme",
  "log",
  "图表",
  "图形",
  "数据",
  "导入",
  "导出",
  "解析",
  "字段",
  "仪表盘",
  "面板",
  "显示",
  "表格",
  "截图",
  "日志",
  "质量门",
  "审批",
  "深色",
  "样式",
  "订单",
];

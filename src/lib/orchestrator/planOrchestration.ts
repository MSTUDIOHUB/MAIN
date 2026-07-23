import type { PlanToolActivitySummary } from "../planExecutionRecovery";
import {
  extractNumberedUserGoalFacets,
  type PlanEvidenceRecord,
} from "../planMaterialization";
import type { PlanEvidenceBundle } from "../planEvidence";
import { buildPlanSubmissionGuidance } from "../planSubmissionGuidance";
import {
  formatPlanEvidenceObligation,
  type PlanEvidenceObligation,
} from "../planEvidenceObligations";
import {
  hasTurnProvidedContext,
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "../turnIntake";
import type { PlanRuntimePhase, ReplyOption } from "../workflowModels";
import { stripControlPromptForPlanFallback } from "./prompts/planPrompts";

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
  evidenceBundle?: PlanEvidenceBundle;
}

export interface PlanClosureEvidenceRecoveryContext {
  unresolvedContractKinds?: string[];
  confirmedChangeTargets?: string[];
  avoidTargets?: string[];
  evidenceObligations?: PlanEvidenceObligation[];
}

export function buildPlanClosureEvidenceRecoveryPrompt(
  language: Language,
  reason: string,
  userGoal = "",
  context: PlanClosureEvidenceRecoveryContext = {},
): string {
  const uncoveredFacets = reason.match(/uncovered_user_goal_facets:([0-9,]+)/i)?.[1] || "";
  const uncoveredFacetIndexes = new Set(
    uncoveredFacets
      .split(",")
      .map((value) => Number(value))
      .filter(Number.isFinite),
  );
  const uncoveredFacetDetails = extractNumberedUserGoalFacets(userGoal)
    .filter((facet) => uncoveredFacetIndexes.has(facet.index))
    .map((facet) => `${facet.index}. ${facet.text}`);
  const unresolvedContractKinds = [...new Set(
    (context.unresolvedContractKinds || []).map((value) => String(value || "").trim()).filter(Boolean),
  )].slice(0, 8);
  const confirmedChangeTargets = [...new Set(
    (context.confirmedChangeTargets || []).map((value) => String(value || "").trim()).filter(Boolean),
  )].slice(0, 12);
  const avoidTargets = [...new Set(
    (context.avoidTargets || []).map((value) => String(value || "").trim()).filter(Boolean),
  )].slice(0, 8);
  const evidenceObligations = [...new Set(
    (context.evidenceObligations || []).map(formatPlanEvidenceObligation).filter(Boolean),
  )].slice(0, 8);
  const hasPermissionContractGap = unresolvedContractKinds.some((kind) =>
    kind.startsWith("permission_contract:")
  );
  const missingCommandHandlers = unresolvedContractKinds
    .filter((kind) => kind.startsWith("command_handler_contract:"))
    .map((kind) => kind.slice("command_handler_contract:".length))
    .filter(Boolean);
  if (language === "en") {
    return [
      "PLAN_CLOSURE_NEEDS_EVIDENCE: MAIN could not get a model-authored reviewable plan from the current clean evidence.",
      reason ? `Failure reason: ${reason}.` : "",
      uncoveredFacets
        ? `The uncovered numbered user-goal item(s) are ${uncoveredFacets}.`
        : "",
      uncoveredFacetDetails.length > 0
        ? `Exact uncovered facets:\n${uncoveredFacetDetails.map((facet) => `- ${facet}`).join("\n")}`
        : "",
      unresolvedContractKinds.length > 0
        ? `Unverified contract counterparts:\n${unresolvedContractKinds.map((kind) => `- ${kind}`).join("\n")}`
        : "",
      confirmedChangeTargets.length > 0
        ? `Already-covered change owners; do not reread them merely to resolve this gap:\n${confirmedChangeTargets.map((target) => `- ${target}`).join("\n")}`
        : "",
      avoidTargets.length > 0
        ? `The previous recovery read did not advance the evidence; choose a different owner than:\n${avoidTargets.map((target) => `- ${target}`).join("\n")}`
        : "",
      evidenceObligations.length > 0
        ? `Runtime-owned evidence obligations (execute exactly one next):\n${evidenceObligations.map((obligation) => `- ${obligation}`).join("\n")}`
        : "",
      hasPermissionContractGap
        ? "Inspect the runtime permission/capability/manifest/configuration owner for the named plugin contract. A package or dependency declaration does not prove that runtime permission is granted. If its path is unknown, use one narrow search to locate that owner and then read it."
        : "",
      missingCommandHandlers.length > 0
        ? `The trusted frontend source invokes ${missingCommandHandlers.map((command) => `\`${command}\``).join(", ")} through a runtime command transport, but the handler signature has not been observed. Locate and read the backend command definition; registration or call-site evidence alone does not establish its argument contract.`
        : "",
      evidenceObligations.length > 0
        ? "Execute exactly one listed runtime obligation. MAIN will reassess the ledger after the result; do not replace it with a broad scan or an inferred path."
        : "Select one unresolved facet or contract and do exactly one targeted read/search that binds it to a concrete source, configuration, permission, interface, or data contract. Do not reread evidence for covered facets.",
      "Submit the complete typed graph only after MAIN reports no remaining evidence obligation. Map every numbered user-goal facet to confirmed evidence, a concrete change/decision, and an executable validation. MAIN runtime owns `.MAIN/plans/plan.md` rendering.",
      buildPlanSubmissionGuidance("en"),
      "Do not call broad directory scans, do not edit source files, and do not create `tasks.md` before approval.",
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_CLOSURE_NEEDS_EVIDENCE: MAIN 无法基于当前干净证据拿到模型亲自生成的可审批计划。",
    reason ? `失败原因：${reason}。` : "",
    uncoveredFacets
      ? `尚未覆盖的用户编号分面是 ${uncoveredFacets}。`
      : "",
    uncoveredFacetDetails.length > 0
      ? `尚未覆盖分面的原文：\n${uncoveredFacetDetails.map((facet) => `- ${facet}`).join("\n")}`
      : "",
    unresolvedContractKinds.length > 0
      ? `尚未核实的契约对应项：\n${unresolvedContractKinds.map((kind) => `- ${kind}`).join("\n")}`
      : "",
    confirmedChangeTargets.length > 0
      ? `这些改动拥有者已经有证据，不要仅为解决当前缺口而重读：\n${confirmedChangeTargets.map((target) => `- ${target}`).join("\n")}`
      : "",
    avoidTargets.length > 0
      ? `上一次补证没有增加有效证据，请改查不同的契约拥有者，不要再读：\n${avoidTargets.map((target) => `- ${target}`).join("\n")}`
      : "",
    evidenceObligations.length > 0
      ? `runtime 生成的精确取证义务（下一步只执行一个）：\n${evidenceObligations.map((obligation) => `- ${obligation}`).join("\n")}`
      : "",
    hasPermissionContractGap
      ? "请检查对应插件的运行时权限、capability、manifest 或配置拥有者；包清单或依赖声明不能证明运行时权限已经授予。若不知道路径，先做一次窄范围搜索定位拥有者，再读取该文件。"
      : "",
    missingCommandHandlers.length > 0
      ? `已读前端源码通过运行时命令通道调用 ${missingCommandHandlers.map((command) => `\`${command}\``).join("、")}，但尚未观察到处理器签名。请定位并读取后端命令定义；仅有注册表或调用点不能证明参数契约。`
      : "",
    evidenceObligations.length > 0
      ? "严格执行其中一个 runtime 义务；结果返回后由 MAIN 重新评估 ledger，不要改成泛扫或自行猜测路径。"
      : "从尚未解决的分面或契约中选择一个，下一步只做一次能够把它绑定到具体源码、配置、权限、接口或数据契约的精确定向取证。不要重读已覆盖分面的证据。",
    "只有 MAIN 报告没有剩余取证义务后，才提交完整 typed graph；每个用户编号分面都必须映射到已确认证据、具体改动/决策和可执行验证。`.MAIN/plans/plan.md` 由 MAIN runtime 负责渲染。",
    buildPlanSubmissionGuidance("zh"),
    "不要再泛扫目录；批准前不要修改源码，也不要创建 `tasks.md`。",
  ].filter(Boolean).join("\n");
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
      "Stop broad rereading now. If targeted source/data evidence is still missing, call exactly one specific read/search tool for the missing file, symbol, or dataset, then stop. If the evidence is decision-complete, submit the complete typed graph; MAIN runtime will render the artifact.",
      buildPlanSubmissionGuidance("en"),
      "The plan must express the goal, grounded current state or constraints, an implementation/design/analysis path, relevant affected boundaries, and executable validation. Adapt headings to the task; do not force bug-root-cause or source-file sections onto feature, design, research, or verification work.",
      "Only use `<user_options>` if there is a real product/design decision the user must make before a plan can be written. Ask and stop without also submitting a typed graph; do not offer options that merely ask to continue reading, checking, analyzing, or verifying.",
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
    "下一步不要继续泛读文件。如果还缺源码/数据定向证据，只能围绕缺失的文件、符号或数据集调用一次具体读取/搜索工具，然后停止；如果证据已经足够，请提交完整 typed graph，计划文件由 MAIN runtime 渲染。",
    buildPlanSubmissionGuidance("zh"),
    "计划必须表达目标、有根据的现状或约束、实施/设计/分析路径、相关影响边界和可执行验证。章节应随任务调整，不要给新功能、设计、调研或验证任务强套 Bug 根因或源码文件章节。",
    "只有存在真实产品/设计分叉、必须由用户决定后才能写计划时，才允许使用 `<user_options>`；提问后停止，不要同时提交 typed graph，也不要给出只是继续读取、检查、分析或验证的选项。",
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
  failurePreview?: string;
}): string {
  const context = normalizeTurnInputContextSignals(input.userContext);
  const toolList = input.toolNames.slice(0, 6).join(", ");
  const missing = (input.missingSections || []).filter(Boolean).join(", ");
  const reason = input.qualityGateReason || (missing ? `missing:${missing}` : "");
  const phase = input.phase || "drafting";
  if (phase === "needs_rewrite") {
    const needsExecutableTestContract = /(?:^|:)non_executable_test_plan(?:$|:)/i.test(reason);
    const needsConcreteImplementationContract = /(?:^|:)empty_plan_implementation_detail(?:$|:)/i.test(reason);
    const needsProtocolCleanup = /(?:^|:)protocol_noise(?:$|:)/i.test(reason);
    const needsEpistemicClassification = /(?:^|:)unverified_diagnostic_claim_as_confirmed(?:$|:)/i.test(reason);
    const failurePreview = String(input.failurePreview || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (input.language === "en") {
      return [
        needsExecutableTestContract
          ? "PLAN_NEEDS_REWRITE: The Test Plan exists, but its execution contract is not concrete enough. This is not a reason to read more files."
          : needsConcreteImplementationContract
          ? "PLAN_NEEDS_REWRITE: The Key Changes section contains an empty implementation owner or a mutation without a concrete post-change behavior. This is not a reason to read more files."
          : needsProtocolCleanup
          ? "PLAN_NEEDS_REWRITE: The visible candidate contains tool/function/parameter protocol markup. The evidence and plan decisions do not need to change."
          : needsEpistemicClassification
          ? "PLAN_NEEDS_REWRITE: A probabilistic or hypothetical causal statement was placed under Confirmed Evidence/Root Cause. This is an epistemic classification defect, not a request for more reads."
          : "PLAN_NEEDS_REWRITE: The last visible plan draft was structurally incomplete, but this is not a reason to read more files.",
        toolList ? `The attempted read-only tool call(s) were suppressed before execution: ${toolList}.` : "",
        reason ? `Quality gate reason: ${reason}.` : "",
        needsEpistemicClassification && failurePreview
          ? `Offending model-authored line: ${failurePreview}`
          : "",
        needsExecutableTestContract
          ? "Rewrite only the Test Plan contract while preserving the objective, evidence, implementation scope, and target files. For each required check, provide either an exact runnable command, or one self-contained scenario with concrete input/setup or action plus a concrete observable expected result/assertion. Do not split the action and expectation across unrelated scenarios."
          : needsConcreteImplementationContract
          ? "Rewrite only Key Changes while preserving the objective, confirmed evidence, target files, interfaces, and validation. Make every change one complete item containing its file/component owner, concrete post-change behavior, and upstream/downstream relationship. Remove standalone labels such as 'Change to:', 'Implement:', or 'Modify:'; do not leave their details in a same-level sibling item."
          : needsProtocolCleanup
          ? "Re-submit the complete typed graph through the submission transport declared by the latest [PLAN AUTHORING CONTRACT]. Remove every unrelated tool call, function/parameter transcript, and legacy Markdown draft. Preserve accepted typed fields and references where possible."
          : needsEpistemicClassification
          ? "Preserve literal source observations and the implementation/validation scope. For each uncertain causal claim, either (1) replace it with only the directly observed conditional behavior and its E-reference, or (2) move the complete claim under Unverified Assumptions and name how execution will verify it. Never turn a hypothesis into a confirmed cause merely by deleting may/might/likely."
          : "Rewrite and submit the complete typed graph now through the transport declared by the latest [PLAN AUTHORING CONTRACT]. Add the missing goal/evidence/action/validation edges from the canonical request and frozen evidence bundle; MAIN runtime owns rendering.",
        needsExecutableTestContract || needsConcreteImplementationContract || needsProtocolCleanup || needsEpistemicClassification
          ? "Submit the complete revised typed graph through the currently declared ingress so MAIN can validate and render it; do not claim that a check has already passed."
          : "",
        "Do not call read-only tools in the next response unless MAIN explicitly reopens evidence recovery.",
        "Do not edit source files or `tasks.md` before approval.",
      ].filter(Boolean).join("\n");
    }
    return [
      needsExecutableTestContract
        ? "PLAN_NEEDS_REWRITE: 测试方案已经存在，但其中的执行契约还不够具体；这不是继续读文件的理由。"
        : needsConcreteImplementationContract
        ? "PLAN_NEEDS_REWRITE: 关键改动中存在没有正文的实施容器，或者改动项没有写明具体的改后行为；这不是继续读文件的理由。"
        : needsProtocolCleanup
        ? "PLAN_NEEDS_REWRITE: 可见候选中混入了工具、函数或参数的协议标记；已有证据和计划决策无需改变。"
        : needsEpistemicClassification
        ? "PLAN_NEEDS_REWRITE: 概率性或假设性的因果陈述被写进了已确认证据/根因；这是认知分类错误，不是继续读文件的理由。"
        : "PLAN_NEEDS_REWRITE: 上一个可见计划草稿只是结构不完整，这不是继续读文件的理由。",
      toolList ? `刚才的只读工具已在执行前静默拦截：${toolList}。` : "",
      reason ? `质量门禁原因：${reason}。` : "",
      needsEpistemicClassification && failurePreview
        ? `触发门禁的模型原句：${failurePreview}`
        : "",
      needsExecutableTestContract
        ? "只修正测试方案的执行契约，并保持用户目标、已有证据、实现范围和目标文件不变。每项必要验证必须提供：精确可运行命令；或者同一场景内的具体输入/准备或操作，以及可观察的具体预期结果/断言。不同场景之间不能借用操作和预期。"
        : needsConcreteImplementationContract
        ? "只修正关键改动，并保持用户目标、已确认证据、目标文件、接口和验证不变。每个改动必须是一条完整项，同时写明文件/组件所有者、具体改后行为以及上下游关系。删除单独的“修改为：/实现：/修改：”空标签，不要把它的细节写成同级列表项。"
        : needsProtocolCleanup
        ? "通过最新 [PLAN AUTHORING CONTRACT] 声明的提交传输重新提交完整 typed graph。删除无关工具调用、函数/参数转录和旧 Markdown 草稿；尽可能保留已合格的 typed 字段和引用。"
        : needsEpistemicClassification
        ? "保持源码中的直接观察、实现范围和验证范围不变。对每条不确定因果只能二选一：（1）改写为带 E 引用的、源码直接呈现的确定条件行为；（2）把完整因果移到“未验证假设”，并写明执行阶段如何验证。禁止只删除“可能/也许”后把假设伪装成已确认根因。"
        : "现在通过最新 [PLAN AUTHORING CONTRACT] 声明的传输重写并提交完整 typed graph：补齐缺失的目标/证据/动作/验证引用，证据只使用当前冻结的证据包；计划文件由 MAIN runtime 渲染。",
      needsExecutableTestContract || needsConcreteImplementationContract || needsProtocolCleanup || needsEpistemicClassification
        ? "通过当前声明的入口提交完整修订 typed graph，供 MAIN 校验并渲染；不要声称验证已经通过。"
        : "",
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
      "Then submit a complete typed graph with diagnosis, evidence refs, affected targets, changes/decisions, and validation primitives. MAIN runtime owns rendering.",
      buildPlanSubmissionGuidance("en"),
      "If one missing fact truly blocks the plan, ask exactly one concrete question with `<user_options>`; do not offer generic continue-reading options.",
      "Allowed next actions: submit the typed graph through the declared transport, or ask one blocking user choice. Do not call more discovery tools in the next response.",
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_READONLY_CONVERGENCE_ENFORCED: 停止继续调用只读发现工具。",
    toolList ? `刚才准备执行的工具已在执行前拦截：${toolList}。` : "",
    reason ? `当前计划质量门禁原因：${reason}。` : "",
    context.imageParts > 0
      ? "下一步必须先写出“截图观察到的现象”：图片中可见的 UI/文本/状态、用户真正要解决的问题，以及它指向的代码/状态链路。"
      : "下一步必须先复述用户提供的上下文和真实目标。",
    "随后提交完整 typed graph，包含结构化问题归因、证据引用、影响目标、改动/决策和验证 primitive；计划文件由 MAIN runtime 渲染。",
    buildPlanSubmissionGuidance("zh"),
    "如果确实只有一个缺失事实阻塞方案，只能提出一个具体问题并用 `<user_options>`；不要再给“继续查/继续分析”这类泛化选项。",
    "下一条只允许：通过已声明入口提交 typed graph，或询问一个真实阻塞选择。不要再次调用发现工具。",
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

/**
 * A compact, user-facing status for the live capsule. This deliberately does
 * not include phase reasons, quality-gate details, or model-authored draft
 * text: those remain runtime diagnostics rather than user work.
 */
export function buildPlanRuntimeCapsuleNarration(
  phase: PlanRuntimePhase,
  language: Language,
): string {
  if (language === "en") {
    switch (phase) {
      case "explore_structure":
      case "grounding":
        return "Gathering the key information needed to prepare the plan";
      case "synthesis":
      case "drafting":
      case "needs_rewrite":
        return "Organizing confirmed findings into a reviewable plan";
      case "needs_evidence":
        return "Collecting one key piece of evidence to complete the plan";
      default:
        return "";
    }
  }

  switch (phase) {
    case "explore_structure":
    case "grounding":
      return "正在收集生成计划所需信息";
    case "synthesis":
    case "drafting":
    case "needs_rewrite":
      return "正在整理已确认信息，生成可审批计划";
    case "needs_evidence":
      return "正在补充一项关键证据以完善计划";
    default:
      return "";
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
      "PLAN_AUTO_SCAFFOLD: Two low-quality typed drafts were rejected. Stop branching and submit one complete typed graph using this scaffold as field guidance. MAIN runtime owns artifact rendering.",
      buildPlanSubmissionGuidance("en"),
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
      "- Exact runtime-executable test/build validation that proves the fix. Put optional user/manual review in the final conclusion as non-blocking follow-up, not in acceptance.",
      "",
      "Convert this scaffold into the complete typed graph now. Do not call tools unless MAIN has explicitly reopened evidence recovery.",
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_AUTO_SCAFFOLD: 连续两个低质量 typed 草稿被拒绝。停止分叉，把下面脚手架转换成完整 typed graph；计划文件由 MAIN runtime 渲染。",
    buildPlanSubmissionGuidance("zh"),
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
    "- 能证明修复成立且 runtime 可执行的测试/构建验证；可选用户/人工复核放入最终结论作为非阻塞后续，不进入验收标准。",
    "",
    "现在把这个脚手架转换成完整 typed graph。除非 MAIN 已重新开放补证据，否则不要调用工具。",
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
      "Use the new evidence below and submit the complete typed graph now; MAIN runtime owns artifact rendering. Do not start another exploration pass.",
      buildPlanSubmissionGuidance("en"),
      evidence,
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_EVIDENCE_RECOVERY_COMPLETE: 定向补证已经完成。",
    reason,
    "现在用下面的新证据提交完整 typed graph；计划文件由 MAIN runtime 渲染，不要开启新一轮泛读。",
    buildPlanSubmissionGuidance("zh"),
    evidence,
  ].filter(Boolean).join("\n");
}

export function buildPlanEvidenceRecoveryBlockedPrompt(input: {
  language: Language;
  recentToolActivity: PlanToolActivitySummary[];
  qualityGateReason?: string;
  missingSections?: string[];
  requireResolvedEvidence?: boolean;
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
      input.requireResolvedEvidence
        ? "Do not keep calling read-only tools and do not draft a plan that assumes the unresolved evidence. State the exact unresolved evidence gap as the blocker and pause safely. Ask the user only when resolving it requires a genuine user-owned decision."
        : "Do not keep calling read-only tools. Either submit the complete typed graph using only confirmed evidence below through the latest authoring contract, or state the single real blocker as a user-visible question.",
      evidence,
    ].filter(Boolean).join("\n");
  }
  return [
    "PLAN_EVIDENCE_RECOVERY_BLOCKED: 这一次定向补证没有得到可用证据。",
    reason,
    input.requireResolvedEvidence
      ? "不要继续调用只读工具，也不要用未闭合的证据假定起草计划。请明确说明尚缺的证据并安全暂停；只有解决它确实需要用户决策时，才向用户提供选择。"
      : "不要继续调用只读工具。要么遵循最新 authoring contract、只基于下面已确认的证据提交完整 typed graph，要么把唯一真实阻塞点作为可见问题告诉用户。",
    evidence,
  ].filter(Boolean).join("\n");
}

export function buildPlanFallbackNotice(language: Language, sourceChars: number): string {
  const formatted = sourceChars.toLocaleString();
  return language === "zh"
    ? `模型刚才输出了约 ${formatted} 个字符的规划正文，但尚未形成通过校验的计划候选。MAIN 会要求模型补齐候选方案，或仅在真正阻塞时请求关键选择；工具日志和截断内容不会被强行物化为计划。`
    : `The model produced about ${formatted} characters of planning text, but no validated plan candidate yet. MAIN will request a corrected candidate, or ask for a key choice only when genuinely blocked; tool logs and truncated text will not be materialized as the plan.`;
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
  _recentActivity: PlanToolActivitySummary[] = [],
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
  // Tool choice describes how evidence was gathered, not which artifact owns
  // the workflow. Inspecting CSV/XLSX data is common in ordinary code fixes;
  // only the explicit stage or an explicit user design request may select
  // design.md.
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
      `- ${buildPlanSubmissionGuidance("en")} MAIN runtime validates the typed graph and renders \`.MAIN/plans/plan.md\` after the response.`,
      "- Keep `plan.md` decision-complete, but adapt its headings to the task. Bug fixes may use root cause, features may use architecture/components/data flow, and research or verification plans may use decisions/constraints without inventing source edits.",
      "- Screenshot/attachment observations, read evidence, and confirmed facts belong in the concise Summary only when real; do not inflate them into empty audit sections.",
      "- Every implementation or design decision must point to concrete files, interfaces, components, data flow, commands, validation, or an explicit default. Mention public API/interface/type disposition only when it affects execution.",
      "- Success acceptance must rely on runtime-executable evidence. Put optional user/manual review in the final conclusion as non-blocking follow-up, never as an unfinished success criterion.",
      "- Do not include console.log/debug-log suggestions, generalized CSS/store guesses, or probability claims as execution steps unless a cited evidence line supports them; otherwise place them under unverified hypotheses.",
      "- If the user asks for analysis, explanation, or advice without explicitly requesting a file, respond directly in the ChatArea with Markdown text. Do NOT write any files to disk to prevent workspace pollution.",
      "- If the user explicitly requests saving a document/report, write the Markdown document directly to `docs/<filename>.md` with `write_file`.",
      "- If user intent is ambiguous, answer in ChatArea and ask proactively with `<user_options>` (options: ChatArea answer only, save as docs/ file, or create code refactoring plan).",
      "- Non-blocking MVP tradeoffs must be written with explicit defaults as assumptions or follow-up enhancements. If a choice blocks execution, ask with `<user_options>` before approval and stop.",
      "- If the plan direction is unclear, ask the user with `<user_options>` and stop. Do not invent a final plan.",
      "- If the direction is clear and requires code changes, submit a concise complete typed graph through the contract-declared transport for runtime validation, rendering, and approval. Do not generate `tasks.md` or edit source files before approval.",
    ].filter(Boolean).join("\n");
  }

  return [
    "上一轮规划没有产出有效的可审批计划。现在请重新生成真正的计划。",
    "",
    contextSummary,
    "",
    "规则：",
    "- 不要把工具日志、重复调用提示、后台思考、原始源码或截断提示写进计划文件。",
    `- ${buildPlanSubmissionGuidance("zh")} MAIN runtime 会在响应后校验 typed graph 并渲染 \`.MAIN/plans/plan.md\`。`,
    "- `plan.md` 必须做到决策完整，但章节应随任务类型调整：修复类可写根因，新增功能可写架构/组件/数据流，调研或验证类可写决策/约束，不要虚构源码改动。",
    "- 截图/附件观察、已读证据和已确认事实只在确有内容时放进精简摘要，不要撑成空洞审计章节。",
    "- 每个实现或设计决策必须指向具体文件、接口、组件、数据流、命令、验证方式或明确默认值；公共 API/接口/类型只有在影响执行时才需要说明。",
    "- 成功验收必须依赖 runtime 可执行证据；可选用户/人工复核放入最终结论作为非阻塞后续，不能作为未完成的成功标准。",
    "- 没有证据支撑时，不要把 console.log/调试日志建议、泛化 CSS/Store 猜测或概率判断写成执行步骤；只能放入未验证假设。",
    "- 若用户未明确要求生成磁盘文件，默认仅在 ChatArea 中回答 Markdown 分析，切勿擅自写磁盘文件污染用户 Git 工作区。",
    "- 若用户明确要求保存报告文件，直接用 `write_file` 保存至工作区 `docs/<文件名>.md`。",
    "- 若意图模糊未明确，在 ChatArea 解答同时使用 `<user_options>` 提问（包含：仅 ChatArea 查看 / 保存为 docs 文件 / 生成代码重构计划）。",
    "- 非阻塞 MVP 取舍必须写成带默认值的默认假设或后续增强；真正阻塞执行的选择必须在批准前用 `<user_options>` 提问并停止。",
    "- 如果设计方向不明确，使用 `<user_options>` 让用户选择并立刻停止；不要编造最终方案。",
    "- 如果方向已经明确，通过 contract 声明的入口提交精简完整 typed graph，交由 runtime 校验、渲染并等待审批。批准前不要生成 `tasks.md`，不要修改源码。",
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
  "spawn_subagent",
  "wait_subagents",
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_status",
  "repo_map_search",
  "repo_map_context",
  "repo_map_files",
  "repo_map_impact",
  "code_ast_query",
  "find_symbol_references",
  "git_status",
  "git_diff",
  "read_file",
  "read_document",
  "knowledge_search",
  "knowledge_get_excerpt",
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
  "code_ast_query",
  "find_symbol_references",
  "git_diff",
  "read_document",
  "knowledge_search",
  "knowledge_get_excerpt",
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

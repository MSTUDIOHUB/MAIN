import type { TurnInputContextSignals } from "./turnIntake";
import type { PlanRuntimePhase } from "./workflowModels";
import type { PlanToolActivitySummary } from "./planExecutionRecovery";

export const PLAN_AUTHORING_CONTRACT_VERSION = 2;

export type PlanAuthoringStage =
  | "understand"
  | "gather"
  | "draft"
  | "revise"
  | "review"
  | "blocked";

export type PlanAcceptanceCriterionId =
  | "objective_coverage"
  | "grounded_evidence"
  | "decision_complete"
  | "implementation_boundary"
  | "executable_validation"
  | "internal_consistency"
  | "review_handoff";

export interface PlanAuthoringContract {
  version: typeof PLAN_AUTHORING_CONTRACT_VERSION;
  contractId: string;
  objective: string;
  contextTargets: string[];
  reusableEvidenceTargets: string[];
  imageCount: number;
  criteria: PlanAcceptanceCriterionId[];
}

export interface PlanAuthoringRuntimeSnapshot {
  phase: PlanRuntimePhase;
  qualityGateReason?: string;
  missingSections?: string[];
}

const ACCEPTANCE_CRITERIA: PlanAcceptanceCriterionId[] = [
  "objective_coverage",
  "grounded_evidence",
  "decision_complete",
  "implementation_boundary",
  "executable_validation",
  "internal_consistency",
  "review_handoff",
];

function compactObjective(value: string, maxChars = 1_600): string {
  const normalized = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[objective truncated]`;
}

function uniqueTargets(signals: TurnInputContextSignals): string[] {
  return Array.from(new Set([
    ...signals.mentionedFilePaths,
    ...signals.attachedFilePaths,
  ].map((path) => String(path || "").trim()).filter(Boolean))).slice(0, 12);
}

function uniqueReusableEvidenceTargets(
  activity: PlanToolActivitySummary[] | undefined,
): string[] {
  return Array.from(new Set((activity || []).flatMap((item) => {
    if (
      item.status !== "succeeded" ||
      item.delegatedObservation?.planningEvidenceState !== "reusable"
    ) return [];
    const target = String(item.target || "").trim();
    return target ? [target] : [];
  }))).slice(0, 12);
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createPlanAuthoringContract(input: {
  objective: string;
  contextSignals: TurnInputContextSignals;
  recentPlanToolActivity?: PlanToolActivitySummary[];
}): PlanAuthoringContract {
  const objective = compactObjective(input.objective) || "(objective unavailable)";
  const contextTargets = uniqueTargets(input.contextSignals);
  const reusableEvidenceTargets = uniqueReusableEvidenceTargets(input.recentPlanToolActivity);
  const imageCount = Math.max(0, Math.floor(Number(input.contextSignals.imageParts || 0)));
  const identity = JSON.stringify({
    version: PLAN_AUTHORING_CONTRACT_VERSION,
    objective,
    contextTargets,
    reusableEvidenceTargets,
    imageCount,
    criteria: ACCEPTANCE_CRITERIA,
  });
  return {
    version: PLAN_AUTHORING_CONTRACT_VERSION,
    contractId: `plan-${stableHash(identity)}`,
    objective,
    contextTargets,
    reusableEvidenceTargets,
    imageCount,
    criteria: [...ACCEPTANCE_CRITERIA],
  };
}

export function resolvePlanAuthoringStage(phase: PlanRuntimePhase): PlanAuthoringStage {
  switch (phase) {
    case "explore_structure":
      return "understand";
    case "grounding":
    case "needs_evidence":
      return "gather";
    case "synthesis":
    case "drafting":
      return "draft";
    case "needs_rewrite":
      return "revise";
    case "review_ready":
      return "review";
    case "blocked":
      return "blocked";
  }
}

export function classifyPlanGateViolation(
  reason: string,
): PlanAcceptanceCriterionId {
  const normalized = String(reason || "").toLowerCase();
  if (/conflict|contradict|inconsistent|矛盾|冲突/.test(normalized)) {
    return "internal_consistency";
  }
  if (/executable|validation|test|acceptance|验收|验证|测试/.test(normalized)) {
    return "executable_validation";
  }
  if (/evidence|unverified|unsupported|ground|source|证据|未验证/.test(normalized)) {
    return "grounded_evidence";
  }
  if (/scope|objective|facet|goal|coverage|目标|范围|分面/.test(normalized)) {
    return "objective_coverage";
  }
  if (/file|interface|component|boundary|implementation|affected|文件|接口|组件|边界|实施/.test(normalized)) {
    return "implementation_boundary";
  }
  if (/review|artifact|materiali|handoff|审批|产物|物化/.test(normalized)) {
    return "review_handoff";
  }
  return "decision_complete";
}

function formatCriteria(language: "zh" | "en"): string[] {
  if (language === "zh") {
    return [
      "- objective_coverage：覆盖用户的每个结果要求，不以邻近问题替代原目标。",
      "- grounded_evidence：当前状态、根因和目标边界必须来自已提供或只读取得的证据；假设必须明确标记。",
      "- decision_complete：执行所需决策已有明确默认值；只有真正由用户拥有的阻塞选择才可提问。",
      "- implementation_boundary：明确受影响文件/接口/组件/数据流及其改动关系，不堆砌源码。",
      "- executable_validation：每个结果都有 runtime 可执行的验证；人工复核只能是非阻塞建议。",
      "- internal_consistency：类型、命名、状态和验收陈述彼此不矛盾。默认保留已建立的下游必需字段与公共契约，在最早归一化/适配边界补齐数据；只有用户明确要求，或完整引用证据证明契约已废弃并给出迁移验收时，才能删除或重命名它。",
      "- review_handoff：输出一个完整可见的 `<proposed_plan>`，由 runtime 物化后进入审核，不在批准前修改源码。",
    ];
  }
  return [
    "- objective_coverage: cover every requested outcome; do not replace the objective with a nearby problem.",
    "- grounded_evidence: current state, diagnosis, and target boundaries come from supplied or read-only evidence; label hypotheses.",
    "- decision_complete: give execution-ready defaults; ask only for a genuinely user-owned blocking choice.",
    "- implementation_boundary: name affected files/interfaces/components/data flow and their relationships without dumping source.",
    "- executable_validation: give runtime-executable validation for every outcome; manual review is advisory only.",
    "- internal_consistency: types, names, states, and acceptance claims do not contradict each other. Preserve established downstream required fields and public contracts by default, repairing the earliest normalization/adapter boundary; remove or rename them only when the user explicitly asks or complete reference evidence proves obsolescence and the plan includes migration acceptance.",
    "- review_handoff: emit one complete visible `<proposed_plan>` for runtime materialization and review; do not edit source before approval.",
  ];
}

function formatArtifactShape(language: "zh" | "en"): string[] {
  if (language === "zh") {
    return [
      "产物角色（标题可按语言等价表达，但角色不能缺失）：摘要、已确认证据、关键改动、公共 API/接口/类型、测试方案、假设与默认值。",
      "- 已确认证据：每条写明精确路径/数据源和实际观察到的事实；不要粘贴工具日志。",
      "- 关键改动：每条同时写明文件或组件所有者、具体变更后的行为、与上下游的关系；禁止只写以冒号结尾的“修改/实现/变更：”空标签。",
      "- 测试方案：写 runtime 可执行的命令或可自动断言的行为与预期结果。",
      "- 不要输出围栏代码块或源码实现；计划描述行为、边界和验收，不转储代码。",
    ];
  }
  return [
    "Artifact roles (headings may use language-equivalent names, but no role may be omitted): Summary, Confirmed Evidence, Key Changes, Public APIs/Interfaces/Types, Test Plan, Assumptions/Defaults.",
    "- Confirmed Evidence: pair every item with an exact path/data source and an observed fact; do not paste tool logs.",
    "- Key Changes: each item names the file/component owner, concrete post-change behavior, and upstream/downstream relationship; never emit an empty 'Change/Implement/Modify:' label ending at a colon.",
    "- Test Plan: give runtime-executable commands or automatically assertable behavior and expected outcomes.",
    "- Do not emit fenced code blocks or source implementations; specify behavior, boundaries, and acceptance without code dumps.",
  ];
}

function formatStageInstruction(stage: PlanAuthoringStage, language: "zh" | "en"): string[] {
  if (language === "zh") {
    switch (stage) {
      case "understand":
        return [
          "当前动作：先对齐目标、已知输入和最小未知项。若已有精确路径/截图/附件，优先使用；不要先做宽泛扫描。",
          "允许的下一步：一次有界只读取证，或在证据已足够时直接起草。",
        ];
      case "gather":
        return [
          "当前动作：只补足会改变方案决策的最小证据。复用已有结果，禁止重复读取未变化上下文。",
          "允许的下一步：有界只读工具，或证据决策完整后输出计划。",
        ];
      case "draft":
        return [
          "当前动作：冻结证据，按下方全部验收条款一次性生成完整计划。",
          "允许的下一步：一个完整可见 `<proposed_plan>`，或一个真正阻塞的 `<user_options>`；不要再泛读。",
        ];
      case "revise":
        return [
          "当前动作：保留上一候选中已合格内容，只修复下方明确列出的违约项。",
          "必须重新输出完整 `<proposed_plan>`，不能只给差量说明，也不能把修订稿仅放在隐藏 reasoning 中。除非 grounded_evidence 被明确列为违约项，否则不得重开探索。",
        ];
      case "review":
        return ["当前动作：计划已通过契约校验。停止生成或探索，等待用户审核。"];
      case "blocked":
        return ["当前动作：只说明一个真实阻塞条件或用户拥有的选择；不得把内部继续分析伪装成用户决策。"];
    }
  }
  switch (stage) {
    case "understand":
      return [
        "Current action: align the objective, known inputs, and the smallest material unknown. Prefer exact paths, screenshots, and attachments over broad discovery.",
        "Allowed next step: one bounded read-only evidence action, or draft immediately when evidence is already sufficient.",
      ];
    case "gather":
      return [
        "Current action: gather only the smallest evidence that can change a planning decision. Reuse prior results and do not reread unchanged context.",
        "Allowed next step: a bounded read-only action, or the plan once evidence is decision-complete.",
      ];
    case "draft":
      return [
        "Current action: freeze the evidence and produce the complete plan against every acceptance criterion below.",
        "Allowed next step: one complete visible `<proposed_plan>`, or one genuinely blocking `<user_options>` choice; do not resume broad discovery.",
      ];
    case "revise":
      return [
        "Current action: preserve accepted content from the prior candidate and repair only the explicit violations below.",
        "Re-emit the complete `<proposed_plan>`, not a delta, and never place the revision only in hidden reasoning. Do not reopen exploration unless grounded_evidence is an explicit violation.",
      ];
    case "review":
      return ["Current action: the Plan passed contract validation. Stop generation and exploration; wait for user review."];
    case "blocked":
      return ["Current action: state one real blocker or user-owned decision; do not turn internal analysis into a user choice."];
  }
}

export function formatPlanAuthoringContractForModel(input: {
  contract: PlanAuthoringContract;
  runtime: PlanAuthoringRuntimeSnapshot;
  language: "zh" | "en";
}): string {
  const { contract, runtime, language } = input;
  const stage = resolvePlanAuthoringStage(runtime.phase);
  const reason = String(runtime.qualityGateReason || "").trim();
  const violation = reason ? classifyPlanGateViolation(reason) : null;
  const missingSections = (runtime.missingSections || []).filter(Boolean).slice(0, 12);
  const targetText = contract.contextTargets.length > 0
    ? contract.contextTargets.join(", ")
    : language === "zh" ? "未提供精确文件目标" : "no exact file target supplied";
  const reusableEvidenceText = contract.reusableEvidenceTargets.length > 0
    ? contract.reusableEvidenceTargets.join(", ")
    : language === "zh" ? "暂无" : "none";

  return [
    "[PLAN AUTHORING CONTRACT]",
    `version=${contract.version}; id=${contract.contractId}; stage=${stage}; runtimePhase=${runtime.phase}.`,
    language === "zh" ? `规范目标：${contract.objective}` : `Canonical objective: ${contract.objective}`,
    language === "zh"
      ? `输入锚点：${targetText}；图片=${contract.imageCount}。`
      : `Input anchors: ${targetText}; images=${contract.imageCount}.`,
    language === "zh"
      ? `已验收的委派取证：${reusableEvidenceText}。这些证据可直接用于制定计划；除非同一路径另有 unresolved 标记，否则不要让父智能体重读。`
      : `Accepted delegated evidence: ${reusableEvidenceText}. Reuse it for planning; do not make the parent reread the same path unless it also has an unresolved marker.`,
    language === "zh"
      ? "流程：理解目标 → 定向取证 → 起草 → 按同一契约修订 → runtime 物化 → pending_review。质量门只能检查下面预先声明的条款，不能在候选生成后改变任务。"
      : "Flow: understand objective -> targeted evidence -> draft -> revise against this same contract -> runtime materialization -> pending_review. The quality gate may check only the predeclared criteria below; it must not redefine the task after drafting.",
    ...formatStageInstruction(stage, language),
    language === "zh" ? "验收条款：" : "Acceptance criteria:",
    ...formatCriteria(language),
    language === "zh" ? "产物结构契约：" : "Artifact shape contract:",
    ...formatArtifactShape(language),
    ...(violation
      ? [
          language === "zh"
            ? `当前违约：${violation}（${reason}）`
            : `Current violation: ${violation} (${reason})`,
        ]
      : []),
    ...(missingSections.length > 0
      ? [
          language === "zh"
            ? `缺失项：${missingSections.join(", ")}`
            : `Missing items: ${missingSections.join(", ")}`,
        ]
      : []),
    "[/PLAN AUTHORING CONTRACT]",
  ].join("\n");
}

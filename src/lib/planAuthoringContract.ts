import type {
  DiagnosisOutcomeRequirement,
  TurnInputContextSignals,
} from "./turnIntake";
import type { PlanRuntimePhase } from "./workflowModels";
import type { PlanToolActivitySummary } from "./planExecutionRecovery";
import { extractNumberedUserGoalFacets } from "./numberedGoalFacets";
import { SUBMIT_PLAN_CANDIDATE_TOOL_NAME } from "./toolSchemas";
import {
  SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS,
  SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS,
  SUPPORTED_INTERACTION_ASSERTION_KINDS,
  type AssertionMatcher,
  type AssertionResultProducer,
  type ServiceReadinessSpec,
} from "./validationContract";

export const PLAN_AUTHORING_CONTRACT_VERSION = 11;

export type PlanSubmissionTransport = "native_tool" | "text_envelope";

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
  | "epistemic_classification"
  | "decision_complete"
  | "implementation_boundary"
  | "executable_validation"
  | "internal_consistency"
  | "review_handoff";

export interface PlanGoalFacetContract {
  id: string;
  index: number;
  text: string;
}

export interface PlanAuthoringContract {
  version: typeof PLAN_AUTHORING_CONTRACT_VERSION;
  contractId: string;
  objective: string;
  /** Frozen, independently reviewable outcomes derived before drafting. */
  facets: PlanGoalFacetContract[];
  contextTargets: string[];
  reusableEvidenceTargets: string[];
  imageCount: number;
  /** Frozen before drafting; quality gates may enforce R links only when true. */
  diagnosisRequired: boolean;
  /** Lexical compatibility hint only; never authorizes a hard quality gate. */
  diagnosisSuggested: boolean;
  diagnosisRequirementSource: "explicit_runtime_intent" | "unspecified_default";
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
  "epistemic_classification",
  "decision_complete",
  "implementation_boundary",
  "executable_validation",
  "internal_consistency",
  "review_handoff",
];

const ASSERTION_MATCHERS = Object.keys({
  equals: true,
  not_equals: true,
  contains: true,
  matches: true,
  exists: true,
  not_exists: true,
  runtime_result: true,
} satisfies Record<AssertionMatcher, true>) as AssertionMatcher[];
const ASSERTION_PRODUCERS = Object.keys({
  runtime_evidence_ledger: true,
  workspace_file_state: true,
  artifact_store: true,
} satisfies Record<AssertionResultProducer, true>) as AssertionResultProducer[];
const SERVICE_READINESS_KINDS = Object.keys({
  process_status: true,
  output_pattern: true,
  port: true,
  custom: true,
} satisfies Record<ServiceReadinessSpec["kind"], true>) as ServiceReadinessSpec["kind"][];

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
      item.delegatedObservation?.planningEvidenceState !== "reusable" ||
      item.delegatedObservation.requiresParentReread === true ||
      item.delegatedObservation.joinState !== "consumed" ||
      item.delegatedObservation.closureState !== "satisfied"
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

/**
 * Compatibility-only lexical hint. This may help an adapter ask for a typed
 * outcome decision, but it must never become Plan-state or quality authority.
 */
export function planObjectiveSuggestsDiagnosis(objective: string): boolean {
  const normalized = compactObjective(objective, 2_000);
  return /(?:根本原因|根因|查明.{0,24}原因|找(?:到|出).{0,24}原因|定位.{0,24}原因|诊断.{0,24}(?:问题|故障|异常)|(?:原因|成因).{0,16}(?:并|和|后).{0,16}(?:修复|解决)|root\s+causes?|diagnos(?:e|is|tic)|(?:find|identify|determine|trace).{0,40}(?:cause|why)|(?:cause|why).{0,40}(?:fix|repair|resolve))/i.test(normalized);
}

/** @deprecated Use only as an advisory lexical suggestion. */
export function planObjectiveRequiresDiagnosis(objective: string): boolean {
  return planObjectiveSuggestsDiagnosis(objective);
}

/** Freeze goal identities once so authoring, evidence, and ingress agree. */
export function derivePlanGoalFacets(objectiveInput: string): PlanGoalFacetContract[] {
  const objective = compactObjective(objectiveInput) || "(objective unavailable)";
  const numberedFacets = extractNumberedUserGoalFacets(objective).map((facet) => ({
    id: `G${facet.index}`,
    index: facet.index,
    text: facet.text,
  }));
  return numberedFacets.length > 0
    ? numberedFacets
    : [{ id: "G1", index: 1, text: objective }];
}

export function createPlanAuthoringContract(input: {
  objective: string;
  contextSignals: TurnInputContextSignals;
  recentPlanToolActivity?: PlanToolActivitySummary[];
  diagnosisRequirement?: DiagnosisOutcomeRequirement;
}): PlanAuthoringContract {
  const objective = compactObjective(input.objective) || "(objective unavailable)";
  // Every Plan has at least one immutable goal identity. Numbering is an input
  // convenience, not a precondition for the typed contract used after model
  // output has been adapted at the materialization boundary.
  const facets = derivePlanGoalFacets(objective);
  const contextTargets = uniqueTargets(input.contextSignals);
  const reusableEvidenceTargets = uniqueReusableEvidenceTargets(input.recentPlanToolActivity);
  const imageCount = Math.max(0, Math.floor(Number(input.contextSignals.imageParts || 0)));
  const diagnosisRequirement = input.diagnosisRequirement || input.contextSignals.diagnosisRequirement;
  const diagnosisRequired = diagnosisRequirement === "required";
  const diagnosisSuggested = planObjectiveSuggestsDiagnosis(objective);
  const diagnosisRequirementSource = diagnosisRequirement
    ? "explicit_runtime_intent" as const
    : "unspecified_default" as const;
  const identity = JSON.stringify({
    version: PLAN_AUTHORING_CONTRACT_VERSION,
    objective,
    facets,
    contextTargets,
    imageCount,
    diagnosisRequired,
    diagnosisSuggested,
    diagnosisRequirementSource,
    criteria: ACCEPTANCE_CRITERIA,
  });
  return {
    version: PLAN_AUTHORING_CONTRACT_VERSION,
    contractId: `plan-${stableHash(identity)}`,
    objective,
    facets,
    contextTargets,
    reusableEvidenceTargets,
    imageCount,
    diagnosisRequired,
    diagnosisSuggested,
    diagnosisRequirementSource,
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
  if (/unverified_diagnostic|unsupported_hypothesis|epistemic|未验证.*(?:诊断|根因|假设)/.test(normalized)) {
    return "epistemic_classification";
  }
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

function formatCriteria(
  language: "zh" | "en",
  submissionTransport: PlanSubmissionTransport,
): string[] {
  const reviewHandoff = submissionTransport === "native_tool"
    ? language === "zh"
      ? `- review_handoff：只调用一次 \`${SUBMIT_PLAN_CANDIDATE_TOOL_NAME}\` 提交完整 typed graph；runtime 从对象单向渲染 Markdown 并进入审核，不在批准前修改源码。`
      : `- review_handoff: call \`${SUBMIT_PLAN_CANDIDATE_TOOL_NAME}\` exactly once with the complete typed graph; runtime renders Markdown from the object and enters review; do not edit source before approval.`
    : language === "zh"
      ? "- review_handoff：提交一个完整 `<plan_candidate>` typed envelope；runtime 从对象单向渲染 Markdown 并进入审核，不在批准前修改源码。"
      : "- review_handoff: submit one complete `<plan_candidate>` typed envelope; runtime renders Markdown from the object and enters review; do not edit source before approval.";
  if (language === "zh") {
    return [
      "- objective_coverage：覆盖用户的每个结果要求，不以邻近问题替代原目标。",
      "- grounded_evidence：当前状态、根因和目标边界必须来自已提供或只读取得的证据；根因必须证明实际执行可达性。若问题跨越接口、参数、事件、状态或字段边界，还必须对比契约两端。仅看到定义、未证实被调用的备用路径不得当作主因；假设必须明确标记。",
      "- evidence_closure：证据包中的每个 runtime-owned Q 关系必须由一条 observed/inferred R 覆盖全部 E；每个关系 owner 必须有证据绑定的 C 或明确 preserve D；每个真实改动 C 必须连接 required V。不得只处置关系的一端。",
      "- epistemic_classification：把直接观察、由证据支持的推断和未验证假设分开。源码中的确定条件分支可以作为观察；概率词或猜测性因果不得放在已确认事实/根因中，也不得仅删除“可能”来伪装成确定结论。",
      "- decision_complete：执行所需决策已有明确默认值；只有真正由用户拥有的阻塞选择才可提问。",
      "- implementation_boundary：明确受影响文件/接口/组件/数据流及其改动关系，不堆砌源码。",
      "- executable_validation：每个结果至少有一个会有限结束并产生可判定退出码的命令（可包含 inline assertion），或一个带结构化断言的 browser/desktop interaction；独立 assertion、dev/serve/watch 长驻命令和人工复核都不能完成验收。",
      "- validation_surface：browser/desktop interaction 的目标必须来自 runtime-owned interaction evidence；不得猜测 DOM/控件选择器。desktop-only 边界不能只用 browser primitive 代替验收。",
      "- internal_consistency：类型、命名、状态和验收陈述彼此不矛盾。默认保留已建立的下游必需字段与公共契约，在最早归一化/适配边界补齐数据；只有用户明确要求，或完整引用证据证明契约已废弃并给出迁移验收时，才能删除或重命名它。",
      reviewHandoff,
    ];
  }
  return [
    "- objective_coverage: cover every requested outcome; do not replace the objective with a nearby problem.",
    "- grounded_evidence: current state, diagnosis, and target boundaries come from supplied or read-only evidence; a root cause must prove runtime reachability. When the issue crosses an interface, argument, event, state, or field boundary, compare both sides of that contract. A definition-only or unreferenced alternate path is not a confirmed cause; label hypotheses.",
    "- evidence_closure: every runtime-owned Q relationship in the evidence bundle needs one observed/inferred R covering all of its E nodes; every relationship owner needs an evidence-bound C or an explicit preserve D; every changing C needs a required V. Never dispose only one side of a relationship.",
    "- epistemic_classification: keep direct observations, evidence-supported inferences, and unverified hypotheses distinct. A deterministic source condition may be an observation; probabilistic or guessed causality cannot appear as a confirmed fact/root cause, and deleting a modal word does not turn it into evidence.",
    "- decision_complete: give execution-ready defaults; ask only for a genuinely user-owned blocking choice.",
    "- implementation_boundary: name affected files/interfaces/components/data flow and their relationships without dumping source.",
    "- executable_validation: every outcome has at least one finite command with a decidable exit status (including a finite inline assertion) or a browser/desktop interaction with structured assertions; standalone assertions, long-lived dev/serve/watch commands, and manual review cannot close acceptance.",
    "- validation_surface: browser/desktop interaction targets must come from runtime-owned interaction evidence; do not guess DOM/control selectors. A desktop-only boundary cannot be accepted through a browser primitive alone.",
    "- internal_consistency: types, names, states, and acceptance claims do not contradict each other. Preserve established downstream required fields and public contracts by default, repairing the earliest normalization/adapter boundary; remove or rename them only when the user explicitly asks or complete reference evidence proves obsolescence and the plan includes migration acceptance.",
    reviewHandoff,
  ];
}

function formatArtifactShape(language: "zh" | "en"): string[] {
  if (language === "zh") {
    return [
      "产物角色（标题可按语言等价表达，但角色不能缺失）：摘要、已确认证据、关键改动、公共 API/接口/类型、测试方案、假设与默认值；诊断/修复任务还必须包含诊断/推断。",
      "- 已确认证据：每条使用 E1/E2/...，写明精确路径/数据源和实际观察到的事实；“存在一个定义”不等于“该定义被执行”；不要粘贴工具日志。",
      "- 诊断/推断：诊断任务使用 R1/R2/...，每条标明 observed、inferred 或 hypothesis，并引用支撑它的 E；inferred 根因列出有序的 E 调用/事件链，跨边界时覆盖契约两端。概率性诊断只能放入未验证假设，禁止仅删除概率词来伪造确定性。",
      "- 关键改动：每条同时写明文件或组件所有者、具体变更后的行为、与上下游的关系；不修改的文件只能作为保留契约或验收依据，不得伪装成变更项；禁止只写以冒号结尾的“修改/实现/变更：”空标签。",
      "- 测试方案：写会有限结束且以退出码判定的命令（可包含 inline assertion），或写明 browser/desktop 自动化工具、动作和结构化断言结果；独立 assertion、dev/serve/watch 长驻命令和纯手工步骤不能作为阻塞验收。",
      "- 多分面目标：先冻结 G1/G2/...；诊断/修复任务的每个分面必须用可解析引用形成 G -> E -> R -> C（或保持不变决策 D）-> V 的完整链；不需要诊断的任务可省略 R。分面追踪行本身的目标复述不算证据；E、R、C/D、V 的被引用正文必须分别支持该分面。",
      "- 不要输出围栏代码块或源码实现；计划描述行为、边界和验收，不转储代码。",
    ];
  }
  return [
    "Artifact roles (headings may use language-equivalent names, but no role may be omitted): Summary, Confirmed Evidence, Key Changes, Public APIs/Interfaces/Types, Test Plan, Assumptions/Defaults; diagnosis/repair work also requires Diagnosis/Inference.",
    "- Confirmed Evidence: label every item E1/E2/... and pair it with an exact path/data source plus the directly observed fact; a definition is not proof that it executes; do not paste tool logs.",
    "- Diagnosis/Inference: for diagnostic work label each item R1/R2/..., classify it as observed, inferred, or hypothesis, and cite its supporting E items. An inferred root cause gives an ordered E call/event chain and both boundary owners when applicable. Probabilistic diagnoses belong under Unverified Assumptions; never manufacture certainty by deleting modal words.",
    "- Key Changes: each item names the file/component owner, concrete post-change behavior, and upstream/downstream relationship. Files that remain unchanged belong only in preserved-contract or validation evidence, never as fake change items; never emit an empty 'Change/Implement/Modify:' label ending at a colon.",
    "- Test Plan: give a finite command with a decidable exit status (including a finite inline assertion), or name the browser/desktop automation tool, action, and structured asserted outcome. Standalone assertions, long-lived dev/serve/watch commands, and manual-only steps cannot be blocking acceptance.",
    "- Multi-facet objectives: freeze G1/G2/... first. For diagnosis/repair work, give every facet a parseable G -> E -> R -> C (or no-change decision D) -> V chain; omit R only when no diagnosis is needed. Repeating the goal in a traceability row is not evidence; the referenced E, R, C/D, and V bodies must each support that facet.",
    "- Do not emit fenced code blocks or source implementations; specify behavior, boundaries, and acceptance without code dumps.",
  ];
}

function formatTypedDraftIngress(
  language: "zh" | "en",
  submissionTransport: PlanSubmissionTransport,
): string[] {
  const objectSchema = '{"schemaVersion":2,"evidenceRefs":["E1"],"goalEvidenceBases":[{"goalRef":"G1","componentRef":"B1","evidenceRefs":["E1"],"ownerRefs":["<EXACT_OWNER_REF_FROM_B1>"],"relationRefs":["Q1"],"diagnosisRefs":["R1"]}],"summary":["..."],"diagnoses":[{"id":"R1","text":"...","certainty":"observed|inferred|hypothesis","evidenceRefs":["E1"],"goalRefs":["G1"],"chainRefs":["E1"]}],"changes":[{"id":"C1","text":"...","targetRef":"<EVIDENCE_BACKED_CHANGE_TARGET>","operation":"modify","evidenceRefs":["E1"],"diagnosisRefs":["R1"],"goalRefs":["G1"],"expectedOutcome":"...","relationships":[]}],"decisions":[{"id":"D1","text":"...","disposition":"change|preserve","evidenceRefs":[],"diagnosisRefs":["R1"],"goalRefs":["G1"]}],"interfaces":[],"validations":[{"id":"V1","goalRefs":["G1"],"changeRefs":["C1"],"primitive":{"kind":"finite_command","command":"<FINITE_DECIDABLE_COMMAND>"},"expectedOutcome":"..."}],"assumptions":[],"blockingChoices":[]}';
  const plannedHarnessShape = '{"id":"C_HARNESS","text":"...","targetRef":"<NEW_HARNESS_TARGET_IN_EVIDENCE_OWNER_MODULE>","targetOwnerRef":"<EXACT_EVIDENCE_OWNER_REF>","operation":"create","evidenceRefs":["E1"],"diagnosisRefs":["R1"],"goalRefs":["G1"],"expectedOutcome":"...","relationships":[],"plannedValidationHarness":{"surface":"<browser-or-desktop>","ownerRef":"<EXACT_EVIDENCE_OWNER_REF>","binding":{"kind":"direct_target","targetRef":"<NEW_HARNESS_TARGET_IN_EVIDENCE_OWNER_MODULE>"}}}';
  const schema = submissionTransport === "native_tool"
    ? objectSchema
    : `<plan_candidate>${objectSchema}</plan_candidate>`;
  const browserActions = SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS.join("|");
  const desktopActions = SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS.join("|");
  const assertions = SUPPORTED_INTERACTION_ASSERTION_KINDS.join("|");
  const assertionMatchers = ASSERTION_MATCHERS.join("|");
  const assertionProducers = ASSERTION_PRODUCERS.join("|");
  const readinessKinds = SERVICE_READINESS_KINDS.join("|");
  const transportInstruction = submissionTransport === "native_tool"
    ? language === "zh"
      ? `当前提交入口是 native tool：必须只调用一次 \`${SUBMIT_PLAN_CANDIDATE_TOOL_NAME}\`，把下面对象作为完整参数；不要在正文或 reasoning 中输出 \`<plan_candidate>\`。`
      : `The active submission ingress is a native tool: call \`${SUBMIT_PLAN_CANDIDATE_TOOL_NAME}\` exactly once with the complete object below; do not emit \`<plan_candidate>\` in prose or reasoning.`
    : language === "zh"
      ? "当前提交入口是文本 envelope：只输出唯一一个完整 `<plan_candidate>`；不要附加正文。"
      : "The active submission ingress is a text envelope: emit exactly one complete `<plan_candidate>` and no surrounding prose.";
  if (language === "zh") {
    return [
      "结构化提交协议（新运行时唯一权威；字段文本可使用任何自然语言）：",
      transportInstruction,
      schema,
      `可选 planned harness 的不可照抄结构（尖括号值必须替换为当前冻结证据中的真实 owner/目标；若没有新建 harness，不要添加这些字段）：${plannedHarnessShape}`,
      "validation primitive 最小合法结构（字段名和枚举是固定协议，不能用自然语言近义词替代）：",
      '- finite_command（required）：{"kind":"finite_command","command":"会有限结束且退出码可判定的测试/构建/检查命令"}；可选 cwd。',
      `- service_observation（advisory，不能单独完成验收）：{"kind":"service_observation","launchCommand":"长驻服务命令"}；可选 cwd、ownerKey、readiness={"kind":"${readinessKinds}","expected":"string|number|boolean","target":"optional string"}。`,
      `- browser_interaction（required）：{"kind":"browser_interaction","actions":[{"id":"A1","kind":"${browserActions}","target":"具体目标"}],"assertions":[{"kind":"${assertions}","target":"可观察目标","afterActionId":"A1","expected":"optional scalar|null"}]}。actions 可为空；一旦有 action，每个 action 都必须有唯一 id，且每个 assertion 都必须引用真实 afterActionId。`,
      `- desktop_interaction（required）：与 browser_interaction 同形，但 action kind=${desktopActions}。`,
      `- assertion（仅 advisory，不能单独完成验收）：{"kind":"assertion","acceptance":"advisory","target":"runtime:...|workspace:...|artifact:...","matcher":"${assertionMatchers}","producer":"${assertionProducers}","expected":"string|number|boolean|null when matcher needs it"}。equals/not_equals/contains/matches 必须有 expected；每个目标还必须有 finite_command 或 browser/desktop interaction 作为 required primitive。`,
      '- advisory（advisory，不能单独完成验收）：{"kind":"advisory","note":"非阻塞建议"}；可选 owner="user|external|runtime"。',
      `只使用冻结证据包中真实存在的 E 与目标路径；create 新路径必须用 targetOwnerRef 指向同目录/模块内已有的证据 owner。goalEvidenceBases 必须映射全部 required B，并让每个 G 至少选择一个 B；optional B 可省略。一个 G 可使用多个 B，但一个 B 不能分配给不同 G；所选 B 必须原样引用其全部 E/owner/Q。G/R/C/D/V 的关系必须写入对应引用数组，operation 和 primitive.kind 必须使用列出的枚举。非改动计划可以使用 decisions+validations 而让 changes 为空；summary/interfaces/assumptions 可为空数组。不要另写旧版 Markdown 草稿协议，runtime 会从对象渲染 plan.md。修订时重新提交完整对象；对象外说明、隐藏 reasoning 和旧 Markdown 都不会成为计划状态。`,
      "若证据包列出 Q，必须按 Q 的全部 evidence/owners 建立闭环：需要诊断时 R 覆盖全部 E，每个 owner 用 C 或引用该 R 的 preserve D 明确处置，每个改动 C 进入 required V，且每个 Q 至少有一个非 preserve C（runtime 尚未提供 resolved/no-change proof 时不能全 preserve）。browser/desktop 的 direct_action、普通 action 和全部 assertion target 都只能复用同一改动证据中已观察到的对应 surface target。desktop-only 行为不能用普通 finite_command 或 browser interaction 代替。未来 harness 只能由 create/modify C 的 plannedValidationHarness 声明，并由 V.harnessChangeRef 精确引用；finite command 必须结构性引用该 C 的 direct target，或调用该 C 所修改 manifest 中声明的 script。否则只能使用 runtime 已观察到的 exact native harness command 或 desktop_interaction。",
    ];
  }
  return [
    "Structured submission protocol (the sole authority for a new runtime proposal; field text may use any natural language):",
    transportInstruction,
    schema,
    `Optional planned-harness non-copyable shape (replace every angle-bracket value with a real owner/target from the frozen evidence; omit these fields when no harness is created): ${plannedHarnessShape}`,
    "Minimum valid validation primitive shapes (field names and enum tokens are fixed protocol, not natural-language synonyms):",
    '- finite_command (required): {"kind":"finite_command","command":"finite test/build/check command with decidable exit status"}; optional cwd.',
    `- service_observation (advisory; never closes acceptance alone): {"kind":"service_observation","launchCommand":"long-lived service command"}; optional cwd, ownerKey, readiness={"kind":"${readinessKinds}","expected":"string|number|boolean","target":"optional string"}.`,
    `- browser_interaction (required): {"kind":"browser_interaction","actions":[{"id":"A1","kind":"${browserActions}","target":"concrete target"}],"assertions":[{"kind":"${assertions}","target":"observable target","afterActionId":"A1","expected":"optional scalar|null"}]}. actions may be empty; when any action exists, every action needs a unique id and every assertion must cite a real afterActionId.`,
    `- desktop_interaction (required): same shape as browser_interaction, with action kind=${desktopActions}.`,
    `- assertion (advisory only; never closes acceptance alone): {"kind":"assertion","acceptance":"advisory","target":"runtime:...|workspace:...|artifact:...","matcher":"${assertionMatchers}","producer":"${assertionProducers}","expected":"string|number|boolean|null when required"}. equals/not_equals/contains/matches require expected; every goal also needs a required finite_command or browser/desktop interaction primitive.`,
    '- advisory (advisory; never closes acceptance alone): {"kind":"advisory","note":"non-blocking guidance"}; optional owner="user|external|runtime".',
    `Use only E IDs and target paths present in the frozen evidence bundle. A create operation must set targetOwnerRef to an evidence-backed owner in the same directory/module boundary. goalEvidenceBases assigns every required B and gives every G at least one selected B; optional B components may be omitted. One G may use several B components, but one B cannot be assigned to different goals; repeat every selected B's complete E/owner/Q sets. Encode every G/R/C/D/V edge in its reference array and use the listed operation/primitive kind enums. A non-mutation plan may use decisions+validations with an empty changes array; summary/interfaces/assumptions may be empty arrays. Do not also emit the legacy Markdown draft protocol; runtime renders plan.md from the object. A revision resubmits the complete object. Text outside it, hidden reasoning, and legacy Markdown never become Plan state.`,
    "When the evidence bundle lists Q obligations, close every listed evidence/owner: when diagnosis is required, one R covers all E nodes; each owner has a C or a preserve D that cites that R; every changing C reaches a required V; and every Q has at least one non-preserve C because the runtime has no resolved/no-change proof type yet. Browser/desktop direct actions, ordinary actions, and every assertion target must reuse a corresponding surface target observed by the same change evidence. Do not replace desktop-only behavior with an ordinary finite command or browser interaction. A future harness is valid only when a create/modify C declares plannedValidationHarness, V.harnessChangeRef cites that exact C, and the finite command structurally references the C's direct target or invokes a manifest script modified by that C. Otherwise use an exact runtime-observed native harness command or desktop_interaction.",
  ];
}

function formatStageInstruction(
  stage: PlanAuthoringStage,
  language: "zh" | "en",
  submissionTransport: PlanSubmissionTransport,
): string[] {
  const submitAction = submissionTransport === "native_tool"
    ? language === "zh"
      ? `只调用一次 \`${SUBMIT_PLAN_CANDIDATE_TOOL_NAME}\` 提交完整 typed graph`
      : `call \`${SUBMIT_PLAN_CANDIDATE_TOOL_NAME}\` exactly once with the complete typed graph`
    : language === "zh"
      ? "输出一个完整 `<plan_candidate>`"
      : "emit one complete `<plan_candidate>`";
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
          `允许的下一步：${submitAction}，或一个真正阻塞的 \`<user_options>\`；不要再泛读。`,
        ];
      case "revise":
        return [
          "当前动作：保留上一候选中已合格内容，只修复下方明确列出的违约项。",
          `必须${submitAction}，不能只给差量说明，也不能把修订稿仅放在隐藏 reasoning 中。除非 grounded_evidence 被明确列为违约项，否则不得重开探索。`,
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
        `Allowed next step: ${submitAction}, or one genuinely blocking \`<user_options>\` choice; do not resume broad discovery.`,
      ];
    case "revise":
      return [
        "Current action: preserve accepted content from the prior candidate and repair only the explicit violations below.",
        `You must ${submitAction}, not a delta, and never place the revision only in hidden reasoning. Do not reopen exploration unless grounded_evidence is an explicit violation.`,
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
  submissionTransport?: PlanSubmissionTransport;
}): string {
  const { contract, runtime, language } = input;
  const submissionTransport = input.submissionTransport || "text_envelope";
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
  const facetLines = contract.facets.map((facet) =>
    language === "zh"
      ? `- ${facet.id}：${facet.text}`
      : `- ${facet.id}: ${facet.text}`
  );

  return [
    "[PLAN AUTHORING CONTRACT]",
    `version=${contract.version}; id=${contract.contractId}; stage=${stage}; runtimePhase=${runtime.phase}.`,
    language === "zh" ? `规范目标：${contract.objective}` : `Canonical objective: ${contract.objective}`,
    ...(facetLines.length > 0
      ? [language === "zh" ? "冻结的独立目标分面：" : "Frozen independent goal facets:", ...facetLines]
      : []),
    language === "zh"
      ? `输入锚点：${targetText}；图片=${contract.imageCount}。`
      : `Input anchors: ${targetText}; images=${contract.imageCount}.`,
    language === "zh"
      ? `诊断链要求：${contract.diagnosisRequired ? "必须为每个目标分面建立 E -> R -> C/D 关系" : "不强制 R；若计划主动提出诊断，仍必须引用 E 并正确标注确定性"}；authority=${contract.diagnosisRequirementSource}。${contract.diagnosisSuggested && !contract.diagnosisRequired ? "目标文本存在诊断词汇提示，但它只用于建议结构化意图确认，不能成为质量门。" : ""}`
      : `Diagnosis graph: ${contract.diagnosisRequired ? "required for every goal facet as E -> R -> C/D" : "R is optional; any diagnosis the plan does make must still cite E and classify certainty"}; authority=${contract.diagnosisRequirementSource}. ${contract.diagnosisSuggested && !contract.diagnosisRequired ? "Objective wording suggests diagnosis, but this is only a hint for typed intent confirmation and cannot authorize a quality gate." : ""}`,
    language === "zh"
      ? `已验收的委派取证：${reusableEvidenceText}。这些证据可直接用于制定计划；除非同一路径另有 unresolved 标记，否则不要让父智能体重读。`
      : `Accepted delegated evidence: ${reusableEvidenceText}. Reuse it for planning; do not make the parent reread the same path unless it also has an unresolved marker.`,
    language === "zh"
      ? "流程：理解目标 → 定向取证 → 起草 → 按同一契约修订 → runtime 物化 → pending_review。质量门只能检查下面预先声明的条款，不能在候选生成后改变任务。"
      : "Flow: understand objective -> targeted evidence -> draft -> revise against this same contract -> runtime materialization -> pending_review. The quality gate may check only the predeclared criteria below; it must not redefine the task after drafting.",
    language === "zh"
      ? `提交传输：${submissionTransport === "native_tool" ? `native tool ${SUBMIT_PLAN_CANDIDATE_TOOL_NAME}` : "text envelope <plan_candidate>"}。`
      : `Submission transport: ${submissionTransport === "native_tool" ? `native tool ${SUBMIT_PLAN_CANDIDATE_TOOL_NAME}` : "text envelope <plan_candidate>"}.`,
    ...formatStageInstruction(stage, language, submissionTransport),
    language === "zh" ? "验收条款：" : "Acceptance criteria:",
    ...formatCriteria(language, submissionTransport),
    language === "zh" ? "产物结构契约：" : "Artifact shape contract:",
    ...formatArtifactShape(language),
    ...(stage === "draft" || stage === "revise"
      ? formatTypedDraftIngress(language, submissionTransport)
      : []),
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

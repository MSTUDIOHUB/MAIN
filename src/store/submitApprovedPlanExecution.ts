import { buildPlanApprovalChoiceHint } from "../lib/planControl";
import { getReviewablePlanArtifacts } from "../lib/planApprovalIdentity";
import {
  deriveRuntimePlanTasksFromArtifacts,
  getPendingPlanTaskCommandFocus,
  isLikelySourceMutationTask,
  isRuntimeTaskMutationSectionHeading,
  isPlanTaskSourceMutationObligation,
  isUserRequestValidationTask,
  mergeRuntimeValidationTaskRequirements,
  mergeUserRequestValidationIntoRuntimeTasks,
  normalizeRuntimePlanSectionHeadings,
  reconcilePlanTaskCompletion,
  validateActionablePlanArtifact,
  validateDerivedPlanTasksForApproval,
  validatePlanArtifactContent,
  type ConversationTurn,
  type PlanArtifact,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
} from "../lib/workflowModels";
import { assessPlanExecutableValidation } from "../lib/planExecutableValidation";

export type ApprovedPlanExecutionReadinessReason =
  | "missing_reviewable_plan_artifact"
  | "plan_artifact_quality_rejected"
  | "runtime_task_set_empty"
  | "runtime_task_set_not_executable"
  | "mutation_task_missing"
  | "executable_validation_task_missing";

export interface ApprovedPlanExecutionReadiness {
  ok: boolean;
  stopClass: "plan_execution_materialization_failed" | null;
  reason: ApprovedPlanExecutionReadinessReason | null;
  qualityReason: string | null;
  mutationOriented: boolean;
  requiresExecutableValidation: boolean;
  concreteMutationTaskCount: number;
  executableValidationTaskCount: number;
  taskCount: number;
}

const LEADING_READ_OR_VALIDATION_INTENT_RE =
  /^(?:(?:需要|需|先|请|继续|首先|下一步|再)\s*)?(?:读取|查看|检查|确认|定位|分析|排查|梳理|调研|审查|理解|验证|测试|验收|运行测试|执行测试)|^(?:(?:need(?:s)?\s+to|first|please|next|then)\s+)?(?:read|inspect|review|analy[sz]e|identify|investigate|check|confirm|understand|verify|validate|test)\b/i;
const EXPLICIT_MUTATION_ACTION_RE =
  /(?:将.{1,140}(?:改为|替换为)|修改|更新|新增|添加|修复|补齐|调整|接入|集成|生成|输出|落地|创建|删除|替换|重构|保存|导出|实现)|\b(?:implement|update|modify|fix|add|wire|integrate|generate|write|create|delete|replace|refactor|save|export)\b/i;
const MUTATION_AFTER_READ_RE =
  /(?:然后|随后|之后|再|并(?:且)?).{0,120}(?:将.{1,80}(?:改为|替换为)|修改|更新|新增|添加|修复|补齐|调整|接入|集成|生成|输出|落地|创建|删除|替换|重构|保存|导出|实现)|(?:then|after(?:wards)?|and then).{0,120}(?:implement|update|modify|fix|add|wire|integrate|generate|write|create|delete|replace|refactor|save|export)/i;
const EXPLICIT_NO_MUTATION_RE =
  /^(?:不(?:修改|改动|新增|改变|写入)|无需(?:修改|改动|新增|改变|写入)|保持.{0,80}不变|do not (?:modify|change|write)\b|no (?:source |code )?changes?\b|keep.{0,80}unchanged\b)/i;

function stripPlanListSyntax(line: string): string {
  return String(line || "")
    .replace(/^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)、:：-]\s+)/, "")
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectSectionLines(
  content: string,
  headingMatcher: RegExp | ((heading: string) => boolean),
): string[] {
  const lines: string[] = [];
  let inSection = false;
  let sectionLevel = 0;
  for (const rawLine of normalizeRuntimePlanSectionHeadings(content).split(/\r?\n/)) {
    const heading = rawLine.trim().match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1]?.length || 0;
      const headingText = (heading[2] || "")
        .replace(/\*\*/g, "")
        .replace(/^\d+[.)、]\s*/, "")
        .trim();
      if (inSection && level > sectionLevel) {
        // Nested headings carry reviewed intent too. Plans commonly put the
        // concrete mutation in a child heading such as
        // "### 1. Modify src/main.js" and only supporting detail below it.
        lines.push(headingText);
        continue;
      }
      if (inSection && level <= sectionLevel) inSection = false;
      const headingMatches = typeof headingMatcher === "function"
        ? headingMatcher(headingText)
        : headingMatcher.test(headingText);
      // H1 is the document title, even when it starts with "Fix". Approval
      // requires a real child execution/validation section.
      if (!inSection && level > 1 && headingMatches) {
        inSection = true;
        sectionLevel = level;
      }
      continue;
    }
    if (inSection) {
      const normalized = stripPlanListSyntax(rawLine);
      if (normalized) lines.push(normalized);
    }
  }
  return lines;
}

function hasExplicitMutationIntent(text: string): boolean {
  const normalized = stripPlanListSyntax(text);
  if (!normalized || EXPLICIT_NO_MUTATION_RE.test(normalized)) return false;
  if (LEADING_READ_OR_VALIDATION_INTENT_RE.test(normalized) && !MUTATION_AFTER_READ_RE.test(normalized)) {
    return false;
  }
  return EXPLICIT_MUTATION_ACTION_RE.test(normalized) &&
    isLikelySourceMutationTask(normalized);
}

function isConcreteMutationOrDeliverableTask(task: PlanTask): boolean {
  const evidence = task.evidence || [];
  if (evidence.some((item) => item.kind === "deliverable" && String(item.value || "").trim())) {
    return true;
  }
  return isPlanTaskSourceMutationObligation(task) && hasExplicitMutationIntent(task.text);
}

function failedPlanExecutionReadiness(input: Omit<ApprovedPlanExecutionReadiness, "ok" | "stopClass">): ApprovedPlanExecutionReadiness {
  return {
    ok: false,
    stopClass: "plan_execution_materialization_failed",
    ...input,
  };
}

/**
 * Defense-in-depth check at the approval boundary. The plan artifact may have
 * been persisted or restored since materialization, so approval must re-run
 * semantic validation and prove that the derived task projection is capable
 * of executing the reviewed plan before a child run is created.
 */
export function evaluateApprovedPlanExecutionReadiness(input: {
  planArtifacts: PlanArtifact[];
  executionPlanTasks: PlanTask[];
}): ApprovedPlanExecutionReadiness {
  const reviewableArtifacts = getReviewablePlanArtifacts(input.planArtifacts);
  const taskCount = input.executionPlanTasks.length;
  if (reviewableArtifacts.length === 0) {
    return failedPlanExecutionReadiness({
      reason: "missing_reviewable_plan_artifact",
      qualityReason: null,
      mutationOriented: false,
      requiresExecutableValidation: false,
      concreteMutationTaskCount: 0,
      executableValidationTaskCount: 0,
      taskCount,
    });
  }

  for (const artifact of reviewableArtifacts) {
    // plan.md follows the full executable Plan contract. Design/bugfix
    // artifacts have their own persisted schemas and must not be rejected for
    // lacking plan-only headings, but still pass their native noise/structure
    // validation before their task projection is trusted.
    const quality = artifact.kind === "plan"
      ? validateActionablePlanArtifact(artifact.content)
      : validatePlanArtifactContent(artifact.content, artifact.kind);
    if (!quality.ok) {
      return failedPlanExecutionReadiness({
        reason: "plan_artifact_quality_rejected",
        qualityReason: quality.reason || "unknown_plan_quality_failure",
        mutationOriented: false,
        requiresExecutableValidation: false,
        concreteMutationTaskCount: 0,
        executableValidationTaskCount: 0,
        taskCount,
      });
    }
  }

  const derivedTaskQuality = validateDerivedPlanTasksForApproval(
    input.executionPlanTasks,
  );
  if (!derivedTaskQuality.ok) {
    return failedPlanExecutionReadiness({
      reason: "plan_artifact_quality_rejected",
      qualityReason: derivedTaskQuality.reason || "invalid_runtime_plan_task_graph",
      mutationOriented: false,
      requiresExecutableValidation: false,
      concreteMutationTaskCount: 0,
      executableValidationTaskCount: 0,
      taskCount,
    });
  }

  const mutationOriented = reviewableArtifacts.some((artifact) =>
    collectSectionLines(artifact.content, isRuntimeTaskMutationSectionHeading).some(hasExplicitMutationIntent)
  );
  const executableValidation = assessPlanExecutableValidation({
    planArtifacts: reviewableArtifacts,
    executionPlanTasks: input.executionPlanTasks,
  });
  const requiresExecutableValidation = executableValidation.requiresExecutableValidation;
  const concreteMutationTaskCount = input.executionPlanTasks.filter(isConcreteMutationOrDeliverableTask).length;
  const executableValidationTaskCount = executableValidation.executableValidationTaskCount;
  const counts = {
    mutationOriented,
    requiresExecutableValidation,
    concreteMutationTaskCount,
    executableValidationTaskCount,
    taskCount,
  };

  if (taskCount === 0) {
    return failedPlanExecutionReadiness({
      reason: "runtime_task_set_empty",
      qualityReason: null,
      ...counts,
    });
  }
  if (concreteMutationTaskCount === 0 && executableValidationTaskCount === 0) {
    return failedPlanExecutionReadiness({
      reason: "runtime_task_set_not_executable",
      qualityReason: null,
      ...counts,
    });
  }
  if (mutationOriented && concreteMutationTaskCount === 0) {
    return failedPlanExecutionReadiness({
      reason: "mutation_task_missing",
      qualityReason: null,
      ...counts,
    });
  }
  if (requiresExecutableValidation && executableValidationTaskCount === 0) {
    return failedPlanExecutionReadiness({
      reason: "executable_validation_task_missing",
      qualityReason: null,
      ...counts,
    });
  }

  return {
    ok: true,
    stopClass: null,
    reason: null,
    qualityReason: null,
    ...counts,
  };
}

export interface ApprovedPlanExecutionState {
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planExecutionEvidenceLedger: PlanExecutionEvidenceEntry[];
  isPlanApproved: boolean;
  currentTurnId?: string | null;
  conversationTurns: Array<Pick<ConversationTurn, "id" | "userPrompt">>;
}

export function normalizeApprovedPlanTaskStatuses(
  tasks: PlanTask[],
  evidenceLedger: PlanExecutionEvidenceEntry[] = [],
  shouldHighlightNextTask = false,
): PlanTask[] {
  if (!tasks.length) return tasks;
  return reconcilePlanTaskCompletion([], tasks, evidenceLedger, {
    preserveMissing: false,
    highlightNext: shouldHighlightNextTask,
  });
}

export function detectRequestedRootMarkdownDeliverables(text: string): string[] {
  const source = String(text || "");
  const hasRootHint = /(?:根目录|项目根目录|当前项目|workspace root|project root|root directory)/i.test(source);
  const names = Array.from(source.matchAll(/(?:^|[^\w./-])([A-Za-z][\w.-]*\.md|README\.md|Readme\.md|readme\.md)(?=$|[^\w./-])/g))
    .map((match) => match[1])
    .filter(Boolean)
    .map((name) => name.replace(/^readme\.md$/i, "Readme.md"))
    .filter((name) => !/^(?:plan|requirements|design|tasks|bugfix)\.md$/i.test(name));

  if (names.length === 0 && hasRootHint && /(?:md\s*文档|markdown|说明文档|总结.*文档|Readme|README)/i.test(source)) {
    names.push("Readme.md");
  }

  return [...new Set(names)];
}

export function buildPlanCommandExecutionHint(
  tasks: PlanTask[],
  language: "zh" | "en",
): string {
  const focus = getPendingPlanTaskCommandFocus(tasks, 3);
  const diagnosticHint = language === "zh"
    ? "诊断步骤优先使用内联 `run_command`，避免在项目根目录创建临时诊断脚本；确需脚本文件时，请先把它列入当前任务清单或持久化的 tasks.md，并使用明确临时路径或清理策略。"
    : "For diagnostics, prefer inline `run_command` and avoid creating temporary diagnostic scripts in the project root; if a script file is truly needed, list it in the current task list or persisted tasks.md first and use an explicit temporary path or cleanup strategy.";
  if (focus.length === 0) {
    return language === "zh"
      ? "如果某个任务需要 shell 命令，请把精确命令写在当前任务清单里并用反引号包裹；如果本轮选择持久化 tasks.md，也同步写入对应 checkbox。执行阶段看到这些命令时，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr，长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查输出。" + diagnosticHint
      : "If a task needs shell work, place the exact command in the current task list using backticks; if this run persists tasks.md, mirror it in the matching checkbox. During execution, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. " + diagnosticHint;
  }

  const lines = focus
    .map(({ task, commands }) =>
      language === "zh"
        ? `任务：${task.text}\n命令：${commands.map((command) => `\`${command}\``).join("、")}`
        : `Task: ${task.text}\nCommands: ${commands.map((command) => `\`${command}\``).join(", ")}`,
    )
    .join("\n\n");

  return language === "zh"
    ? "以下未完成任务里已经包含明确的 shell 命令，恢复执行后请优先真实运行它们：一次性命令用 run_command；长驻或交互式命令用 execute_command 后再读取 PTY 日志。不要只复述：\n\n" + lines + "\n\n" + diagnosticHint
    : "The remaining tasks already include concrete shell commands. After resuming, run them for real: use run_command for finite commands; use execute_command and then read PTY logs for long-running or interactive commands. Do not only describe them:\n\n" + lines + "\n\n" + diagnosticHint;
}

export function ensureApprovedPlanRuntimeTasksForState(
  state: ApprovedPlanExecutionState,
  language: "zh" | "en",
): PlanTask[] {
  const hasPersistedTasksArtifact = state.planArtifacts.some((artifact) => artifact.kind === "tasks");
  const currentPlanTurn = state.currentTurnId
    ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)
    : null;
  const durableUserValidationTasks = state.planTasks.filter(isUserRequestValidationTask);
  const withUserRequestValidation = (tasks: PlanTask[]): PlanTask[] => {
    const withDurableValidation = mergeRuntimeValidationTaskRequirements(
      tasks,
      durableUserValidationTasks,
    );
    return normalizeApprovedPlanTaskStatuses(
      mergeUserRequestValidationIntoRuntimeTasks(
        withDurableValidation,
        currentPlanTurn?.userPrompt || "",
        { language },
      ),
      state.planExecutionEvidenceLedger,
      state.isPlanApproved && state.planExecutionEvidenceLedger.length > 0,
    );
  };
  if (state.planTasks.length > 0) {
    const normalizedTasks = normalizeApprovedPlanTaskStatuses(
      state.planTasks,
      state.planExecutionEvidenceLedger,
      state.isPlanApproved,
    );
    if (!hasPersistedTasksArtifact) {
      const derivedRuntimeTasks = deriveRuntimePlanTasksFromArtifacts(state.planArtifacts, {
        language,
      });
      if (derivedRuntimeTasks.length > 0) {
        return withUserRequestValidation(reconcilePlanTaskCompletion(
          normalizedTasks,
          derivedRuntimeTasks,
          state.planExecutionEvidenceLedger,
          {
            preserveMissing: false,
            highlightNext: state.isPlanApproved && state.planExecutionEvidenceLedger.length > 0,
          },
        ));
      }
    }
    return withUserRequestValidation(normalizedTasks);
  }
  if (hasPersistedTasksArtifact) {
    return withUserRequestValidation(state.planTasks);
  }
  return withUserRequestValidation(deriveRuntimePlanTasksFromArtifacts(state.planArtifacts, {
    language,
  }));
}

export function formatPlanTaskListForPrompt(tasks: PlanTask[], language: "zh" | "en", limit = 12): string {
  const visibleTasks = tasks.slice(0, limit);
  if (visibleTasks.length === 0) {
    return language === "zh"
      ? "- 暂无 runtime 任务；请先从 plan.md 生成可审计任务清单。"
      : "- No runtime tasks yet; first derive an auditable task list from plan.md.";
  }
  return visibleTasks.map((task, index) => {
    const evidence = task.evidence?.map((item) =>
      `${item.kind}:${item.value}${item.requiredTerms?.length ? ` requires-change:${item.requiredTerms.join("|")}` : ""}`
    ).join(", ") ||
      (language === "zh" ? "无证据标签" : "no evidence label");
    return `${index + 1}. ${task.text} [${evidence}]`;
  }).join("\n");
}

export function buildApprovedPlanExecutionPrompt(input: {
  state: ApprovedPlanExecutionState;
  language: "zh" | "en";
  executionPlanTasks: PlanTask[];
  normalizedApprovalChoice: string | null;
}): string {
  const hasTasksArtifact =
    input.state.planArtifacts.some((artifact) => artifact.kind === "tasks") ||
    input.executionPlanTasks.length > 0;
  const hasPersistedTasksArtifact = input.state.planArtifacts.some((artifact) => artifact.kind === "tasks");
  const derivedRuntimeTasks =
    input.state.planTasks.length === 0 &&
    !hasPersistedTasksArtifact &&
    input.executionPlanTasks.length > 0;
  const currentPlanTurn = input.state.currentTurnId
    ? input.state.conversationTurns.find((turn) => turn.id === input.state.currentTurnId)
    : null;
  const requestedDocs = detectRequestedRootMarkdownDeliverables(currentPlanTurn?.userPrompt || "");
  const deliverableHint = requestedDocs.length > 0
    ? input.language === "en"
      ? ` The final tasks must include writing ${requestedDocs.map((name) => `project-root \`${name}\``).join(", ")} before completion.`
      : ` 最终 tasks 必须包含写入${requestedDocs.map((name) => `项目根目录 \`${name}\``).join("、")}，完成前必须真实落盘。`
    : "";
  const approvalChoiceHint = buildPlanApprovalChoiceHint(input.normalizedApprovalChoice, input.language);
  const taskListText = formatPlanTaskListForPrompt(input.executionPlanTasks, input.language);
  const runtimeTaskNotice = derivedRuntimeTasks
    ? input.language === "en"
      ? "\n\nMAIN already derived a runtime task list from the approved plan, so you do not need to create `.MAIN/plans/tasks.md` before the first source write. Use this list as the execution source of truth; persist it to tasks.md only if the work becomes long, needs cross-session audit, or the user explicitly asks for an audit file:\n" + taskListText
      : "\n\nMAIN 已经从批准后的 design 派生出 runtime 任务清单，因此第一次源码写入前不必先创建 `.MAIN/plans/tasks.md`。请把下面清单作为本轮执行事实来源；只有任务变长、需要跨会话审计或用户明确要求留档时，才持久化到 tasks.md：\n" + taskListText
    : "";

  if (input.language === "en") {
    return hasTasksArtifact
      ? approvalChoiceHint + "The plan is approved. Follow the current task list in order: close one task with its minimum necessary read, mutation, and declared validation before moving to the next. Reorder only for a proven dependency, and record the reason in the next tool result. Do not repeat the plan. Do not read `.MAIN/plans/tasks.md` just to check whether it exists. If a source file has already been read and another read only returns `FILE_UNCHANGED_STUB`, switch to writing/patching, inspect a different target, or pause with the exact blocker instead of rereading. If `.MAIN/plans/tasks.md` is already known to exist, keep it as an audit record: do not delete completed or previous task records, and only check an item off after real evidence exists for its file/command/deliverable/browser validation, or the item is explicitly pending user validation." + deliverableHint + runtimeTaskNotice + "\n\n" + buildPlanCommandExecutionHint(input.executionPlanTasks, "en")
      : approvalChoiceHint + "The plan is approved. First derive a concise runtime task list from the approved plan.md; generate `.MAIN/plans/tasks.md` only if the work is long, needs cross-session audit, or the user explicitly requested a durable task file. Do not read tasks.md just to check whether it exists. Then execute real work without repeating the plan. Task items should be concise and include lightweight evidence such as `evidence: file:src/app.ts` or `evidence: cmd:npm test` when there is a concrete deliverable." + deliverableHint;
  }

  return hasTasksArtifact
    ? approvalChoiceHint + "计划已批准。请按当前任务清单顺序执行：每项只做最小必要读取、修改和该项声明的验证，形成真实证据后再进入下一项。只有存在已确认的依赖关系时才允许调整顺序，并在下一次工具结果中记录原因。不要重复计划内容。不要为了确认 `.MAIN/plans/tasks.md` 是否存在而读取它；如果源码文件已经读过，再读只返回 `FILE_UNCHANGED_STUB`，请改为写入/替换、读取不同目标，或明确暂停说明阻塞，不要继续重复读取；如果它已知存在，它是审计记录：不要删除已完成或旧任务记录；只有文件/命令/交付物/浏览器验证的真实证据满足，或该项明确待用户验证后，才能勾选对应任务。" + deliverableHint + runtimeTaskNotice + "\n\n" + buildPlanCommandExecutionHint(input.executionPlanTasks, "zh")
    : approvalChoiceHint + "计划已批准。请先基于已批准的 plan.md 派生精简 runtime 任务清单；只有任务较长、需要跨会话审计或用户明确要求持久任务文件时，才生成 `.MAIN/plans/tasks.md`。不要为了确认 tasks.md 是否存在而读取它。然后执行真实任务，不要重复计划内容。有明确交付物的任务请保留轻量证据标签，例如 `证据: file:src/app.ts` 或 `证据: cmd:npm test`。" + deliverableHint;
}

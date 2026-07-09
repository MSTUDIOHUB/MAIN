import { buildPlanApprovalChoiceHint } from "../lib/planControl";
import {
  deriveRuntimePlanTasksFromArtifacts,
  getPendingPlanTaskCommandFocus,
  reconcilePlanTaskCompletion,
  type ConversationTurn,
  type PlanArtifact,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
} from "../lib/workflowModels";

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
  if (state.planTasks.length > 0) {
    const normalizedTasks = normalizeApprovedPlanTaskStatuses(
      state.planTasks,
      state.planExecutionEvidenceLedger,
      state.isPlanApproved,
    );
    if (!hasPersistedTasksArtifact) {
      const derivedRuntimeTasks = deriveRuntimePlanTasksFromArtifacts(state.planArtifacts, {
        language,
        maxTasks: 8,
      });
      if (derivedRuntimeTasks.length > 0) {
        return reconcilePlanTaskCompletion(
          normalizedTasks,
          derivedRuntimeTasks,
          state.planExecutionEvidenceLedger,
          {
            preserveMissing: false,
            highlightNext: state.isPlanApproved && state.planExecutionEvidenceLedger.length > 0,
          },
        );
      }
    }
    return normalizedTasks;
  }
  if (hasPersistedTasksArtifact) {
    return state.planTasks;
  }
  return deriveRuntimePlanTasksFromArtifacts(state.planArtifacts, {
    language,
    maxTasks: 8,
  });
}

export function formatPlanTaskListForPrompt(tasks: PlanTask[], language: "zh" | "en", limit = 12): string {
  const visibleTasks = tasks.slice(0, limit);
  if (visibleTasks.length === 0) {
    return language === "zh"
      ? "- 暂无 runtime 任务；请先从 plan.md 生成可审计任务清单。"
      : "- No runtime tasks yet; first derive an auditable task list from plan.md.";
  }
  return visibleTasks.map((task, index) => {
    const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
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
      ? approvalChoiceHint + "The plan is approved. Continue directly from the current task list and execute the remaining items without repeating the plan. Do not read `.MAIN/plans/tasks.md` just to check whether it exists. If a source file has already been read and another read only returns `FILE_UNCHANGED_STUB`, switch to writing/patching, inspect a different target, or pause with the exact blocker instead of rereading. If `.MAIN/plans/tasks.md` is already known to exist, keep it as an audit record: do not delete completed or previous task records, and only check an item off after real evidence exists for its file/command/deliverable/browser validation, or the item is explicitly pending user validation." + deliverableHint + runtimeTaskNotice + "\n\n" + buildPlanCommandExecutionHint(input.executionPlanTasks, "en")
      : approvalChoiceHint + "The plan is approved. First derive a concise runtime task list from the approved plan.md; generate `.MAIN/plans/tasks.md` only if the work is long, needs cross-session audit, or the user explicitly requested a durable task file. Do not read tasks.md just to check whether it exists. Then execute real work without repeating the plan. Task items should be concise and include lightweight evidence such as `evidence: file:src/app.ts` or `evidence: cmd:npm test` when there is a concrete deliverable." + deliverableHint;
  }

  return hasTasksArtifact
    ? approvalChoiceHint + "计划已批准。请直接基于当前任务清单继续执行剩余任务，不要重复计划内容。不要为了确认 `.MAIN/plans/tasks.md` 是否存在而读取它；如果源码文件已经读过，再读只返回 `FILE_UNCHANGED_STUB`，请改为写入/替换、读取不同目标，或明确暂停说明阻塞，不要继续重复读取；如果它已知存在，它是审计记录：不要删除已完成或旧任务记录；只有文件/命令/交付物/浏览器验证的真实证据满足，或该项明确待用户验证后，才能勾选对应任务。" + deliverableHint + runtimeTaskNotice + "\n\n" + buildPlanCommandExecutionHint(input.executionPlanTasks, "zh")
    : approvalChoiceHint + "计划已批准。请先基于已批准的 plan.md 派生精简 runtime 任务清单；只有任务较长、需要跨会话审计或用户明确要求持久任务文件时，才生成 `.MAIN/plans/tasks.md`。不要为了确认 tasks.md 是否存在而读取它。然后执行真实任务，不要重复计划内容。有明确交付物的任务请保留轻量证据标签，例如 `证据: file:src/app.ts` 或 `证据: cmd:npm test`。" + deliverableHint;
}

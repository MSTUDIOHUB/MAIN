import type { MainThreadEvent, MainThreadProgressUpdate } from "./turnEvents";
import type { ProgressNarrationPhase } from "./progressNarration";
import { isInternalRuntimeProgressUpdate } from "./runtimeProgressVisibility";

/**
 * 阶段步骤项 — 用于在 ExecutionCapsule 中展示按阶段编号的跟踪进度。
 * 完全基于 runtimeEvents 中的 progress.updated 事件聚合生成。
 */
export interface ProgressStageItem {
  stepNumber: number;    // 1-based step number
  title: string;         // 步骤标题，如 "理解需求"
  description: string;   // 详细描述
  phase: string;         // 阶段标识，如 "understanding"
  status: "completed" | "in_progress" | "pending";
  totalSteps: number;    // 总步数
}

/** 已知阶段的默认排序（执行模式） */
const EXECUTION_PHASE_ORDER: ProgressNarrationPhase[] = [
  "understanding",
  "investigating",
  "editing",
  "verifying",
  "summarizing",
];

/** 已知阶段的默认排序（计划模式） */
const PLAN_PHASE_ORDER: string[] = [
  "understanding",
  "investigating",
  "synthesis",
  "review_ready",
];

/** 阶段标识 → 中文标题映射 */
const ZH_PHASE_TITLES: Record<string, string> = {
  understanding: "理解需求",
  investigating: "调查上下文",
  editing: "编辑实现",
  verifying: "验证结果",
  blocked: "受阻等待",
  summarizing: "生成摘要",
  synthesis: "综合方案",
  review_ready: "待审核",
};

/** 阶段标识 → 英文标题映射 */
const EN_PHASE_TITLES: Record<string, string> = {
  understanding: "Understanding",
  investigating: "Investigating",
  editing: "Editing",
  verifying: "Verifying",
  blocked: "Blocked",
  summarizing: "Summarizing",
  synthesis: "Synthesis",
  review_ready: "Review Ready",
};

/** 默认阶段描述模板（执行模式） */
const EXECUTION_DESC_ZH: Record<string, string> = {
  understanding: "分析用户目标、约束和安全边界，明确本轮要完成的任务",
  investigating: "探索项目结构、搜索相关代码、收集关键证据和上下文信息",
  editing: "根据理解的结果修改或创建文件，执行代码变更",
  verifying: "运行测试、构建或验证命令，确认修改结果正确无误",
  summarizing: "汇总本轮完成的工作，生成最终摘要和后续建议",
  blocked: "当前操作被阻止，等待用户审批或外部条件满足",
  synthesis: "综合调研结果，生成执行方案",
  review_ready: "方案就绪，等待审核确认",
};

const EXECUTION_DESC_EN: Record<string, string> = {
  understanding: "Analyzing user goals, constraints, and safety boundaries to define the task",
  investigating: "Exploring project structure, searching code, and gathering key evidence and context",
  editing: "Modifying or creating files based on understanding, executing code changes",
  verifying: "Running tests, builds, or verification commands to confirm changes are correct",
  summarizing: "Summarizing completed work, generating final summary and next-step recommendations",
  blocked: "Current operation blocked, awaiting user approval or external conditions",
  synthesis: "Synthesizing research findings into an execution plan",
  review_ready: "Plan ready for review and confirmation",
};

/** 默认阶段描述模板（计划模式） */
const PLAN_DESC_ZH: Record<string, string> = {
  understanding: "理解用户需求并明确计划目标",
  investigating: "调研项目结构和相关代码",
  synthesis: "综合调研结果，生成执行方案",
  review_ready: "方案就绪，等待审核确认",
};

const PLAN_DESC_EN: Record<string, string> = {
  understanding: "Understand user requirements and define plan goals",
  investigating: "Research project structure and relevant code",
  synthesis: "Synthesizing research findings into an execution plan",
  review_ready: "Plan ready for review and confirmation",
};

/**
 * 根据 phase 获取双语标题
 */
function getPhaseTitle(phase: string, language: "zh" | "en"): string {
  const titles = language === "zh" ? ZH_PHASE_TITLES : EN_PHASE_TITLES;
  return titles[phase] || phase;
}

/**
 * 根据 phase 获取双语描述
 */
function getPhaseDescription(
  phase: string,
  language: "zh" | "en",
  mode: "plan" | "execution",
): string {
  if (mode === "execution") {
    const descs = language === "zh" ? EXECUTION_DESC_ZH : EXECUTION_DESC_EN;
    return descs[phase] || (language === "zh" ? "正在处理" : "Processing");
  }
  const descs = language === "zh" ? PLAN_DESC_ZH : PLAN_DESC_EN;
  return descs[phase] || (language === "zh" ? "正在处理" : "Processing");
}

/**
 * 内部类型：带时间戳的进度更新
 */
interface IndexedProgressUpdate extends MainThreadProgressUpdate {
  timestampMs: number;
}

/**
 * 从 runtimeEvents 中构建带时间戳的 progress.updated 事件列表
 */
function buildIndexedProgressEvents(events: MainThreadEvent[]): IndexedProgressUpdate[] {
  const results: IndexedProgressUpdate[] = [];
  for (const event of events) {
    if (
      event.type === "progress.updated" &&
      event.progress &&
      !isInternalRuntimeProgressUpdate(event.progress)
    ) {
      results.push({
        ...event.progress,
        timestampMs: event.timestampMs,
      });
    }
  }
  return results;
}

/**
 * 按 phase 分组去重，保留每个 phase 的最新一条记录（按 timestampMs 最大的）。
 * 使用 dedupeKey 优先去重，回退到 phase。
 * 返回按时间升序排列的结果。
 */
function dedupeByPhase(
  events: IndexedProgressUpdate[],
): IndexedProgressUpdate[] {
  const map = new Map<string, IndexedProgressUpdate>();

  for (const event of events) {
    const key = event.dedupeKey || event.phase || "unknown";
    const existing = map.get(key);
    if (!existing || event.timestampMs > existing.timestampMs) {
      map.set(key, event);
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => a.timestampMs - b.timestampMs,
  );
}

/**
 * 从 runtimeEvents 聚合出步骤序列。
 *
 * 聚合逻辑：
 * 1. 过滤出所有 progress.updated 事件
 * 2. 按 phase 分组去重（同一 phase 只保留最新一条）
 * 3. 按时间排序赋予 stepNumber
 * 4. 最新 phase → in_progress，之前的 → completed，尚未出现的 → pending
 * 5. 使用双语标题和描述
 *
 * @param events - runtimeEvents 列表
 * @param language - 界面语言（zh | en）
 * @param mode - 模式（plan | execution），决定默认阶段顺序
 * @returns ProgressStageItem[] 排序后的步骤序列
 */
export function buildStageSummary(
  events: MainThreadEvent[],
  language: "zh" | "en" = "zh",
  mode: "plan" | "execution" = "execution",
): ProgressStageItem[] {
  const indexedEvents = buildIndexedProgressEvents(events);

  if (indexedEvents.length === 0) {
    // 没有事件时，返回默认阶段的 pending 状态
    const phases = mode === "execution" ? EXECUTION_PHASE_ORDER : PLAN_PHASE_ORDER;
    return phases.map((phase, index) => ({
      stepNumber: index + 1,
      title: getPhaseTitle(phase, language),
      description: getPhaseDescription(phase, language, mode),
      phase,
      status: "pending",
      totalSteps: phases.length,
    }));
  }

  const deduped = dedupeByPhase(indexedEvents);

  // 确定总步数：合并去重后的 phase 和默认阶段
  const defaultPhases =
    mode === "execution" ? EXECUTION_PHASE_ORDER : PLAN_PHASE_ORDER;
  const allPhases = [...defaultPhases];

  // 添加去重事件中不在默认阶段的 phase
  for (const event of deduped) {
    if (!allPhases.includes(event.phase)) {
      allPhases.push(event.phase);
    }
  }

  const totalSteps = allPhases.length;

  // 按默认阶段顺序 + 额外阶段排序
  const phaseOrderMap = new Map<string, number>();
  allPhases.forEach((p, i) => phaseOrderMap.set(p, i));

  deduped.sort((a, b) => {
    const orderA = phaseOrderMap.get(a.phase) ?? 999;
    const orderB = phaseOrderMap.get(b.phase) ?? 999;
    return orderA - orderB;
  });

  // 最新 phase 是 in_progress，之前的是 completed
  const isInProgress = deduped.length > 0
    ? deduped[deduped.length - 1].status === "running" || deduped[deduped.length - 1].status === "paused"
    : false;

  const result: ProgressStageItem[] = [];

  // 为去重后的 phase 创建步骤
  for (let i = 0; i < deduped.length; i++) {
    const event = deduped[i];
    const isCurrent = i === deduped.length - 1 && isInProgress;
    result.push({
      stepNumber: i + 1,
      title: getPhaseTitle(event.phase, language),
      description: getPhaseDescription(event.phase, language, mode),
      phase: event.phase,
      status: isCurrent ? "in_progress" : "completed",
      totalSteps,
    });
  }

  // 补充 pending 状态（尚未出现的默认阶段）
  const lastVisibleStep = result.length;
  for (let i = lastVisibleStep; i < totalSteps; i++) {
    result.push({
      stepNumber: i + 1,
      title: getPhaseTitle(allPhases[i], language),
      description: getPhaseDescription(allPhases[i], language, mode),
      phase: allPhases[i],
      status: "pending",
      totalSteps,
    });
  }

  return result;
}

/**
 * 生成阶段摘要文本，格式："第 X/Y 步"
 */
export function buildStageLabel(
  stageItems: ProgressStageItem[],
  language: "zh" | "en",
): string {
  const inProgress = stageItems.find((s) => s.status === "in_progress");
  if (!inProgress) {
    const completed = stageItems.filter((s) => s.status === "completed").length;
    return language === "zh"
      ? `第 ${completed}/${stageItems.length} 步`
      : `${completed}/${stageItems.length} steps`;
  }
  return language === "zh"
    ? `第 ${inProgress.stepNumber}/${inProgress.totalSteps} 步`
    : `${inProgress.stepNumber}/${inProgress.totalSteps} steps`;
}

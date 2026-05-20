import {
  compactToolPresentationTarget,
  deriveToolPhase,
  formatToolPresentation,
  type ToolExecutionPhase,
  type ToolPresentationLanguage,
} from "./toolPresentation";
import type { ResolvedUserIntent } from "./runIntent";

export type ProgressNarrationPhase =
  | "understanding"
  | "investigating"
  | "editing"
  | "verifying"
  | "blocked"
  | "summarizing";

export type ProgressNarrationStatus = "running" | "done" | "failed";
export type ProgressNarrationSource = "runtime" | "model" | "tool_result";

export interface ProgressNarration {
  phase: ProgressNarrationPhase;
  title: string;
  why: string;
  action: string;
  evidence: string;
  next: string;
  targets: string[];
  status: ProgressNarrationStatus;
  source: ProgressNarrationSource;
}

export interface ToolProgressNarrationInput {
  toolName: string;
  target?: string;
  language?: ToolPresentationLanguage;
  status?: ProgressNarrationStatus;
  source?: ProgressNarrationSource;
  userGoal?: string;
  turnIntent?: ResolvedUserIntent | string;
  workflowMode?: "chat" | "edit" | "plan" | string;
  currentHypothesis?: string;
  previousObservation?: string;
  targetRole?: string;
  result?: string;
  noOp?: boolean;
}

const VERIFY_COMMAND_RE = /\b(?:test|build|lint|check|typecheck|tsc|playwright|vitest|jest|pytest|cargo\s+(?:test|check)|go\s+test|npm\s+(?:run\s+)?(?:build|test|lint|check)|pnpm\s+(?:run\s+)?(?:build|test|lint|check)|yarn\s+(?:build|test|lint|check))\b/i;

function normalizeLanguage(language?: ToolPresentationLanguage): ToolPresentationLanguage {
  return language === "en" ? "en" : "zh";
}

function compactLine(text: string, maxChars = 180): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function compactMarkdownSnippet(text: string, maxChars = 180): string {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/\b(?:thought|analysis|thinking|reasoning)\b[:：]?/gi, " ")
    .replace(/^(?:因为|原因|下一步|正在做|证据)\s*[:：]\s*/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function looksLikeProgressEcho(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:正在|等待|已读取|已搜索|已记录|已确认|下一步|根据证据|用.*作为成功标准)/.test(normalized) &&
    /(?:读取|搜索|修改|运行|验证|工具|返回|结果|证据)/.test(normalized)
  );
}

function compactContextSnippet(text: string, maxChars = 180): string {
  const normalized = compactMarkdownSnippet(text, maxChars);
  return looksLikeProgressEcho(normalized) ? "" : normalized;
}

function compactGoal(goal: string, language: ToolPresentationLanguage): string {
  const normalized = compactLine(goal, language === "zh" ? 42 : 54);
  if (!normalized) return "";
  return language === "zh" ? `“${normalized}”` : `"${normalized}"`;
}

function basenameLike(target: string): string {
  const normalized = String(target || "").replace(/[\\/]+$/g, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function stripExtension(name: string): string {
  return name.replace(/\.(?:tsx?|jsx?|mjs|cjs|css|scss|sass|html?|mdx?|md|json|ya?ml|toml|rs|vue|svelte)$/i, "");
}

export function deriveToolTargetRole(input: {
  toolName: string;
  target?: string;
  language?: ToolPresentationLanguage;
  targetRole?: string;
}): string {
  const language = normalizeLanguage(input.language);
  const explicit = String(input.targetRole || "").replace(/\s+/g, " ").trim();
  if (explicit) return explicit;

  const toolName = String(input.toolName || "");
  const target = String(input.target || "").trim();
  const lowerTarget = target.toLowerCase();
  const base = stripExtension(basenameLike(target));

  if (!target) {
    if (toolName === "get_project_skeleton") return language === "zh" ? "项目结构" : "project structure";
    if (toolName.includes("pty")) return language === "zh" ? "终端状态" : "terminal state";
    return language === "zh" ? "当前工作区" : "current workspace";
  }

  if (toolName === "run_command" || toolName === "execute_command") {
    if (VERIFY_COMMAND_RE.test(target)) {
      return language === "zh" ? `验证命令 \`${compactLine(target, 72)}\`` : `verification command \`${compactLine(target, 72)}\``;
    }
    return language === "zh" ? `命令 \`${compactLine(target, 72)}\`` : `command \`${compactLine(target, 72)}\``;
  }

  if (/chatarea/i.test(target)) return language === "zh" ? "ChatArea 渲染逻辑" : "ChatArea rendering path";
  if (/actioncard/i.test(target)) return language === "zh" ? "ActionCard 工具卡展示" : "ActionCard tool-card presentation";
  if (/useappstore/i.test(target)) return language === "zh" ? "消息状态与可见性逻辑" : "message state and visibility logic";
  if (/orchestrator/i.test(target)) return language === "zh" ? "agent 编排逻辑" : "agent orchestration logic";
  if (/toolpresentation/i.test(target)) return language === "zh" ? "工具意图说明逻辑" : "tool-intent presentation logic";
  if (/systemprompt/i.test(target)) return language === "zh" ? "系统提示规则" : "system prompt rules";
  if (/turn-process-archive|turnprocessarchive/i.test(target)) return language === "zh" ? "过程归档时间线" : "process archive timeline";
  if (/progress/i.test(target)) return language === "zh" ? "进度展示逻辑" : "progress presentation logic";
  if (/hiddenprocess/i.test(target)) return language === "zh" ? "hiddenProcess 可见性链路" : "hiddenProcess visibility path";
  if (/tests?\//i.test(target) || /\.test\./i.test(target) || /\.spec\./i.test(target)) return language === "zh" ? `${base || "测试"} 回归测试` : `${base || "test"} regression test`;
  if (lowerTarget === "." || lowerTarget === "./") return language === "zh" ? "项目根目录" : "project root";

  if (!/[\\/]/.test(target) && !/\.[a-z0-9]{1,8}$/i.test(target)) {
    return language === "zh" ? `${compactLine(target, 56)} 相关线索` : `signals for ${compactLine(target, 56)}`;
  }

  return compactToolPresentationTarget(target, toolName, language);
}

function progressPhaseForTool(phase: ToolExecutionPhase, target: string): ProgressNarrationPhase {
  if (phase === "blocked") return "blocked";
  if (phase === "edit") return "editing";
  if (phase === "verify") return "verifying";
  if (phase === "command") return VERIFY_COMMAND_RE.test(target) ? "verifying" : "investigating";
  if (phase === "discover" || phase === "inspect") return "investigating";
  return "understanding";
}

function localizedActionVerb(toolName: string, phase: ToolExecutionPhase, language: ToolPresentationLanguage): string {
  if (language === "en") {
    if (toolName === "grep_search" || toolName === "glob_search") return "search";
    if (phase === "discover") return "scan";
    if (phase === "inspect") return "read";
    if (phase === "edit") return "edit";
    if (phase === "verify") return "verify";
    if (phase === "command") return "run";
    if (phase === "blocked") return "preserve";
    return "process";
  }
  if (toolName === "grep_search" || toolName === "glob_search") return "搜索";
  if (phase === "discover") return "扫描";
  if (phase === "inspect") return "读取";
  if (phase === "edit") return "修改";
  if (phase === "verify") return "验证";
  if (phase === "command") return "执行";
  if (phase === "blocked") return "保留";
  return "处理";
}

function joinZhVerbObject(verb: string, object: string): string {
  return /^[A-Za-z0-9_`]/.test(object) ? `${verb} ${object}` : `${verb}${object}`;
}

function englishPastVerb(verb: string): string {
  if (verb === "read") return "Read";
  if (verb === "run") return "Ran";
  if (verb === "process") return "Processed";
  if (verb.endsWith("e")) return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}d`;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}ed`;
}

function englishRunningVerb(verb: string): string {
  if (verb === "run") return "Running";
  if (verb === "scan") return "Scanning";
  if (verb.endsWith("y")) return `${verb.charAt(0).toUpperCase()}${verb.slice(1, -1)}ying`;
  if (verb.endsWith("e")) return `${verb.charAt(0).toUpperCase()}${verb.slice(1, -1)}ing`;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}ing`;
}

function buildWhy(input: ToolProgressNarrationInput & {
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  language: ToolPresentationLanguage;
  role: string;
}): string {
  const { language, phase, progressPhase, role } = input;
  const goal = compactGoal(String(input.userGoal || ""), language);
  const hypothesis = compactContextSnippet(String(input.currentHypothesis || ""), 150);
  const observation = compactContextSnippet(String(input.previousObservation || ""), 150);
  const target = String(input.target || "");

  if (language === "en") {
    if (progressPhase === "blocked") return "Keep the real blocker visible so recovery starts from the failed step.";
    if (phase === "edit") {
      return goal
        ? `The requested goal ${goal} needs a concrete change in ${role}, so this step applies the focused edit.`
        : `The relevant implementation has been identified, so this step applies the focused edit in ${role}.`;
    }
    if (progressPhase === "verifying") {
      if (/npm\s+(?:run\s+)?build/i.test(target)) return "Use the build result as the success signal: exit code 0 and no blocking TypeScript/Vite errors.";
      if (/\btest|vitest|jest|playwright|pytest|go\s+test|cargo\s+test\b/i.test(target)) return "Use the test output as evidence that the affected behavior still passes.";
      return "Use command output as concrete evidence before claiming the work is complete.";
    }
    if (hypothesis) return `Current judgment points to ${hypothesis}. This step checks ${role} for evidence before changing anything.`;
    if (observation) return `The previous result showed ${observation}; this step narrows the next useful evidence in ${role}.`;
    return goal
      ? `The goal ${goal} depends on how ${role} currently works, so this step gathers that context first.`
      : `Read or search ${role} first so the next change is based on evidence instead of guesswork.`;
  }

  if (progressPhase === "blocked") return "保留真实受阻点，方便从失败步骤继续恢复。";
  if (phase === "edit") {
    return goal
      ? `用户目标 ${goal} 需要落到 ${role} 的具体改动，这一步负责实施最小必要修改。`
      : `已经收敛到 ${role}，这一步负责把确认后的方案改进代码里。`;
  }
  if (progressPhase === "verifying") {
    if (/npm\s+(?:run\s+)?build/i.test(target)) return "用构建结果作为成功标准：命令退出码为 0，且没有阻塞性的 TypeScript/Vite 错误。";
    if (/\btest|vitest|jest|playwright|pytest|go\s+test|cargo\s+test\b/i.test(target)) return "用测试输出确认受影响行为仍然通过，而不是只依赖文字判断。";
    return "用命令输出作为真实反馈，确认是否可以继续总结或需要修复。";
  }
  if (hypothesis) return `当前判断指向：${hypothesis}。先查看 ${role}，用代码证据确认后再继续。`;
  if (observation) return `前一步结果显示 ${observation}，所以继续在 ${role} 收窄证据。`;
  return goal
    ? `用户目标 ${goal} 依赖 ${role} 的当前实现，先确认上下文再修改。`
    : `先读取/搜索 ${role}，避免在不了解实现时猜测改动。`;
}

function buildEvidence(input: {
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  status: ProgressNarrationStatus;
  language: ToolPresentationLanguage;
  role: string;
  result?: string;
  noOp?: boolean;
}): string {
  const { language, phase, progressPhase, status, role } = input;
  if (status === "failed") {
    return language === "zh" ? "工具返回了失败信息，失败原因会作为恢复依据。" : "The tool returned a failure; the error is kept as recovery evidence.";
  }
  if (status === "done") {
    return summarizeToolObservation({
      toolName: phase === "edit" ? "replace_in_file" : progressPhase === "verifying" ? "run_command" : "read_file",
      target: role,
      result: input.result || "",
      language,
      noOp: input.noOp,
    });
  }
  if (language === "en") {
    if (phase === "edit") return "Waiting for the write result or diff to confirm what changed.";
    if (progressPhase === "verifying") return "Waiting for exit code, stdout, and stderr to judge success.";
    return "Waiting for returned content, matches, or metadata to confirm the relevant facts.";
  }
  if (phase === "edit") return "等待写入结果或 diff，确认实际改动范围。";
  if (progressPhase === "verifying") return "等待退出码、stdout/stderr 或测试摘要，用来判断是否通过。";
  return "等待返回内容、搜索命中或元数据，用来确认相关事实。";
}

function buildNext(input: {
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  status: ProgressNarrationStatus;
  language: ToolPresentationLanguage;
}): string {
  const { language, phase, progressPhase, status } = input;
  if (status === "failed") {
    return language === "zh" ? "先根据失败原因调整目标、参数或方案，再继续。" : "Adjust the target, parameters, or approach before continuing.";
  }
  if (language === "en") {
    if (phase === "edit") return "Verify the touched behavior with the smallest relevant check.";
    if (progressPhase === "verifying") return "Use the result to decide whether to fix another issue or summarize completion.";
    return "Use this evidence to choose the smallest safe edit or the next focused read.";
  }
  if (phase === "edit") return "修改完成后，用最相关的检查验证受影响行为。";
  if (progressPhase === "verifying") return "根据验证结果决定继续修复，还是总结完成情况。";
  return "根据证据决定最小修改范围，或继续读取缺口上下文。";
}

function titleForTool(input: {
  toolName: string;
  phase: ToolExecutionPhase;
  progressPhase: ProgressNarrationPhase;
  role: string;
  language: ToolPresentationLanguage;
}): string {
  const verb = localizedActionVerb(input.toolName, input.phase, input.language);
  if (input.language === "en") {
    if (input.progressPhase === "blocked") return `Blocked at ${input.role}`;
    return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${input.role}`;
  }
  if (input.progressPhase === "blocked") return `${input.role} 受阻`;
  return joinZhVerbObject(verb, input.role);
}

export function buildToolProgressNarration(input: ToolProgressNarrationInput): ProgressNarration {
  const language = normalizeLanguage(input.language);
  const target = String(input.target || "");
  const toolPhase = deriveToolPhase({
    toolName: input.toolName,
    target,
    status: input.status === "failed" ? "failed" : input.status,
    toolStatus: input.status === "failed" ? "failed" : input.status,
  });
  const progressPhase = progressPhaseForTool(toolPhase, target);
  const status = input.status || "running";
  const role = deriveToolTargetRole({
    toolName: input.toolName,
    target,
    language,
    targetRole: input.targetRole,
  });
  const verb = localizedActionVerb(input.toolName, toolPhase, language);
  const action = language === "en"
    ? status === "done"
      ? `${englishPastVerb(verb)} ${role}.`
      : `${englishRunningVerb(verb)} ${role}.`
    : status === "done"
    ? `已${joinZhVerbObject(verb, role)}。`
    : `正在${joinZhVerbObject(verb, role)}。`;

  return normalizeProgressNarration({
    phase: progressPhase,
    title: titleForTool({ toolName: input.toolName, phase: toolPhase, progressPhase, role, language }),
    why: buildWhy({ ...input, phase: toolPhase, progressPhase, language, role }),
    action,
    evidence: buildEvidence({ phase: toolPhase, progressPhase, status, language, role, result: input.result, noOp: input.noOp }),
    next: buildNext({ phase: toolPhase, progressPhase, status, language }),
    targets: [compactToolPresentationTarget(target, input.toolName, language)].filter(Boolean),
    status,
    source: input.source || "runtime",
  });
}

export function buildToolCallsProgressNarration(input: {
  calls: Array<{ name: string; target?: string }>;
  language?: ToolPresentationLanguage;
  userGoal?: string;
  turnIntent?: ResolvedUserIntent | string;
  workflowMode?: "chat" | "edit" | "plan" | string;
  currentHypothesis?: string;
  previousObservation?: string;
  status?: ProgressNarrationStatus;
  source?: ProgressNarrationSource;
}): ProgressNarration | null {
  const calls = input.calls.filter((call) => call?.name).slice(0, 3);
  if (calls.length === 0) return null;
  const language = normalizeLanguage(input.language);
  if (calls.length === 1) {
    return buildToolProgressNarration({
      toolName: calls[0].name,
      target: calls[0].target,
      language,
      userGoal: input.userGoal,
      turnIntent: input.turnIntent,
      workflowMode: input.workflowMode,
      currentHypothesis: input.currentHypothesis,
      previousObservation: input.previousObservation,
      status: input.status || "running",
      source: input.source || "runtime",
    });
  }

  const first = buildToolProgressNarration({
    toolName: calls[0].name,
    target: calls[0].target,
    language,
    userGoal: input.userGoal,
    turnIntent: input.turnIntent,
    workflowMode: input.workflowMode,
    currentHypothesis: input.currentHypothesis,
    previousObservation: input.previousObservation,
    status: input.status || "running",
    source: input.source || "runtime",
  });
  const presentations = calls.map((call) =>
    formatToolPresentation({ toolName: call.name, target: call.target, language }).summary
  );
  const extra = input.calls.length - calls.length;
  const targets = calls
    .map((call) => compactToolPresentationTarget(call.target || "", call.name, language))
    .filter(Boolean);
  return normalizeProgressNarration({
    ...first,
    title: language === "zh"
      ? `准备执行 ${input.calls.length} 个相关步骤`
      : `Prepare ${input.calls.length} related steps`,
    action: language === "zh"
      ? `正在安排：${presentations.join("；")}${extra > 0 ? `，另有 ${extra} 个步骤` : ""}。`
      : `Preparing: ${presentations.join("; ")}${extra > 0 ? `, plus ${extra} more` : ""}.`,
    targets,
  });
}

export function normalizeProgressNarration(progress: ProgressNarration): ProgressNarration {
  const phase: ProgressNarrationPhase = [
    "understanding",
    "investigating",
    "editing",
    "verifying",
    "blocked",
    "summarizing",
  ].includes(progress.phase)
    ? progress.phase
    : "investigating";
  const status: ProgressNarrationStatus = progress.status === "done" || progress.status === "failed" ? progress.status : "running";
  const source: ProgressNarrationSource = progress.source === "model" || progress.source === "tool_result" ? progress.source : "runtime";
  return {
    phase,
    title: compactLine(progress.title, 120),
    why: compactMarkdownSnippet(progress.why, 240),
    action: compactMarkdownSnippet(progress.action, 220),
    evidence: compactLine(progress.evidence, 220),
    next: compactLine(progress.next, 220),
    targets: Array.from(new Set((progress.targets || []).map((target) => compactLine(target, 80)).filter(Boolean))).slice(0, 6),
    status,
    source,
  };
}

export function progressNarrationToText(progress: ProgressNarration, language: ToolPresentationLanguage = "zh"): string {
  const normalized = normalizeProgressNarration(progress);
  const lines = [
    normalized.action,
    normalized.why,
    normalized.evidence,
    normalized.next,
  ].filter(Boolean);
  const distinctLines: string[] = [];
  for (const line of lines) {
    const normalizedLine = compactMarkdownSnippet(line, 240);
    if (!normalizedLine) continue;
    const key = normalizedLine.replace(/\s+/g, " ").toLowerCase();
    if (distinctLines.some((existing) => {
      const existingKey = existing.replace(/\s+/g, " ").toLowerCase();
      return existingKey.includes(key) || key.includes(existingKey);
    })) {
      continue;
    }
    distinctLines.push(normalizedLine);
  }
  return compactMarkdownSnippet(distinctLines.join(language === "en" ? " " : " "), 420);
}

export function summarizeToolObservation(input: {
  toolName: string;
  target?: string;
  result?: string;
  language?: ToolPresentationLanguage;
  noOp?: boolean;
}): string {
  const language = normalizeLanguage(input.language);
  const result = String(input.result || "");
  const role = deriveToolTargetRole({
    toolName: input.toolName,
    target: input.target,
    language,
  });
  const lower = result.toLowerCase();
  const hasHiddenProcess = /hiddenprocess/i.test(result);
  const exitZero = /(?:exitCode|exit_code|code)["':\s]+0\b/i.test(result) || /\bexit(?:ed)?\s+(?:with\s+)?0\b/i.test(lower);
  const failed = /\b(?:error|failed|failure|timed out|exitCode["':\s]+[1-9]|exit_code["':\s]+[1-9])\b/i.test(result);

  if (language === "en") {
    if (input.noOp) return "No file change was needed because the target already matched the requested content.";
    if (hasHiddenProcess) return `Confirmed ${role} contains hiddenProcess-related visibility logic.`;
    if (input.toolName === "replace_in_file" || input.toolName === "write_file") return `Recorded the file change for ${role}; the diff is available as evidence.`;
    if (input.toolName === "run_command" || input.toolName === "execute_command") {
      if (exitZero && !failed) return `Verification command for ${role} exited successfully.`;
      if (failed) return `Command output for ${role} contains a failure signal that needs follow-up.`;
      return `Command output for ${role} was captured for the next decision.`;
    }
    if (input.toolName === "grep_search" || input.toolName === "glob_search") return `Search results narrowed the relevant evidence around ${role}.`;
    return `Read ${role} and captured the relevant context.`;
  }

  if (input.noOp) return "目标内容已经匹配，本次没有产生文件改动。";
  if (hasHiddenProcess) return `已确认 ${role} 包含 hiddenProcess 相关可见性逻辑。`;
  if (input.toolName === "replace_in_file" || input.toolName === "write_file") return `已记录 ${role} 的文件改动，diff 可作为证据。`;
  if (input.toolName === "run_command" || input.toolName === "execute_command") {
    if (exitZero && !failed) return `${role}已成功退出，可作为验证通过证据。`;
    if (failed) return `${role}输出里包含失败信号，需要继续处理。`;
    return `已记录${role}的命令输出，用于判断下一步。`;
  }
  if (input.toolName === "grep_search" || input.toolName === "glob_search") return `搜索结果已收窄 ${role} 的相关证据。`;
  return `已读取 ${role}，捕获了后续判断所需上下文。`;
}

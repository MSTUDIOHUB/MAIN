import {
  buildContextMemoryState,
  formatContextMemoryPacket,
  type ContextMemoryMessage,
} from "./contextMemory";
import { compactContextForExecuteRecovery, type TrimMessage } from "./contextTrim";
import { summarizeApplyPatchTarget } from "./applyPatchTool";
import {
  EXECUTE_RECOVERY_MUTATION_TOOLS,
  isExecutePatchMismatchRecoveryActivity,
  isReadOnlyNoProgressDetail,
  normalizeExecuteRecoveryMode,
  type ExecuteRecoveryMode,
} from "./executeRecoveryTools";
import { looksLikeSyntheticContinuationText } from "./syntheticContinuation";
import { parseToolFeedbackEnvelope } from "./toolFeedbackEnvelope";
import { isSuccessfulVerificationToolObservation } from "./verificationEvidence";
import { workspacePathsReferToSameFile } from "./workspacePaths";
import type {
  GoalContinuationMessage,
  GoalContinuationState,
  GoalContinuationToolCall,
} from "./goalState";

export const GOAL_CONTINUATION_CONTROL_PREFIX = "[goal_continuation";

const MAX_CONTINUATION_MESSAGES = 72;
const MAX_CONTINUATION_CHARS = 120_000;
const MAX_USER_MESSAGE_CHARS = 8_000;
const MAX_ASSISTANT_MESSAGE_CHARS = 16_000;
const MAX_TOOL_MESSAGE_CHARS = 20_000;
const MAX_TOOL_ARGUMENT_CHARS = 16_000;
const MAX_ASSISTANT_CONTEXT_CHARS = 4_000;
const MAX_CONTINUATION_MEMORY_CHARS = 6_000;
const MAX_MEMORY_CONCLUSIONS = 6;
const MEMORY_CONCLUSIONS_HEADING = "Retained model conclusions:";
const TRANSIENT_RECOVERY_RESULT_PREFIXES = [
  "READ_FILE_NOT_AVAILABLE_IN_RECOVERY:",
  "EXECUTE_RECOVERY_BATCH_DEFERRED:",
] as const;

interface ContinuationMessageLike {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

function compactMiddle(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= maxChars) return text;
  const marker = "\n...[continuation content compacted]...\n";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.floor(available * 0.65);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (available - head))}`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text") return String(candidate.text || "");
      return candidate.type === "image_url" || candidate.type === "input_image"
        ? "[image retained in the original Goal source context]"
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Recovery tool availability is scoped to one inner loop. A result carrying
 * this runtime marker is therefore transport state, not workspace evidence.
 * Do not replay it into the next Goal continuation after the tool surface has
 * reset to normal.
 */
function isTransientRecoveryToolResult(content: unknown): boolean {
  const rawText = contentToText(content).trim();
  const text = (parseToolFeedbackEnvelope(rawText)?.body || rawText).trim();
  if (!text || text.length > 1_000) return false;
  return TRANSIENT_RECOVERY_RESULT_PREFIXES.some((prefix) =>
    text.startsWith(prefix) || text.startsWith(`Error: ${prefix}`)
  );
}

function containsTransientRecoveryMarkerLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const normalized = line.trim().replace(/^-\s*/, "").replace(/^Error:\s*/i, "");
    return TRANSIENT_RECOVERY_RESULT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  });
}

/**
 * Older Goal snapshots may already have compacted a loop-scoped recovery
 * marker into free-form memory. Once provenance is lost, selectively removing
 * one sentence could corrupt the packet, so discard only the contaminated
 * packet and rebuild memory from the retained messages and current evidence.
 */
export function sanitizeGoalContinuationMemoryPacket(value: unknown): string | undefined {
  const text = String(value || "").trim();
  if (!text || containsTransientRecoveryMarkerLine(text)) return undefined;
  return text;
}

function normalizeToolCalls(value: unknown): GoalContinuationToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const id = String(candidate.id || "").trim();
    const name = String(candidate.function?.name || "").trim();
    if (!id || !name) return [];
    return [{
      id,
      type: "function" as const,
      function: {
        name,
        arguments: compactMiddle(candidate.function?.arguments || "{}", MAX_TOOL_ARGUMENT_CHARS),
      },
    }];
  });
  return calls.length > 0 ? calls : undefined;
}

export function isGoalContinuationControlText(value: unknown): boolean {
  const text = String(value || "").trim();
  return text.startsWith(GOAL_CONTINUATION_CONTROL_PREFIX)
    || /^(?:Execute bounded goal slice|执行有界目标切片)\s+\d+\/\d+/i.test(text);
}

function sanitizeContinuationMessages(messages: ContinuationMessageLike[]): GoalContinuationMessage[] {
  const normalized = messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") return [];
    const role = message.role;
    const rawContent = contentToText(message.content);
    if (role === "user" && (
      isGoalContinuationControlText(rawContent)
      || looksLikeSyntheticContinuationText(rawContent)
    )) return [];
    const maxChars = role === "user"
      ? MAX_USER_MESSAGE_CHARS
      : role === "assistant"
        ? MAX_ASSISTANT_MESSAGE_CHARS
        : MAX_TOOL_MESSAGE_CHARS;
    const content = compactMiddle(rawContent, maxChars);
    const toolCalls = role === "assistant" ? normalizeToolCalls(message.tool_calls) : undefined;
    const toolCallId = role === "tool" ? String(message.tool_call_id || "").trim() : "";
    if (role === "tool" && isTransientRecoveryToolResult(rawContent)) return [];
    if (!content && !toolCalls?.length) return [];
    if (role === "tool" && !toolCallId) return [];
    return [{
      role,
      content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    } satisfies GoalContinuationMessage];
  });

  const resultIds = new Set(
    normalized
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => message.tool_call_id as string),
  );
  const parentIds = new Set<string>();
  const withCompleteCalls = normalized.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return message;
    const completeCalls = message.tool_calls.filter((call) => resultIds.has(call.id));
    completeCalls.forEach((call) => parentIds.add(call.id));
    return {
      ...message,
      ...(completeCalls.length > 0 ? { tool_calls: completeCalls } : { tool_calls: undefined }),
    };
  });

  return withCompleteCalls.filter((message) =>
    message.role !== "tool" || !!message.tool_call_id && parentIds.has(message.tool_call_id)
  );
}

function continuationChars(messages: GoalContinuationMessage[]): number {
  return messages.reduce((total, message) =>
    total
      + message.content.length
      + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0), 0);
}

function readPriorMemoryConclusions(memoryPacket: string | undefined): string[] {
  const text = String(memoryPacket || "");
  const start = text.lastIndexOf(MEMORY_CONCLUSIONS_HEADING);
  if (start < 0) return [];
  return text
    .slice(start + MEMORY_CONCLUSIONS_HEADING.length)
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_MEMORY_CONCLUSIONS);
}

function buildContinuationMemoryPacket(input: {
  messages: GoalContinuationMessage[];
  previous?: GoalContinuationState | null;
}): string | undefined {
  const previousMemoryPacket = sanitizeGoalContinuationMemoryPacket(input.previous?.memoryPacket);
  const memoryMessages: ContextMemoryMessage[] = [
    ...(previousMemoryPacket
      ? [{ role: "user" as const, content: previousMemoryPacket }]
      : []),
    ...input.messages,
  ];
  const structuredMemory = formatContextMemoryPacket(
    buildContextMemoryState(memoryMessages),
    4_200,
  );
  const conclusionCandidates = [
    ...readPriorMemoryConclusions(previousMemoryPacket),
    ...input.messages
      .filter((message) => message.role === "assistant" && message.content.trim())
      .map((message) => extractGoalAssistantSummary(message.content, 360))
      .filter(Boolean),
  ];
  const seen = new Set<string>();
  const conclusions: string[] = [];
  for (let index = conclusionCandidates.length - 1; index >= 0; index -= 1) {
    const conclusion = conclusionCandidates[index].replace(/\s+/g, " ").trim();
    const key = conclusion.toLowerCase();
    if (!conclusion || seen.has(key)) continue;
    seen.add(key);
    conclusions.unshift(conclusion);
    if (conclusions.length >= MAX_MEMORY_CONCLUSIONS) break;
  }
  const conclusionSection = conclusions.length > 0
    ? `${MEMORY_CONCLUSIONS_HEADING}\n${conclusions.map((conclusion) => `- ${conclusion}`).join("\n")}`
    : "";
  const combined = [structuredMemory, conclusionSection].filter(Boolean).join("\n");
  return combined ? compactMiddle(combined, MAX_CONTINUATION_MEMORY_CHARS) : undefined;
}

function compactOversizedContinuation(messages: GoalContinuationMessage[]): GoalContinuationMessage[] {
  const latestPlainAssistantMessages = messages
    .filter((message) => message.role === "assistant" && !message.tool_calls?.length && message.content.trim())
    .slice(-3);
  const compacted = compactContextForExecuteRecovery(
    [{ role: "system", content: "Goal continuation transport" }, ...messages] as TrimMessage[],
    {
      maxMessages: MAX_CONTINUATION_MESSAGES,
      maxToolResultMessages: 24,
      maxToolChars: 72_000,
      maxToolCallGroups: 16,
      maxToolResultTokens: 2_000,
      latestUserMessages: 4,
    },
  ).messages;
  const sanitized = sanitizeContinuationMessages(compacted as ContinuationMessageLike[]);
  const fingerprints = new Set(sanitized.map((message) => `${message.role}:${message.content}`));
  for (const message of latestPlainAssistantMessages) {
    const fingerprint = `${message.role}:${message.content}`;
    if (!fingerprints.has(fingerprint)) sanitized.push(message);
  }
  let bounded = sanitizeContinuationMessages(sanitized.slice(-MAX_CONTINUATION_MESSAGES));
  while (
    bounded.length > 1
    && (bounded.length > MAX_CONTINUATION_MESSAGES || continuationChars(bounded) > MAX_CONTINUATION_CHARS)
  ) {
    bounded = sanitizeContinuationMessages(bounded.slice(1));
  }
  return bounded;
}

export function createGoalContinuationState(input: {
  messages: ContinuationMessageLike[];
  sourceIteration: number;
  previous?: GoalContinuationState | null;
  executeRecoveryState?: {
    mode: ExecuteRecoveryMode;
    reason?: string | null;
    expectedTarget?: string | null;
  } | null;
  now?: number;
}): GoalContinuationState {
  const messageCountBefore = input.messages.length;
  const sanitized = sanitizeContinuationMessages(input.messages);
  const needsCompaction = sanitized.length > MAX_CONTINUATION_MESSAGES
    || continuationChars(sanitized) > MAX_CONTINUATION_CHARS;
  const messages = needsCompaction ? compactOversizedContinuation(sanitized) : sanitized;
  const memoryPacket = buildContinuationMemoryPacket({ messages, previous: input.previous });
  const previousMemoryPacket = sanitizeGoalContinuationMemoryPacket(input.previous?.memoryPacket);
  const recoveryInput = input.executeRecoveryState === undefined
    ? input.previous?.executeRecoveryState
    : input.executeRecoveryState;
  const executeRecoveryState = recoveryInput
    ? {
        mode: normalizeExecuteRecoveryMode(recoveryInput.mode),
        reason: String(recoveryInput.reason || "").trim(),
        expectedTarget: normalizeRecoveryTarget(recoveryInput.expectedTarget),
      }
    : undefined;
  return {
    sourceIteration: Math.max(0, Math.floor(Number(input.sourceIteration) || 0)),
    updatedAt: input.now ?? Date.now(),
    messages,
    memoryPacket: memoryPacket || previousMemoryPacket,
    messageCountBefore,
    compacted: needsCompaction || input.previous?.compacted === true,
    operationCount: messages.filter((message) => message.role === "tool").length,
    ...(executeRecoveryState ? { executeRecoveryState } : {}),
  };
}

export function restoreGoalContinuationMessages(
  state: GoalContinuationState | null | undefined,
): GoalContinuationMessage[] {
  return sanitizeContinuationMessages(Array.isArray(state?.messages) ? state.messages : []);
}

function legacyGoalContinuationMutationLooksEffective(text: string): boolean {
  return !/(?:"noOp"\s*:\s*true|FILE_UNCHANGED_STUB|NO_EFFECT_MUTATION|empty_change|identical_content|no changes|no-op|nothing to (?:change|patch|write)|already matched requested content)/i.test(text);
}

function legacyGoalContinuationToolResultLooksFailed(text: string): boolean {
  return /^(?:Error:|system_error:|TASK_TARGETING_BLOCKED:|REPEATED_FAILURE_BLOCKED:|ENOENT\b|EACCES\b|no such file\b|permission denied\b)/i.test(text.trim());
}

interface RetainedGoalToolCall {
  name: string;
  target: string | null;
}

export interface GoalContinuationExecuteRecoveryState {
  mode: Exclude<ExecuteRecoveryMode, "normal">;
  reason: string;
  expectedTarget: string | null;
}

function parseGoalToolCallArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeRecoveryTarget(value: unknown): string | null {
  const target = String(value || "").trim();
  if (
    !target ||
    /^(?:workspace patch|workspace|terminal(?: tail| status)?|git status)$/i.test(target) ||
    /,\s|\s\+\d+$/.test(target)
  ) {
    return null;
  }
  return target;
}

function resolveGoalToolCallTarget(call: GoalContinuationToolCall): string | null {
  const args = parseGoalToolCallArguments(call.function.arguments);
  if (call.function.name === "apply_patch") {
    return normalizeRecoveryTarget(summarizeApplyPatchTarget(String(args.patch || ""), 1));
  }
  return normalizeRecoveryTarget(
    args.path || args.file_path || args.filePath || args.target || args.TargetFile,
  );
}

function recoveryTargetsMatch(expectedTarget: string | null, observedTarget: string | null): boolean {
  if (!expectedTarget) return true;
  return !!observedTarget && workspacePathsReferToSameFile(expectedTarget, observedTarget);
}

function buildGoalContinuationRecoveryState(input: {
  mode: GoalContinuationExecuteRecoveryState["mode"];
  reason: string;
  target: string | null;
}): GoalContinuationExecuteRecoveryState {
  return {
    mode: input.mode,
    reason: input.reason,
    expectedTarget: input.target,
  };
}

/**
 * Recover an unfinished inner-loop transaction at a Goal slice boundary from
 * complete retained tool pairs. This keeps slower/local models on the same
 * read -> mutate -> validate sequence even though each slice creates a fresh
 * AgentLoop mutable state.
 */
export function resolveGoalContinuationExecuteRecoveryState(
  state: GoalContinuationState | null | undefined,
  options: { mutationRequired: boolean },
): GoalContinuationExecuteRecoveryState | null {
  if (!state || !options.mutationRequired) return null;
  if (state.executeRecoveryState) {
    const mode = normalizeExecuteRecoveryMode(state.executeRecoveryState.mode);
    if (mode === "normal") return null;
    return {
      mode,
      reason: state.executeRecoveryState.reason || "goal_continuation_runtime_state",
      expectedTarget: normalizeRecoveryTarget(state.executeRecoveryState.expectedTarget),
    };
  }
  const messages = restoreGoalContinuationMessages(state);
  const toolCalls = new Map<string, RetainedGoalToolCall>();
  let recoveryState: GoalContinuationExecuteRecoveryState | null = null;

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls || []) {
        toolCalls.set(call.id, {
          name: call.function.name,
          target: resolveGoalToolCallTarget(call),
        });
      }
      continue;
    }
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const retainedCall = toolCalls.get(message.tool_call_id);
    if (!retainedCall) continue;
    const rawText = contentToText(message.content).trim();
    if (isTransientRecoveryToolResult(rawText)) continue;
    const parsedFeedback = parseToolFeedbackEnvelope(rawText);
    if (parsedFeedback && (
      parsedFeedback.envelope.tool_call_id !== message.tool_call_id ||
      parsedFeedback.envelope.tool !== retainedCall.name
    )) {
      // A structured result belongs only to the exact retained call pair. Do
      // not reinterpret a mismatched envelope body as legacy free-form text.
      continue;
    }
    const structuredStatus = parsedFeedback?.envelope.status ?? null;
    const text = (parsedFeedback?.body ?? rawText).trim();
    const diagnostic = [
      text,
      parsedFeedback?.envelope.summary,
      ...(parsedFeedback?.envelope.hints || []),
    ].filter(Boolean).join("\n");
    const target = normalizeRecoveryTarget(parsedFeedback?.envelope.target) || retainedCall.target;
    const legacyFailed = !parsedFeedback && legacyGoalContinuationToolResultLooksFailed(text);
    const structuredFailed = structuredStatus === "failed" || structuredStatus === "blocked";
    const freshSuccess = parsedFeedback
      ? structuredStatus === "completed"
      : !legacyFailed;

    if ((structuredFailed || legacyFailed) && isExecutePatchMismatchRecoveryActivity({
      name: retainedCall.name,
      status: "failed",
      target: target || undefined,
      detail: diagnostic,
    })) {
      recoveryState = buildGoalContinuationRecoveryState({
        mode: "patch_recovery_read",
        reason: "goal_continuation_patch_mismatch",
        target,
      });
      continue;
    }
    if (!freshSuccess) continue;

    if (retainedCall.name === "read_file") {
      if (!parsedFeedback && isReadOnlyNoProgressDetail(text)) continue;
      if (recoveryState?.mode === "patch_recovery_read") {
        if (!recoveryTargetsMatch(recoveryState.expectedTarget, target)) continue;
        recoveryState = buildGoalContinuationRecoveryState({
          mode: "mutation_first",
          reason: "goal_continuation_context_observed",
          target: recoveryState.expectedTarget || target,
        });
        continue;
      }
      // Legacy continuations did not persist runtime state. A plain successful
      // read is not enough to prove recovery was active; inferring from it
      // recreates the original bug by hiding read_file at arbitrary slices.
      continue;
    }

    if (EXECUTE_RECOVERY_MUTATION_TOOLS.has(retainedCall.name)) {
      if (!parsedFeedback && !legacyGoalContinuationMutationLooksEffective(text)) continue;
      if (
        recoveryState?.mode === "mutation_first" &&
        !recoveryTargetsMatch(recoveryState.expectedTarget, target)
      ) {
        continue;
      }
      recoveryState = buildGoalContinuationRecoveryState({
        mode: "validation_only",
        reason: "goal_continuation_mutation_observed",
        target: recoveryState?.expectedTarget || target,
      });
      continue;
    }

    if (
      recoveryState?.mode === "validation_only" &&
      isSuccessfulVerificationToolObservation({
        name: retainedCall.name,
        content: text,
        feedbackStatus: structuredStatus,
      })
    ) {
      recoveryState = null;
    }
  }

  return recoveryState;
}

/** Compatibility projection for callers that only need the tool-surface mode. */
export function resolveGoalContinuationExecuteRecoveryMode(
  state: GoalContinuationState | null | undefined,
  options: { mutationRequired: boolean },
): ExecuteRecoveryMode | null {
  return resolveGoalContinuationExecuteRecoveryState(state, options)?.mode || null;
}

export function buildGoalContinuationPrompt(input: {
  language: "zh" | "en";
  goalId: string;
  continuationIndex: number;
}): string {
  const index = Math.max(1, Math.floor(Number(input.continuationIndex) || 1));
  const body = input.language === "en"
    ? [
        "Continue the same persistent goal and logical task.",
        "Reuse the retained conversation, completed tool results, checkpoint, and evidence. Do not restart discovery or repeat an operation unless newer workspace evidence makes it necessary.",
        "Tool availability is scoped to each continuation and recovery step. The tools exposed for this continuation are authoritative; any earlier temporary tool-unavailable recovery result has expired.",
        "For a pending file change, use one fixed action order: targeted read only when exact current text is missing, then one focused mutation, then finite validation.",
        "Choose the next unfinished, verifiable action. The runtime will decide completion from evidence.",
      ]
    : [
        "继续同一个持续目标和同一个逻辑任务。",
        "复用已保留的对话、已完成工具结果、检查点和证据；除非工作区出现更新证据，不要重新开始探索或重复已经做过的操作。",
        "工具可用性只对各自的连续执行和恢复步骤有效；以本次实际开放的工具为准，之前临时的工具不可用恢复结果已经失效。",
        "如果尚有文件修改，遵循固定行动顺序：只在缺少当前精确文本时定向读取，然后执行一次聚焦修改，再进行有限验证。",
        "选择下一个尚未完成且可验证的行动；最终完成由运行时根据证据判定。",
      ];
  return [
    `[goal_continuation goal_id="${String(input.goalId || "goal").replace(/"/g, "")}" index="${index}"]`,
    ...body,
    "[/goal_continuation]",
  ].join("\n");
}

function assistantParagraphScore(value: string, index: number): number {
  const concreteReferences = (
    value.match(/(?:`[^`\n]{2,}`|(?:^|\s)[\w.-]+\/[\w./-]+|\bL?\d{1,5}(?:[-:]\d{1,5})?\b)/g) || []
  ).length;
  const structuralDetail = (value.match(/[:：=()[\]{}]/g) || []).length;
  return concreteReferences * 10 + Math.min(12, structuralDetail) + Math.min(12, value.length / 60) + index / 100;
}

export function extractGoalAssistantSummary(value: unknown, maxChars = 500): string {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const candidates = [...text.split(/\n{2,}/), ...text.split("\n")]
    .map((part) => part
      .replace(/^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/, "")
      .replace(/\b(?:GOAL_COMPLETION_CANDIDATE|GOAL_COMPLETED)\b/gi, "")
      .trim())
    .filter((part) =>
      part.length >= 12
      && !/^#{1,6}\s/.test(part)
      && !isGoalContinuationControlText(part)
    );
  if (candidates.length === 0) return compactMiddle(text, maxChars);
  const best = candidates
    .map((candidate, index) => ({ candidate, score: assistantParagraphScore(candidate, index) }))
    .sort((left, right) => right.score - left.score)[0]?.candidate || candidates[candidates.length - 1];
  return compactMiddle(best, maxChars);
}

export function compactGoalAssistantContext(value: unknown): string {
  const text = String(value || "")
    .replace(/\b(?:GOAL_COMPLETION_CANDIDATE|GOAL_COMPLETED)\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return compactMiddle(text, MAX_ASSISTANT_CONTEXT_CHARS);
}

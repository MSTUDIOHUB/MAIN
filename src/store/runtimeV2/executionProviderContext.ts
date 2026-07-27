import type { AgentMessage } from "../../lib/agentMessages";
import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import {
  DEFAULT_PROVIDER_LANE_PROFILE_V1,
  deriveRuntimeV2PlanSourceFreshness,
  type ProviderLaneProfileV1,
} from "../../lib/runtime-v2";
import { RUNTIME_V2_PLAN_ARTIFACT_PATH } from "../../lib/runtime-v2/workPlan";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import { boundedToolContent } from "./executionText";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2LiveExecutionState,
  RuntimeV2ModelContextEntry,
} from "./executionTypes";

const MAX_CONTEXT_ENTRIES = 16;
const MAX_CONTEXT_ENTRY_CHARS = 5_000;
const MAX_PLAN_CONTEXT_CHARS = 16_000;
const MAX_CONTEXT_DIGEST_CHARS = 18_000;

export function containsProviderTextEnvelopePrompt(
  language: "zh" | "en",
  toolRequired: boolean,
): string {
  if (language === "en") {
    return toolRequired
      ? "Native tools are unavailable for this request. A structured tool call is required now. Output exactly `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` with valid JSON and no prose."
      : "Native tools are unavailable for this request. If a tool is needed, output exactly `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` with valid JSON and no prose.";
  }
  return toolRequired
    ? "本次请求不使用原生工具，但当前阶段必须提交一个结构化工具调用。只输出完整的 `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` JSON 信封，不要混入说明文字。"
    : "本次请求不使用原生工具。若需要工具，只输出一个完整的 `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` JSON 信封，不要混入说明文字。";
}

function systemInstruction(input: RuntimeV2ExecutionPortsInput): string {
  const workspace = input.context.runWorkspace || "未绑定工作区";
  const language = input.context.phaseLanguage === "en"
    ? "English"
    : "简体中文";
  const readOnlyWorkspaceTurn = !!input.context.runWorkspace &&
    (
      input.context.runtimeRunIntent === "respond" ||
      input.context.runtimeRunIntent === "discuss" ||
      input.context.runtimeRunIntent === "analyze" ||
      input.context.runtimeRunIntent === "summarize" ||
      input.context.runtimeRunIntent === "report"
    );
  return [
    "[MAIN RUNTIME V2]",
    `Workspace: ${workspace}`,
    `Respond in: ${language}`,
    "Use structured tools for every read, modification, command, and verification. With a native tool call, you may include one brief public progress sentence in normal response content; MAIN routes it only to Capsule and never uses it as control state. Do not expose private reasoning or repeat that sentence in the final answer.",
    readOnlyWorkspaceTurn
      ? "This is a workspace task with read-only authority. Inspect only the minimum relevant workspace evidence. Never request or claim a file mutation, shell command, browser action, or validation effect."
      : "Before a final answer, use evidence from actual tool results. For a repair, make the smallest justified change and run an appropriate finite validation after a modification.",
    readOnlyWorkspaceTurn
      ? "Return one complete evidence-backed Markdown answer and state any remaining uncertainty. Do not describe this workspace task as Chat."
      : "A final answer must state confirmed cause, files changed, validation performed, and any remaining limit. Never claim success merely because a tool call was issued.",
  ].join("\n");
}

export function baseProviderProfile(state: any): ProviderLaneProfileV1 {
  const settings = deriveStreamSettings(state.config);
  const nativeTools = String(settings.toolProtocol || "auto").toLowerCase() !==
    "xml";
  return {
    ...DEFAULT_PROVIDER_LANE_PROFILE_V1,
    nativeTools,
    requiredToolChoice: false,
    textToolEnvelope: true,
  };
}

export function recordApprovedPlanContext(
  input: RuntimeV2ExecutionPortsInput,
): void {
  const aggregate = aggregateForCurrentTurn(input);
  const approved = approvedPlanForCurrentTurn(input);
  if (!aggregate || !approved) return;
  const freshness = deriveRuntimeV2PlanSourceFreshness(aggregate);
  recordModelContext(input.live, {
    id: `approved-plan:${approved.plan.id}:${approved.plan.revision}:${approved.plan.digest}`,
    source: "plan",
    label: "approved_work_plan",
    target: RUNTIME_V2_PLAN_ARTIFACT_PATH,
    status: "succeeded",
    content: [
      "This sealed WorkPlan is the mutation and validation authority for the current Run.",
      JSON.stringify({
        authority: approved.commit.authority,
        objective: approved.plan.draft.objective,
        summary: approved.plan.draft.summary,
        findings: approved.plan.draft.findings,
        steps: approved.plan.draft.steps,
        validations: approved.plan.draft.validations,
        risks: approved.plan.draft.risks,
        assumptions: approved.plan.draft.assumptions,
        sourceFreshness: freshness
          ? {
              allFresh: freshness.allFresh,
              missingTargets: freshness.missingTargets,
              staleTargets: freshness.staleTargets,
              unversionedTargets: freshness.unversionedTargets,
            }
          : null,
      }, null, 2),
      freshness && !freshness.allFresh
        ? `Before the first mutation, call read_file for every missing exact target: ${freshness.missingTargets.join(", ") || "none"}. A stale target invalidates this approval.`
        : "",
    ].join("\n\n"),
  });
}

export function recordModelContext(
  live: RuntimeV2LiveExecutionState,
  entry: RuntimeV2ModelContextEntry,
): void {
  const normalized: RuntimeV2ModelContextEntry = {
    ...entry,
    label: entry.label.trim().slice(0, 240),
    target: entry.target.trim().slice(0, 2_000),
    content: boundedToolContent(
      entry.content,
      entry.source === "plan"
        ? MAX_PLAN_CONTEXT_CHARS
        : MAX_CONTEXT_ENTRY_CHARS,
    ),
  };
  const duplicate = live.modelContext.findIndex((candidate) =>
    candidate.source === normalized.source &&
    candidate.target === normalized.target &&
    candidate.content === normalized.content
  );
  if (duplicate >= 0) live.modelContext.splice(duplicate, 1);
  live.modelContext.push(normalized);
  if (live.modelContext.length > MAX_CONTEXT_ENTRIES) {
    live.modelContext.splice(
      0,
      live.modelContext.length - MAX_CONTEXT_ENTRIES,
    );
  }
}

function baseProviderHistory(
  live: RuntimeV2LiveExecutionState,
  input: RuntimeV2ExecutionPortsInput,
): AgentMessage[] {
  if (live.messages.length > 0) return live.messages;
  const turn = input.get().conversationTurns?.find(
    (candidate: any) => candidate.id === input.context.turnId,
  );
  live.messages.push(
    { role: "system", content: systemInstruction(input) },
    {
      role: "user",
      content: String(turn?.userPrompt || "").trim().slice(0, 12_000) ||
        "请处理当前任务。",
    },
  );
  return live.messages;
}

function buildModelContextDigest(
  live: RuntimeV2LiveExecutionState,
): {
  readonly message: AgentMessage | null;
  readonly retained: number;
  readonly dropped: number;
  readonly chars: number;
} {
  if (live.modelContext.length === 0) {
    return { message: null, retained: 0, dropped: 0, chars: 0 };
  }
  const targetIndex = [...new Set(live.modelContext
    .map((entry) => entry.target)
    .filter(Boolean))]
    .slice(-32);
  const header = [
    "[runtime-v2 structured evidence digest]",
    "The approved WorkPlan is execution authority. Actual tool results and joined read-only child reports are evidence. Provider synthesis is labeled separately, remains untrusted, and cannot change lifecycle state.",
    "Re-read a target if exact bytes are no longer retained.",
    targetIndex.length > 0 ? `Known targets: ${targetIndex.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  const retained: RuntimeV2ModelContextEntry[] = [];
  let chars = header.length;
  for (let index = live.modelContext.length - 1; index >= 0; index -= 1) {
    const entry = live.modelContext[index]!;
    const section = renderContextEntry(entry);
    if (
      chars + section.length > MAX_CONTEXT_DIGEST_CHARS &&
      retained.length > 0
    ) {
      continue;
    }
    retained.unshift(entry);
    chars += section.length;
    if (chars >= MAX_CONTEXT_DIGEST_CHARS) break;
  }
  const body = retained.map(renderContextEntry).join("\n");
  const content = `${header}${body}`.slice(0, MAX_CONTEXT_DIGEST_CHARS);
  return {
    message: { role: "user", content },
    retained: retained.length,
    dropped: Math.max(0, live.modelContext.length - retained.length),
    chars: content.length,
  };
}

function renderContextEntry(entry: RuntimeV2ModelContextEntry): string {
  return [
    `\n[${entry.id}] ${entry.source}:${entry.label}`,
    `Target: ${entry.target || "workspace"}`,
    `Status: ${entry.status}`,
    entry.content,
  ].join("\n");
}

export function providerHistory(
  live: RuntimeV2LiveExecutionState,
  input: RuntimeV2ExecutionPortsInput,
): {
  readonly messages: AgentMessage[];
  readonly retained: number;
  readonly dropped: number;
  readonly chars: number;
} {
  const base = baseProviderHistory(live, input);
  const digest = buildModelContextDigest(live);
  return {
    messages: digest.message ? [...base, digest.message] : [...base],
    retained: digest.retained,
    dropped: digest.dropped,
    chars: base.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ) + digest.chars,
  };
}

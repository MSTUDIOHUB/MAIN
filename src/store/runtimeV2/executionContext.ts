import type { AgentMessage } from "../../lib/agentMessages";
import { deriveStreamSettings } from "../../lib/providerLaneSettings";
import { getToolTarget } from "../../lib/toolTarget";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import { executeTool } from "../../lib/toolExecutor";
import {
  buildToolCapabilityRegistry,
  getLocalFileReadPathForToolCall,
  getToolRiskLevelForCall,
  isLocalFileReadApproved,
  normalizeToolPermissionPolicy,
  type ToolCapabilityRegistry,
  type ToolPermissionPolicy,
} from "../../lib/toolCapabilities";
import { buildToolCatalog, type ToolCatalog } from "../../lib/toolCatalog";
import { shellPermissionPreflight, type ShellPermissionApproval } from "../../lib/ipc";
import { canApplyShellAutoReview, resolveShellAutoApproval } from "../../lib/shellAutoApproval";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import {
  DEFAULT_PROVIDER_LANE_PROFILE_V1,
  deriveRuntimeV2SubagentConcurrency,
  deriveRuntimeV2PlanSourceFreshness,
  normalizeRuntimeV2CheckpointMap,
  resolveRuntimeV2PlanMutationScope,
  resolveRuntimeV2PlanValidationScope,
  runtimeV2EvidenceVersion,
  scheduleReadOnlySubagents,
  type ProviderLaneProfileV1,
  type RuntimeV2Command,
  type RuntimeV2EvidenceReference,
  type RuntimeV2EventDraft,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2SubagentJob,
  type SchedulerPort,
  type ToolPort,
} from "../../lib/runtime-v2";
import {
  isRuntimeV2WorkspaceReadToolName,
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import { RUNTIME_V2_PLAN_ARTIFACT_PATH } from "../../lib/runtime-v2/workPlan";
import { resolveApprovedRuntimeV2WorkPlanFromAggregate } from "./workPlanAdapter";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

export type StoreGet = () => any;

const READ_ONLY_CHILD_TOOL_NAMES = new Set([
  "list_directory",
  "read_file",
  "grep_search",
  "get_file_outline",
  "code_ast_query",
  "find_symbol_references",
]);

const CHILD_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((definition) =>
  READ_ONLY_CHILD_TOOL_NAMES.has(definition.function.name),
);
const RUNTIME_V2_CHILD_DEADLINE_MS = 90_000;
const RUNTIME_V2_VALIDATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
]);
const RUNTIME_V2_CORE_TOOL_NAMES = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_search",
  "repo_map_context",
  "code_ast_query",
  "find_symbol_references",
  "read_file",
  "get_file_outline",
  "replace_in_file",
  "write_file",
  "apply_patch",
  "git_status",
  "git_diff",
  "run_command",
  "browser_evaluate",
  "get_project_skeleton",
]);
const RUNTIME_V2_MAX_CONTEXT_ENTRIES = 16;
const RUNTIME_V2_MAX_CONTEXT_ENTRY_CHARS = 5_000;
const RUNTIME_V2_MAX_PLAN_CONTEXT_CHARS = 16_000;
const RUNTIME_V2_MAX_CONTEXT_DIGEST_CHARS = 18_000;

interface RuntimeV2ModelContextEntry {
  readonly id: string;
  readonly source: "workspace" | "tool" | "subagent" | "provider" | "plan";
  readonly label: string;
  readonly target: string;
  readonly status: "succeeded" | "failed" | "blocked";
  readonly content: string;
}

export interface RuntimeV2LiveExecutionState {
  readonly messages: AgentMessage[];
  readonly modelContext: RuntimeV2ModelContextEntry[];
  readonly childRuns: Map<string, Promise<RuntimeV2ChildResult>>;
  readonly childAbortControllers: Map<string, AbortController>;
  readonly childTelemetry: Map<string, { firstTokenAt: number | null; closedAt: number | null }>;
  workspaceOverview: string;
  subagentCandidates: Array<{ scopeKey: string; objective: string; allowedPaths: string[] }>;
  evidenceCounter: number;
  latestProviderResult: RuntimeV2NormalizedProviderResult | null;
  latestVisibleText: string;
  lastProviderTransport: "native" | "text_envelope" | null;
  providerLaneProfile: ProviderLaneProfileV1 | null;
  authorization: RuntimeV2ExecutionAuthorization | null;
}

export interface RuntimeV2ExecutionAuthorization {
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly toolCatalog: ToolCatalog;
  readonly capabilityRegistry: ToolCapabilityRegistry;
  readonly policy: ToolPermissionPolicy;
}

export interface RuntimeV2ChildResult {
  readonly job: RuntimeV2SubagentJob;
  readonly status: "completed" | "failed" | "canceled";
  readonly summary: string;
  readonly evidenceTarget: string | null;
}

export interface RuntimeV2ExecutionPortsInput {
  readonly get: StoreGet;
  readonly context: RuntimeV2SubmissionContext;
  readonly live: RuntimeV2LiveExecutionState;
  readonly nextId: (scope: string) => string;
  readonly now: () => number;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

interface RuntimeV2ToolAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly allowExternalLocalRead: boolean;
  readonly shellPermissionApproval?: ShellPermissionApproval;
}

function stringValue(value: unknown, max = 24_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedToolContent(value: unknown, max = 12_000): string {
  const raw = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
  const text = String(raw || "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 80)}\n[Runtime v2 truncated this tool result for context safety.]`;
}

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
  const language = input.context.phaseLanguage === "en" ? "English" : "简体中文";
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
  const nativeTools = String(settings.toolProtocol || "auto").toLowerCase() !== "xml";
  return {
    ...DEFAULT_PROVIDER_LANE_PROFILE_V1,
    nativeTools,
    requiredToolChoice: false,
    textToolEnvelope: true,
  };
}

function runtimeToolDefinitions(state?: any): ToolDefinition[] {
  const includeNetwork = state?.webSearchEnabled === true;
  return TOOL_DEFINITIONS.filter((definition) => {
    const name = definition.function.name;
    return RUNTIME_V2_CORE_TOOL_NAMES.has(name) ||
      (includeNetwork && RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name));
  });
}

/** Freeze the built-in tool surface and policy for this Runtime v2 Turn.
 * Extensions stay on the legacy adapter until their own capability contract
 * is migrated; an unknown tool can therefore never bypass the catalog. */
export function createRuntimeV2ExecutionAuthorization(state: any): RuntimeV2ExecutionAuthorization {
  const toolDefinitions = runtimeToolDefinitions(state);
  const policy = normalizeToolPermissionPolicy(state?.config?.toolPermissionPolicy);
  const toolCatalog = buildToolCatalog({ builtInDefinitions: toolDefinitions });
  const capabilityRegistry = buildToolCapabilityRegistry({
    toolDefinitions,
    toolCatalog,
    policy,
  });
  return { toolDefinitions, toolCatalog, capabilityRegistry, policy };
}

function authorizationFor(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2ExecutionAuthorization {
  if (!input.live.authorization) {
    input.live.authorization = createRuntimeV2ExecutionAuthorization(input.get());
  }
  return input.live.authorization;
}

function approvedPlanForCurrentTurn(
  input: RuntimeV2ExecutionPortsInput,
) {
  return resolveApprovedRuntimeV2WorkPlanFromAggregate(
    aggregateForCurrentTurn(input),
  );
}

function aggregateForCurrentTurn(
  input: RuntimeV2ExecutionPortsInput,
) {
  const checkpoint = normalizeRuntimeV2CheckpointMap(
    input.get()?.runtimeV2Checkpoints,
  )[input.context.turnId];
  return checkpoint?.aggregate || null;
}

export function recordApprovedPlanContext(input: RuntimeV2ExecutionPortsInput): void {
  const approved = approvedPlanForCurrentTurn(input);
  if (!approved) return;
  const freshness = deriveRuntimeV2PlanSourceFreshness(
    aggregateForCurrentTurn(input)!,
  );
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
        ? RUNTIME_V2_MAX_PLAN_CONTEXT_CHARS
        : RUNTIME_V2_MAX_CONTEXT_ENTRY_CHARS,
    ),
  };
  const duplicate = live.modelContext.findIndex((candidate) =>
    candidate.source === normalized.source &&
    candidate.target === normalized.target &&
    candidate.content === normalized.content,
  );
  if (duplicate >= 0) live.modelContext.splice(duplicate, 1);
  live.modelContext.push(normalized);
  if (live.modelContext.length > RUNTIME_V2_MAX_CONTEXT_ENTRIES) {
    live.modelContext.splice(0, live.modelContext.length - RUNTIME_V2_MAX_CONTEXT_ENTRIES);
  }
}

function currentPhaseSuccessfulToolNames(
  input: RuntimeV2ExecutionPortsInput,
): readonly string[] {
  const aggregate = aggregateForCurrentTurn(input);
  if (!aggregate) return [];
  let phaseStart = -1;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      (event.type === "phase.changed" && event.phase === aggregate.phase) ||
      (event.type === "run.started" && event.phase === aggregate.phase)
    ) {
      phaseStart = index;
      break;
    }
  }
  const scheduledNames = new Map<string, string>();
  for (const event of aggregate.events.slice(phaseStart + 1)) {
    if (
      event.type === "command.scheduled" &&
      (event.command.kind === "execute_tool" ||
        event.command.kind === "execute_validation")
    ) {
      const name = event.command.payload.toolName;
      if (typeof name === "string" && name.trim()) {
        scheduledNames.set(event.command.idempotencyKey, name.trim());
      }
    }
  }
  return aggregate.events.slice(phaseStart + 1)
    .filter((event) =>
      event.type === "tool.completed" && event.status === "succeeded"
    )
    .map((event) =>
      event.type === "tool.completed"
        ? scheduledNames.get(event.idempotencyKey) || ""
        : ""
    )
    .filter(Boolean);
}

export function providerToolDefinitionsForCommand(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): ToolDefinition[] {
  const available = [...authorizationFor(input).toolDefinitions];
  const mode = String(command.payload.mode || "").trim();
  if (mode === "conclude") return [];
  if (mode === "analyze") {
    return available.filter((definition) =>
      isRuntimeV2WorkspaceReadToolName(definition.function.name)
    );
  }
  if (mode === "validate") {
    const approved = approvedPlanForCurrentTurn(input);
    const allowed = approved
      ? new Set(approved.plan.draft.validations.flatMap((validation) => {
          if (validation.kind === "finite_command") return ["run_command"];
          if (validation.kind === "browser") return ["browser_evaluate"];
          if (validation.kind === "desktop") return ["computer_use"];
          return [];
        }))
      : RUNTIME_V2_VALIDATION_TOOL_NAMES;
    return available.filter((definition) =>
      allowed.has(definition.function.name)
    );
  }
  const mutationOrRead = (definition: ToolDefinition) =>
    isWorkspaceMutationToolName(definition.function.name) ||
    RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(definition.function.name);
  if (mode === "execute") {
    const aggregate = aggregateForCurrentTurn(input);
    const approvedPlanNeedsFreshReads =
      aggregate?.strategy === "plan" &&
      aggregate.workPlan?.status === "approved" &&
      !aggregate.evidence.some((evidence) => evidence.kind === "mutation") &&
      deriveRuntimeV2PlanSourceFreshness(aggregate)?.allFresh === false;
    if (approvedPlanNeedsFreshReads) {
      return available.filter((definition) =>
        RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(definition.function.name)
      );
    }
    const focusedReadAlreadyUsed = currentPhaseSuccessfulToolNames(input)
      .some((name) => RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name));
    return available.filter((definition) =>
      focusedReadAlreadyUsed
        ? isWorkspaceMutationToolName(definition.function.name)
        : mutationOrRead(definition)
    );
  }
  if (mode === "observe") {
    const childEvidencePending = command.payload.childEvidencePending === true;
    return available.filter((definition) =>
      (!childEvidencePending && isWorkspaceMutationToolName(definition.function.name)) ||
      RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(definition.function.name) ||
      RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(definition.function.name)
    );
  }
  return available.filter(mutationOrRead);
}

export function compactTextEnvelopeCatalog(tools: readonly ToolDefinition[]): string {
  const entries = tools.map((definition) => ({
    name: definition.function.name,
    required: definition.function.parameters.required,
    properties: Object.fromEntries(
      Object.entries(definition.function.parameters.properties).map(
        ([name, schema]) => [
          name,
          {
            type: schema.type,
            ...(schema.enum ? { enum: schema.enum } : {}),
          },
        ],
      ),
    ),
  }));
  return [
    "[runtime-v2 allowed tool catalog]",
    JSON.stringify(entries),
  ].join("\n").slice(0, 12_000);
}

function validateToolAgainstPhaseAndPlan(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly failureKind: "not_authorized" | "protocol_invalid" | null;
  readonly reasonCode: string | null;
} {
  if (
    input.command.kind === "execute_tool" &&
    RUNTIME_V2_VALIDATION_TOOL_NAMES.has(input.toolName)
  ) {
    return {
      allowed: false,
      reason: "有限验证只能在验证阶段执行；当前应先提交计划内的最小修改。",
      failureKind: "protocol_invalid",
      reasonCode: "validation_phase_required",
    };
  }

  const aggregate = aggregateForCurrentTurn(input.ports);
  if (
    aggregate?.strategy === "analyze" &&
    (
      !isRuntimeV2WorkspaceReadToolName(input.toolName) ||
      input.command.kind === "execute_validation"
    )
  ) {
    return {
      allowed: false,
      reason: "工作区只读任务没有修改或验证效果权限。",
      failureKind: "not_authorized",
      reasonCode: "workspace_read_only_authority",
    };
  }
  if (
    input.command.phase === "observing" &&
    isWorkspaceMutationToolName(input.toolName) &&
    aggregate?.subagents.some((job) =>
      job.status === "queued" || job.status === "running"
    )
  ) {
    return {
      allowed: false,
      reason: "并行只读调查尚未汇合；当前修改调用已拒绝，先消费已调度的子智能体证据。",
      failureKind: "protocol_invalid",
      reasonCode: "subagent_join_required_before_mutation",
    };
  }
  if (aggregate?.strategy !== "plan") {
    return { allowed: true, reason: null, failureKind: null, reasonCode: null };
  }
  const approved = resolveApprovedRuntimeV2WorkPlanFromAggregate(aggregate);
  if (!approved) {
    return {
      allowed: false,
      reason: "当前 Plan 的批准权威无效或已过期，运行时拒绝执行外部效果。",
      failureKind: "not_authorized",
      reasonCode: "approved_plan_authority_missing",
    };
  }
  if (isWorkspaceMutationToolName(input.toolName)) {
    const freshness = deriveRuntimeV2PlanSourceFreshness(aggregate);
    const mutationAlreadyCommitted = aggregate.evidence.some(
      (evidence) => evidence.kind === "mutation",
    );
    if (!mutationAlreadyCommitted && freshness && !freshness.allFresh) {
      const stale = [...freshness.staleTargets, ...freshness.unversionedTargets];
      return stale.length > 0
        ? {
            allowed: false,
            reason: `已批准 WorkPlan 的源版本已变化或缺少版本权威：${stale.join(", ")}`,
            failureKind: "not_authorized",
            reasonCode: "approved_plan_source_version_stale",
          }
        : {
            allowed: false,
            reason: `执行已批准 WorkPlan 前必须重新读取当前目标：${freshness.missingTargets.join(", ")}`,
            failureKind: "protocol_invalid",
            reasonCode: "approved_plan_source_refresh_required",
          };
    }
    const scope = resolveRuntimeV2PlanMutationScope({
      plan: approved.plan,
      requestedTargets: resolveWorkspaceMutationTargets(
        input.toolName,
        input.args,
        input.target,
      ),
    });
    if (!scope.allowed) {
      return {
        allowed: false,
        reason: `修改目标不在已批准 WorkPlan 范围内：${scope.unexpectedTargets.join(", ") || "未解析目标"}`,
        failureKind: "not_authorized",
        reasonCode: "approved_plan_mutation_scope",
      };
    }
  }
  if (input.command.kind === "execute_validation") {
    const scope = resolveRuntimeV2PlanValidationScope({
      plan: approved.plan,
      toolName: input.toolName,
      args: input.args,
    });
    if (!scope.allowed) {
      return {
        allowed: false,
        reason: "该验证调用与已批准 WorkPlan 中的命令或验证类型不一致。",
        failureKind: "not_authorized",
        reasonCode: "approved_plan_validation_scope",
      };
    }
  }
  return { allowed: true, reason: null, failureKind: null, reasonCode: null };
}

async function authorizeToolForCurrentTurn(
  input: RuntimeV2ExecutionPortsInput,
  name: string,
  args: Record<string, unknown>,
): Promise<RuntimeV2ToolAuthorizationResult> {
  const state = input.get();
  const authorization = authorizationFor(input);
  const catalogResolution = authorization.toolCatalog.lookup(name);
  if (catalogResolution.status !== "resolved" || catalogResolution.entry.source !== "built_in") {
    return { allowed: false, reason: `当前 Runtime v2 未暴露工具 ${name}。`, allowExternalLocalRead: false };
  }
  const risk = getToolRiskLevelForCall(name, args, authorization.capabilityRegistry, {
    workspace: input.context.runWorkspace,
    approvedLocalFileReadPaths: state.approvedLocalFileReadPaths,
  });
  const capability = authorization.capabilityRegistry.tools[name];
  if (!capability?.enabled || authorization.policy.disabledRiskLevels.includes(risk)) {
    return { allowed: false, reason: `工具 ${name} 的 ${risk} 权限已被当前策略禁用。`, allowExternalLocalRead: false };
  }
  if (risk === "read_only") return { allowed: true, reason: null, allowExternalLocalRead: false };
  if (risk === "external_read") {
    const networkTool = name === "web_search" || name === "web_fetch";
    return networkTool && state.webSearchEnabled !== true
      ? { allowed: false, reason: "当前会话未启用网络访问。", allowExternalLocalRead: false }
      : { allowed: true, reason: null, allowExternalLocalRead: false };
  }
  if (risk === "local_file_read") {
    const path = getLocalFileReadPathForToolCall(name, args, input.context.runWorkspace);
    const approved = !!path && isLocalFileReadApproved(path, state.approvedLocalFileReadPaths);
    return approved
      ? { allowed: true, reason: null, allowExternalLocalRead: true }
      : { allowed: false, reason: "读取工作区外本地文件需要用户明确授权。", allowExternalLocalRead: false };
  }
  const consent = state.currentTurnExecutionConsent;
  if (consent?.turnId !== input.context.turnId || consent.granted !== true) {
    return { allowed: false, reason: `执行 ${risk} 工具前需要本轮执行授权。`, allowExternalLocalRead: false };
  }
  if (risk === "workspace_write") {
    return { allowed: true, reason: null, allowExternalLocalRead: false };
  }
  if (risk === "shell") {
    const shell = await resolveShellAutoApproval({
      toolName: name,
      args,
      workspace: input.context.runWorkspace || "",
      preflight: shellPermissionPreflight,
    });
    if (!canApplyShellAutoReview(shell)) {
      return {
        allowed: false,
        reason: shell.error || "该 Shell 命令需要单独审批，未执行。",
        allowExternalLocalRead: false,
      };
    }
    return {
      allowed: true,
      reason: null,
      allowExternalLocalRead: false,
      ...(shell.approval ? { shellPermissionApproval: shell.approval } : {}),
    };
  }
  return { allowed: false, reason: `Runtime v2 不会自动执行 ${risk} 工具。`, allowExternalLocalRead: false };
}

function baseProviderHistory(live: RuntimeV2LiveExecutionState, input: RuntimeV2ExecutionPortsInput): AgentMessage[] {
  if (live.messages.length > 0) return live.messages;
  const turn = input.get().conversationTurns?.find((candidate: any) => candidate.id === input.context.turnId);
  live.messages.push(
    { role: "system", content: systemInstruction(input) },
    { role: "user", content: String(turn?.userPrompt || "").trim().slice(0, 12_000) || "请处理当前任务。" },
  );
  return live.messages;
}

function buildModelContextDigest(
  live: RuntimeV2LiveExecutionState,
): { readonly message: AgentMessage | null; readonly retained: number; readonly dropped: number; readonly chars: number } {
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
    const section = [
      `\n[${entry.id}] ${entry.source}:${entry.label}`,
      `Target: ${entry.target || "workspace"}`,
      `Status: ${entry.status}`,
      entry.content,
    ].join("\n");
    if (chars + section.length > RUNTIME_V2_MAX_CONTEXT_DIGEST_CHARS && retained.length > 0) continue;
    retained.unshift(entry);
    chars += section.length;
    if (chars >= RUNTIME_V2_MAX_CONTEXT_DIGEST_CHARS) break;
  }
  const body = retained.map((entry) => [
    `\n[${entry.id}] ${entry.source}:${entry.label}`,
    `Target: ${entry.target || "workspace"}`,
    `Status: ${entry.status}`,
    entry.content,
  ].join("\n")).join("\n");
  const content = `${header}${body}`.slice(0, RUNTIME_V2_MAX_CONTEXT_DIGEST_CHARS);
  return {
    message: { role: "user", content },
    retained: retained.length,
    dropped: Math.max(0, live.modelContext.length - retained.length),
    chars: content.length,
  };
}

export function providerHistory(
  live: RuntimeV2LiveExecutionState,
  input: RuntimeV2ExecutionPortsInput,
): { readonly messages: AgentMessage[]; readonly retained: number; readonly dropped: number; readonly chars: number } {
  const base = baseProviderHistory(live, input);
  const digest = buildModelContextDigest(live);
  return {
    messages: digest.message ? [...base, digest.message] : [...base],
    retained: digest.retained,
    dropped: digest.dropped,
    chars: base.reduce((total, message) => total + String(message.content || "").length, 0) + digest.chars,
  };
}

function childScopeAllows(job: RuntimeV2SubagentJob, args: Record<string, unknown>): boolean {
  const candidate = stringValue(args.path || args.file_path || args.cwd || "", 2_000)
    .replace(/^\.\//, "")
    .replace(/\\/g, "/");
  if (!candidate || candidate === "." || candidate.startsWith("/") || candidate.startsWith("../")) return false;
  return job.allowedPaths.some((root) => candidate === root || candidate.startsWith(`${root.replace(/\/$/, "")}/`));
}

function deriveSubagentCandidates(overview: string, objective: string): Array<{ scopeKey: string; objective: string; allowedPaths: string[] }> {
  const source = String(overview || "").replace(/\\/g, "/");
  const candidates: Array<{ scopeKey: string; objective: string; allowedPaths: string[] }> = [];
  const add = (scopeKey: string, allowedPath: string, description: string) => {
    if (candidates.some((candidate) => candidate.scopeKey === scopeKey)) return;
    candidates.push({
      scopeKey,
      objective: `${description}。围绕用户目标：${objective.slice(0, 600)}`,
      allowedPaths: [allowedPath],
    });
  };
  if (/(?:^|[\s\[\/])src(?:[\]\s/]|$)/m.test(source)) {
    add("frontend", "src", "调查前端实现、事件消费与交互路径");
  }
  if (/(?:^|[\s\[\/])src-tauri(?:[\]\s/]|$)/m.test(source)) {
    add("backend", "src-tauri", "调查桌面后端、文件对话框与 IPC 路径");
  }
  return candidates.slice(0, 2);
}

function nextEvidenceId(live: RuntimeV2LiveExecutionState): string {
  live.evidenceCounter += 1;
  return `E${live.evidenceCounter}`;
}

function recordToolModelContext(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly target: string;
  readonly status: "succeeded" | "failed" | "blocked";
  readonly content: string;
}): void {
  recordModelContext(input.ports.live, {
    id: `tool-result:${String(input.command.payload.toolCallId || input.ports.nextId("tool-context"))}`,
    source: "tool",
    label: input.toolName || "unknown_tool",
    target: input.target || input.toolName || "workspace",
    status: input.status,
    content: input.content,
  });
}

function toolDefinitionExists(input: RuntimeV2ExecutionPortsInput, name: string): boolean {
  const resolution = authorizationFor(input).toolCatalog.lookup(name);
  return resolution.status === "resolved" && resolution.entry.source === "built_in";
}

function toolResultEvent(
  command: RuntimeV2Command,
  status: "succeeded" | "failed" | "blocked",
  evidence: RuntimeV2EvidenceReference[],
): RuntimeV2EventDraft {
  return {
    type: "tool.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    status,
    evidence,
  };
}

function validationResultEvent(
  command: RuntimeV2Command,
  passed: boolean,
  evidence: Array<{ id: string; kind: "validation"; target: string; version: string | null }>,
  failureKind?: Extract<RuntimeV2EventDraft, { type: "validation.completed" }>["failureKind"],
): RuntimeV2EventDraft {
  return {
    type: "validation.completed",
    run: command.run,
    idempotencyKey: command.idempotencyKey,
    passed,
    evidence,
    ...(!passed && failureKind ? { failureKind } : {}),
  };
}

function parseResultRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isValidationPassed(toolName: string, output: unknown): boolean {
  const result = parseResultRecord(output);
  if (!result) return false;
  if (result.timedOut === true || result.timeout === true || result.error) return false;
  if (typeof result.exitCode === "number") return result.exitCode === 0;
  if (typeof result.exit_code === "number") return result.exit_code === 0;
  if (typeof result.exitCodeAfter === "number") return result.exitCodeAfter === 0;
  if (result.passed === true || result.success === true || result.ok === true) return true;
  // PTY dispatch only confirms that input was accepted; it does not establish
  // a completed validation process and must not close acceptance.
  if (/^(?:run_command|execute_command)$/i.test(toolName)) return false;
  return false;
}

function toolCompletionFor(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
  toolName: string,
  args: Record<string, unknown>,
  target: string,
  output: unknown,
  status: "succeeded" | "failed" | "blocked",
  failureKind?: Extract<RuntimeV2EventDraft, { type: "validation.completed" }>["failureKind"],
): RuntimeV2EventDraft {
  if (command.kind !== "execute_validation") {
    const targets = isWorkspaceMutationToolName(toolName)
      ? resolveWorkspaceMutationTargets(toolName, args, target)
      : [target || toolName];
    const evidenceKind = isWorkspaceMutationToolName(toolName)
      ? "mutation" as const
      : RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(toolName)
        ? "source" as const
        : "tool" as const;
    return toolResultEvent(command, status, status === "succeeded"
      ? targets.map((resolvedTarget) => ({
          id: nextEvidenceId(input.live),
          kind: evidenceKind,
          target: resolvedTarget,
          version: evidenceKind === "source"
            ? runtimeV2EvidenceVersion(output)
            : null,
        }))
      : []);
  }
  const passed = status === "succeeded" && isValidationPassed(toolName, output);
  return validationResultEvent(command, passed, passed
    ? [{ id: nextEvidenceId(input.live), kind: "validation", target: target || toolName, version: null }]
    : [], passed
      ? undefined
      : failureKind || (status === "succeeded" ? "assertion_failed" : "execution_failed"));
}

export function createRuntimeV2ToolPort(
  input: RuntimeV2ExecutionPortsInput,
): ToolPort {
  return {
    async execute({ command }) {
      if (command.kind === "collect_observation") {
        input.logStoreEvent("runtime_v2_tool_execution_started", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName: "get_project_skeleton",
          target: input.context.runWorkspace || "workspace",
        });
        try {
          const overview = boundedToolContent(await executeTool(
            "get_project_skeleton",
            {},
            input.context.runWorkspace || "",
            input.context.runSessionKey,
            { toolCatalog: authorizationFor(input).toolCatalog },
          ), 12_000);
          input.live.workspaceOverview = overview;
          input.live.subagentCandidates = deriveSubagentCandidates(
            overview,
            String(command.payload.objective || ""),
          );
          const evidenceId = nextEvidenceId(input.live);
          recordModelContext(input.live, {
            id: evidenceId,
            source: "workspace",
            label: "workspace_overview",
            target: input.context.runWorkspace || "workspace",
            status: "succeeded",
            content: overview,
          });
          input.logStoreEvent("runtime_v2_tool_execution_completed", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            commandKind: command.kind,
            toolName: "get_project_skeleton",
            target: input.context.runWorkspace || "workspace",
            status: "succeeded",
            discoveredSubagentScopes: input.live.subagentCandidates.map((candidate) => candidate.scopeKey),
          });
          return {
            type: "observation.recorded",
            run: command.run,
            evidence: {
              id: evidenceId,
              kind: "source",
              target: input.context.runWorkspace || "workspace",
              version: null,
            },
          };
        } catch (error) {
          input.logStoreEvent("runtime_v2_tool_execution_failed", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            commandKind: command.kind,
            toolName: "get_project_skeleton",
            target: input.context.runWorkspace || "workspace",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }

      if (command.kind !== "execute_tool" && command.kind !== "execute_validation") {
        throw new Error(`Unsupported Runtime v2 tool command: ${command.kind}`);
      }
      const toolName = stringValue(command.payload.toolName, 256);
      const args = command.payload.arguments && typeof command.payload.arguments === "object" && !Array.isArray(command.payload.arguments)
        ? command.payload.arguments as Record<string, unknown>
        : {};
      const target = getToolTarget(toolName, args);
      input.logStoreEvent("runtime_v2_tool_execution_started", {
        turnId: command.run.turnId,
        runId: command.run.runId,
        commandKind: command.kind,
        toolName,
        target: target || null,
      });
      if (!toolDefinitionExists(input, toolName)) {
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target,
          status: "failed",
          content: `UNKNOWN_TOOL: ${toolName}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: "unknown_tool",
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          null,
          "failed",
          "protocol_invalid",
        );
      }
      if (command.kind === "execute_validation" && !RUNTIME_V2_VALIDATION_TOOL_NAMES.has(toolName)) {
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target,
          status: "failed",
          content: `VALIDATION_TOOL_REJECTED: ${toolName}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: "validation_tool_required",
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          null,
          "failed",
          "protocol_invalid",
        );
      }
      const phaseAndPlan = validateToolAgainstPhaseAndPlan({
        ports: input,
        command,
        toolName,
        args,
        target,
      });
      if (!phaseAndPlan.allowed) {
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target,
          status: "blocked",
          content: `TOOL_BLOCKED: ${phaseAndPlan.reason}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_blocked", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: phaseAndPlan.reasonCode,
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          null,
          "blocked",
          phaseAndPlan.failureKind || "not_authorized",
        );
      }
      const authorization = await authorizeToolForCurrentTurn(input, toolName, args);
      if (!authorization.allowed) {
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target,
          status: "blocked",
          content: `TOOL_BLOCKED: ${authorization.reason || `${toolName} is not authorized for this Turn.`}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_blocked", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: authorization.reason || "authorization_required",
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          null,
          "blocked",
          "not_authorized",
        );
      }
      try {
        const rawOutput = await executeTool(
          toolName,
          args,
          input.context.runWorkspace || "",
          input.context.runSessionKey,
          {
            toolCatalog: authorizationFor(input).toolCatalog,
            allowExternalLocalRead: authorization.allowExternalLocalRead,
            ...(authorization.shellPermissionApproval
              ? { shellPermissionApproval: authorization.shellPermissionApproval }
              : {}),
          },
        );
        const output = boundedToolContent(rawOutput);
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target,
          status: "succeeded",
          content: output,
        });
        const completion = toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          rawOutput,
          "succeeded",
        );
        input.logStoreEvent("runtime_v2_tool_execution_completed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          status: completion.type === "validation.completed" && !completion.passed ? "failed" : "succeeded",
          mutationCommitted: isWorkspaceMutationToolName(toolName),
          validationPassed: completion.type === "validation.completed" ? completion.passed : null,
        });
        return completion;
      } catch (error) {
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target,
          status: "failed",
          content: `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_failed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          error: error instanceof Error ? error.message : String(error),
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          null,
          "failed",
          "execution_failed",
        );
      }
    },
  };
}

async function runReadOnlyChild(input: {
  job: RuntimeV2SubagentJob;
  ports: RuntimeV2ExecutionPortsInput;
  signal: AbortSignal;
}): Promise<RuntimeV2ChildResult> {
  const telemetry = input.ports.live.childTelemetry.get(input.job.id);
  const language = input.ports.context.phaseLanguage === "en" ? "English" : "简体中文";
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: [
        "You are a read-only child investigator in MAIN Runtime v2.",
        `Scope key: ${input.job.scopeKey}`,
        `Allowed paths: ${input.job.allowedPaths.join(", ")}`,
        "Use only provided read/search tools. Never write files, run shell commands, ask for approval, or address the end user.",
        `Return a concise evidence report in ${language}, with exact paths and uncertainty.`,
      ].join("\n"),
    },
    { role: "user", content: input.job.objective },
  ];
  try {
    let finalText = "";
    const observedTargets: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      const result = await streamChatCompletion(
        messages,
        deriveStreamSettings(input.ports.get().config),
        {
          onToken: () => {
            if (telemetry && telemetry.firstTokenAt === null) telemetry.firstTokenAt = input.ports.now();
          },
          onDone: () => undefined,
          onError: () => undefined,
        },
        input.signal,
        CHILD_TOOL_DEFINITIONS,
        undefined,
        { toolChoice: "auto" },
      );
      finalText = sanitizeAssistantDisplayContent(result.content || "").trim();
      messages.push({
        role: "assistant",
        content: result.content || "",
        ...(result.toolCalls.length > 0
          ? {
              tool_calls: result.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
      if (result.toolCalls.length === 0) break;
      for (const call of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        } catch {
          // The structured tool result below instructs the child to repair its
          // own argument shape without widening its scope.
        }
        const allowed = READ_ONLY_CHILD_TOOL_NAMES.has(call.name) && childScopeAllows(input.job, args);
        if (!allowed) {
          messages.push({ role: "tool", tool_call_id: call.id, content: "CHILD_SCOPE_BLOCKED: use an allowed read-only path." });
          continue;
        }
        try {
          const target = getToolTarget(call.name, args);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: boundedToolContent(await executeTool(
              call.name,
              args,
              input.ports.context.runWorkspace || "",
              input.ports.context.runSessionKey,
              { toolCatalog: authorizationFor(input.ports).toolCatalog },
            ), 8_000),
          });
          if (target) observedTargets.push(target);
        } catch (error) {
          messages.push({ role: "tool", tool_call_id: call.id, content: `CHILD_TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      // A tool-containing final round is not a report. Give the child one
      // bounded, tool-free chance to synthesize the evidence it just read.
      if (round === 3) {
        finalText = "子智能体达到只读调查轮次上限；已提交读取结果，未生成可确认摘要。";
      }
    }
    if (telemetry) telemetry.closedAt = input.ports.now();
    if (input.signal.aborted) {
      return {
        job: input.job,
        status: "canceled",
        summary: "子智能体已因父任务停止或超时而结束。",
        evidenceTarget: observedTargets[0] || null,
      };
    }
    return {
      job: input.job,
      status: "completed",
      summary: finalText.slice(0, 4_000) || "子智能体未返回可展示摘要，但已结束只读调查。",
      evidenceTarget: observedTargets[0] || null,
    };
  } catch (error) {
    if (telemetry) telemetry.closedAt = input.ports.now();
    return {
      job: input.job,
      status: input.signal.aborted ? "canceled" : "failed",
      summary: input.signal.aborted
        ? "子智能体已因父任务停止或超时而结束。"
        : `只读调查失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
      evidenceTarget: null,
    };
  }
}

function startReadOnlyChild(
  input: RuntimeV2ExecutionPortsInput,
  job: RuntimeV2SubagentJob,
  parentSignal: AbortSignal,
): Promise<RuntimeV2ChildResult> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  input.live.childAbortControllers.set(job.id, controller);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<RuntimeV2ChildResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(new Error("Runtime v2 child deadline exceeded."));
      const telemetry = input.live.childTelemetry.get(job.id);
      if (telemetry && telemetry.closedAt === null) telemetry.closedAt = input.now();
      resolve({
        job,
        status: "failed",
        summary: "子智能体超过 90 秒只读调查时限，已停止并保留此前可用结果。",
        evidenceTarget: null,
      });
    }, RUNTIME_V2_CHILD_DEADLINE_MS);
  });
  const run = runReadOnlyChild({ job, ports: input, signal: controller.signal });
  return Promise.race([run, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    parentSignal.removeEventListener("abort", abortFromParent);
    input.live.childAbortControllers.delete(job.id);
  });
}

export function createRuntimeV2SchedulerPort(
  input: RuntimeV2ExecutionPortsInput,
): SchedulerPort {
  return {
    async prepareSchedule({ command }) {
      if (command.kind !== "schedule_subagents") return null;
      const decision = scheduleReadOnlySubagents({
        parentRun: command.run,
        candidates: input.live.subagentCandidates,
        requestedAt: input.now(),
        nextId: input.nextId,
      });
      if (decision.jobs.length !== 2) {
        throw new Error("Runtime v2 requires two disjoint read-only child scopes before scheduling collaboration.");
      }
      return {
        type: "subagents.scheduled",
        run: command.run,
        jobs: decision.jobs,
      };
    },
    async execute({ command, signal, scheduledSubagents }) {
      if (command.kind === "schedule_subagents") {
        const jobs = (scheduledSubagents || []).filter((job) =>
          job.status === "queued" || job.status === "running"
        );
        if (jobs.length !== 2) {
          throw new Error("Runtime v2 scheduler can only start or resume the two child jobs already committed in its ledger.");
        }
        const events: RuntimeV2EventDraft[] = [];
        input.logStoreEvent("runtime_v2_subagent_batch_starting", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          jobCount: jobs.length,
          scopes: jobs.map((job) => job.scopeKey),
          concurrent: jobs.length === 2,
          resumed: jobs.some((job) => job.status === "running"),
        });
        for (const job of jobs) {
          if (!input.live.childRuns.has(job.id)) {
            input.live.childTelemetry.set(job.id, {
              firstTokenAt: job.firstTokenAt,
              closedAt: job.closedAt,
            });
            input.live.childRuns.set(job.id, startReadOnlyChild(input, job, signal));
          }
          if (job.status === "queued") {
            input.logStoreEvent("runtime_v2_subagent_request_opened", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              jobId: job.id,
              scopeKey: job.scopeKey,
              allowedPaths: job.allowedPaths,
            });
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: { jobId: job.id, phase: "request_opened", at: input.now() },
            });
          } else {
            input.logStoreEvent("runtime_v2_subagent_request_resumed", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              jobId: job.id,
              scopeKey: job.scopeKey,
            });
          }
        }
        return events;
      }
      if (command.kind === "join_subagents") {
        const jobIds = Array.isArray(command.payload.jobIds)
          ? command.payload.jobIds.map((value) => String(value || "")).filter(Boolean)
          : [];
        const results = await Promise.all(jobIds.map(async (jobId) => {
          const promise = input.live.childRuns.get(jobId);
          if (promise) return await promise;
          const job = (scheduledSubagents || []).find((candidate) => candidate.id === jobId);
          return job
            ? {
                job,
                status: "failed" as const,
                summary: "子智能体请求在进程重启后无法继续；已结束该只读子任务并保留父任务证据。",
                evidenceTarget: null,
              }
            : null;
        }));
        const events: RuntimeV2EventDraft[] = [];
        const observedJobs: RuntimeV2SubagentJob[] = [];
        for (const result of results) {
          if (!result) continue;
          const committedJob = (scheduledSubagents || []).find((job) => job.id === result.job.id);
          const telemetry = input.live.childTelemetry.get(result.job.id);
          if (committedJob?.status === "queued") {
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: { jobId: result.job.id, phase: "request_opened", at: input.now() },
            });
          }
          if (telemetry && telemetry.firstTokenAt !== null) {
            events.push({
              type: "subagent.telemetry",
              run: command.run,
              telemetry: { jobId: result.job.id, phase: "first_token", at: telemetry.firstTokenAt },
            });
          }
          events.push({
            type: "subagent.telemetry",
            run: command.run,
            telemetry: { jobId: result.job.id, phase: "closed", at: telemetry?.closedAt || input.now() },
          });
          events.push({
            type: "subagent.completed",
            run: command.run,
            jobId: result.job.id,
            status: result.status,
            summary: result.summary,
            evidence: result.status === "completed" && result.evidenceTarget
              ? [{ id: nextEvidenceId(input.live), kind: "subagent", target: result.evidenceTarget, version: null }]
              : [],
          });
          observedJobs.push({
            ...result.job,
            status: result.status,
            firstTokenAt: telemetry?.firstTokenAt || null,
            closedAt: telemetry?.closedAt || input.now(),
            summary: result.summary,
          });
          // This enters only the parent model's evidence context. The UI
          // projection remains a concise structured milestone, so a child's
          // untrusted prose never becomes a duplicate ChatArea narration.
          recordModelContext(input.live, {
            id: `child:${result.job.id}`,
            source: "subagent",
            label: result.job.scopeKey,
            target: result.evidenceTarget || result.job.allowedPaths.join(", "),
            status: result.status === "completed" ? "succeeded" : "failed",
            content: [
              `Scope: ${result.job.scopeKey} (${result.job.allowedPaths.join(", ")})`,
              `Status: ${result.status}`,
              `Report: ${result.summary.slice(0, 4_000)}`,
            ].join("\n"),
          });
          input.logStoreEvent("runtime_v2_subagent_joined", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            jobId: result.job.id,
            status: result.status,
            firstTokenAt: telemetry?.firstTokenAt || null,
            closedAt: telemetry?.closedAt || null,
            evidenceTarget: result.evidenceTarget,
          });
        }
        const concurrency = deriveRuntimeV2SubagentConcurrency(observedJobs);
        input.logStoreEvent("runtime_v2_subagent_batch_joined", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          jobCount: observedJobs.length,
          peakInFlight: concurrency.peakInFlight,
          hasRequestOverlap: concurrency.hasRequestOverlap,
        });
        return events;
      }
      throw new Error(`Unsupported Runtime v2 scheduler command: ${command.kind}`);
    },
  };
}

export function createRuntimeV2LiveExecutionState(): RuntimeV2LiveExecutionState {
  return {
    messages: [],
    modelContext: [],
    childRuns: new Map(),
    childAbortControllers: new Map(),
    childTelemetry: new Map(),
    workspaceOverview: "",
    subagentCandidates: [],
    evidenceCounter: 0,
    latestProviderResult: null,
    latestVisibleText: "",
    lastProviderTransport: null,
    providerLaneProfile: null,
    authorization: null,
  };
}

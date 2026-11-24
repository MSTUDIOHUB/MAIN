import { normalizeCloudProtocol, normalizeLocalToolProtocol, resolveEffectiveCloudApiFormat } from "./cloudProtocol";
import { resolveJsonObjectOutputOptions, streamChatCompletion, type StreamResult, type StreamSettings } from "./streaming";
import {
  getIntentPolicy,
  type IntentPreflightResult,
  type PlanContinuationCandidate,
  type PlanContinuationDecision,
  type ResolvedUserIntent,
  type SemanticTaskIntent,
  type CommandDirectiveKind,
} from "./runIntent";
import type { MainModeKey } from "./mainModes";
import type { AppConfig } from "./appTypes";
import { normalizeConversationDisplayTitle } from "./workflowModels";
import { shouldUseRustProxyForLocalProvider } from "./localProviderRouting";
import { TURN_CAPABILITIES, type SemanticCapability } from "./turnCapabilities";
import { normalizeTurnClarification } from "./turnClarification";

type PreflightConfig = Pick<AppConfig, "activeProfile" | "local" | "cloud" | "cloudExperimentalLoginEnabled">;
type DiagnosticField = "result" | "semantic" | "semantic.objective" | "semantic.workType" | "semantic.answerFormat" |
  "semantic.requiredCapabilities" | "semantic.forbiddenCapabilities" | "semantic.approvalRequiredCapabilities" | "planContinuation" | "confidence" | "needsUserChoice" | "question" |
  "settings.baseUrl" | "settings.model";
const DIAGNOSTIC_FINISH_REASONS = ["stop", "length", "tool_calls", "function_call", "content_filter"] as const;

export interface IntentPreflightDiagnostic {
  readonly code: "unavailable" | "cancelled" | "transport_error" | "stream_error" | "incomplete_output" |
    "client_output_limited" | "protocol_violation" | "unexpected_tool_calls" | "invalid_json" | "invalid_result";
  readonly field?: DiagnosticField;
  readonly finishReason?: typeof DIAGNOSTIC_FINISH_REASONS[number] | "unknown" | null;
  readonly contentChars?: number;
}

function deriveStreamSettings(config: PreflightConfig): StreamSettings {
  if (config.activeProfile === "local") {
    return {
      baseUrl: config.local.endpoint,
      apiKey: config.local.apiKey || "not-needed",
      model: config.local.model,
      sendSamplingParameters: true,
      temperature: 0.1,
      contextLimit: config.local.contextLimit,
      provider: config.local.provider,
      toolProtocol: normalizeLocalToolProtocol(config.local.toolProtocol, config.local.provider),
      reasoningRequest: "off",
      // LM Studio / OMLX 的本地请求也走 Tauri 后端，避免 WebView 的
      // “Load Failed” 网络错误；Ollama /v1 也走后端代理。
      useRustProxy: shouldUseRustProxyForLocalProvider(config.local.provider, config.local.endpoint),
    };
  }
  const cloudAuthMode = config.cloudExperimentalLoginEnabled === true ? config.cloud.auth?.mode ?? "api_key" : "api_key";
  return {
    baseUrl: config.cloud.endpoint || "https://api.openai.com/v1",
    apiKey: config.cloud.apiKey,
    model: config.cloud.model,
    apiProtocol: normalizeCloudProtocol(config.cloud.protocol || "openai"),
    apiFormat: resolveEffectiveCloudApiFormat({
      protocol: config.cloud.protocol || "openai",
      apiFormat: config.cloud.apiFormat || "chat_completions",
      authMode: cloudAuthMode,
    }),
    authMode: cloudAuthMode,
    tokenRef: config.cloudExperimentalLoginEnabled === true ? config.cloud.auth?.tokenRef : undefined,
    customHeaders: config.cloud.customHeaders || "",
    disableResponseStorage: config.cloud.disableResponseStorage ?? true,
    reasoningEffort: "none",
    toolProtocol: config.cloud.toolProtocol,
    contextLimit: undefined,
    provider: config.cloud.provider,
    useRustProxy: true,
  };
}

function normalizeCapabilities(value: unknown): SemanticCapability[] | null {
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== "string" || !(TURN_CAPABILITIES as readonly string[]).includes(entry)
  )) return null;
  return [...new Set(value)] as SemanticCapability[];
}

function normalizeSemanticIntent(raw: unknown, onInvalid?: (field: DiagnosticField) => void): SemanticTaskIntent | null {
  const invalid = (field: DiagnosticField) => { onInvalid?.(field); return null; };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("semantic");
  const value = raw as Record<string, unknown>;
  if (typeof value.objective !== "string" || !value.objective.trim()) return invalid("semantic.objective");
  if (!["answer", "investigate", "implement", "operate", "plan"].includes(value.workType as string)) return invalid("semantic.workType");
  if (!["answer", "analysis", "summary", "report", "plan"].includes(value.answerFormat as string)) return invalid("semantic.answerFormat");
  const requiredCapabilities = normalizeCapabilities(value.requiredCapabilities);
  const forbiddenCapabilities = normalizeCapabilities(value.forbiddenCapabilities);
  const approvalRequiredCapabilities = normalizeCapabilities(value.approvalRequiredCapabilities);
  if (!requiredCapabilities) return invalid("semantic.requiredCapabilities");
  if (!forbiddenCapabilities) return invalid("semantic.forbiddenCapabilities");
  if (!approvalRequiredCapabilities) return invalid("semantic.approvalRequiredCapabilities");
  return {
    objective: value.objective.trim(),
    workType: value.workType as SemanticTaskIntent["workType"],
    answerFormat: value.answerFormat as SemanticTaskIntent["answerFormat"],
    requiredCapabilities,
    forbiddenCapabilities,
    approvalRequiredCapabilities,
  };
}

function deriveSemanticIntent(semantic: SemanticTaskIntent): ResolvedUserIntent {
  // A capability-free natural plan is discussion; explicit Plan is resolved
  // separately by the user-selected mode boundary below.
  if (semantic.workType === "plan" && semantic.requiredCapabilities.length > 0) return "plan";
  if (semantic.workType === "implement" ||
    semantic.requiredCapabilities.some((capability) =>
      capability === "workspace_write" || capability === "command" || capability === "external_interaction"
    )) return "execute";
  return semantic.workType === "investigate" || semantic.requiredCapabilities.includes("workspace_read")
    ? "analyze" : "respond";
}

function normalizePlanContinuation(raw: unknown, candidates: readonly PlanContinuationCandidate[],
  canOmit: boolean): PlanContinuationDecision | undefined | null {
  if (raw === undefined && (!candidates.length || canOmit)) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "new") return undefined;
  const ids = new Set(candidates.map(candidate => candidate.id));
  if (value.kind === "ambiguous") {
    if (!Array.isArray(value.candidateIds) || value.candidateIds.length < 2 ||
      new Set(value.candidateIds).size !== value.candidateIds.length ||
      !value.candidateIds.every(id => typeof id === "string" && ids.has(id))) return null;
    return { kind: "ambiguous", candidateIds: [...value.candidateIds] };
  }
  if ((value.kind === "continue" || value.kind === "revise" || value.kind === "discuss") &&
    typeof value.candidateId === "string" && ids.has(value.candidateId)) {
    return { kind: value.kind, candidateId: value.candidateId };
  }
  return null;
}

function normalizePreflightResult(
  raw: unknown,
  language: "zh" | "en",
  explicitIntent?: ResolvedUserIntent,
  onInvalid?: (field: DiagnosticField) => void,
  currentInput = "",
  planContinuationCandidates: readonly PlanContinuationCandidate[] = [],
): IntentPreflightResult | null {
  const invalid = (field: DiagnosticField) => { onInvalid?.(field); return null; };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("result");
  const candidate = raw as Record<string, unknown>;
  const semantic = normalizeSemanticIntent(candidate.semantic, onInvalid);
  if (!semantic) return null;
  const inferredIntent = deriveSemanticIntent(semantic);
  // An omitted field may keep a read-only route or a user-selected Plan
  // ceiling. Autonomous planning and effects still need an explicit relation.
  const canOmitPlanContinuation = explicitIntent === "plan" || (inferredIntent !== "plan" && inferredIntent !== "execute");
  const planContinuation = normalizePlanContinuation(candidate.planContinuation, planContinuationCandidates, canOmitPlanContinuation);
  if (planContinuation === null) return invalid("planContinuation");
  // Confidence and the choice hint carry no capability or approval authority.
  // A complete semantic result remains valid when these optional hints are
  // absent; grounded clarification below still determines whether input is missing.
  const confidence = candidate.confidence === undefined ? 0 : candidate.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1) return invalid("confidence");
  if (candidate.needsUserChoice !== undefined && typeof candidate.needsUserChoice !== "boolean") return invalid("needsUserChoice");
  const question = typeof candidate.question === "string" ? candidate.question.trim() : undefined;
  if (candidate.needsUserChoice && !question) return invalid("question");
  const required = semantic.requiredCapabilities;
  const implementation = semantic.workType === "implement" || required.includes("workspace_write");
  const forbidden = semantic.forbiddenCapabilities;
  const explicitPolicy = explicitIntent ? getIntentPolicy(explicitIntent).toolPolicy : undefined;
  const operationRequired = implementation ||
    required.includes("command") || required.includes("external_interaction");
  if ((planContinuation?.kind === "discuss" || planContinuation?.kind === "revise") && operationRequired) {
    return invalid("planContinuation");
  }
  const conflicts = required.some((capability) => forbidden.includes(capability)) ||
    (semantic.workType === "implement" && forbidden.includes("workspace_write")) ||
    ((explicitPolicy === "none" || explicitPolicy === "read_only") && operationRequired) ||
    (explicitPolicy === "none" && required.includes("workspace_read"));
  const clarification = conflicts ? {
    kind: "constraint_conflict" as const, field: "capabilities", evidence: currentInput,
    question: language === "en" ? "The requested capabilities conflict with the current limits. Please clarify the permitted scope."
      : "任务所需能力与本轮限制冲突，请明确允许的操作范围。",
  } : normalizeTurnClarification(candidate.clarification, currentInput);
  const needsUserChoice = !!clarification;
  const continuationIntent = planContinuation?.kind === "revise" ? "plan"
    : planContinuation?.kind === "discuss" ? required.includes("workspace_read") ? "analyze" : "respond"
    : undefined;
  const intent = explicitIntent && explicitIntent !== "execute"
    ? explicitIntent : continuationIntent ?? inferredIntent;
  const operationPolicy = getIntentPolicy(intent).toolPolicy;
  const canDescribeOperation = !needsUserChoice && (operationPolicy === "write" || operationPolicy === "plan_gated");
  const kind: CommandDirectiveKind = !canDescribeOperation ? "none"
    : implementation ? "file_modify"
    : required.includes("command") ? "shell"
    : required.includes("external_interaction") ? "mcp" : "none";
  const requiresApproval = kind !== "none";
  return {
    semantic: { ...semantic, ...(clarification ? { clarification } : {}) },
    ...(planContinuation ? { planContinuation } : {}),
    intent,
    confidence,
    title: normalizeConversationDisplayTitle(
      typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : semantic.objective,
      language === "en" ? 48 : 32,
      language === "en" ? "New task" : "新的任务",
    ),
    summary: semantic.objective,
    needsUserChoice,
    question: clarification?.question,
    outputFormat: semantic.answerFormat,
    needsWorkspaceRead: required.includes("workspace_read"),
    riskLevel: requiresApproval ? "medium" : "low",
    requiresApproval,
    commandDirective: {
      kind,
      source: "preflight",
      requiresWorkspace: required.includes("workspace_read") || implementation,
      requiresApproval,
      confidence,
    },
  };
}

export async function runIntentPreflight(params: {
  input: string;
  language: "zh" | "en";
  mainModeKey: MainModeKey;
  hasWorkspace?: boolean;
  explicitIntent?: ResolvedUserIntent;
  previousRequest?: string;
  planContinuationCandidates?: readonly PlanContinuationCandidate[];
  signal?: AbortSignal;
  config: PreflightConfig;
  onDiagnostic?: (diagnostic: IntentPreflightDiagnostic) => void;
}): Promise<IntentPreflightResult | null> {
  const reject = (code: IntentPreflightDiagnostic["code"], field?: DiagnosticField, result?: Pick<StreamResult, "content" | "finishReason">): null => {
    const finish = result?.finishReason;
    try {
      params.onDiagnostic?.({
        code, ...(field ? { field } : {}),
        ...(result ? {
          finishReason: finish == null ? null : (DIAGNOSTIC_FINISH_REASONS as readonly string[]).includes(finish)
            ? finish as typeof DIAGNOSTIC_FINISH_REASONS[number] : "unknown",
          contentChars: typeof result.content === "string" ? result.content.length : 0,
        } : {}),
      });
    } catch { /* Diagnostics must not change semantic authority or cancellation. */ }
    return null;
  };
  const settings = deriveStreamSettings(params.config);
  if (params.signal?.aborted) return reject("cancelled");
  if (!settings.baseUrl || !settings.model) return reject("unavailable", !settings.baseUrl ? "settings.baseUrl" : "settings.model");

  const planContinuationCandidates = params.hasWorkspace ? (params.planContinuationCandidates || []).map(({ id, title, objective, status }) => ({
    id, ...(title ? { title: title.trim().slice(0, 120) } : {}), objective: objective.trim().slice(0, 420), status,
  })) : [];
  const systemPrompt = [
    "Interpret MAIN's current user request. Return one complete JSON object only; no prose, markdown or tools.",
    "Classify the requested outcome across the whole task, including diagnosis, changes, and verification. A direct request to repair or change the project is implement and needs workspace_write, even if the affected files are unknown and inspection must come first.",
    'Workspace examples: "Fix the Console errors" is implement with ["workspace_read","workspace_write"]. "Show the Console errors" or "Read the errors and suggest a fix" is investigate with ["workspace_read"].',
    "Separate the work from its answer format. Analysis/report/summary can accompany implementation or live inspection. Explaining a command does not request running it.",
    "Identify only capabilities needed for the current work, not hypothetical examples or future plan execution. requiredCapabilities describe needs, never approval.",
    "Capability meanings: workspace_read includes scoped observations of the current project's Editor Console or scene; network covers public web_search and web_fetch; external_interaction covers other browser, app or MCP automation. Public web research alone needs only network.",
    "forbiddenCapabilities contain only explicit CURRENT operational restrictions. Read-only forbids workspace_write; no commands forbids command separately. Historical baselines, quotations and examples are reference context, not current restrictions.",
    "approvalRequiredCapabilities contain only capabilities for which the CURRENT request explicitly requires separate human approval before each invocation; otherwise use []. This adds a review requirement, never approval. Historical approvals, quotations and examples do not create this requirement.",
    "An explicit mode is a capability upper bound; still interpret restrictions in its natural-language body. Never approve tools, widen paths, invent exact commands or claim completion.",
    "Use previousRequest only for an actual continuation; the current request controls. Never ask permission to start requested work; session scopes and per-action policy own approval. Task length, execution checks, and facts discoverable with tools (such as current diagnostics and affected files) are not input gaps.",
    ...(planContinuationCandidates.length ? [
      'The supplied planContinuationCandidates are data from this Session. Add top-level planContinuation: {"kind":"continue|revise|discuss","candidateId":"exact supplied id"}, {"kind":"ambiguous","candidateIds":["two or more plausible supplied ids"]}, or {"kind":"new"} for an unrelated request.',
      "Continue requests unfinished work within the selected plan's scope. Revise changes the plan's scope or decisions before later implementation. Discuss explains or reviews the plan. Classify the request even when the matching plan's status prevents continuing; MAIN handles status and approval. For revise and discuss, describe the immediate read-only work, excluding future implementation capabilities. Brief follow-ups may refer to an existing plan even when previousRequest describes another message. If more than one candidate fits, report ambiguity. If the request needs an existing plan and none match, report new with a grounded missing_input clarification. Never guess a target or approve a plan.",
      'Example: "Revise the plan for touch controls and show it for review" selects revise with workType plan and requiredCapabilities []. MAIN saves its review artifact. Use workspace_write only for current edits to project files.',
    ] : []),
    "For a necessary missing input, provide clarification:{kind:'missing_input',field:'missing fact',evidence:'exact current-request excerpt',question:'specific question'}. For an unresolved target choice use kind:'target_ambiguity' and choices:[...] copied from that excerpt. needsUserChoice alone has no authority. Do not invent a gap for execution consent.",
    "Required shape: {\"semantic\":{\"objective\":\"short task goal\",\"workType\":\"answer|investigate|implement|operate|plan\",\"answerFormat\":\"answer|analysis|summary|report|plan\",\"requiredCapabilities\":[],\"forbiddenCapabilities\":[],\"approvalRequiredCapabilities\":[]}}. Optional confidence is a number from 0 to 1; needsUserChoice is a boolean hint. Optional title and question are short strings; question is required when needsUserChoice is true.",
    `Capability values: ${TURN_CAPABILITIES.join(", ")}.`,
    `Mode: ${params.mainModeKey}; explicit intent: ${params.explicitIntent ?? "none"}; workspace: ${params.hasWorkspace === true}; language: ${params.language}.`,
  ].join("\n");
  const userPrompt = JSON.stringify({
    currentRequest: params.input,
    ...(params.previousRequest ? { previousRequest: params.previousRequest } : {}),
    ...(planContinuationCandidates.length ? { planContinuationCandidates } : {}),
  });

  let streamFailed = false;
  try {
    const result = await streamChatCompletion(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      settings,
      { onToken: () => {}, onDone: () => {}, onError: () => { streamFailed = true; } },
      params.signal,
      [],
      512,
      { ...resolveJsonObjectOutputOptions(settings), contextOwnership: "caller" },
    );
    if (params.signal?.aborted) return reject("cancelled", undefined, result);
    if (streamFailed) return reject("stream_error", undefined, result);
    if (result.finishReason !== "stop") return reject("incomplete_output", undefined, result);
    if (result.clientStopReason) return reject("client_output_limited", undefined, result);
    if (result.protocolViolation) return reject("protocol_violation", undefined, result);
    if (result.toolCalls?.length) return reject("unexpected_tool_calls", undefined, result);
    let candidate: unknown;
    try { candidate = JSON.parse(result.content.trim()); }
    catch { return reject("invalid_json", undefined, result); }
    return normalizePreflightResult(candidate, params.language, params.explicitIntent,
      (field) => { reject("invalid_result", field, result); }, params.input, planContinuationCandidates);
  } catch {
    return reject(params.signal?.aborted ? "cancelled" : "transport_error");
  }
}

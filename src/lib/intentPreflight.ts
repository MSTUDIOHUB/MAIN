import { normalizeCloudProtocol, normalizeLocalToolProtocol, resolveEffectiveCloudApiFormat } from "./cloudProtocol";
import { streamChatCompletion, type StreamSettings } from "./streaming";
import {
  getIntentPolicy,
  type IntentPreflightResult,
  type ResolvedUserIntent,
  type SemanticTaskIntent,
  type CommandDirectiveKind,
} from "./runIntent";
import type { MainModeKey } from "./mainModes";
import type { AppConfig } from "./appTypes";
import { normalizeConversationDisplayTitle } from "./workflowModels";
import { shouldUseRustProxyForLocalProvider } from "./localProviderRouting";
import { TURN_CAPABILITIES, type SemanticCapability } from "./turnCapabilities";

type PreflightConfig = Pick<AppConfig, "activeProfile" | "local" | "cloud" | "cloudExperimentalLoginEnabled">;

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

function normalizeSemanticIntent(raw: unknown): SemanticTaskIntent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.objective !== "string" || !value.objective.trim()) return null;
  if (!["answer", "investigate", "implement", "operate", "plan"].includes(value.workType as string)) return null;
  if (!["answer", "analysis", "summary", "report", "plan"].includes(value.answerFormat as string)) return null;
  const requiredCapabilities = normalizeCapabilities(value.requiredCapabilities);
  const forbiddenCapabilities = normalizeCapabilities(value.forbiddenCapabilities);
  if (!requiredCapabilities || !forbiddenCapabilities) return null;
  return {
    objective: value.objective.trim(),
    workType: value.workType as SemanticTaskIntent["workType"],
    answerFormat: value.answerFormat as SemanticTaskIntent["answerFormat"],
    requiredCapabilities,
    forbiddenCapabilities,
  };
}

function deriveSemanticIntent(semantic: SemanticTaskIntent): ResolvedUserIntent {
  if (semantic.workType === "plan") return "plan";
  if (semantic.workType === "implement" || semantic.workType === "operate" ||
    semantic.requiredCapabilities.some((capability) =>
      capability === "workspace_write" || capability === "command" || capability === "external_interaction"
    )) return "execute";
  return semantic.workType === "investigate" || semantic.requiredCapabilities.includes("workspace_read")
    ? "analyze" : "respond";
}

function normalizePreflightResult(
  raw: unknown,
  language: "zh" | "en",
  explicitIntent?: ResolvedUserIntent,
): IntentPreflightResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const semantic = normalizeSemanticIntent(candidate.semantic);
  if (!semantic || typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 || candidate.confidence > 1 || typeof candidate.needsUserChoice !== "boolean") return null;
  const question = typeof candidate.question === "string" ? candidate.question.trim() : undefined;
  if (candidate.needsUserChoice && !question) return null;
  const required = semantic.requiredCapabilities;
  const implementation = semantic.workType === "implement" || required.includes("workspace_write");
  const forbidden = semantic.forbiddenCapabilities;
  const explicitPolicy = explicitIntent ? getIntentPolicy(explicitIntent).toolPolicy : undefined;
  const operationRequired = implementation || semantic.workType === "operate" ||
    required.includes("command") || required.includes("external_interaction");
  const conflicts = required.some((capability) => forbidden.includes(capability)) ||
    (semantic.workType === "implement" && forbidden.includes("workspace_write")) ||
    ((explicitPolicy === "none" || explicitPolicy === "read_only") && operationRequired) ||
    (explicitPolicy === "none" && required.includes("workspace_read"));
  const needsUserChoice = candidate.needsUserChoice || conflicts;
  const intent = explicitIntent && explicitIntent !== "execute"
    ? explicitIntent : deriveSemanticIntent(semantic);
  const operationPolicy = getIntentPolicy(intent).toolPolicy;
  const canDescribeOperation = !needsUserChoice && (operationPolicy === "write" || operationPolicy === "plan_gated");
  const kind: CommandDirectiveKind = !canDescribeOperation ? "none"
    : implementation ? "file_modify"
    : required.includes("command") ? "shell"
    : required.includes("external_interaction") ? "mcp" : "none";
  const requiresApproval = kind !== "none";
  return {
    semantic,
    intent,
    confidence: candidate.confidence,
    title: normalizeConversationDisplayTitle(
      typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : semantic.objective,
      language === "en" ? 48 : 32,
      language === "en" ? "New task" : "新的任务",
    ),
    summary: semantic.objective,
    needsUserChoice,
    question: question ?? (conflicts
      ? language === "en" ? "The requested capabilities conflict with the current limits. Please clarify the permitted scope."
        : "任务所需能力与本轮限制冲突，请明确允许的操作范围。"
      : undefined),
    outputFormat: semantic.answerFormat,
    needsWorkspaceRead: required.includes("workspace_read"),
    riskLevel: requiresApproval ? "medium" : "low",
    requiresApproval,
    commandDirective: {
      kind,
      source: "preflight",
      requiresWorkspace: required.includes("workspace_read") || implementation,
      requiresApproval,
      confidence: candidate.confidence,
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
  signal?: AbortSignal;
  config: PreflightConfig;
}): Promise<IntentPreflightResult | null> {
  const settings = deriveStreamSettings(params.config);
  if (!settings.baseUrl || !settings.model || params.signal?.aborted) return null;

  const systemPrompt = [
    "Interpret MAIN's current user request. Return one complete JSON object only; no prose, markdown or tools.",
    "Separate the work from its answer format. Analysis/report/summary can accompany implementation or live inspection. Explaining a command does not request running it.",
    "Identify only capabilities needed for the current work, not hypothetical examples or future plan execution. requiredCapabilities describe needs, never approval.",
    "forbiddenCapabilities contain only explicit CURRENT operational restrictions. Read-only forbids workspace_write; no commands forbids command separately. Historical baselines, quotations and examples are reference context, not current restrictions.",
    "An explicit mode is a capability upper bound; still interpret restrictions in its natural-language body. Never approve tools, widen paths, invent exact commands or claim completion.",
    "Use previousRequest only to understand an actual continuation; the current request always controls. If materially ambiguous, set needsUserChoice true and provide a brief question.",
    "Required shape: {\"semantic\":{\"objective\":\"short task goal\",\"workType\":\"answer|investigate|implement|operate|plan\",\"answerFormat\":\"answer|analysis|summary|report|plan\",\"requiredCapabilities\":[],\"forbiddenCapabilities\":[]},\"confidence\":0.0,\"needsUserChoice\":false}. Optional title and question are short strings; question is required when needsUserChoice is true.",
    `Capability values: ${TURN_CAPABILITIES.join(", ")}.`,
    `Mode: ${params.mainModeKey}; explicit intent: ${params.explicitIntent ?? "none"}; workspace: ${params.hasWorkspace === true}; language: ${params.language}.`,
  ].join("\n");
  const userPrompt = JSON.stringify({
    currentRequest: params.input,
    ...(params.previousRequest ? { previousRequest: params.previousRequest } : {}),
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
    );
    if (streamFailed || params.signal?.aborted || result.finishReason !== "stop" ||
      result.clientStopReason || result.protocolViolation || result.toolCalls?.length) return null;
    return normalizePreflightResult(JSON.parse(result.content.trim()), params.language, params.explicitIntent);
  } catch {
    return null;
  }
}

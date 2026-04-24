import { normalizeCloudApiFormat, normalizeCloudProtocol } from "./cloudProtocol";
import { streamChatCompletion, type StreamSettings } from "./streaming";
import type { PendingRunDecisionOption, IntentPreflightResult, ResolvedUserIntent } from "./runIntent";
import type { MainModeKey } from "./mainModes";
import type { AppConfig } from "../store/useAppStore";

type PreflightConfig = Pick<AppConfig, "activeProfile" | "local" | "cloud">;

const ALLOWED_INTENTS = new Set<ResolvedUserIntent>([
  "discuss",
  "plan",
  "execute",
  "summarize",
  "report",
  "studio_workflow",
]);

function deriveStreamSettings(config: PreflightConfig): StreamSettings {
  if (config.activeProfile === "local") {
    const isLocalhost = /127\.0\.0\.1|localhost|\[::1\]/.test(config.local.endpoint);
    return {
      baseUrl: config.local.endpoint,
      apiKey: config.local.apiKey || "not-needed",
      model: config.local.model,
      temperature: 0.1,
      contextLimit: config.local.contextLimit,
      provider: config.local.provider,
      useRustProxy: !isLocalhost,
    };
  }

  return {
    baseUrl: config.cloud.endpoint || "https://api.openai.com/v1",
    apiKey: config.cloud.apiKey,
    model: config.cloud.model,
    apiProtocol: normalizeCloudProtocol(config.cloud.protocol || "openai"),
    apiFormat: normalizeCloudApiFormat(config.cloud.apiFormat || "chat_completions"),
    customHeaders: config.cloud.customHeaders || "",
    temperature: 0.1,
    topP: 0.8,
    disableResponseStorage: config.cloud.disableResponseStorage ?? true,
    reasoningEffort: "none",
    contextLimit: undefined,
    provider: config.cloud.provider,
    useRustProxy: true,
  };
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() || trimmed;
}

function extractJsonObject(text: string): string | null {
  const cleaned = stripJsonFence(text);
  const directStart = cleaned.indexOf("{");
  const directEnd = cleaned.lastIndexOf("}");
  if (directStart >= 0 && directEnd > directStart) {
    return cleaned.slice(directStart, directEnd + 1);
  }
  return null;
}

function normalizeIntent(value: unknown): ResolvedUserIntent | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase() as ResolvedUserIntent;
  return ALLOWED_INTENTS.has(normalized) ? normalized : null;
}

function normalizeOption(option: unknown, language: "zh" | "en"): PendingRunDecisionOption | null {
  if (typeof option === "string") {
    const intent = normalizeIntent(option);
    if (!intent) return null;
    return {
      id: intent,
      label: intent,
      value: language === "en" ? `Please handle this as ${intent}.` : `请按 ${intent} 处理这轮请求。`,
    };
  }

  if (!option || typeof option !== "object") return null;
  const candidate = option as Partial<PendingRunDecisionOption> & { intent?: string };
  const intent = normalizeIntent(candidate.id || candidate.intent);
  if (!intent) return null;
  const label = typeof candidate.label === "string" && candidate.label.trim()
    ? candidate.label.trim()
    : intent;
  const value = typeof candidate.value === "string" && candidate.value.trim()
    ? candidate.value.trim()
    : language === "en"
    ? `Please handle this as ${intent}.`
    : `请按 ${intent} 处理这轮请求。`;
  return { id: intent, label, value };
}

function normalizePreflightResult(
  raw: unknown,
  language: "zh" | "en",
): IntentPreflightResult | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<IntentPreflightResult> & { options?: unknown[] };
  const intent = normalizeIntent(candidate.intent);
  if (!intent) return null;

  const options = Array.isArray(candidate.options)
    ? candidate.options
        .map((option) => normalizeOption(option, language))
        .filter(Boolean) as PendingRunDecisionOption[]
    : undefined;

  return {
    intent,
    confidence: typeof candidate.confidence === "number" ? Math.max(0, Math.min(1, candidate.confidence)) : 0.6,
    summary: typeof candidate.summary === "string" ? candidate.summary.trim() : undefined,
    reason: typeof candidate.reason === "string" ? candidate.reason.trim() : undefined,
    needsUserChoice: candidate.needsUserChoice === true,
    question: typeof candidate.question === "string" ? candidate.question.trim() : undefined,
    options: options && options.length > 0 ? options : undefined,
    outputFormat: candidate.outputFormat,
    bypassMainRouter: candidate.bypassMainRouter === true,
    needsWorkspaceRead: candidate.needsWorkspaceRead === true,
  };
}

export async function runIntentPreflight(params: {
  input: string;
  language: "zh" | "en";
  mainModeKey: MainModeKey;
  config: PreflightConfig;
}): Promise<IntentPreflightResult | null> {
  const settings = deriveStreamSettings(params.config);
  if (!settings.baseUrl || !settings.model) return null;

  const systemPrompt = [
    "You are MAIN's hidden intent preflight router.",
    "Return JSON only. No markdown, no prose, no tools.",
    "Classify the user's next-turn intent for MAIN before execution.",
    "Allowed intents: discuss, plan, execute, summarize, report, studio_workflow.",
    "Only use studio_workflow if the text clearly belongs to MAIN GAME STUDIO.",
    "Also provide summary: a short user-facing intent summary of what MAIN is about to do. Do not copy the user's wording verbatim.",
    "Also provide reason: a brief routing reason for the chosen intent.",
    "If the request is ambiguous in a way that materially changes behavior, set needsUserChoice=true and provide a short user-facing question plus 2-3 clear options.",
    "Options must be plain user-facing choices, not reasoning.",
    "The JSON shape must be:",
    "{\"intent\":\"discuss|plan|execute|summarize|report|studio_workflow\",\"confidence\":0.0,\"summary\":\"直接执行：调整 TopIsland 的等待交互展示\",\"reason\":\"The request asks for a concrete UI change.\",\"needsUserChoice\":false,\"question\":\"\",\"options\":[{\"id\":\"plan\",\"label\":\"进入计划模式\",\"value\":\"先给我一个方案和计划，再决定是否执行\"}],\"outputFormat\":\"answer|summary|report|plan|execution\",\"bypassMainRouter\":false,\"needsWorkspaceRead\":false}",
    `Current visible mode: ${params.mainModeKey}`,
    `Preferred user language: ${params.language}`,
  ].join("\n");

  const userPrompt = [
    `User input: ${params.input}`,
    "Return strict JSON now.",
  ].join("\n");

  let fullText = "";
  try {
    const result = await streamChatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      settings,
      {
        onToken: (token) => {
          fullText += token;
        },
        onDone: (result) => {
          fullText = result.content || fullText;
        },
        onError: () => {
          // Swallow here and return null below.
        },
      },
      undefined,
      [],
      512,
    );

    const jsonText = extractJsonObject(result.content || fullText);
    if (!jsonText) return null;
    return normalizePreflightResult(JSON.parse(jsonText), params.language);
  } catch {
    const jsonText = extractJsonObject(fullText);
    if (!jsonText) return null;
    try {
      return normalizePreflightResult(JSON.parse(jsonText), params.language);
    } catch {
      return null;
    }
  }
}

import {
  buildAnthropicRequestBody,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  buildGeminiRequestForAuthMode,
  buildOpenAiResponsesInputCandidates,
  buildOpenAiResponsesRequestExtras,
  ensureOpenAiChatGptCodexRequestBody,
  extractAnthropicResponseText,
  extractGeminiResponseText,
  extractOpenAiResponsesInstructions,
  extractOpenAiResponseText,
  parseOpenAiResponsesSseText,
  normalizeCloudAuthMode,
  normalizeCloudApiFormat,
  normalizeCloudProtocol,
  type ProtocolChatMessage,
} from "./cloudProtocol";
import type { GitDiffEntry, GitStatus } from "./ipc";

type Language = "zh" | "en";

interface CommitMessageConfig {
  [key: string]: unknown;
  activeProfile?: "local" | "cloud";
  local?: {
    provider?: string;
    endpoint?: string;
    model?: string;
    apiKey?: string;
  };
  cloud?: {
    protocol?: unknown;
    apiFormat?: unknown;
    provider?: string;
    endpoint?: string;
    model?: string;
    apiKey?: string;
    customHeaders?: string;
    disableResponseStorage?: boolean;
    auth?: {
      mode?: unknown;
      tokenRef?: string;
    };
  };
}

export interface GenerateGitCommitMessageParams {
  config: CommitMessageConfig;
  language: Language;
  workspace: string;
  status?: GitStatus | null;
  entries: GitDiffEntry[];
  requestJson?: (request: {
    url: string;
    method: "POST";
    headers: Record<string, string>;
    body: Record<string, unknown>;
    isCloud: boolean;
    authMode?: unknown;
    tokenRef?: string;
  }) => Promise<unknown>;
}

export interface GeneratedGitCommitMessage {
  message: string;
  source: "model" | "fallback";
}

const MAX_DIFF_FILES = 30;
const MAX_DIFF_CHARS = 60_000;
const COMMIT_SUBJECT_MAX_LENGTH = 72;

function trimToLength(value: string, maxLength: number) {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength).trim();
}

function titleCaseWord(value: string) {
  if (!value) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function splitPathTokens(path: string): string[] {
  return path
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[\\/._\-\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !/^(src|lib|app|test|tests|node|components)$/i.test(token));
}

function inferCommitTopic(entries: GitDiffEntry[], language: Language) {
  const paths = entries.map((entry) => entry.path.toLowerCase());
  const joined = paths.join("\n");
  if (/sidebar/.test(joined) && /git/.test(joined)) return language === "zh" ? "Git 菜单" : "sidebar git menu";
  if (/git/.test(joined) && /diff/.test(joined)) return language === "zh" ? "Git Diff" : "git diff preview";
  if (/top[-_]?island/.test(joined)) return "TopIsland";
  if (/diff/.test(joined)) return language === "zh" ? "Diff 视图" : "diff view";
  if (/tool|schema|executor/.test(joined)) return language === "zh" ? "工具执行" : "tool execution";

  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const token of splitPathTokens(entry.path)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  const [best] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0] || [];
  if (best) return language === "zh" ? best : best.split(/\s+/).map(titleCaseWord).join(" ");
  return language === "zh" ? "项目文件" : "project files";
}

export function buildFallbackGitCommitMessage(
  entries: GitDiffEntry[],
  language: Language = "zh",
  status?: GitStatus | null,
): string {
  const topic = inferCommitTopic(entries, language);
  const statuses = new Set(entries.map((entry) => entry.status));
  const changedFiles = status?.changedFiles || entries.length;
  const onlyAdded = statuses.size > 0 && Array.from(statuses).every((value) => value === "A" || value === "U");
  const onlyDeleted = statuses.size > 0 && Array.from(statuses).every((value) => value === "D");

  if (language === "zh") {
    if (onlyAdded) return trimToLength(`新增 ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
    if (onlyDeleted) return trimToLength(`删除 ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
    if (changedFiles > 1) return trimToLength(`更新 ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
    return trimToLength(`调整 ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
  }

  if (onlyAdded) return trimToLength(`Add ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
  if (onlyDeleted) return trimToLength(`Remove ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
  return trimToLength(`Update ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
}

export function sanitizeGitCommitSubject(raw: string): string | null {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!cleaned) return null;

  const subject = cleaned
    .replace(/^[-*]\s+/, "")
    .replace(/^(commit message|subject|提交信息)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();

  if (!subject || subject.length < 3) return null;
  if (/[\r\n]/.test(subject)) return null;
  return trimToLength(subject, COMMIT_SUBJECT_MAX_LENGTH);
}

function appendLimited(lines: string[], next: string, maxChars: number) {
  const current = lines.join("\n").length;
  if (current >= maxChars) return;
  const remaining = maxChars - current;
  lines.push(next.length <= remaining ? next : next.slice(0, remaining));
}

function buildDiffPromptContext(entries: GitDiffEntry[], status?: GitStatus | null) {
  const lines: string[] = [
    `Files changed: ${status?.changedFiles ?? entries.length}`,
    `Insertions: ${status?.insertions ?? 0}`,
    `Deletions: ${status?.deletions ?? 0}`,
    "",
    "Changed files:",
  ];

  for (const entry of entries.slice(0, MAX_DIFF_FILES)) {
    lines.push(`- ${entry.status} ${entry.path}${entry.binary ? " (binary)" : ""}`);
  }

  lines.push("", "Diff excerpts:");
  for (const entry of entries.slice(0, MAX_DIFF_FILES)) {
    if (entry.binary) continue;
    const oldText = (entry.old || "").slice(0, 1600);
    const newText = (entry.new || "").slice(0, 2400);
    appendLimited(lines, [`### ${entry.status} ${entry.path}`, "--- old", oldText, "--- new", newText].join("\n"), MAX_DIFF_CHARS);
  }

  return lines.join("\n").slice(0, MAX_DIFF_CHARS);
}

async function defaultRequestJson(request: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
  isCloud: boolean;
  authMode?: unknown;
  tokenRef?: string;
}): Promise<unknown> {
  if (request.isCloud) {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<string>("proxy_request", {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      authMode: request.authMode,
      tokenRef: request.tokenRef,
    });
    const contentType = (result.match(/^__CONTENT_TYPE__:(.*)\n/) || [])[1]?.trim() || "";
    if (contentType.includes("text/event-stream")) {
      return { output_text: parseOpenAiResponsesSseText(result.replace(/^__CONTENT_TYPE__:.*\n/, "")) };
    }
    return JSON.parse(result);
  }

  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  if (!response.ok) throw new Error(`Commit message request failed: ${response.status}`);
  return response.json();
}

async function requestModelCommitMessage(params: GenerateGitCommitMessageParams): Promise<string | null> {
  const isCloud = params.config.activeProfile === "cloud";
  const activeConfig = isCloud ? params.config.cloud : params.config.local;
  const endpoint = String(activeConfig?.endpoint || "").trim();
  const model = String(activeConfig?.model || "").trim();
  const provider = String(activeConfig?.provider || "").trim();
  const cloudExperimentalLoginEnabled = isCloud && params.config.cloudExperimentalLoginEnabled === true;
  const cloudAuthMode = isCloud
    ? cloudExperimentalLoginEnabled
      ? normalizeCloudAuthMode(params.config.cloud?.auth?.mode)
      : "api_key"
    : undefined;
  if ((!endpoint && cloudAuthMode !== "gemini_google_oauth") || !model) return null;

  const messages: ProtocolChatMessage[] = [
    {
      role: "system",
      content: [
        "You generate Git commit subjects.",
        "Return exactly one commit subject line.",
        "No markdown, no quotes, no prefixes, no explanations.",
        `Maximum ${COMMIT_SUBJECT_MAX_LENGTH} characters.`,
        params.language === "zh" ? "Use concise Chinese." : "Use concise English.",
      ].join("\n"),
    },
    {
      role: "user",
      content: buildDiffPromptContext(params.entries.filter((entry) => !entry.binary), params.status),
    },
  ];

  const cloudProtocol = normalizeCloudProtocol(isCloud ? params.config.cloud?.protocol : "openai");
  const cloudApiFormat = normalizeCloudApiFormat(isCloud ? params.config.cloud?.apiFormat : "chat_completions");
  const isAnthropicCloud = isCloud && cloudProtocol === "anthropic";
  const isGeminiCloud = isCloud && cloudProtocol === "gemini";
  const cloudTokenRef = cloudExperimentalLoginEnabled ? params.config.cloud?.auth?.tokenRef : undefined;
  let url = "";
  let body: Record<string, unknown> = {};
  let headers: Record<string, string> = {};

  if (!isCloud && provider === "Ollama") {
    url = `${endpoint.replace(/\/v1\/?$/i, "")}/api/chat`;
    body = { model, messages, stream: false, options: { temperature: 0.1, top_p: 0.8 } };
    headers = { "Content-Type": "application/json" };
  } else if (isAnthropicCloud) {
    url = buildCloudMessagesApiUrl(endpoint, "anthropic");
    body = buildAnthropicRequestBody({ messages, model, maxTokens: 80, stream: false });
    headers = buildCloudHeaders("anthropic", params.config.cloud?.apiKey || "", true, params.config.cloud?.customHeaders, cloudAuthMode);
  } else if (isGeminiCloud) {
    const request = buildGeminiRequestForAuthMode(endpoint, { messages, model, maxTokens: 80 }, cloudAuthMode);
    url = request.url;
    body = request.body;
    headers = buildCloudHeaders("gemini", params.config.cloud?.apiKey || "", true, params.config.cloud?.customHeaders, cloudAuthMode);
  } else {
    url = buildCloudMessagesApiUrl(endpoint, "openai", cloudApiFormat);
    body = cloudApiFormat === "responses"
      ? ensureOpenAiChatGptCodexRequestBody({
          model,
          ...(extractOpenAiResponsesInstructions(messages) ? { instructions: extractOpenAiResponsesInstructions(messages) } : {}),
          input: buildOpenAiResponsesInputCandidates(messages)[0].input,
          ...buildOpenAiResponsesRequestExtras({
            disableResponseStorage: params.config.cloud?.disableResponseStorage,
            reasoningEffort: "none",
          }),
        }, { userPromptId: "main-commit-message" })
      : { model, messages, stream: false, max_tokens: 80 };
    headers = buildCloudHeaders("openai", isCloud ? params.config.cloud?.apiKey || "" : params.config.local?.apiKey || "", true, isCloud ? params.config.cloud?.customHeaders : undefined, cloudAuthMode);
  }

  const requestJson = params.requestJson || defaultRequestJson;
  const timeout = new Promise<never>((_, reject) => {
    globalThis.setTimeout(() => reject(new Error("Commit message generation timed out")), 6_000);
  });
  const payload = await Promise.race([
    requestJson({ url, method: "POST", headers, body, isCloud, authMode: cloudAuthMode, tokenRef: cloudTokenRef }),
    timeout,
  ]);

  const raw = !isCloud && provider === "Ollama"
    ? String((payload as { message?: { content?: unknown } })?.message?.content || "")
    : isAnthropicCloud
      ? extractAnthropicResponseText(payload)
      : isGeminiCloud
        ? extractGeminiResponseText(payload)
        : extractOpenAiResponseText(payload, cloudApiFormat);

  return sanitizeGitCommitSubject(raw);
}

export async function generateGitCommitMessage(params: GenerateGitCommitMessageParams): Promise<GeneratedGitCommitMessage> {
  try {
    const modelMessage = await requestModelCommitMessage(params);
    if (modelMessage) return { message: modelMessage, source: "model" };
  } catch {
    // Fall through to deterministic local generation.
  }

  return {
    message: buildFallbackGitCommitMessage(params.entries, params.language, params.status),
    source: "fallback",
  };
}

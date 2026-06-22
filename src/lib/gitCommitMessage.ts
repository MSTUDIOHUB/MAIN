import {
  buildAnthropicRequestBody,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  buildGeminiRequestForAuthMode,
  buildOpenAiResponsesInputCandidates,
  buildOpenAiResponsesRequestExtras,
  extractAnthropicResponseText,
  extractGeminiResponseText,
  extractOpenAiResponsesInstructions,
  extractOpenAiResponseText,
  parseOpenAiResponsesSseText,
  normalizeCloudAuthMode,
  resolveEffectiveCloudApiFormat,
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
const MAX_DIFF_HIGHLIGHT_LINES = 5;
const MAX_DIFF_HIGHLIGHT_CHARS = 180;
const MAX_FALLBACK_FILES = 8;
const MAX_FALLBACK_GROUPS = 4;
const COMMIT_SUBJECT_MAX_LENGTH = 72;

function trimToLength(value: string, maxLength: number) {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength).trim();
}

function titleCaseWord(value: string) {
  if (!value) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function splitPathTokens(path: string): string[] {
  return path
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\\/._\-\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !/^(src|lib|app|test|tests|node|components)$/i.test(token));
}

function inferCommitTopicFromPaths(entries: GitDiffEntry[], language: Language) {
  const paths = entries.map((entry) => entry.path.toLowerCase());
  const joined = paths.join("\n");
  if (/sidebar/.test(joined) && /git/.test(joined)) return language === "zh" ? "Git 菜单" : "sidebar git menu";
  if (/git/.test(joined) && /diff/.test(joined)) return language === "zh" ? "Git Diff" : "git diff preview";
  if (/top[-_]?island/.test(joined)) return "ExecutionCapsule";
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

interface CommitChangeGroup {
  key: string;
  zhLabel: string;
  enLabel: string;
  priority: number;
  paths: string[];
  keywords: string[];
}

const COMMIT_CHANGE_GROUP_SPECS: Array<Omit<CommitChangeGroup, "paths"> & { test: (path: string) => boolean }> = [
  {
    key: "manual",
    zhLabel: "MAIN 使用手册",
    enLabel: "MAIN manual",
    priority: 100,
    keywords: ["main", "manual", "docs", "手册", "文档", "截图"],
    test: (path) => /^docs\/main-manual(?:\/|$)/i.test(path),
  },
  {
    key: "commit_generation",
    zhLabel: "提交信息生成",
    enLabel: "commit message generation",
    priority: 95,
    keywords: ["commit", "message", "generation", "提交", "信息", "生成"],
    test: (path) => /gitCommitMessage|git-commit-message|sidebar-git-menu\.spec/i.test(path),
  },
  {
    key: "git_menu",
    zhLabel: "Git 菜单",
    enLabel: "Git menu",
    priority: 90,
    keywords: ["git", "menu", "sidebar", "菜单", "侧边栏"],
    test: (path) => /Sidebar\.tsx|sidebar-git/i.test(path),
  },
  {
    key: "theme",
    zhLabel: "主题样式",
    enLabel: "theme styling",
    priority: 70,
    keywords: ["theme", "style", "主题", "样式"],
    test: (path) => /ThemeStyles|theme|\.css$/i.test(path),
  },
  {
    key: "tests",
    zhLabel: "测试覆盖",
    enLabel: "test coverage",
    priority: 40,
    keywords: ["test", "coverage", "测试", "验证"],
    test: (path) => /^tests\//i.test(path),
  },
  {
    key: "docs",
    zhLabel: "项目文档",
    enLabel: "project docs",
    priority: 30,
    keywords: ["docs", "文档"],
    test: (path) => /^docs\//i.test(path),
  },
  {
    key: "source",
    zhLabel: "应用逻辑",
    enLabel: "app logic",
    priority: 20,
    keywords: ["app", "logic", "应用", "逻辑"],
    test: (path) => /^src\//i.test(path),
  },
];

function buildCommitChangeGroups(entries: GitDiffEntry[]): CommitChangeGroup[] {
  const groups = new Map<string, CommitChangeGroup>();
  for (const entry of entries) {
    const normalizedPath = entry.path.replace(/\\/g, "/");
    const spec = COMMIT_CHANGE_GROUP_SPECS.find((candidate) => candidate.test(normalizedPath));
    if (!spec) continue;
    const group = groups.get(spec.key) || {
      key: spec.key,
      zhLabel: spec.zhLabel,
      enLabel: spec.enLabel,
      priority: spec.priority,
      paths: [],
      keywords: spec.keywords,
    };
    group.paths.push(normalizedPath);
    groups.set(spec.key, group);
  }
  return Array.from(groups.values()).sort((a, b) => b.priority - a.priority);
}

function hasCommitGroup(groups: CommitChangeGroup[], key: string) {
  return groups.some((group) => group.key === key);
}

function inferCommitTopic(entries: GitDiffEntry[], language: Language) {
  const groups = buildCommitChangeGroups(entries);
  const hasManual = hasCommitGroup(groups, "manual");
  const hasGitMenu = hasCommitGroup(groups, "git_menu");
  const hasCommitGeneration = hasCommitGroup(groups, "commit_generation");

  if (language === "zh") {
    if (hasManual && (hasGitMenu || hasCommitGeneration)) return "MAIN 手册与 Git 提交体验";
    if (hasGitMenu && hasCommitGeneration) return "Git 提交体验";
    if (hasCommitGeneration) return "提交信息生成";
    if (hasGitMenu) return "Git 菜单";
    if (hasManual) return "MAIN 使用手册";
    if (hasCommitGroup(groups, "theme")) return "主题样式";
  } else {
    if (hasManual && (hasGitMenu || hasCommitGeneration)) return "MAIN manual and Git commit workflow";
    if (hasGitMenu && hasCommitGeneration) return "Git commit workflow";
    if (hasCommitGeneration) return "commit message generation";
    if (hasGitMenu) return "Git menu";
    if (hasManual) return "MAIN manual";
    if (hasCommitGroup(groups, "theme")) return "theme styling";
  }

  return inferCommitTopicFromPaths(entries, language);
}

function statusLabel(status: string, language: Language) {
  const normalized = status.toUpperCase();
  if (language === "zh") {
    if (normalized === "A" || normalized === "U") return "新增";
    if (normalized === "D") return "删除";
    if (normalized === "R") return "重命名";
    return "修改";
  }
  if (normalized === "A" || normalized === "U") return "add";
  if (normalized === "D") return "remove";
  if (normalized === "R") return "rename";
  return "modify";
}

function splitTextLines(value: string) {
  if (!value) return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

function countTextLines(value: string) {
  if (!value) return 0;
  return splitTextLines(value).length;
}

function normalizeHighlightLine(value: string) {
  return compactWhitespace(value).replace(/^[-+]\s*/, "");
}

function isUsefulHighlightLine(value: string) {
  const normalized = normalizeHighlightLine(value);
  if (normalized.length < 4) return false;
  if (/^[{}()[\];,.:'"`=\-\s]+$/.test(normalized)) return false;
  if (/^(import|export)\s+type\s+/i.test(normalized)) return false;
  return true;
}

function countNormalizedLines(lines: string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const normalized = normalizeHighlightLine(line);
    if (!isUsefulHighlightLine(normalized)) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return counts;
}

function collectLineHighlights(lines: string[], comparisonCounts: Map<string, number>) {
  const remaining = new Map(comparisonCounts);
  const seen = new Set<string>();
  const highlights: string[] = [];

  for (const line of lines) {
    const normalized = normalizeHighlightLine(line);
    if (!isUsefulHighlightLine(normalized)) continue;

    const matchingCount = remaining.get(normalized) || 0;
    if (matchingCount > 0) {
      remaining.set(normalized, matchingCount - 1);
      continue;
    }

    const compacted = trimToLength(normalized.replace(/`/g, "'"), MAX_DIFF_HIGHLIGHT_CHARS);
    const key = compacted.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    highlights.push(compacted);
    if (highlights.length >= MAX_DIFF_HIGHLIGHT_LINES) break;
  }

  return highlights;
}

function extractEntryHighlights(entry: GitDiffEntry) {
  const oldLines = splitTextLines(entry.old || "");
  const newLines = splitTextLines(entry.new || "");
  const oldCounts = countNormalizedLines(oldLines);
  const newCounts = countNormalizedLines(newLines);
  return {
    oldLineCount: countTextLines(entry.old || ""),
    newLineCount: countTextLines(entry.new || ""),
    added: collectLineHighlights(newLines, oldCounts),
    removed: collectLineHighlights(oldLines, newCounts),
  };
}

function formatPromptHighlights(lines: string[]) {
  return lines.length > 0 ? lines.map((line) => `  + ${line}`).join("\n") : "  (none detected from text excerpt)";
}

function buildEntryPromptSummary(entry: GitDiffEntry) {
  const highlights = extractEntryHighlights(entry);
  const label = entry.binary ? "binary" : entry.fullFile ? "full-file text" : "partial text";
  return [
    `### ${entry.status} ${entry.path}`,
    `Status: ${statusLabel(entry.status, "en")} (${label})`,
    `Lines: old ${highlights.oldLineCount}, new ${highlights.newLineCount}`,
    "Added/changed line highlights:",
    formatPromptHighlights(highlights.added),
    "Removed/replaced line highlights:",
    highlights.removed.length > 0 ? highlights.removed.map((line) => `  - ${line}`).join("\n") : "  (none detected from text excerpt)",
  ].join("\n");
}

function summarizeFallbackGroup(group: CommitChangeGroup, language: Language) {
  const hasScreenshots = group.paths.some((path) => /assets\/screenshots\//i.test(path));
  const hasMarkdown = group.paths.some((path) => /\.md$/i.test(path));

  if (language === "zh") {
    if (group.key === "manual") {
      if (hasScreenshots && hasMarkdown) return "- 精简 MAIN 手册内容并补充截图资源";
      if (hasScreenshots) return "- 补充 MAIN 手册截图资源";
      return "- 精简 MAIN 手册内容与页面说明";
    }
    if (group.key === "commit_generation") return "- 将提交信息生成改为摘要式输出，并补充质量校验";
    if (group.key === "git_menu") return "- 优化 Git 菜单的提交输入、弹层布局和提交后状态";
    if (group.key === "theme") return "- 调整侧边栏与 Git 图标相关主题样式";
    if (group.key === "tests") return "- 补充相关自动化测试覆盖";
    if (group.key === "docs") return "- 更新项目文档说明";
    return `- 更新${group.zhLabel}`;
  }

  if (group.key === "manual") {
    if (hasScreenshots && hasMarkdown) return "- Streamline MAIN manual content and add screenshot assets";
    if (hasScreenshots) return "- Add screenshot assets for the MAIN manual";
    return "- Streamline MAIN manual content and page descriptions";
  }
  if (group.key === "commit_generation") return "- Summarize generated commit messages and add quality checks";
  if (group.key === "git_menu") return "- Improve Git menu commit input, popover layout, and post-commit state";
  if (group.key === "theme") return "- Adjust sidebar and Git icon theme styling";
  if (group.key === "tests") return "- Add related automated test coverage";
  if (group.key === "docs") return "- Update project documentation";
  return `- Update ${group.enLabel}`;
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
  const subject = (() => {
    if (language === "zh") {
      if (onlyAdded) return trimToLength(`新增 ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
      if (onlyDeleted) return trimToLength(`删除 ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
      if (changedFiles > 1) return trimToLength(`更新 ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
      return trimToLength(`调整 ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
    }

    if (onlyAdded) return trimToLength(`Add ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
    if (onlyDeleted) return trimToLength(`Remove ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
    return trimToLength(`Update ${topic}`, COMMIT_SUBJECT_MAX_LENGTH);
  })();

  if (language === "zh") {
    const groups = buildCommitChangeGroups(entries);
    const bullets = groups.length > 0
      ? groups.slice(0, MAX_FALLBACK_GROUPS).map((group) => summarizeFallbackGroup(group, language))
      : ["- 汇总项目文件的主要变更"];
    return `${subject}\n\n${bullets.join("\n")}`;
  }

  const groups = buildCommitChangeGroups(entries);
  const bullets = groups.length > 0
    ? groups.slice(0, MAX_FALLBACK_GROUPS).map((group) => summarizeFallbackGroup(group, language))
    : ["- Summarize the main project file changes"];
  return `${subject}\n\n${bullets.join("\n")}`;
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

function stripInlineCommitMarkdown(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .trim();
}

export function sanitizeGitCommitMessage(raw: string): string | null {
  let cleaned = raw.trim();

  // Try to extract content inside <commit_message>...</commit_message> tags
  const tagStart = cleaned.toLowerCase().indexOf("<commit_message>");
  if (tagStart !== -1) {
    const contentStart = tagStart + "<commit_message>".length;
    const tagEnd = cleaned.toLowerCase().indexOf("</commit_message>", contentStart);
    if (tagEnd !== -1) {
      cleaned = cleaned.slice(contentStart, tagEnd).trim();
    } else {
      cleaned = cleaned.slice(contentStart).trim();
    }
  }

  // Remove code block fences if any
  cleaned = cleaned.replace(/```[\s\S]*?```/g, (block) => {
    return block.replace(/```[a-z]*|```/gi, "");
  });

  cleaned = cleaned.trim();
  if (cleaned.startsWith("```") && cleaned.endsWith("```")) {
    cleaned = cleaned.slice(3, -3).trim();
  }

  const lines = cleaned.split(/\r?\n/);

  // Find the first line starting with a conventional commit type prefix (optionally numbered or bolded)
  const ccRegex = /^(?:\d+\.\s*)?(?:\*\*)?(feat|fix|chore|refactor|docs|style|test|perf|ci|build|revert)(?:\(.+?\))?(?:\*\*)?\s*:\s*/i;
  const ccIndex = lines.findIndex(line => ccRegex.test(line.trim()));

  let startingIndex = 0;
  if (ccIndex !== -1) {
    startingIndex = ccIndex;
  }

  const resultLines: string[] = [];
  let foundFirstLine = false;

  for (let i = startingIndex; i < lines.length; i++) {
    let trimmed = lines[i].trim();
    if (!foundFirstLine) {
      if (!trimmed) continue;
      if (/^(here is (?:your |the |a |your first )?commit message|commit message|subject|提交信息|git commit|here's a thinking process|thinking process|analyze user input)\s*[:：.]?$/i.test(trimmed)) {
        continue;
      }
      trimmed = trimmed
        .replace(/^(commit message|subject|提交信息)\s*[:：]\s*/i, "")
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
        .trim();
      if (!trimmed) continue;

      // Clean leading list numbers/dots/spaces/bold tags from conventional commit prefix
      const cleanPrefixMatch = trimmed.match(/^(?:\d+\.\s*)?(?:\*\*)?((?:feat|fix|chore|refactor|docs|style|test|perf|ci|build|revert)(?:\(.+?\))?)(?:\*\*)?\s*:\s*(.*)$/i);
      if (cleanPrefixMatch) {
        trimmed = `${cleanPrefixMatch[1].toLowerCase()}: ${cleanPrefixMatch[2].trim()}`;
      }

      foundFirstLine = true;
    }
    resultLines.push(stripInlineCommitMarkdown(trimmed));
  }

  const finalMessage = resultLines.join("\n").trim();
  if (finalMessage.length < 3) return null;
  return finalMessage;
}

function isDetailedEnoughGitCommitMessage(message: string, entries: GitDiffEntry[], status?: GitStatus | null) {
  const lines = message.split(/\r?\n/);
  const meaningfulLines = lines.map((line) => line.trim()).filter(Boolean);
  if (meaningfulLines.length < 2) return false;

  const bodyLines = meaningfulLines.slice(1).filter((line) => {
    const normalized = line.replace(/^[-*]\s+/, "").trim();
    return normalized.length >= 16;
  });
  const changedFiles = entries.length > 0 ? entries.length : status?.changedFiles ?? 0;
  const requiredBodyLines = changedFiles <= 1 ? 1 : changedFiles <= 3 ? 2 : 3;
  if (bodyLines.length < requiredBodyLines) return false;

  const bodyText = bodyLines.join("\n").toLowerCase();
  if (/files changed|insertions?|deletions?|新增\/调整|移除\/替换/i.test(bodyText) || /覆盖\s*\d+\s*个文件|行新增|行删除/.test(bodyText)) {
    return false;
  }

  const coverageHints = new Set<string>();
  for (const group of buildCommitChangeGroups(entries)) {
    coverageHints.add(group.zhLabel.toLowerCase());
    coverageHints.add(group.enLabel.toLowerCase());
    for (const keyword of group.keywords) coverageHints.add(keyword.toLowerCase());
  }
  for (const entry of entries.slice(0, MAX_FALLBACK_FILES)) {
    for (const token of splitPathTokens(entry.path)) {
      if (token.length >= 3) coverageHints.add(token.toLowerCase());
    }
    const basename = entry.path.split(/[\\/]/).pop()?.replace(/\.[a-z0-9]+$/i, "") || "";
    if (basename.length >= 3) coverageHints.add(basename.toLowerCase());
  }

  if (coverageHints.size === 0) return true;
  return Array.from(coverageHints).some((hint) => bodyText.includes(hint));
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

  lines.push("", "Per-file change summaries:");
  for (const entry of entries.slice(0, MAX_DIFF_FILES)) {
    appendLimited(lines, buildEntryPromptSummary(entry), MAX_DIFF_CHARS);
  }

  lines.push("", "Raw file excerpts for context:");
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
  try {
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
  } catch {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    if (!response.ok) throw new Error(`Commit message request failed: ${response.status}`);
    return response.json();
  }
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
        "You are an expert developer. Generate a clean, concise, yet detailed Git commit message (a subject and description body) based on the provided git diff.",
        "Your output MUST be wrapped inside <commit_message> and </commit_message> tags.",
        "Do NOT include any introductory text, explanations, or thinking process. Go straight to the <commit_message> tag.",
        "",
        "Format of the commit message inside the tags:",
        "<subject line starting with conventional commit type (feat/fix/chore/refactor/docs/style/test/perf/ci/build/revert), under 72 characters>",
        "",
        "<2-4 short plain-text summary bullets, grouped by change theme>",
        "",
        "CRITICAL RULES:",
        "- Do not return a subject-only message. Include a blank line and 2-4 body bullets.",
        "- Summarize by theme, feature, workflow, or component. Do not list every changed file.",
        "- Do not include file-count/stat lines such as 'covers N files', insertions, deletions, or raw Git stats.",
        "- Do not quote exact changed lines or frontmatter values. Do not use inline code/backticks.",
        "- Each bullet should explain a meaningful outcome from the diff, not generic wording such as 'update files' or 'improve code'.",
        "- Do NOT wrap the commit message in markdown code blocks (no ```). Only use the <commit_message> tags.",
        "- Do NOT include markdown headers, tables, numbering (like '1.', '2.', '3.'), explanations, conversational preambles, or postscripts. Return ONLY the xml-wrapped commit message.",
        "- Do NOT explain your process or mention 'Analyze User Input'. Just output the commit message directly.",
        params.language === "zh"
          ? "- Use clear, professional Chinese. Keep descriptions concise."
          : "- Use clear, professional English. Keep descriptions concise."
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Files changed: 2",
        "Insertions: 10",
        "Deletions: 2",
        "",
        "Changed files:",
        "- M src/components/Sidebar.tsx",
        "- M src/lib/gitCommitMessage.ts",
        "",
        "Diff excerpts:",
        "### M src/components/Sidebar.tsx",
        "--- old",
        "// old sidebar code",
        "--- new",
        "// new sidebar code with dynamic theme",
        "### M src/lib/gitCommitMessage.ts",
        "--- old",
        "// old git commit message code",
        "--- new",
        "// new git commit message code with XML tagging"
      ].join("\n"),
    },
    {
      role: "assistant",
      content: params.language === "zh"
        ? [
            "<commit_message>",
            "feat(git): 优化 Git 提交体验",
            "",
            "- 改进 Git 菜单的提交输入和提交后状态处理",
            "- 强化提交信息生成的摘要输出和格式稳定性",
            "</commit_message>"
          ].join("\n")
        : [
            "<commit_message>",
            "feat(git): improve Git commit workflow",
            "",
            "- Improve Git menu commit input and post-commit state handling",
            "- Strengthen summarized commit generation and output formatting",
            "</commit_message>"
          ].join("\n"),
    },
    {
      role: "user",
      content: buildDiffPromptContext(params.entries, params.status),
    },
  ];

  const cloudProtocol = normalizeCloudProtocol(isCloud ? params.config.cloud?.protocol : "openai");
  const cloudApiFormat = resolveEffectiveCloudApiFormat({
    protocol: isCloud ? params.config.cloud?.protocol : "openai",
    apiFormat: isCloud ? params.config.cloud?.apiFormat : "chat_completions",
    authMode: cloudAuthMode,
  });
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
    body = buildAnthropicRequestBody({ messages, model, maxTokens: 800, stream: false });
    headers = buildCloudHeaders("anthropic", params.config.cloud?.apiKey || "", true, params.config.cloud?.customHeaders, cloudAuthMode);
  } else if (isGeminiCloud) {
    const request = buildGeminiRequestForAuthMode(endpoint, { messages, model, maxTokens: 800 }, cloudAuthMode);
    url = request.url;
    body = request.body;
    headers = buildCloudHeaders("gemini", params.config.cloud?.apiKey || "", true, params.config.cloud?.customHeaders, cloudAuthMode);
  } else {
    url = buildCloudMessagesApiUrl(endpoint, "openai", cloudApiFormat);
    body = cloudApiFormat === "responses"
      ? {
          model,
          ...(extractOpenAiResponsesInstructions(messages) ? { instructions: extractOpenAiResponsesInstructions(messages) } : {}),
          input: buildOpenAiResponsesInputCandidates(messages)[0].input,
          ...buildOpenAiResponsesRequestExtras({
            disableResponseStorage: params.config.cloud?.disableResponseStorage,
            reasoningEffort: "none",
          }),
          ...(cloudAuthMode === "openai_chatgpt_oauth" ? { user_prompt_id: "main-commit-message" } : {}),
        }
      : { model, messages, stream: false, max_tokens: 800 };
    headers = buildCloudHeaders("openai", isCloud ? params.config.cloud?.apiKey || "" : params.config.local?.apiKey || "", true, isCloud ? params.config.cloud?.customHeaders : undefined, cloudAuthMode);
  }

  const requestJson = params.requestJson || defaultRequestJson;
  let timerId: any;
  const timeout = new Promise<never>((_, reject) => {
    timerId = globalThis.setTimeout(() => reject(new Error("Commit message generation timed out")), 30_000);
  });
  try {
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

    return sanitizeGitCommitMessage(raw);
  } finally {
    globalThis.clearTimeout(timerId);
  }
}

export async function generateGitCommitMessage(params: GenerateGitCommitMessageParams): Promise<GeneratedGitCommitMessage> {
  try {
    const modelMessage = await requestModelCommitMessage(params);
    if (modelMessage && isDetailedEnoughGitCommitMessage(modelMessage, params.entries, params.status)) {
      return { message: modelMessage, source: "model" };
    }
  } catch {
    // Fall through to deterministic local generation.
  }

  return {
    message: buildFallbackGitCommitMessage(params.entries, params.language, params.status),
    source: "fallback",
  };
}

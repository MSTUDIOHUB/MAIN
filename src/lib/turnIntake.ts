export interface TurnInputContextSignals {
  imageParts: number;
  mentionedFilePaths: string[];
  attachedFilePaths: string[];
}

export interface TurnInputContextLike {
  imageParts?: number;
  mentionedFilePaths?: string[];
  attachedFilePaths?: string[];
}

type MessageLike = {
  role?: string;
  content?: unknown;
};

function uniq(values: string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function normalizeTurnInputContextSignals(input: TurnInputContextLike = {}): TurnInputContextSignals {
  const imageParts = Math.max(0, Math.floor(Number(input.imageParts || 0)));
  return {
    imageParts,
    mentionedFilePaths: uniq(input.mentionedFilePaths),
    attachedFilePaths: uniq(input.attachedFilePaths),
  };
}

export function hasTurnProvidedContext(signals: TurnInputContextLike = {}): boolean {
  const normalized = normalizeTurnInputContextSignals(signals);
  return (
    normalized.imageParts > 0 ||
    normalized.mentionedFilePaths.length > 0 ||
    normalized.attachedFilePaths.length > 0
  );
}

export function buildTurnIntakeContextBlock(input: {
  rawUserInput: string;
  signals: TurnInputContextLike;
  language: "zh" | "en";
  workflowMode?: "chat" | "edit" | "plan";
}): string {
  const signals = normalizeTurnInputContextSignals(input.signals);
  const hasContext = hasTurnProvidedContext(signals);
  if (!hasContext && !String(input.rawUserInput || "").trim()) return "";

  const rawUserInput = String(input.rawUserInput || "").trim();
  const lines: string[] = ["[turn_intake]"];
  lines.push(`workflowMode: ${input.workflowMode || "chat"}`);
  lines.push(`imageParts: ${signals.imageParts}`);
  lines.push(`mentionedFiles: ${signals.mentionedFilePaths.length}`);
  for (const path of signals.mentionedFilePaths.slice(0, 12)) {
    lines.push(`@file: ${path}`);
  }
  lines.push(`attachedFiles: ${signals.attachedFilePaths.length}`);
  for (const path of signals.attachedFilePaths.slice(0, 12)) {
    lines.push(`attachment: ${path}`);
  }

  if (input.language === "en") {
    lines.push(
      "priority: First understand the user's actual instruction and provided context before repository discovery.",
      "rules:",
      "- Treat images, attachments, and @ files as primary evidence, not decoration.",
      "- If imageParts > 0, first state the screenshot observations you can see, then map those observations to likely UI/state/code areas before reading files.",
      "- If @ files or attachments are present, inspect those exact paths before broad project discovery.",
      "- Do not start from root skeleton or broad directory sweeps when the user already provided visual/file context; use targeted search/read based on the observed phenomenon.",
    );
  } else {
    lines.push(
      "priority: 先理解用户真实指令和用户提供的上下文，再决定是否探索仓库。",
      "rules:",
      "- 图片、附件、@ 文件都是一等证据，不是装饰信息。",
      "- 如果 imageParts > 0，必须先说明从截图观察到的现象，再把现象映射到可能的 UI、状态或代码区域，然后才读取文件。",
      "- 如果存在 @ 文件或附件，必须优先围绕这些精确路径读取或查询，再考虑更大范围探索。",
      "- 用户已提供视觉/文件上下文时，不要从根目录骨架或大范围目录扫读开始；应根据观察到的现象做定向搜索/读取。",
    );
  }

  lines.push("[user_request]");
  lines.push(rawUserInput || (input.language === "en" ? "(empty visible text)" : "（用户未输入可见文本）"));
  lines.push("[/user_request]");
  lines.push("[/turn_intake]");
  return lines.join("\n");
}

export function extractPrimaryUserRequestText(text: string): string {
  const raw = String(text || "");
  const marked = raw.match(/\[user_request\]\s*([\s\S]*?)\s*\[\/user_request\]/i);
  if (marked) {
    const request = marked[1].trim();
    const originalPlan = raw.match(/(?:上一轮计划请求|Original plan request)[:：]\s*([\s\S]*?)(?:\n(?:现在必须|Produce real|每个 <option>|Keep any|用户最新消息|Latest user message|$))/i)?.[1]?.trim();
    const originalRequest = raw.match(/(?:上一轮原始请求|Original request)[:：]\s*([\s\S]*?)(?:\n(?:上一轮状态|Previous turn status|请从|Resume from|$))/i)?.[1]?.trim();
    const isContinuation = /^(?:继续|接着|继续生成|继续执行|继续推进|go on|continue|keep going)$/i.test(request);
    if (isContinuation && (originalPlan || originalRequest)) {
      return [originalPlan || originalRequest, request].filter(Boolean).join("\n");
    }
    return request;
  }

  const latestZh = raw.match(/用户最新消息：([\s\S]*?)(?:\n\n|\n\[|$)/);
  if (latestZh?.[1]?.trim()) return latestZh[1].trim();
  const latestEn = raw.match(/Latest user message:\s*([\s\S]*?)(?:\n\n|\n\[|$)/i);
  if (latestEn?.[1]?.trim()) return latestEn[1].trim();

  return raw.trim();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text || ""))
    .join("\n");
}

function countImageParts(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "image_url").length;
}

export function extractTurnInputContextSignalsFromMessages(messages: MessageLike[]): TurnInputContextSignals {
  const latestUser = [...(messages || [])].reverse().find((message) => message.role === "user");
  if (!latestUser) return normalizeTurnInputContextSignals();

  const text = contentText(latestUser.content);
  const mentionedFilePaths: string[] = [];
  const attachedFilePaths: string[] = [];
  for (const match of text.matchAll(/^@file:\s*(.+?)\s*$/gmi)) {
    mentionedFilePaths.push(match[1] || "");
  }
  for (const match of text.matchAll(/^attachment:\s*(.+?)\s*$/gmi)) {
    attachedFilePaths.push(match[1] || "");
  }
  for (const match of text.matchAll(/^\s*path:\s*(.+?)\s*$/gmi)) {
    const path = match[1] || "";
    if (text.includes("[user_mentioned_files]")) mentionedFilePaths.push(path);
  }
  for (const match of text.matchAll(/^\s*(?:originalPath|path):\s*(.+?)\s*$/gmi)) {
    const path = match[1] || "";
    if (/\[(?:attached_file|attached_document|attached_tabular_file)\]/i.test(text)) {
      attachedFilePaths.push(path);
    }
  }

  const intakeImage = text.match(/^imageParts:\s*(\d+)\s*$/mi);
  const imagePartsFromIntake = intakeImage ? Number(intakeImage[1]) : 0;
  return normalizeTurnInputContextSignals({
    imageParts: Math.max(countImageParts(latestUser.content), Number.isFinite(imagePartsFromIntake) ? imagePartsFromIntake : 0),
    mentionedFilePaths,
    attachedFilePaths,
  });
}

export function buildSemanticMetadataContextLines(input: {
  signals: TurnInputContextLike;
  language: "zh" | "en";
}): string[] {
  const signals = normalizeTurnInputContextSignals(input.signals);
  if (!hasTurnProvidedContext(signals)) return [];
  const lines = [
    `Image parts: ${signals.imageParts}`,
    `Mentioned @ files: ${signals.mentionedFilePaths.length}`,
    ...signals.mentionedFilePaths.slice(0, 6).map((path) => `- @ ${path}`),
    `Attached files: ${signals.attachedFilePaths.length}`,
    ...signals.attachedFilePaths.slice(0, 6).map((path) => `- attachment ${path}`),
  ];
  lines.push(input.language === "en"
    ? "Title/summary must reflect the user's actual task plus this visual/file context."
    : "标题/摘要必须体现用户真实任务以及这次图片/文件上下文。");
  return lines;
}

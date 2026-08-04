export type SubagentDelegationPreference =
  | "unspecified"
  | "forbidden"
  | "allowed"
  | "preferred";

/** Structured Turn-admission authority; never infer this field from model prose. */
export type DiagnosisOutcomeRequirement = "required" | "optional";

export interface TurnInputContextSignals {
  imageParts: number;
  mentionedFilePaths: string[];
  attachedFilePaths: string[];
  subagentPreference: SubagentDelegationPreference;
  diagnosisRequirement?: DiagnosisOutcomeRequirement;
}

export interface TurnInputContextLike {
  imageParts?: number;
  mentionedFilePaths?: string[];
  attachedFilePaths?: string[];
  subagentPreference?: SubagentDelegationPreference;
  diagnosisRequirement?: DiagnosisOutcomeRequirement;
}

const SUBAGENT_REFERENCE_RE = /(?:sub[\s_-]?agents?|子智能体|子代理|多智能体|multi[\s_-]?agents?|multiple\s+agents?)/i;
// A negative instruction about what a child may read or mutate is not a ban
// on delegation. Keep this predicate syntactically tied to enabling/using the
// child itself instead of treating arbitrary nearby negation as "forbidden".
const SUBAGENT_FORBIDDEN_RE = /(?:(?:不要|禁止|无需|不需要|别|不可|不能)\s*(?:再\s*)?(?:使用|启用|开启|调用|创建|启动|派遣|委派)\s*(?:任何\s*|一个\s*|多个\s*)?(?:sub[\s_-]?agents?|子智能体|子代理|多智能体)|(?:不要|禁止|无需|不需要|别|不可|不能)\s*(?:任何\s*|一个\s*|多个\s*)?(?:sub[\s_-]?agents?|子智能体|子代理|多智能体)\s*(?:参与|介入|协作|工作)?(?=$|[，,。.!！？?；;])|(?:do\s+not|don't)\s+(?:use\s+|spawn\s+|create\s+|enable\s+)(?:sub[\s_-]?agents?|multi[\s_-]?agents?|multiple\s+agents?)|without\s+(?:using\s+)?(?:sub[\s_-]?agents?|multi[\s_-]?agents?|multiple\s+agents?)|(?:^|[.!?;]\s*)no\s+(?:sub[\s_-]?agents?|multi[\s_-]?agents?|multiple\s+agents?)(?:\s+(?:for|in|on)\s+(?:this\s+)?(?:turn|task|request))?(?=$|[.!?;]))/i;
const SUBAGENT_REQUIRED_RE = /(?:(?:必须|务必|需要|请)\s*(?:(?:先|连续|立即|优先)\s*)*(?:调用|使用|启动|创建|派遣|委派)\s*(?:一个|多个|\d+\s*个|[一二三四五六七八九十]+\s*个)?\s*(?:spawn[\s_-]?sub[\s_-]?agent|sub[\s_-]?agents?|子智能体|子代理)|(?:must|required\s+to|need\s+to|please)\s+(?:first\s+)?(?:use|spawn|create|start|call)\s+(?:one|two|three|several|multiple|\d+)?\s*(?:spawn[\s_-]?sub[\s_-]?agent|sub[\s_-]?agents?|agents?))/i;
const SUBAGENT_PARALLEL_RE = /(?:(?:多个|两个|多开|并行|协同|分工).{0,32}(?:sub[\s_-]?agents?|子智能体|子代理|智能体)|(?:sub[\s_-]?agents?|子智能体|子代理|智能体).{0,32}(?:多个|两个|多开|并行|协同|分工)|(?:parallel|multiple|two|several|collaborat(?:e|ion)|divide\s+the\s+work).{0,32}(?:sub[\s_-]?agents?|agents?))/i;
const SUBAGENT_ALLOWED_RE = /(?:(?:可以|可用|允许|同意|可开启|可使用).{0,28}(?:sub[\s_-]?agents?|子智能体|子代理|多智能体)|(?:may|can|allowed\s+to|feel\s+free\s+to).{0,28}(?:use\s+|spawn\s+)?(?:sub[\s_-]?agents?|agents?))/i;

export function resolveSubagentDelegationPreference(input: string): SubagentDelegationPreference {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text || !SUBAGENT_REFERENCE_RE.test(text)) return "unspecified";
  const requiredDirective = SUBAGENT_REQUIRED_RE.exec(text);
  const forbiddenDirective = SUBAGENT_FORBIDDEN_RE.exec(text);
  if (requiredDirective && forbiddenDirective) {
    return requiredDirective.index > forbiddenDirective.index ? "preferred" : "forbidden";
  }
  if (requiredDirective) return "preferred";
  if (forbiddenDirective) return "forbidden";
  if (SUBAGENT_PARALLEL_RE.test(text)) return "preferred";
  if (SUBAGENT_ALLOWED_RE.test(text)) return "allowed";
  return "allowed";
}

export function normalizeSubagentDelegationPreference(
  value: unknown,
): SubagentDelegationPreference {
  return value === "forbidden" || value === "allowed" || value === "preferred"
    ? value
    : "unspecified";
}

export function resolveEffectiveSubagentDelegationPreference(input: {
  rawUserInput: string;
  defaultPreference?: SubagentDelegationPreference;
}): SubagentDelegationPreference {
  const explicitPreference = resolveSubagentDelegationPreference(input.rawUserInput);
  const defaultPreference = normalizeSubagentDelegationPreference(
    input.defaultPreference,
  );
  if (explicitPreference === "unspecified") return defaultPreference;
  if (explicitPreference === "forbidden") return "forbidden";
  if (explicitPreference === "preferred") return "preferred";
  // The Composer collaboration switch is a durable preference for this Turn,
  // not an instruction to spawn at a particular lifecycle boundary.
  // Permissive wording such as "可以启动子智能体" agrees with that preference
  // and must not silently weaken it from preferred to allowed.
  return defaultPreference === "preferred" ? "preferred" : "allowed";
}

/**
 * Give the model the collaboration method at Turn admission, before it has
 * chosen an inspection or implementation action. Tool schemas remain the
 * effect boundary; this text teaches decomposition and never requires a
 * spawn at a particular lifecycle stage.
 */
export function buildSubagentDelegationGuidance(input: {
  readonly preference: SubagentDelegationPreference;
  readonly language: "zh" | "en";
}): string {
  if (input.preference === "forbidden") {
    return input.language === "en"
      ? "The user explicitly disabled subagents for this turn."
      : "用户明确要求本轮不使用子智能体。";
  }
  if (
    input.preference !== "preferred" &&
    input.preference !== "allowed"
  ) {
    return "";
  }
  const availability = input.preference === "preferred"
    ? input.language === "en"
      ? "Collaboration is enabled for this turn."
      : "本轮已开启协作。"
    : input.language === "en"
      ? "Collaboration is available for this turn."
      : "本轮允许按需协作。";
  return input.language === "en"
    ? [
        availability,
        "During intent analysis, identify genuinely independent work, dependencies, and exact ownership; invoke spawn_subagent only when that tool is actually exposed. Spawning is optional at every inspect, edit, and verify stage and is never a prerequisite for mutation or completion.",
        "Parallelize bounded investigation, review, or validation when it can overlap useful parent work.",
        "Each child receives a curated context capsule—its self-contained objective, relevant exact source/evidence, constraints, and any active implementation contract—not the parent's hidden reasoning or full transcript. Assign enough explicit evidence and boundaries for the child to finish and report independently.",
        "Delegate implementation only after the parent has an evidence-backed solution: assign a create/modify/delete operation, a concrete implementation plan and success criteria, and every exact non-overlapping file target. Do not grant a directory and let the child choose mutation targets. Each implementation child stages one transaction; Runtime revalidates and commits it at join.",
        "The parent continues non-dependent work, waits only when a child result becomes a dependency, integrates returned evidence or mutations, and owns final validation and completion. Never delegate merely because the current action failed or is difficult; never split by directory alone or reuse a terminal child.",
      ].join(" ")
    : [
        availability,
        "分析用户意图时就识别真正独立的工作、依赖关系和精确责任范围；只有实际暴露 spawn_subagent 工具时才可调用。读取、修改或验证任一阶段都可根据实际工作量自行判断是否启动，但绝不强制，也不是写入或完成的前置条件。",
        "能与主体有效重叠时，可并行委派范围明确的调查、评审或验证。",
        "每个子智能体只接收父线程整理的上下文胶囊：可独立理解的目标、相关精确源码/证据、约束和现行实施契约；不会继承父线程隐藏推理或完整对话。分配时必须给足证据和边界，使其能独立完成并回报。",
        "只有父线程已形成证据化方案后才能委派实现：必须指定 create/modify/delete 操作、具体 implementation_plan、成功标准和每个精确且互不重叠的文件目标；不能只授权目录再让子智能体自行选择修改目标。每个实现子智能体只暂存一个事务，由 Runtime 在汇合时重新校验并提交。",
        "父线程继续推进不依赖子结果的工作，只在结果成为依赖时等待，负责整合返回的证据或修改，并承担最终验证与完成。不得因当前动作失败或困难而甩给子智能体，不得只按目录拆分或复用已终止实例。",
      ].join("");
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
  const diagnosisRequirement = input.diagnosisRequirement === "required" ||
      input.diagnosisRequirement === "optional"
    ? input.diagnosisRequirement
    : undefined;
  return {
    imageParts,
    mentionedFilePaths: uniq(input.mentionedFilePaths),
    attachedFilePaths: uniq(input.attachedFilePaths),
    subagentPreference: normalizeSubagentDelegationPreference(input.subagentPreference),
    ...(diagnosisRequirement ? { diagnosisRequirement } : {}),
  };
}

export function hasTurnProvidedContext(signals: TurnInputContextLike = {}): boolean {
  const normalized = normalizeTurnInputContextSignals(signals);
  return (
    normalized.imageParts > 0 ||
    normalized.mentionedFilePaths.length > 0 ||
    normalized.attachedFilePaths.length > 0 ||
    normalized.diagnosisRequirement !== undefined
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
  const subagentPreference = resolveEffectiveSubagentDelegationPreference({
    rawUserInput,
    defaultPreference: signals.subagentPreference,
  });
  const lines: string[] = ["[turn_intake]"];
  lines.push(`workflowMode: ${input.workflowMode || "chat"}`);
  lines.push(`subagentPreference: ${subagentPreference}`);
  if (signals.diagnosisRequirement) {
    lines.push(`diagnosisRequirement: ${signals.diagnosisRequirement}`);
  }
  lines.push(`imageParts: ${signals.imageParts}`);
  lines.push(`mentionedFiles: ${signals.mentionedFilePaths.length}`);
  for (const path of signals.mentionedFilePaths.slice(0, 12)) {
    lines.push(`@file: ${path}`);
  }

  const delegationGuidance = buildSubagentDelegationGuidance({
    preference: subagentPreference,
    language: input.language,
  });
  if (delegationGuidance) {
    lines.push(`delegation: ${delegationGuidance}`);
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
  const intakeBlock = text.match(/\[turn_intake\]([\s\S]*?)\[\/turn_intake\]/i)?.[1] || "";
  const intakeSubagentPreference = intakeBlock.match(
    /^subagentPreference:\s*(unspecified|forbidden|allowed|preferred)\s*$/mi,
  )?.[1];
  const intakeDiagnosisRequirement = intakeBlock.match(
    /^diagnosisRequirement:\s*(required|optional)\s*$/mi,
  )?.[1];
  return normalizeTurnInputContextSignals({
    imageParts: Math.max(countImageParts(latestUser.content), Number.isFinite(imagePartsFromIntake) ? imagePartsFromIntake : 0),
    mentionedFilePaths,
    attachedFilePaths,
    subagentPreference: normalizeSubagentDelegationPreference(intakeSubagentPreference),
    diagnosisRequirement: intakeDiagnosisRequirement === "required" || intakeDiagnosisRequirement === "optional"
      ? intakeDiagnosisRequirement
      : undefined,
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
  if (signals.diagnosisRequirement) {
    lines.push(`Diagnosis outcome requirement: ${signals.diagnosisRequirement}`);
  }
  lines.push(input.language === "en"
    ? "Title/summary must reflect the user's actual task plus this visual/file context."
    : "标题/摘要必须体现用户真实任务以及这次图片/文件上下文。");
  return lines;
}

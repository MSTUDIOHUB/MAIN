import { deriveToolPhase, type ToolPresentationLanguage } from "./toolPresentation";

export type TurnRuntimePhaseKind = "scope" | "context" | "diagnosis" | "implementation" | "validation";
export type TurnRuntimePhaseStatus = "pending" | "running" | "done" | "failed";

export interface TurnRuntimePhase {
  id: string;
  kind: TurnRuntimePhaseKind;
  title: string;
  summary?: string;
  domain?: string;
  status?: TurnRuntimePhaseStatus;
}

const PHASE_TITLES: Record<TurnRuntimePhaseKind, { zh: string; en: string }> = {
  scope: { zh: "范围归纳", en: "Scope" },
  context: { zh: "关键上下文", en: "Key Context" },
  diagnosis: { zh: "归因方案", en: "Diagnosis" },
  implementation: { zh: "实施修改", en: "Implementation" },
  validation: { zh: "验证结果", en: "Validation" },
};

const PHASE_SUMMARIES: Record<TurnRuntimePhaseKind, { zh: string; en: string }> = {
  scope: { zh: "先把任务拆成稳定阶段，锁定相关范围和约束。", en: "Break the task into stable phases and identify the relevant scope." },
  context: { zh: "读取和分析最小必要上下文，为归因和修改提供证据。", en: "Read and analyze the smallest useful context before deciding the fix." },
  diagnosis: { zh: "收束已读证据，形成问题归因、方案取舍和下一步决策。", en: "Condense the evidence into causes, tradeoffs, and the next decision." },
  implementation: { zh: "按已确认的方案实施文件或配置修改。", en: "Apply the confirmed changes to files or configuration." },
  validation: { zh: "运行构建、测试或人工可见验证，确认结果满足目标。", en: "Run checks or visible validation to confirm the result." },
};

function languageOrZh(language?: ToolPresentationLanguage): ToolPresentationLanguage {
  return language === "en" ? "en" : "zh";
}

export function makeTurnRuntimePhase(
  kind: TurnRuntimePhaseKind,
  language?: ToolPresentationLanguage,
  options: Partial<Omit<TurnRuntimePhase, "kind">> = {},
): TurnRuntimePhase {
  const resolvedLanguage = languageOrZh(language);
  return {
    id: options.id || kind,
    kind,
    title: options.title || PHASE_TITLES[kind][resolvedLanguage],
    summary: options.summary || PHASE_SUMMARIES[kind][resolvedLanguage],
    domain: options.domain,
    status: options.status || "running",
  };
}

export function normalizeTurnRuntimePhase(
  value: unknown,
  language?: ToolPresentationLanguage,
): TurnRuntimePhase | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const kind = String(candidate.kind || "") as TurnRuntimePhaseKind;
  if (!["scope", "context", "diagnosis", "implementation", "validation"].includes(kind)) {
    return undefined;
  }
  const phase = makeTurnRuntimePhase(kind, language, {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : kind,
    title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title.trim() : undefined,
    summary: typeof candidate.summary === "string" && candidate.summary.trim() ? candidate.summary.trim() : undefined,
    domain: typeof candidate.domain === "string" && candidate.domain.trim() ? candidate.domain.trim() : undefined,
    status: ["pending", "running", "done", "failed"].includes(String(candidate.status || ""))
      ? String(candidate.status) as TurnRuntimePhaseStatus
      : undefined,
  });
  return phase;
}

export function withTurnRuntimePhaseStatus(
  phase: TurnRuntimePhase | undefined,
  status: TurnRuntimePhaseStatus,
  language?: ToolPresentationLanguage,
): TurnRuntimePhase | undefined {
  const normalized = normalizeTurnRuntimePhase(phase, language);
  return normalized ? { ...normalized, status } : undefined;
}

export function deriveTurnPhaseDomain(toolName: string, target = ""): string {
  const tool = String(toolName || "");
  const value = `${tool} ${target}`.replace(/\\/g, "/").toLowerCase();

  if (/\.protocols\/|design-md|design\.md|awesome-design/.test(value)) return "design_protocol";
  if (/theme|themestyles|app\.css|index\.css|sidebar|color|palette|light|dark|black/.test(value)) return "theme_ui";
  if (/csv|tsv|xlsx|excel|tabular|parser|upload|dragupload|dashboardstore|order|coursecleaner|数据|导入/.test(value)) return "data_pipeline";
  if (/chart|trend|monthly|compare|pie|heatmap|overview|buyer|dashboard|recharts|图表|趋势|环比/.test(value)) return "chart_rendering";
  if (/layout|topisland|composer|chatarea|time|header|title|grid|flex|遮挡/.test(value)) return "layout";
  if (/test|build|lint|typecheck|playwright|browser_evaluate|computer_use|vitest|jest|pytest|cargo/.test(value)) return "validation";
  if (/src\/|components\/|hooks\/|store\/|lib\//.test(value)) return "source";
  if (/pty|terminal|command|shell|run_command|execute_command/.test(value)) return "terminal";
  return "workspace";
}

export function deriveTurnRuntimePhaseForTool(input: {
  toolName: string;
  target?: string;
  language?: ToolPresentationLanguage;
  status?: TurnRuntimePhaseStatus;
}): TurnRuntimePhase {
  const toolPhase = deriveToolPhase({
    toolName: input.toolName,
    target: input.target,
    toolStatus: input.status === "failed" ? "failed" : input.status,
  });
  const domain = deriveTurnPhaseDomain(input.toolName, input.target || "");
  const kind: TurnRuntimePhaseKind =
    toolPhase === "discover" ? "scope" :
    toolPhase === "inspect" ? "context" :
    toolPhase === "edit" ? "implementation" :
    toolPhase === "verify" || toolPhase === "command" ? "validation" :
    input.status === "failed" ? "diagnosis" :
    "context";
  return makeTurnRuntimePhase(kind, input.language, {
    domain,
    status: input.status || "running",
  });
}

export function deriveTurnRuntimePhaseForText(
  text: string,
  language?: ToolPresentationLanguage,
  fallback?: TurnRuntimePhase,
): TurnRuntimePhase {
  const value = String(text || "").toLowerCase();
  if (/归因|方案|原因|取舍|收束|diagnos|root cause|tradeoff|proposal|user_options/.test(value)) {
    return makeTurnRuntimePhase("diagnosis", language, { domain: fallback?.domain, status: "running" });
  }
  if (/验证|测试|构建|build|test|verify/.test(value)) {
    return makeTurnRuntimePhase("validation", language, { domain: fallback?.domain, status: "running" });
  }
  if (/修改|实现|修复|编辑|write|replace|implement|fix|edit/.test(value)) {
    return makeTurnRuntimePhase("implementation", language, { domain: fallback?.domain, status: "running" });
  }
  if (/读取|检查|上下文|分析|read|inspect|context|analyz/.test(value)) {
    return makeTurnRuntimePhase("context", language, { domain: fallback?.domain, status: "running" });
  }
  return normalizeTurnRuntimePhase(fallback, language) || makeTurnRuntimePhase("scope", language);
}

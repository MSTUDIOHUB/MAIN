import { sanitizePlanArtifactContent } from "./sanitize";
import {
  validatePlanArtifactContent,
  type PlanStage,
} from "./workflowModels";

export type MaterializablePlanKind = "design";

export interface PlanMaterializationResult {
  ok: boolean;
  kind?: MaterializablePlanKind;
  path?: string;
  content?: string;
  reason?: string;
}

const PROTOCOL_NOISE_RE = /<\/?(?:tool_use|tool_call|function_call|tool|parameter|user_options|option)\b/i;
const PROPOSAL_MARKER_RE = /^\s*\[PROPOSAL START\]\s*$/gim;

function countPlanShapeSignals(content: string): number {
  const headingCount = (content.match(/^#{1,3}\s+\S+/gm) || []).length;
  const bulletCount = (content.match(/^\s*(?:[-*]|\d+[.)、])\s+\S+/gm) || []).length;
  const keywordCount = (content.match(/目标|约束|发现|方案|设计|执行|接口|文件|数据流|控制流|风险|验证|开放问题|Goal|Constraint|Finding|Approach|Design|Interface|File|Flow|Risk|Validation|Open question/gi) || []).length;
  return headingCount + Math.min(bulletCount, 6) + Math.min(keywordCount, 8);
}

function normalizePlanContent(rawText: string): string {
  const withoutProposalMarkers = rawText.replace(PROPOSAL_MARKER_RE, "").trim();
  const strippedPlanJson = withoutProposalMarkers.replace(/<plan>[\s\S]*?<\/plan>/gi, "").trim();
  const sanitized = sanitizePlanArtifactContent(strippedPlanJson);
  if (/^#\s+/m.test(sanitized)) return sanitized;
  return `# Design\n\n${sanitized}`;
}

export function materializePlanArtifactFromVisibleText(input: {
  visibleText: string;
  planStage?: PlanStage | null;
  preferredKind?: MaterializablePlanKind | null;
}): PlanMaterializationResult {
  const raw = String(input.visibleText || "").trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (PROTOCOL_NOISE_RE.test(raw)) return { ok: false, reason: "protocol_noise" };
  if (raw.length < 280) return { ok: false, reason: "too_short" };

  const kind: MaterializablePlanKind = "design";
  const content = normalizePlanContent(raw);
  if (countPlanShapeSignals(content) < 5) return { ok: false, reason: "not_structured" };

  const validation = validatePlanArtifactContent(content, kind);
  if (!validation.ok) return { ok: false, reason: validation.reason || "quality_gate" };

  return {
    ok: true,
    kind,
    path: ".MAIN/plans/design.md",
    content,
  };
}

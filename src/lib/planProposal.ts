export type PlanJobStatus = "pending" | "in_progress" | "completed";

export interface PlanJobItem {
  id: string;
  subject: string;
  status: PlanJobStatus;
}

export interface StructuredPlanProposal {
  markdown: string;
  jobs: PlanJobItem[];
}

const STAGE_TAG_RE = /\[STAGE:\s*(REQUIREMENTS|DESIGN|TASKS|BUGFIX)\]/i;
const DRAFT_SECTION_RE =
  /(验收标准|Acceptance Criteria|下一步计划|后续步骤|System Requirements|用户故事|User Story|需求条目|Requirements|Design|Implementation)/i;

const REASONING_BLOCK_RE =
  /<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi;

const PROPOSAL_START_RE = /^\s*\[PROPOSAL START\]\s*$/im;
const PROPOSAL_TITLE_RE = /^\s*#\s*Proposed Plan\s*$/im;
const PROPOSAL_END_RE = /^\s*\[PROPOSAL END\]\s*$/gim;
const PLAN_BLOCK_RE = /<plan>([\s\S]*?)<\/plan>/i;
const STRUCTURED_PLAN_LINE_RE = /^\s*(?:##\s+\S+|[-*]\s+\S+|\d+\.\s+\S+|\|.+\|)\s*$/gm;

function stripReasoningBlocks(text: string): string {
  return text.replace(REASONING_BLOCK_RE, "");
}

export function parsePlanJobs(content: string): PlanJobItem[] | null {
  try {
    const parsed = JSON.parse(content.trim());
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const jobs: PlanJobItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;

      const rawId = "id" in item ? String(item.id ?? "").trim() : "";
      const rawSubject =
        typeof item.subject === "string"
          ? item.subject.trim()
          : typeof item.title === "string"
          ? item.title.trim()
          : "";

      if (!rawId || !rawSubject) return null;

      const rawStatus = "status" in item ? String(item.status ?? "").trim() : "";
      const status: PlanJobStatus =
        rawStatus === "completed" || rawStatus === "in_progress" || rawStatus === "pending"
          ? rawStatus
          : "pending";

      jobs.push({
        id: rawId,
        subject: rawSubject,
        status,
      });
    }

    return jobs;
  } catch {
    return null;
  }
}

function hasStructuredPlanMarkdown(markdown: string): boolean {
  const withoutTitle = markdown.replace(PROPOSAL_TITLE_RE, "").trim();
  if (withoutTitle.length < 80) return false;

  const meaningfulLines = withoutTitle
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (meaningfulLines.length < 3) return false;

  const structuredLines = withoutTitle.match(STRUCTURED_PLAN_LINE_RE) ?? [];
  return structuredLines.length >= 2;
}

function hasPlanDraftStructure(markdown: string): boolean {
  const meaningfulLines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (meaningfulLines.length < 5 || markdown.length < 180) return false;

  const structuralCount =
    (markdown.match(STRUCTURED_PLAN_LINE_RE) ?? []).length +
    (markdown.match(/^\s*[-*]\s+\[[ xX]\]\s+.+$/gm) ?? []).length;

  return structuralCount >= 3;
}

export function extractStructuredPlanProposal(text: string): StructuredPlanProposal | null {
  if (!text.trim()) return null;

  const rootText = stripReasoningBlocks(text);
  const planMatch = rootText.match(PLAN_BLOCK_RE);
  if (!planMatch || planMatch.index == null) return null;

  const jobs = parsePlanJobs(planMatch[1] ?? "");
  if (!jobs) return null;

  const proposalStart = rootText.match(PROPOSAL_START_RE);
  const proposalTitle = rootText.match(PROPOSAL_TITLE_RE);

  if (!proposalStart || proposalStart.index == null || !proposalTitle || proposalTitle.index == null) {
    return null;
  }

  if (proposalTitle.index < proposalStart.index) return null;
  if (planMatch.index <= proposalTitle.index) return null;

  const markdown = rootText
    .slice(proposalStart.index + proposalStart[0].length, planMatch.index)
    .replace(PROPOSAL_END_RE, "")
    .trim();

  if (!PROPOSAL_TITLE_RE.test(markdown)) return null;
  if (!hasStructuredPlanMarkdown(markdown)) return null;

  return { markdown, jobs };
}

export function hasStructuredPlanProposal(text: string): boolean {
  return extractStructuredPlanProposal(text) !== null;
}

export function extractPlanDraftPreview(text: string): string | null {
  if (!text.trim()) return null;

  const rootText = stripReasoningBlocks(text)
    .replace(/<plan>[\s\S]*?<\/plan>/gi, "")
    .replace(PROPOSAL_START_RE, "")
    .replace(PROPOSAL_END_RE, "")
    .trim();

  if (!rootText) return null;
  if (!STAGE_TAG_RE.test(rootText) && !DRAFT_SECTION_RE.test(rootText)) return null;
  if (!hasPlanDraftStructure(rootText)) return null;

  return rootText;
}

export function hasPlanDraftPreview(text: string): boolean {
  return extractPlanDraftPreview(text) !== null;
}

// ── Tiered Plan Output Support ──────────────────────────────────────
// Accept the supported document/protocol shapes without inferring anything
// about the model that produced them.
// Tier 1 = full structured protocol.
// Tier 2 = <proposed_plan> wrapped Markdown.
// Tier 3 = plain structured Markdown compatibility output.

export interface TextPlanProposal {
  kind: "tier2_proposed_plan" | "tier3_plaintext";
  markdown: string;
}

type TieredPlanResult = StructuredPlanProposal | TextPlanProposal;

// Detect the plan output tier from model text
export function detectPlanTier(text: string): 1 | 2 | 3 | 0 {
  if (!text.trim()) return 0;
  const rootText = stripReasoningBlocks(text);

  // Tier 1: [PROPOSAL START] ... <plan>{...}</plan> ... [PROPOSAL END]
  if (PROPOSAL_START_RE.test(rootText) && PLAN_BLOCK_RE.test(rootText)) {
    return 1;
  }

  // Tier 2: <proposed_plan> ... </proposed_plan>
  if (/<proposed_plan(?:\s[^>]*)?>([\s\S]*?)<\/proposed_plan>/i.test(rootText)) {
    return 2;
  }

  // Tier 3: Plain markdown with plan-like structure (headings + structured lines)
  const headingRe = /^#{1,4}\s+\S+/gm;
  const bulletRe = /^\s*[-*]\s+\S+/gm;
  const numberedRe = /^\d+\.\s+\S+/gm;
  const tableRe = /^\|.+\|/gm;
  const headingMatches = rootText.match(headingRe);
  const bulletMatches = rootText.match(bulletRe);
  const numberedMatches = rootText.match(numberedRe);
  const tableMatches = rootText.match(tableRe);

  const structuredCount = [headingMatches, bulletMatches, numberedMatches, tableMatches]
    .filter(Boolean).reduce((sum, arr) => sum + arr!.length, 0);

  if (structuredCount >= 3 && rootText.length >= 120) {
    return 3;
  }

  return 0;
}

// Extract plan from any tier, returning a unified result
export function extractTieredPlanProposal(text: string): TieredPlanResult | null {
  if (!text.trim()) return null;

  const rootText = stripReasoningBlocks(text);

  // Tier 1: Full structured format
  const tier1 = extractStructuredPlanProposal(text);
  if (tier1) return tier1;

  // Tier 2: <proposed_plan> wrapper
  const proposedPlanMatch = rootText.match(/<proposed_plan(?:\s[^>]*)?>([\s\S]*?)<\/proposed_plan>/i);
  if (proposedPlanMatch && proposedPlanMatch[1]) {
    const content = proposedPlanMatch[1].trim();
    if (content.length >= 80 && content.split('\n').filter(Boolean).length >= 3) {
      return { kind: "tier2_proposed_plan", markdown: content };
    }
  }

  // Tier 3: Plain structured markdown
  const stripped = rootText
    .replace(/<proposed_plan[\s\S]*?<\/proposed_plan>/gi, "")
    .replace(PROPOSAL_START_RE, "")
    .replace(PROPOSAL_END_RE, "")
    .replace(/<plan>[\s\S]*?<\/plan>/gi, "")
    .trim();

  if (stripped.length >= 120) {
    const headingRe = /^#{1,4}\s+\S+/gm;
    const bulletRe = /^\s*[-*]\s+\S+/gm;
    const numberedRe = /^\d+\.\s+\S+/gm;
    const tableRe = /^\|.+\|/gm;
    const structuredCount = [
      stripped.match(headingRe) || [],
      stripped.match(bulletRe) || [],
      stripped.match(numberedRe) || [],
      stripped.match(tableRe) || [],
    ].filter(Boolean).reduce((sum, arr) => sum + arr!.length, 0);

    if (structuredCount >= 3) {
      return { kind: "tier3_plaintext", markdown: stripped };
    }
  }

  return null;
}

export function hasTieredPlanProposal(text: string): boolean {
  return extractTieredPlanProposal(text) !== null;
}

/**
 * Returns true only when the model used an explicit proposal protocol.
 *
 * Plain structured Markdown is intentionally excluded here. It is a useful
 * compatibility fallback while the runtime is already in Plan mode, but the
 * same shape is also used by completion summaries, reviews, and reports.
 */
export function hasExplicitPlanProposal(text: string): boolean {
  const proposal = extractTieredPlanProposal(text);
  return proposal !== null && (!("kind" in proposal) || proposal.kind === "tier2_proposed_plan");
}

// Normalize any tier to a unified format that the runtime can consume
export function normalizePlanProposal(proposal: TieredPlanResult): StructuredPlanProposal {
  if ("jobs" in proposal) {
    return proposal;
  }
  // Convert Tier 2/3 to StructuredPlanProposal with empty jobs
  return { markdown: proposal.markdown, jobs: [] };
}

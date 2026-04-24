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

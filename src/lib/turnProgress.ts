import { parsePlanJobs, type PlanJobItem } from "./planProposal";

export type TurnProgressStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TurnProgressItem {
  id: string;
  text: string;
  status: TurnProgressStatus;
}

interface ProgressBlock {
  id?: number | string;
  type?: string;
  content?: string;
  streaming?: boolean;
  jobs?: Array<{ id: string; subject: string; status: string }>;
  toolName?: string;
  target?: string;
  toolStatus?: string;
}

const PLAN_BLOCK_RE = /<plan>([\s\S]*?)<\/plan>/gi;

function normalizeJobStatus(status: string): TurnProgressStatus {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in_progress";
  if (status === "failed") return "failed";
  return "pending";
}

function parsePlanJobsFromAgentContent(content: string): PlanJobItem[] | null {
  let latest: PlanJobItem[] | null = null;
  let match: RegExpExecArray | null;
  PLAN_BLOCK_RE.lastIndex = 0;

  while ((match = PLAN_BLOCK_RE.exec(content)) !== null) {
    const parsed = parsePlanJobs(match[1] || "");
    if (parsed && parsed.length > 0) latest = parsed;
  }

  return latest;
}

function mapJobsToProgressItems(jobs: PlanJobItem[]): TurnProgressItem[] {
  return jobs.map((job, index) => ({
    id: String(job.id || index + 1),
    text: job.subject,
    status: normalizeJobStatus(job.status),
  }));
}

function findLatestExplicitProgress(blocks: ProgressBlock[]): TurnProgressItem[] {
  let latestIndex = -1;
  let latestItems: TurnProgressItem[] = [];

  blocks.forEach((block, index) => {
    if (block.type === "jobList" && Array.isArray(block.jobs) && block.jobs.length > 0) {
      latestIndex = index;
      latestItems = block.jobs.map((job, jobIndex) => ({
        id: String(job.id || jobIndex + 1),
        text: String(job.subject || "").trim(),
        status: normalizeJobStatus(String(job.status || "")),
      })).filter((item) => item.text.length > 0);
      return;
    }

    if (block.type !== "agent" || block.streaming) return;
    const parsed = parsePlanJobsFromAgentContent(String(block.content || ""));
    if (!parsed || parsed.length === 0 || index < latestIndex) return;
    latestIndex = index;
    latestItems = mapJobsToProgressItems(parsed);
  });

  return latestItems;
}

export function deriveTurnProgressItems(
  blocks: ProgressBlock[],
  _language: "zh" | "en" = "zh",
): TurnProgressItem[] {
  const explicitItems = findLatestExplicitProgress(blocks);
  if (explicitItems.length > 0) return explicitItems;
  return [];
}

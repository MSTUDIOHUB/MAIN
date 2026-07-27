import type { RuntimeV2SubagentJob } from "../../lib/runtime-v2";
import { stringValue } from "./executionText";
import type { RuntimeV2SubagentCandidate } from "./executionTypes";

export function childScopeAllows(
  job: RuntimeV2SubagentJob,
  args: Record<string, unknown>,
): boolean {
  const candidate = stringValue(
    args.path || args.file_path || args.cwd || "",
    2_000,
  )
    .replace(/^\.\//, "")
    .replace(/\\/g, "/");
  if (
    !candidate ||
    candidate === "." ||
    candidate.startsWith("/") ||
    candidate.startsWith("../")
  ) {
    return false;
  }
  return job.allowedPaths.some((root) =>
    candidate === root ||
    candidate.startsWith(`${root.replace(/\/$/, "")}/`)
  );
}

export function deriveSubagentCandidates(
  overview: string,
  objective: string,
): RuntimeV2SubagentCandidate[] {
  const source = String(overview || "").replace(/\\/g, "/");
  const candidates: RuntimeV2SubagentCandidate[] = [];
  const add = (
    scopeKey: string,
    allowedPath: string,
    description: string,
  ) => {
    if (candidates.some((candidate) => candidate.scopeKey === scopeKey)) return;
    candidates.push({
      scopeKey,
      objective: `${description}。围绕用户目标：${objective.slice(0, 600)}`,
      allowedPaths: [allowedPath],
    });
  };
  if (/(?:^|[\s\[\/])src(?:[\]\s/]|$)/m.test(source)) {
    add("frontend", "src", "调查前端实现、事件消费与交互路径");
  }
  if (/(?:^|[\s\[\/])src-tauri(?:[\]\s/]|$)/m.test(source)) {
    add("backend", "src-tauri", "调查桌面后端、文件对话框与 IPC 路径");
  }
  return candidates.slice(0, 2);
}

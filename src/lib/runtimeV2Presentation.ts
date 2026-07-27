import type { MainThreadEvent, MainThreadProgressUpdate } from "./turnEvents";

export interface RuntimeV2CompatibleCapsuleProjection {
  readonly markdown: string;
  readonly source: "structured_runtime";
  readonly updatedAt: number;
  readonly dedupeKey: string;
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function progressKey(event: Extract<MainThreadEvent, { type: "progress.updated" }>): string {
  const progress = event.progress;
  return [
    event.runId || "",
    progress.dedupeKey || "",
    progress.tool || "",
    progress.canonicalTarget || progress.target || "",
    progress.phase || "",
  ].join("\u0000");
}

function actionLine(progress: MainThreadProgressUpdate, language: "zh" | "en"): string {
  const title = normalize(progress.title);
  const tool = normalize(progress.tool);
  const target = normalize(progress.canonicalTarget || progress.target);
  const action = normalize(progress.action);
  const targetMarkdown = target ? `\`${target.replace(/`/g, "")}\`` : "";
  if (tool === "read_file" || tool === "read_document" || tool === "get_file_outline") {
    return language === "zh"
      ? `正在读取 ${targetMarkdown || "当前文件"}，确认与当前问题相关的实现。`
      : `Reading ${targetMarkdown || "the current file"} to confirm the implementation related to this issue.`;
  }
  if (/search|grep|glob|find|repo_map/i.test(tool)) {
    return language === "zh"
      ? `正在搜索 ${targetMarkdown || "当前工作区"}，收窄需要检查的代码范围。`
      : `Searching ${targetMarkdown || "the current workspace"} to narrow the relevant code path.`;
  }
  if (/apply_patch|replace_in_file|write_file|delete_workspace_path/i.test(tool)) {
    return language === "zh"
      ? `正在修改 ${targetMarkdown || "目标文件"}，落实已经确认的修复方案。`
      : `Updating ${targetMarkdown || "the target file"} to apply the confirmed fix.`;
  }
  if (/run_command|execute_command|browser/i.test(tool)) {
    return language === "zh"
      ? `正在验证 ${targetMarkdown || "当前修改"}，检查真实行为和回归结果。`
      : `Validating ${targetMarkdown || "the current change"} against real behavior and regressions.`;
  }
  return action || title || (language === "zh" ? "正在推进当前任务。" : "Advancing the current task.");
}

/**
 * Compatibility projector for existing MainThread progress events. It is
 * intentionally structural: no model text is parsed to decide lifecycle or
 * activity. An explicit public action is already the complete Capsule
 * projection and remains intact for Markdown rendering. Older events without
 * one receive a single sentence derived from their structured tool and target;
 * their summary remains owned by Run Status/Timeline instead of being
 * duplicated in Capsule.
 */
export function buildRuntimeV2CompatibleCapsuleProjection(input: {
  readonly events: readonly MainThreadEvent[];
  readonly turnId: string;
  readonly runId: string | null | undefined;
  readonly language: "zh" | "en";
}): RuntimeV2CompatibleCapsuleProjection | null {
  const latestByKey = new Map<string, Extract<MainThreadEvent, { type: "progress.updated" }>>();
  for (const event of input.events) {
    if (event.type !== "progress.updated" || event.turnId !== input.turnId) continue;
    if (input.runId && event.runId && event.runId !== input.runId) continue;
    if (event.progress.audience === "internal") continue;
    latestByKey.set(progressKey(event), event);
  }
  const active = [...latestByKey.values()]
    .filter((event) => String(event.progress.status || "running").toLowerCase() === "running")
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .pop();
  if (!active) return null;
  const action = normalize(active.progress.action) ||
    actionLine(active.progress, input.language);
  return {
    markdown: action,
    source: "structured_runtime",
    updatedAt: active.timestampMs,
    dedupeKey: progressKey(active),
  };
}

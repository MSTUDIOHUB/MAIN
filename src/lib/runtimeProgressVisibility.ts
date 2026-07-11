/**
 * Runtime-only progress is useful for diagnostics and recovery, but it is not
 * user work. Keep the predicate centralized so live UI, persisted history and
 * reload projections cannot disagree about what is visible.
 */
export function isInternalRuntimeProgressBlock(block: any): boolean {
  if (!block) return false;
  if (block.audience === "internal") return true;
  if (block.type !== "progress") return false;
  if (block.turnPhase?.domain === "plan_runtime") return true;

  const phase = String(block.phase || "").toLowerCase();
  const tool = String(block.toolName || "").trim();
  const target = String(block.target || block.targets?.[0] || "").trim();
  return phase === "understanding" && !tool && !target;
}

export function isInternalRuntimeProgressUpdate(progress: any): boolean {
  if (!progress || typeof progress !== "object") return false;
  if (progress.audience === "internal") return true;

  const dedupeKey = String(progress.dedupeKey || "");
  if (dedupeKey.startsWith("plan-runtime:")) return true;

  const phase = String(progress.phase || "").toLowerCase();
  const tool = String(progress.tool || "").trim();
  const target = String(progress.target || "").trim();
  return phase === "understanding" && !tool && !target;
}

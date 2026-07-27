import type { RuntimeV2SubagentJob } from "../../lib/runtime-v2";
import { stringValue } from "./executionText";

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
    candidate.startsWith("/") ||
    /^[A-Za-z]:\//.test(candidate) ||
    candidate.split("/").includes("..")
  ) {
    return false;
  }
  return job.allowedPaths.some((root) =>
    root === "." ||
    candidate === root ||
    candidate.startsWith(`${root.replace(/\/$/, "")}/`)
  );
}
